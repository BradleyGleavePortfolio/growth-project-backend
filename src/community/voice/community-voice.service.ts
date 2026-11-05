import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CommunityCohort, CommunityVoiceNote, User } from '@prisma/client';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CommunityAccessService } from '../community-access.service';
import {
  COMMUNITY_BROADCAST_EVENTS,
  COMMUNITY_TELEMETRY_EVENTS,
  classifyTelemetryError,
} from '../community-events';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { MessageRemovedPayloadSchema, type MessageRemovedPayload } from '../realtime/community-realtime.types';
import {
  CreateVoiceNoteDto,
  IssueVoiceUploadDto,
  ListVoiceNotesQueryDto,
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS,
  VOICE_NOTE_MIME_ALLOWLIST,
  bytesToPeaks,
  peaksToBytes,
  type VoiceConsentResponse,
  VoiceConsentResponseSchema,
  type VoiceHeardResponse,
  VoiceHeardResponseSchema,
  type VoiceNoteFeedResponse,
  VoiceNoteFeedResponseSchema,
  type VoiceNoteMimeType,
  type VoiceNoteResponse,
  VoiceNoteResponseSchema,
  VoiceNoteViewSchema,
  type VoiceUploadTarget,
  VoiceUploadTargetSchema,
} from './community-voice.dto';
import {
  CommunityVoiceRepository,
  type VoiceNoteSeed,
  type VoiceViewExtras,
} from './community-voice.repository';
import { memberName } from '../member-display-name';
import { resolveVoiceEntitlementRequired } from './community-voice-flag.guard';
import { VoiceUploadProvider } from './voice-upload.provider';
import { verifyPublishableVoiceKey } from './voice-storage-key';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { placeOf } from '../community-space-access';

/**
 * REMOVED-BY-BE (#174-4): who removed a note, on a coach-removed note only
 * (absent on every live note). The name follows the author_name rule for that
 * coach in that place; `role` is always 'coach' (the TGP owner shows as one).
 * Kept here, next to the only code that builds it, as the voice DTO file
 * belongs to another lane.
 */
export const RemovedBySchema = z
  .object({ role: z.literal('coach'), user_id: z.string(), name: z.string() })
  .strict();
const VoiceNoteRowSchema = VoiceNoteViewSchema.extend({
  removed_at: z.string().datetime().optional(),
  removed_by: RemovedBySchema.optional(),
}).strict();
export type VoiceNoteRow = z.infer<typeof VoiceNoteRowSchema>;
const VoiceNoteRowResponseSchema = VoiceNoteResponseSchema.extend({ voice_note: VoiceNoteRowSchema }).strict();
const VoiceNoteRowFeedSchema = VoiceNoteFeedResponseSchema.extend({ voice_notes: z.array(VoiceNoteRowSchema) }).strict();

/** A coach's removal of someone else's note (shown as a placeholder), not an author's delete. */
function coachRemoved(row: CommunityVoiceNote): row is CommunityVoiceNote & { soft_deleted_at: Date; removed_by_user_id: string } {
  return !!row.soft_deleted_at && !!row.removed_by_user_id;
}

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.voice.not_found',
  message:
    'This voice note could not be found. It may have been deleted or removed. Refresh and try again.',
} as const;

/** VOICE-BE: the reply's chat message is not in that space (the chat's own code-only 404). */
const PARENT_NOT_FOUND = { error: 'not_found', code: 'community.message.not_found' } as const;

/**
 * Voice notes in direct messages are not offered: a DM thread is keyed by the
 * pair of members (dm_key), not by a conversation id, so a DM voice note
 * could never reach its recipient, and it would sit outside the DM block and
 * report rules. Channel (cohort) and hall voice notes are the product.
 */
export const VOICE_DM_NOT_SUPPORTED = {
  error: 'bad_request',
  code: 'community.voice.dm_not_supported',
  message:
    'Voice notes can be shared in your community spaces, not in direct messages. Send a text message instead, or share the voice note in a space.',
} as const;

/** A-610-1: a key the server did not mint for this caller (or a stale one). */
export const VOICE_STORAGE_KEY_REJECTED = {
  error: 'bad_request',
  code: 'community.voice.storage_key_rejected',
  message:
    'This recording could not be attached. Record the voice note again in the app, then send it.',
} as const;

/** A-610-1: nothing was uploaded at the minted key (or it does not match). */
export const VOICE_UPLOAD_MISSING = {
  error: 'bad_request',
  code: 'community.voice.upload_missing',
  message:
    'We could not find the uploaded recording. Check your connection, record the voice note again, then send it.',
} as const;

