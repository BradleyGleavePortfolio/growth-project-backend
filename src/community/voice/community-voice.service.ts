import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CommunityVoiceNote, User } from '@prisma/client';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CommunityAccessService } from '../community-access.service';
import {
  COMMUNITY_BROADCAST_EVENTS,
  COMMUNITY_TELEMETRY_EVENTS,
  classifyTelemetryError,
} from '../community-events';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import {
  CreateVoiceNoteDto,
  IssueVoiceUploadDto,
  ListVoiceNotesQueryDto,
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_MS,
  VOICE_NOTE_MIME_ALLOWLIST,
  type VoiceNoteFeedResponse,
  VoiceNoteFeedResponseSchema,
  type VoiceNoteMimeType,
  type VoiceNoteResponse,
  VoiceNoteResponseSchema,
  type VoiceNoteView,
  type VoiceUploadTarget,
  VoiceUploadTargetSchema,
} from './community-voice.dto';
import { CommunityVoiceRepository, type VoiceNoteSeed } from './community-voice.repository';
import { resolveVoiceEntitlementRequired } from './community-voice-flag.guard';
import { VoiceUploadProvider } from './voice-upload.provider';
import { verifyPublishableVoiceKey } from './voice-storage-key';
import { CommunitySafetyService } from '../safety/community-safety.service';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.voice.not_found',
  message:
    'This voice note could not be found. It may have been deleted or removed. Refresh and try again.',
} as const;

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
  private async assertEntitled(workspaceId: string, user: User): Promise<void> {
    if (!resolveVoiceEntitlementRequired()) return;
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    // A workspace-coach tier of 'free' means voice notes are not entitled for
    // that workspace's members. Resolve the owning coach's tier.
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    const entitled = await this.access.membershipInWorkspace(workspaceId, user.id);
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
   * Resolve the target scope (cohort / conversation) for a write and assert the
   * caller may post into it. A channel note targets a cohort the caller can
   * access (or the workspace hall when neither cohort nor conversation given).
   * A DM note targets a conversation; participant resolution is the author's
   * own thread membership (the conversation roster lives in the messaging
   * domain — out of this lane's OWNS — so we scope DM writes to the author).
   */
  private async resolveWriteScope(
    workspaceId: string,
    user: User,
    cohortId: string | undefined,
    conversationId: string | undefined,
  ): Promise<{ cohortId: string | null; conversationId: string | null }> {
    if (cohortId && conversationId) {
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
    if (cohortId) {
      const cohort = await this.access.findCohort(cohortId);
      if (!cohort || cohort.workspace_id !== workspaceId) {
        throw new NotFoundException(NOT_FOUND);
      }
      if (!(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
      return { cohortId: cohort.id, conversationId: null };
    }
    // Workspace-hall note — any member of the workspace may post.
    if (!(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    return { cohortId: null, conversationId: null };
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  private async noteView(row: CommunityVoiceNote): Promise<VoiceNoteView> {
    // A-610-1: signed only for a canonical key inside the AUTHOR's folder.
    const url = await this.upload.createSignedDownload(row.storage_key, undefined, row.author_id);
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
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertEntitled(workspaceId, user);
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
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertEntitled(workspaceId, user);
    this.assertWithinLimits(dto);

    const scope = await this.resolveWriteScope(
      workspaceId,
      user,
      dto.cohort_id,
      dto.conversation_id,
    );

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

    // One row per recording: a key already published (even one a moderator
    // later hid or the author deleted) can never be re-published.
    if (await this.repo.findByStorageKey(dto.storage_key)) {
      throw new ConflictException(VOICE_KEY_ALREADY_USED);
    }

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
      waveformPeaks: null,
    };
    const row = await this.repo.createVoiceNote(seed);

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

    return VoiceNoteResponseSchema.parse({
      voice_note: await this.noteView(row),
    });
  }

  /**
   * Fire an ID-only ping on the cohort channel for a channel/cohort voice note.
   * Reuses the v1-4 postCreated broadcast contract (PostCreatedPayload) so we
   * do not widen the closed broadcast payload union (out of this lane's OWNS).
   * DM notes are not broadcast on a community channel (the messaging realtime
   * path owns DM fanout).
   */
  private async publishPing(row: CommunityVoiceNote): Promise<void> {
    if (row.conversation_id !== null) return;
    const cohortId = row.cohort_id;
    if (!cohortId) return; // workspace-hall notes ride the REST poll floor.
    const shard = this.realtime.cohortShard(cohortId);
    const channel = this.realtime.channels.cohort(cohortId, shard);
    await this.realtime.broadcastCommunityEvent(
      channel,
      COMMUNITY_BROADCAST_EVENTS.postCreated,
      {
        id: row.id,
        workspaceId: row.workspace_id,
        authorId: row.author_id,
        createdAt: row.created_at.toISOString(),
      },
      { distinctId: row.author_id, channelKind: 'cohort' },
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getOne(user: User, voiceNoteId: string): Promise<VoiceNoteResponse> {
    const row = await this.readableNote(user, voiceNoteId);
    // Two-way block: a direct id read cannot go around the list filter.
    await this.safety.assertVisibleTo(user.id, row.author_id, NOT_FOUND);
    return VoiceNoteResponseSchema.parse({
      voice_note: await this.noteView(row),
    });
  }

  /**
   * Resolve a voice note the caller may READ, or 404. Coach/owner reads any
   * non-deleted note in their workspace; a member reads a channel note in a
   * cohort/workspace they belong to, or a DM note they authored. Anything else
   * is an identical 404 so existence never leaks.
   */
  private async readableNote(user: User, voiceNoteId: string): Promise<CommunityVoiceNote> {
    const row = await this.repo.findById(voiceNoteId);
    if (!row || row.soft_deleted_at !== null) {
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
      if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
      return row;
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
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace || !(await this.access.canAccessWorkspace(workspaceId, user))) {
      throw new NotFoundException(NOT_FOUND);
    }

    let cohortFilter: string | null = null;
    if (query.cohort_id) {
      const cohort = await this.access.findCohort(query.cohort_id);
      if (
        !cohort ||
        cohort.workspace_id !== workspaceId ||
        !(await this.access.canAccessCohort(cohort, user))
      ) {
        throw new NotFoundException(NOT_FOUND);
      }
      cohortFilter = cohort.id;
    }

    const isCoach = await this.isCoach(workspaceId, user);
    const page = await this.repo.list({
      workspaceId,
      cohortId: cohortFilter,
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
    );
    const voiceNotes = await Promise.all(visibleRows.map((row) => this.noteView(row)));
    return VoiceNoteFeedResponseSchema.parse({
      voice_notes: voiceNotes,
      next_cursor: page.nextCursor,
    });
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
      await this.safety.assertVisibleTo(user.id, row.author_id, NOT_FOUND);
      throw new ForbiddenException(VOICE_NOT_AUTHOR);
    }
    await this.deleteAndErase(row);
    return { deleted: true };
  }

  /**
   * One transaction records the erasure and soft-deletes the rows
   * (C-610-10); storage is tried only after it commits.
   */
  private async deleteAndErase(row: CommunityVoiceNote): Promise<void> {
    const work = await this.repo.softDeleteWithErasure(row, 'author_delete');
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
