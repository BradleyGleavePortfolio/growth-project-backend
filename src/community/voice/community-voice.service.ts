import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import {
  CommunityVoiceRepository,
  type VoiceNoteSeed,
} from './community-voice.repository';
import {
  resolveVoiceEntitlementRequired,
} from './community-voice-flag.guard';
import { VoiceUploadProvider } from './voice-upload.provider';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.voice.not_found',
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

  private track(
    distinctId: string,
    event: string,
    props: Record<string, unknown>,
  ): void {
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
    if (
      !(VOICE_NOTE_MIME_ALLOWLIST as readonly string[]).includes(
        input.mime_type,
      )
    ) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.mime_rejected',
        allowed: [...VOICE_NOTE_MIME_ALLOWLIST],
      });
    }
    const maxDuration = this.maxDurationMs();
    if (input.duration_ms <= 0 || input.duration_ms > maxDuration) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.duration_out_of_range',
        max_duration_ms: maxDuration,
      });
    }
    const maxBytes = this.maxBytes();
    if (input.bytes <= 0 || input.bytes > maxBytes) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.size_out_of_range',
        max_bytes: maxBytes,
      });
    }
    // Duration-spoofing defence (50-failures): a client cannot claim a tiny
    // duration for a huge upload (or vice-versa). Enforce a coarse time-based
    // size budget — at most ~512 KB per second of audio, which comfortably
    // covers high-bitrate AAC/Opus while rejecting obviously-mismatched pairs.
    const maxBytesForDuration =
      Math.ceil(input.duration_ms / 1000) * 512 * 1024 + 256 * 1024;
    if (input.bytes > maxBytesForDuration) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.size_duration_mismatch',
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
  private async assertEntitled(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    if (!resolveVoiceEntitlementRequired()) return;
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    // A workspace-coach tier of 'free' means voice notes are not entitled for
    // that workspace's members. Resolve the owning coach's tier.
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    const entitled = await this.access.membershipInWorkspace(
      workspaceId,
      user.id,
    );
    if (!entitled) throw new NotFoundException(NOT_FOUND);
    // Default-deny: require an explicit paid entitlement signal on the member.
    const tier = (user as { plan_tier?: string }).plan_tier ?? 'flat_300';
    const isEntitled = tier !== 'free';
    if (!isEntitled) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.voice.not_entitled',
      });
    }
  }

  // ── Authorization ────────────────────────────────────────────────────────────

  private async isCoach(workspaceId: string, user: User): Promise<boolean> {
    return (
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id))
    );
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
      });
    }
    if (conversationId) {
      // DM note — scoped to the author's thread. The author is always a
      // participant of their own DM; cross-participant posting is mediated by
      // the messaging domain, not this lane.
      return { cohortId: null, conversationId };
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
    const url = await this.upload.createSignedDownload(row.storage_key);
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
    if (
      !workspace ||
      !(await this.access.canAccessWorkspace(workspaceId, user))
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertEntitled(workspaceId, user);
    this.assertWithinLimits(dto);

    const mime: VoiceNoteMimeType = dto.mime_type;
    const signed = await this.upload.createSignedUpload(user.id, {
      duration_sec: Math.ceil(dto.duration_ms / 1000),
      size_bytes: dto.bytes,
      content_type: mime,
    });
    // The provider's public_url embeds the object path; we derive the storage
    // key (the path within the bucket) from it so the client persists the same
    // key the server minted. The key is `${authorId}/<ts>-<rand>.<ext>`.
    const storageKey = this.deriveStorageKey(signed.public_url, user.id);

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

  /**
   * Extract the bucket-relative storage key from the provider's public URL,
   * asserting the author-id namespace prefix (bucket-binding). The public URL
   * shape is `.../object/public/<bucket>/<authorId>/<file>`; we take everything
   * after the bucket segment. Falls back to re-minting a key if the URL shape
   * is unexpected so we never return a key outside the author's namespace.
   */
  private deriveStorageKey(publicUrl: string, authorId: string): string {
    const bucket = this.upload.bucket();
    const marker = `/${bucket}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx >= 0) {
      const key = publicUrl.slice(idx + marker.length);
      if (key.startsWith(`${authorId}/`)) return key;
    }
    // Unexpected shape — mint a fresh namespaced key rather than trust the URL.
    return `${authorId}/${Date.now()}-fallback`;
  }

  // ── Create (durable insert after upload confirmed) ───────────────────────────

  async create(
    user: User,
    workspaceId: string,
    dto: CreateVoiceNoteDto,
  ): Promise<VoiceNoteResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (
      !workspace ||
      !(await this.access.canAccessWorkspace(workspaceId, user))
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.assertEntitled(workspaceId, user);
    this.assertWithinLimits(dto);

    // Bucket binding: the storage key MUST live in the caller's namespace. A
    // forged key for another principal's path is rejected — the server never
    // trusts a client-supplied key outside `${authorId}/`.
    if (!dto.storage_key.startsWith(`${user.id}/`)) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.voice.storage_key_rejected',
      });
    }

    const scope = await this.resolveWriteScope(
      workspaceId,
      user,
      dto.cohort_id,
      dto.conversation_id,
    );

    const seed: VoiceNoteSeed = {
      workspaceId,
      cohortId: scope.cohortId,
      conversationId: scope.conversationId,
      authorId: user.id,
      storageKey: dto.storage_key,
      durationMs: dto.duration_ms,
      bytes: dto.bytes,
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
  private async readableNote(
    user: User,
    voiceNoteId: string,
  ): Promise<CommunityVoiceNote> {
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
    if (
      !workspace ||
      !(await this.access.canAccessWorkspace(workspaceId, user))
    ) {
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

    const voiceNotes = await Promise.all(
      page.items.map((row) => this.noteView(row)),
    );
    return VoiceNoteFeedResponseSchema.parse({
      voice_notes: voiceNotes,
      next_cursor: page.nextCursor,
    });
  }

  async delete(user: User, voiceNoteId: string): Promise<{ deleted: true }> {
    const row = await this.repo.findById(voiceNoteId);
    if (!row || row.soft_deleted_at !== null) {
      throw new NotFoundException(NOT_FOUND);
    }
    // Author or workspace coach/owner may soft-delete.
    if (
      row.author_id !== user.id &&
      !(await this.isCoach(row.workspace_id, user))
    ) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.voice.not_author',
      });
    }
    await this.repo.softDelete(voiceNoteId, new Date());
    return { deleted: true };
  }
}