export const VOICE_UPLOAD_MISMATCH = {
  error: 'bad_request',
  code: 'community.voice.upload_mismatch',
  message:
    'The uploaded recording does not match what was recorded. Record the voice note again in the app, then send it.',
} as const;

export const VOICE_KEY_ALREADY_USED = {
  error: 'conflict',
  code: 'community.voice.already_posted',
  message: 'This recording was already posted. Refresh to see it, or record a new voice note.',
} as const;

export const VOICE_STORAGE_UNAVAILABLE = {
  error: 'service_unavailable',
  code: 'community.voice.storage_unavailable',
  message:
    'Voice notes cannot be checked right now. Your recording was not posted. Try sending it again in a minute.',
} as const;

export const VOICE_NOT_AUTHOR = {
  error: 'forbidden',
  code: 'community.voice.not_author',
  message:
    'Only the person who recorded this voice note, or your coach, can delete it. You can report it instead.',
} as const;

/** A removed row as its removal ping needs it: a voice note, or a space chat message. */
export type RemovedRow = Pick<CommunityVoiceNote, 'id' | 'workspace_id' | 'cohort_id' | 'created_at'> & {
  kind: MessageRemovedPayload['kind'];
  sender_id: string;
};

/**
 * REMOVED-BY-BE / FR-1165R (B2): a coach's (or the TGP owner's) removal of someone else's
 * item, live, to everyone who may read it now: a space's readers (channelKind 'cohort') or,
 * for a Hall note, the Hall's readers (cohortId null, channelKind 'workspace', as Hall posts).
 * Same event name as an edit; ids and times only. The direct DELETE and the queue's Hide send
 * it after the commit, so a failed ping never undoes the removal.
 */
export async function publishRemoval(realtime: CommunityRealtimeService, row: RemovedRow, removedBy: string, at: Date): Promise<void> {
  const payload = MessageRemovedPayloadSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    cohortId: row.cohort_id,
    updatedAt: at.toISOString(),
    removedAt: at.toISOString(),
    createdAt: row.created_at.toISOString(),
    kind: row.kind,
    authorId: row.sender_id,
    removedBy: { role: 'coach', userId: removedBy },
  });
  const channelKind = row.cohort_id ? 'cohort' : 'workspace';
  await realtime.broadcastCommunityEvent(
    { workspaceId: row.workspace_id, cohortId: row.cohort_id },
    COMMUNITY_BROADCAST_EVENTS.messageUpdated,
    payload,
    { distinctId: removedBy, channelKind },
  );
}

/**
 * Community voice notes (v3-3): audio attachments coaches and members send into
 * community channels (cohort / workspace hall) and DM threads.
 *
 * TENANCY (v1-2 / v3-1 / v3-2 doctrine): the app runs as service_role
 * (BYPASSRLS), so a non-member read resolves to 404 (existence never leaks) and
 * an unauthorised write resolves to 403. The migration's RLS policies are
 * defence-in-depth for any non-service-role connection.
 *
 * UPLOAD → CONFIRM → INSERT (audit rule "no voice note durable-stored before
 * upload confirmed"): the client first calls upload-url to get a signed PUT
 * URL + storage key, uploads the bytes to Supabase Storage, THEN calls
 * create() to durably record the row. The row is only written on that second
 * call — never speculatively at URL-issue time.
 *
 * BUCKET BINDING (50-failures: signed-URL bucket binding): the storage key is
 * minted SERVER-SIDE, namespaced by the author id, and on create() the service
 * re-asserts the `${authorId}/` prefix so a client cannot persist a key for
 * another principal's path or an arbitrary bucket location.
 *
 * REALTIME (best-effort, brief test 7): after the insert we fire an ID-only
 * ping on the cohort channel via the existing CommunityRealtimeService. The
 * publish is void-ed (never blocks/fails the write); a publish failure is
 * captured as telemetry and the row stays. Reuses the closed v1-4 broadcast
 * contract (postCreated + PostCreatedPayload) rather than widening the closed
 * payload union — that union lives outside this lane's OWNS (R77).
 */
@Injectable()
export class CommunityVoiceService {
  private readonly logger = new Logger(CommunityVoiceService.name);

  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityVoiceRepository,
    private readonly upload: VoiceUploadProvider,
    private readonly realtime: CommunityRealtimeService,
    private readonly analytics: AnalyticsService,
    private readonly safety: CommunitySafetyService,
  ) {}

  // ── Config ─────────────────────────────────────────────────────────────────

  private maxDurationMs(): number {
    const raw = parseInt(process.env.VOICE_NOTE_MAX_DURATION_MS ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : MAX_VOICE_DURATION_MS;
  }

  private maxBytes(): number {
    const raw = parseInt(process.env.VOICE_NOTE_MAX_BYTES ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : MAX_VOICE_BYTES;
  }

  private telemetryEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_TELEMETRY === 'true';
  }

  private track(distinctId: string, event: string, props: Record<string, unknown>): void {
    if (!this.telemetryEnabled()) return;
    this.analytics.capture(distinctId, event, props);
  }

  // ── Validation ───────────────────────────────────────────────────────────────

  /**
   * Re-validate duration / size / mime against the server limits. The DTO
   * already enforces these, but the service is the authoritative gate so an
   * internal caller (or a future controller) can never bypass them. MIME is
   * checked against the exact 4-type allowlist — declared-type spoofing past
   * the allowlist is rejected here before any storage interaction.
   */
  private assertWithinLimits(input: {
    duration_ms: number;
    bytes: number;
    mime_type: string;
  }): void {
    if (!(VOICE_NOTE_MIME_ALLOWLIST as readonly string[]).includes(input.mime_type)) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.mime_rejected',
        message:
          'This recording format is not supported. Record the voice note again in the app, then send it.',
        allowed: [...VOICE_NOTE_MIME_ALLOWLIST],
      });
    }
    const maxDuration = this.maxDurationMs();
    if (input.duration_ms <= 0 || input.duration_ms > maxDuration) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.duration_out_of_range',
        message: `Voice notes can be up to ${Math.floor(maxDuration / 1000)} seconds long. Record a shorter one, then send it.`,
        max_duration_ms: maxDuration,
      });
    }
    const maxBytes = this.maxBytes();
    if (input.bytes <= 0 || input.bytes > maxBytes) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.size_out_of_range',
        message: 'This recording is too large to send. Record a shorter voice note, then send it.',
        max_bytes: maxBytes,
      });
    }
    // Duration-spoofing defence (50-failures): a client cannot claim a tiny
    // duration for a huge upload (or vice-versa). Enforce a coarse time-based
    // size budget — at most ~512 KB per second of audio, which comfortably
    // covers high-bitrate AAC/Opus while rejecting obviously-mismatched pairs.
    const maxBytesForDuration = Math.ceil(input.duration_ms / 1000) * 512 * 1024 + 256 * 1024;
    if (input.bytes > maxBytesForDuration) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.size_duration_mismatch',
        message:
          'This recording could not be checked. Record the voice note again in the app, then send it.',
        max_bytes_for_duration: maxBytesForDuration,
      });
    }
  }

  // ── Entitlement gate (brief test 6) ──────────────────────────────────────────

  /**
   * When FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT is on, a non-entitled
   * member is rejected (403). Coaches/owners are always entitled (they author
   * the surface); a member is entitled when their coach is on a paid tier. The
   * check reads only the already-loaded User + a single workspace-coach lookup,
   * so it adds no dependency on the checkout module (R77 scope).
   */
  private async assertEntitled(workspaceId: string, user: User, inSpace: boolean): Promise<void> {
    if (!resolveVoiceEntitlementRequired()) return;
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    // A workspace-coach tier of 'free' means voice notes are not entitled for
    // that workspace's members. Resolve the owning coach's tier.
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    // BPF-1: a note for a space has met that space's rule (targetFor), a public
    // space's included; only a Hall note needs a membership here.
    const entitled = inSpace || (await this.access.membershipInWorkspace(workspaceId, user.id));
    if (!entitled) throw new NotFoundException(NOT_FOUND);
    // Default-deny: require an explicit paid entitlement signal on the member.
    const tier = (user as { plan_tier?: string }).plan_tier ?? 'flat_300';
    const isEntitled = tier !== 'free';
    if (!isEntitled) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.voice.not_entitled',
        message:
          'Voice notes are not included in your current plan. You can post a text message instead, or ask your coach about your plan.',
      });
    }
  }

  // ── Authorization ────────────────────────────────────────────────────────────

  private async isCoach(workspaceId: string, user: User): Promise<boolean> {
    return user.role === 'owner' || (await this.access.isWorkspaceCoach(workspaceId, user.id));
  }

  /**
   * BPF-1: the place a voice upload, note or list is for, or the same 404.
   * With `cohortId`, that space of this workspace under its own rule
   * (canAccessCohort, the check a text message there passes), so a member of
   * a public space only reaches it; without one, the Hall (null) under the
   * workspace rule, as before.
   */
  private async targetFor(
    user: User,
    workspaceId: string,
    cohortId: string | undefined,
  ): Promise<CommunityCohort | null> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (workspace && !cohortId && (await this.access.canAccessWorkspace(workspaceId, user))) return null;
    const space = workspace && cohortId ? await this.access.findCohort(cohortId) : null;
    if (space && space.workspace_id === workspaceId && (await this.access.canAccessCohort(space, user))) return space;
    throw new NotFoundException(NOT_FOUND);
  }

  /**
   * Resolve the target scope (cohort / conversation) for a write and assert the
   * caller may post into it. `space` is what targetFor resolved: a space the
   * caller can access, or null for the workspace hall (its rule already met).
   * A DM note targets a conversation; participant resolution is the author's
   * own thread membership (the conversation roster lives in the messaging
   * domain — out of this lane's OWNS — so we scope DM writes to the author).
   */
  private async resolveWriteScope(
    user: User,
    space: CommunityCohort | null,
    conversationId: string | undefined,
    reply: boolean,
  ): Promise<{ cohortId: string | null; conversationId: string | null }> {
    if (space && conversationId) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.ambiguous_target',
        message:
          'A voice note can go to one space at a time. Choose one space, then send it again.',
      });
    }
    if (conversationId) {
      // DM voice notes are not offered (VOICE_DM_NOT_SUPPORTED): refuse before
      // any row is written.
      throw new BadRequestException(VOICE_DM_NOT_SUPPORTED);
    }
    if (space) {
      // FIX-1122-R1: a reply (its parent is checked next by replyParent, 404
      // unless live and in this space) needs only access, as a text reply does;
      // a top-level note needs the start permission; a section takes neither.
      if (!reply || space.kind === 'section') await this.access.assertCanPost(space, user);
      return { cohortId: space.id, conversationId: null };
    }
    // Workspace-hall note — any member of the workspace may post.
    return { cohortId: null, conversationId: null };
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  /** One workspace's notes as `viewerId` sees them (VOICE-BE extras in one batch). */
  private async noteViews(viewerId: string, rows: CommunityVoiceNote[]): Promise<VoiceNoteRow[]> {
    if (rows.length === 0) return [];
    const extras = await this.repo.viewExtras(viewerId, rows);
    return Promise.all(rows.map((row) => this.noteView(row, extras)));
  }

  private async noteView(row: CommunityVoiceNote, x: VoiceViewExtras): Promise<VoiceNoteRow> {
    if (coachRemoved(row)) return this.placeholderView(row, x);
    // A-610-1: signed only for a canonical key inside the AUTHOR's folder.
    const url = await this.upload.createSignedDownload(row.storage_key, undefined, row.author_id);
    const chat = x.chat.get(row.id);
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      cohort_id: row.cohort_id,
      conversation_id: row.conversation_id,
      author_id: row.author_id,
      url,
      duration_ms: row.duration_ms,
      bytes: Number(row.bytes),
      mime_type: row.mime_type,
      has_waveform: row.waveform_peaks !== null,
      created_at: row.created_at.toISOString(),
      author_name: memberName(x.names.get(row.author_id), x.fullName(row.cohort_id, row.author_id)),
      author_is_coach: row.author_id === x.coachId,
      waveform_peaks: bytesToPeaks(row.waveform_peaks),
      heard_at: x.heardAt.get(row.id)?.toISOString() ?? null,
      message_id: chat ? row.id : null,
      parent_message_id: chat?.parent_message_id ?? null,
    };
  }

  /**
   * REMOVED-BY-BE (#174-4): a coach-removed note keeps its place as a
   * placeholder: who sent it and when, when and by whom it was removed. Every
   * audio field is emptied and nothing is signed (the recording is erased).
   */
  private placeholderView(
    row: CommunityVoiceNote & { soft_deleted_at: Date; removed_by_user_id: string },
    x: VoiceViewExtras,
  ): VoiceNoteRow {
    const chat = x.chat.get(row.id);
    const remover = row.removed_by_user_id;
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      cohort_id: row.cohort_id,
      conversation_id: row.conversation_id,
      author_id: row.author_id,
      url: null,
      duration_ms: 0,
      bytes: 0,
      mime_type: row.mime_type,
      has_waveform: false,
      created_at: row.created_at.toISOString(),
      author_name: memberName(x.names.get(row.author_id), x.fullName(row.cohort_id, row.author_id)),
      author_is_coach: row.author_id === x.coachId,
      waveform_peaks: null,
      heard_at: null,
      message_id: chat ? row.id : null,
      parent_message_id: chat?.parent_message_id ?? null,
      removed_at: row.soft_deleted_at.toISOString(),
      removed_by: {
        role: 'coach',
        user_id: remover,
        name: memberName(x.names.get(remover), x.fullName(row.cohort_id, remover)),
      },
    };
  }

  // ── Upload URL issuance ──────────────────────────────────────────────────────

  /**
   * Issue a signed upload URL for a voice note. Validates limits + entitlement
   * BEFORE minting the URL (no URL for a payload we'd reject), then returns the
   * server-minted storage key the client echoes back on create(). The bucket
   * name is server-authoritative and returned for assertion, never trusted from
   * the client.
   */
  async issueUploadUrl(
    user: User,
    workspaceId: string,
    dto: IssueVoiceUploadDto,
  ): Promise<VoiceUploadTarget> {
    // BPF-1: access to the place only; create() adds the posting policy and
    // the reply parent, which only it knows.
    const space = await this.targetFor(user, workspaceId, dto.cohort_id);
    await this.assertEntitled(workspaceId, user, space !== null);
    this.assertWithinLimits(dto);

    const mime: VoiceNoteMimeType = dto.mime_type;
    const signed = await this.upload.createSignedUploadWithKey(user.id, {
      duration_sec: Math.ceil(dto.duration_ms / 1000),
      size_bytes: dto.bytes,
      content_type: mime,
    });
    // The exact key the server minted (`<authorId>/<ms>-<nonce>-<mac>.<ext>`,
    // voice-storage-key.ts). The client echoes it on create(), where the MAC
    // proves it was issued to this caller.
    const storageKey = signed.storage_key;

    this.track(user.id, COMMUNITY_TELEMETRY_EVENTS.voiceUploadIssued, {
      workspace_id: workspaceId,
      duration_ms: dto.duration_ms,
      bytes: dto.bytes,
      mime_type: mime,
    });

    const ttl = this.upload.ttlSeconds();
    return VoiceUploadTargetSchema.parse({
      upload_url: signed.upload_url,
      storage_key: storageKey,
      expires_at: signed.expires_at,
      expires_in_seconds: ttl,
      bucket: this.upload.bucket(),
    });
  }

  // ── Create (durable insert after upload confirmed) ───────────────────────────

  async create(
    user: User,
    workspaceId: string,
    dto: CreateVoiceNoteDto,
  ): Promise<VoiceNoteResponse> {
    const space = await this.targetFor(user, workspaceId, dto.cohort_id);
    await this.assertEntitled(workspaceId, user, space !== null);
    this.assertWithinLimits(dto);

    const scope = await this.resolveWriteScope(
      user,
      space,
      dto.conversation_id,
      Boolean(dto.parent_message_id), // the same test replyParent uses
    );
    const parent = await this.replyParent(user, space, dto.parent_message_id);

    // A-610-1 bucket binding: only a key the server minted for THIS caller
    // (valid issuance MAC, canonical shape, recent) is accepted, checked after
    // the same normalization the storage SDK + fetch apply, so a dot-segment,
    // encoded, foreign-owner or other-bucket key never gets a row or a
    // signing request.
    const keyCheck = verifyPublishableVoiceKey(this.upload.bucket(), dto.storage_key, user.id);
    if (!keyCheck.ok) {
      this.logger.warn(`voice publish refused: storage key ${keyCheck.reason}`);
      throw new BadRequestException(VOICE_STORAGE_KEY_REJECTED);
    }

    // One row per recording (VOICE-IDEM-BE): the same create sent again after
    // a lost reply gets the first note back; any other use of the key (another
    // place or parent, or a note since deleted or hidden) stays the 409.
    const first = await this.repo.findByStorageKey(dto.storage_key);
    if (first) return this.replay(user, workspaceId, scope, parent, first);

    // Upload confirmed: the object must exist at the exact minted key, be
    // audio, and fit the declared limits (the stored size is authoritative).
    const stat = await this.upload.statObject(dto.storage_key, user.id);
    if (stat.state === 'unavailable') {
      throw new ServiceUnavailableException(VOICE_STORAGE_UNAVAILABLE);
    }
    if (stat.state === 'missing') {
      throw new BadRequestException(VOICE_UPLOAD_MISSING);
    }
    const storedBytes = stat.size ?? dto.bytes;
    if (
      (stat.contentType !== null && !stat.contentType.toLowerCase().startsWith('audio/')) ||
      storedBytes <= 0
    ) {
      throw new BadRequestException(VOICE_UPLOAD_MISMATCH);
    }
    this.assertWithinLimits({ ...dto, bytes: storedBytes });

    const seed: VoiceNoteSeed = {
      workspaceId,
      cohortId: scope.cohortId,
      conversationId: scope.conversationId,
      authorId: user.id,
      storageKey: dto.storage_key,
      durationMs: dto.duration_ms,
      bytes: storedBytes,
      mimeType: dto.mime_type,
      waveformPeaks: peaksToBytes(dto.waveform_peaks),
      parent,
      answersClients: user.role === 'coach' || user.role === 'owner',
    };
    const { row, replayed } = await this.repo.createVoiceNote(seed);
    if (replayed) return this.replay(user, workspaceId, scope, parent, row); // a racing create won

    this.track(user.id, COMMUNITY_TELEMETRY_EVENTS.voiceNotePublished, {
      workspace_id: workspaceId,
      cohort_id: scope.cohortId,
      is_dm: scope.conversationId !== null,
      duration_ms: dto.duration_ms,
      bytes: dto.bytes,
      mime_type: dto.mime_type,
    });

    // Best-effort realtime ping — void-ed so a Supabase outage never blocks or
    // fails the write (failure #24). A publish failure is captured as telemetry
    // and the row stays. Only channel/cohort notes ping a cohort channel.
    void this.publishPing(row).catch((err: unknown) => {
      this.track(user.id, COMMUNITY_TELEMETRY_EVENTS.voicePublishFailed, {
        workspace_id: workspaceId,
        error_code: classifyTelemetryError(err),
      });
    });

    return VoiceNoteRowResponseSchema.parse({
      voice_note: (await this.noteViews(user.id, [row]))[0],
    });
  }

  /**
   * VOICE-IDEM-BE replay: the first note is returned (same body as its create,
   * nothing written, no ping or telemetry) only to its author, in the same
   * space or thread with the same reply parent, while it and its chat message
   * are live. Every gate in create() has already run for this request.
   */
  private async replay(
    user: User,
    workspaceId: string,
    scope: { cohortId: string | null; conversationId: string | null },
    parent: VoiceNoteSeed['parent'],
    row: CommunityVoiceNote,
  ): Promise<VoiceNoteResponse> {
    const chat = row.cohort_id ? await this.repo.findChatMessage(row.id) : null;
    const live = row.cohort_id === null
      ? parent === null
      : chat?.kind === 'voice' && chat.deleted_at === null && chat.visibility === 'active' &&
        chat.parent_message_id === (parent?.id ?? null);
    if (
      !live || row.soft_deleted_at !== null || row.author_id !== user.id || row.workspace_id !== workspaceId ||
      row.cohort_id !== scope.cohortId || row.conversation_id !== scope.conversationId
    ) {
      throw new ConflictException(VOICE_KEY_ALREADY_USED);
    }
    return VoiceNoteResponseSchema.parse({ voice_note: (await this.noteViews(user.id, [row]))[0] });
  }

  /**
   * VOICE-BE reply link: the chat message a space note answers must be a live,
   * plain chat message in the same space whose author the caller can see; a
   * reply to a reply joins the first message's thread (one level, Slack-like).
   * Anything else, a Hall note included, is the message 404 (no new words).
   * BPF-1: the rule a text reply there meets (CommunityMessagesService
   * .replyParent): the first message is checked the same way, and in a
   * coach-only space a member replies only in a thread the coach started.
   */
  private async replyParent(
    user: User,
    space: CommunityCohort | null,
    parentId: string | undefined,
  ): Promise<{ id: string; at: Date } | null> {
    if (!parentId) return null;
    const tapped = await this.liveParent(user, space, parentId);
    const root = tapped.parent_message_id ? await this.liveParent(user, space, tapped.parent_message_id) : tapped;
    if (space?.posting_policy === 'coach' && !(await this.access.isWorkspaceCoach(space.workspace_id, root.sender_id))) {
      await this.access.assertCanPost(space, user);
    }
    return { id: root.id, at: root.created_at };
  }

  private async liveParent(user: User, space: CommunityCohort | null, messageId: string) {
    const m = space ? await this.repo.findChatMessage(messageId) : null;
    if (!m || m.scope !== 'cohort' || m.cohort_id !== space?.id || m.deleted_at || m.plan_context_type !== null) {
      throw new NotFoundException(PARENT_NOT_FOUND);
    }
    await this.safety.assertVisibleTo(user.id, m.sender_id, PARENT_NOT_FOUND, placeOf(m));
    return m;
  }

  /**
   * Fire an ID-only ping to everyone who may read the space of a cohort voice note.
   * VOICE-BE: the note is now a chat message in that space (same id), so it is
   * the chat's messageCreated ping, exactly as a text message sends it.
   * DM notes are not broadcast on a community channel (the messaging realtime
   * path owns DM fanout).
   */
  private async publishPing(row: CommunityVoiceNote): Promise<void> {
    if (row.conversation_id !== null) return;
    const cohortId = row.cohort_id;
    if (!cohortId) return; // workspace-hall notes ride the REST poll floor.
    await this.realtime.broadcastCommunityEvent(
      { workspaceId: row.workspace_id, cohortId },
      COMMUNITY_BROADCAST_EVENTS.messageCreated,
      {
        id: row.id,
        cohortId,
        authorId: row.author_id,
        createdAt: row.created_at.toISOString(),
      },
      { distinctId: row.author_id, channelKind: 'cohort' },
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getOne(user: User, voiceNoteId: string): Promise<VoiceNoteResponse> {
    // REMOVED-BY-BE: a coach-removed note reads as its placeholder.
    const row = await this.readableNote(user, voiceNoteId, { placeholder: true });
    // Two-way block: a direct id read cannot go around the list filter.
    await this.safety.assertVisibleTo(user.id, row.author_id, NOT_FOUND, placeOf(row));
    return VoiceNoteRowResponseSchema.parse({
      voice_note: (await this.noteViews(user.id, [row]))[0],
    });
  }

  /**
   * Resolve a voice note the caller may READ, or 404. Coach/owner reads any
   * non-deleted note in their workspace; a member reads a channel note in a
   * cohort/workspace they belong to, or a DM note they authored. Anything else
   * is an identical 404 so existence never leaks. Rule D (FR-1173R2): a live
   * note of a public space reads for its author's own coach too. REMOVED-BY-BE: with
   * `placeholder` (the single read only), a coach-removed note passes the
   * same rules so it reads as its placeholder; every other path (heard,
   * delete) still treats it as missing.
   */
  private async readableNote(
    user: User,
    voiceNoteId: string,
    opts: { placeholder?: boolean } = {},
  ): Promise<CommunityVoiceNote> {
    const row = await this.repo.findById(voiceNoteId);
    if (!row || (row.soft_deleted_at !== null && !(opts.placeholder && coachRemoved(row)))) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (await this.isCoach(row.workspace_id, user)) return row;

    if (row.conversation_id !== null) {
      // DM note — only the author may read through this lane.
      if (row.author_id !== user.id) throw new NotFoundException(NOT_FOUND);
      return row;
    }
    if (row.cohort_id) {
      const cohort = await this.access.findCohort(row.cohort_id);
      if (!cohort) throw new NotFoundException(NOT_FOUND);
      if (await this.access.canAccessCohort(cohort, user)) return row;
      // Rule D (FR-1173R2, LS-1173R2 B2): a public space's live note by the caller's own client reads for that
      // coach too, outside the space (community-public-row.ts; the row layer's community_voice_notes_public_own_coach).
      if (row.soft_deleted_at === null && (await this.repo.isPublicRowOfMyClient(cohort.id, user.id, row.author_id))) {
        return row;
      }
      throw new NotFoundException(NOT_FOUND);
    }
    if (!(await this.access.canAccessWorkspace(row.workspace_id, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    return row;
  }

  async list(
    user: User,
    workspaceId: string,
    query: ListVoiceNotesQueryDto,
  ): Promise<VoiceNoteFeedResponse> {
    const space = await this.targetFor(user, workspaceId, query.cohort_id);

    const isCoach = await this.isCoach(workspaceId, user);
    const page = await this.repo.list({
      workspaceId,
      cohortId: space?.id ?? null,
      conversationId: query.conversation_id ?? null,
      visibleCohortIds: isCoach
        ? undefined
        : await this.access.listAccessibleCohortIds(workspaceId, user.id),
      isCoach,
      viewerId: user.id,
      limit: query.limit,
      cursor: query.cursor,
    });

    const visibleRows = await this.safety.filterBlocked(
      user.id,
      page.items,
      (row) => row.author_id,
      placeOf,
    );
    const voiceNotes = await this.noteViews(user.id, visibleRows);
    return VoiceNoteRowFeedSchema.parse({
      voice_notes: voiceNotes,
      next_cursor: page.nextCursor,
    });
  }

  // ── Heard marker and consent (VOICE-BE) ─────────────────────────────────────

  /**
   * The phone heard this note to the end: mark it heard for THIS listener only
   * (the first time is kept). Same read rule as getOne, so a note the caller
   * cannot read is the same 404; the table's RLS check repeats the rule.
   */
  async markHeard(user: User, voiceNoteId: string): Promise<VoiceHeardResponse> {
    const row = await this.readableNote(user, voiceNoteId);
    await this.safety.assertVisibleTo(user.id, row.author_id, NOT_FOUND, placeOf(row));
    const heardAt = await this.repo.markHeard(row.id, user.id);
    return VoiceHeardResponseSchema.parse({ voice_note_id: row.id, heard_at: heardAt.toISOString() });
  }

  /** Whether this person has seen the voice consent card (it is shown once). */
  async consent(user: User): Promise<VoiceConsentResponse> {
    const seenAt = await this.repo.consentSeenAt(user.id);
    return VoiceConsentResponseSchema.parse({ seen: seenAt !== null, seen_at: seenAt?.toISOString() ?? null });
  }

  /** Record that the consent card was shown (idempotent; the first time is kept). */
  async markConsentSeen(user: User): Promise<VoiceConsentResponse> {
    const seenAt = await this.repo.markConsentSeen(user.id);
    return VoiceConsentResponseSchema.parse({ seen: true, seen_at: seenAt.toISOString() });
  }

  /**
   * Author delete (and workspace coach / platform owner).
   *
   * B-610-3: the author can always delete their own note, checked BEFORE any
   * read/membership rule, so a member who was removed, banned or lost their
   * plan can still take their own recording down. Anyone else who cannot
   * read the note gets the same 404 as a missing note (no existence leak); a
   * member who can read it but did not record it gets 403 VOICE_NOT_AUTHOR.
   *
   * B-610-5 / C-610-10: the erasure of the recording (community_voice_erasures)
   * and the soft delete of the note and its search row (no read path, queue
   * or search shows it and nothing signs it again) commit in ONE transaction;
   * only after that commit is the object erased and the removal verified. A
   * crash can therefore never leave a live note whose recording the retry
   * cron erases. A storage outage leaves the erasure open and
   * VoiceErasureService retries it until verified, so "deleted" is never a
   * recording left behind.
   */
  async delete(user: User, voiceNoteId: string): Promise<{ deleted: true }> {
    const own = await this.repo.findById(voiceNoteId);
    if (own && own.author_id === user.id) {
      if (own.soft_deleted_at !== null) {
        // Already deleted: re-open and retry the erasure (idempotent), then
        // answer like a missing note (unchanged contract).
        await this.eraseRecording(own);
        throw new NotFoundException(NOT_FOUND);
      }
      await this.deleteAndErase(own);
      return { deleted: true };
    }
    const row = await this.readableNote(user, voiceNoteId);
    if (!(await this.isCoach(row.workspace_id, user))) {
      // Blocked either way reads as missing, like every other voice read.
      await this.safety.assertVisibleTo(user.id, row.author_id, NOT_FOUND, placeOf(row));
      throw new ForbiddenException(VOICE_NOT_AUTHOR);
    }
    // REMOVED-BY-BE (#174-4): the coach's removal of someone else's note is
    // moderation, stores who removed it (placeholder) and tells the author.
    const removedAt = new Date();
    await this.deleteAndErase(row, user.id, removedAt);
    // The removal's live update (space or Hall); a DM note sends none (its create sends none).
    const ping = { ...row, kind: 'voice' as const, sender_id: row.author_id };
    if (row.conversation_id === null) void publishRemoval(this.realtime, ping, user.id, removedAt).catch((err: unknown) => {
      this.track(user.id, COMMUNITY_TELEMETRY_EVENTS.voicePublishFailed, {
        workspace_id: row.workspace_id,
        error_code: classifyTelemetryError(err),
      });
    });
    return { deleted: true };
  }

  /**
   * One transaction records the erasure and soft-deletes the rows
   * (C-610-10); storage is tried only after it commits. `removedBy` set =
   * a coach's removal (reason 'moderation', who and when kept, author told).
   */
  private async deleteAndErase(row: CommunityVoiceNote, removedBy: string | null = null, at?: Date): Promise<void> {
    const work = removedBy
      ? await this.repo.softDeleteWithErasure(row, 'moderation', at, removedBy)
      : await this.repo.softDeleteWithErasure(row, 'author_delete');
    await this.runErasure(row, work);
  }

  /** Re-open (or create) the durable erasure for an already-deleted note and try it. */
  private async eraseRecording(row: CommunityVoiceNote): Promise<void> {
    const work = await this.repo.recordErasure([row.storage_key], 'author_delete');
    await this.runErasure(row, work);
  }

  private async runErasure(
    row: CommunityVoiceNote,
    work: Awaited<ReturnType<CommunityVoiceRepository['recordErasure']>>,
  ): Promise<void> {
    try {
      const outcome = await this.repo.attemptErasure(this.upload, work);
      if (outcome.pending > 0) {
        this.logger.warn(
          `voice note ${row.id}: recording removal not yet verified; erasure recorded and retried by VoiceErasureService`,
        );
      }
    } catch (err) {
      // The delete and its erasure work are already committed (C-610-10), so
      // the member's delete succeeded; the retry cron owns the erasure from
      // here (same rule as a moderation Hide/Ban after commit).
      this.logger.error(
        `voice note ${row.id}: erasure attempt failed after commit (${(err as Error).message}); VoiceErasureService retries it`,
      );
    }
  }
}
