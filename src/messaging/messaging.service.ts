import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  VoiceUploadProvider,
  type SignedVoiceUploadRequest as ProviderSignedVoiceUploadRequest,
  type SignedVoiceUploadResponse as ProviderSignedVoiceUploadResponse,
} from '../community/voice/voice-upload.provider';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PtmService } from '../ptm/ptm.service';
import { MessageReceivedEmitter } from '../notifications/emitters/message-received.emitter';
import { AuditService } from '../audit/audit.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
// Apple 1.2 — server-side defence-in-depth for the mobile blocklist. Used
// to (a) skip new-message push fanout when either side has blocked the
// other and (b) filter blocked senders out of list / unread responses.
import { MessagesSafetyService } from '../messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { isCoachReviewedAtEnabled } from '../roman/coach-reviewed.feature';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type ListOpts = { before?: string; limit?: number };

// Phase 6C — voice attachment metadata. Server-validated at message-send
// time; never trusted blindly even though the upload endpoint already
// validates. The DTO carries the same shape from the client.
export interface VoicePayload {
  url: string;
  duration_sec: number;
  size_bytes: number;
  content_type: string;
}

export interface SendMessagePayload {
  body?: string;
  voice?: VoicePayload;
}

// v3-3: the signed-upload request/response shapes now live with the extracted
// VoiceUploadProvider (src/community/voice/voice-upload.provider.ts) — the one
// place the Supabase signed-upload contract is typed. Re-exported here under
// the original names so existing messaging importers keep compiling unchanged.
export type SignedVoiceUploadRequest = ProviderSignedVoiceUploadRequest;
export type SignedVoiceUploadResponse = ProviderSignedVoiceUploadResponse;

// Whitelist of accepted voice MIME types. Anything outside this set is
// rejected before we touch storage. iOS records m4a/aac, Android typically
// produces mp4/aac or webm/opus, web's MediaRecorder default is webm; ogg is
// supported for completeness.
export const VOICE_CONTENT_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
]);

const VOICE_DEFAULT_MAX_DURATION_SEC = 300;
const VOICE_DEFAULT_MAX_SIZE_MB = 5;
const VOICE_DURATION_CLAMP = { min: 10, max: 600 } as const;
const VOICE_SIZE_MB_CLAMP = { min: 1, max: 25 } as const;
const VOICE_DEFAULT_BUCKET = 'voice-notes';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private prisma: PrismaService,
    private supabase: SupabaseService,
    private analytics: AnalyticsService,
    private ptm: PtmService,
    private messageReceived: MessageReceivedEmitter,
    private audit: AuditService,
    // M2 — bust the client's AI context cache when a coach message arrives.
    private aiContext: ClientAIContextService,
    // Apple 1.2 — Optional so legacy unit tests that build the service via
    // `new MessagingService(...)` without the safety arg still compile. In
    // production DI it is always provided via MessagesSafetyModule.
    @Optional() private safety: MessagesSafetyService | null = null,
    // Phase 11: optional in the type signature so unit tests that
    // construct MessagingService directly with the legacy 4-arg form
    // keep compiling. In production DI it's always populated because
    // SubCoachModule is @Global.
    private subCoachScope?: SubCoachScopeService,
    // v3-3: the signed-upload helper is now the extracted VoiceUploadProvider.
    // @Optional so the legacy unit tests that construct MessagingService with
    // the positional 7-arg form still compile; production DI always provides it
    // (MessagingModule imports CommunityVoiceModule's provider). When absent we
    // lazily build one from the already-injected SupabaseService, so behaviour
    // is identical whether or not DI supplied it.
    @Optional() private voiceUpload: VoiceUploadProvider | null = null,
    // H6 (D-H6-3): structured same-transaction audit substrate. D-H6-3
    // verbatim wants every message saved for future AI training; this wrap
    // is the first concrete delivery toward BL-DATA-CAPTURE. @Optional so
    // legacy positional-construction specs keep compiling; AuditLogModule
    // is @Global so production DI always populates it.
    @Optional() private auditLog?: AuditLogService,
  ) {}

  // Resolve the extracted signed-upload provider, lazily constructing one from
  // the injected SupabaseService when DI did not supply it (legacy unit-test
  // construction path). Behaviour is identical either way.
  private voiceUploadProvider(): VoiceUploadProvider {
    if (!this.voiceUpload) {
      this.voiceUpload = new VoiceUploadProvider(this.supabase);
    }
    return this.voiceUpload;
  }

  // Resolve a sender's display name for the push notification body. Falls
  // back to a neutral label so a missing user row never crashes the send.
  private async resolveSenderName(senderId: string): Promise<string> {
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: senderId },
        select: { name: true },
      });
      return u?.name?.trim() || 'Your coach';
    } catch {
      return 'Your coach';
    }
  }

  // ---- voice config (env-driven, clamped) ----

  private maxVoiceDurationSec(): number {
    const raw = parseInt(process.env.VOICE_NOTE_MAX_DURATION_SEC ?? '', 10);
    if (!Number.isFinite(raw)) return VOICE_DEFAULT_MAX_DURATION_SEC;
    return Math.min(Math.max(raw, VOICE_DURATION_CLAMP.min), VOICE_DURATION_CLAMP.max);
  }

  private maxVoiceSizeBytes(): number {
    const raw = parseInt(process.env.VOICE_NOTE_MAX_SIZE_MB ?? '', 10);
    const mb = !Number.isFinite(raw)
      ? VOICE_DEFAULT_MAX_SIZE_MB
      : Math.min(Math.max(raw, VOICE_SIZE_MB_CLAMP.min), VOICE_SIZE_MB_CLAMP.max);
    return mb * 1024 * 1024;
  }

  private voiceBucket(): string {
    return (process.env.SUPABASE_VOICE_BUCKET ?? '').trim() || VOICE_DEFAULT_BUCKET;
  }

  // Validate a voice payload against the env-driven limits + content-type
  // allowlist. Throws BadRequestException with a stable error code so the
  // mobile client can render a precise message.
  private assertVoiceWithinLimits(voice: {
    duration_sec: number;
    size_bytes: number;
    content_type: string;
  }): void {
    if (!VOICE_CONTENT_TYPE_ALLOWLIST.has(voice.content_type)) {
      throw new BadRequestException({
        error: 'VOICE_CONTENT_TYPE_REJECTED',
        allowed: Array.from(VOICE_CONTENT_TYPE_ALLOWLIST),
      });
    }
    const maxDuration = this.maxVoiceDurationSec();
    if (voice.duration_sec <= 0 || voice.duration_sec > maxDuration) {
      throw new BadRequestException({
        error: 'VOICE_DURATION_OUT_OF_RANGE',
        max_seconds: maxDuration,
      });
    }
    const maxBytes = this.maxVoiceSizeBytes();
    if (voice.size_bytes <= 0 || voice.size_bytes > maxBytes) {
      throw new BadRequestException({
        error: 'VOICE_SIZE_OUT_OF_RANGE',
        max_bytes: maxBytes,
      });
    }
  }

  // Validate the combined message payload. Either `body` (non-empty) or
  // `voice` must be present — never both empty. The DTO already enforces
  // length / shape; this method enforces the cross-field invariant and the
  // server-side voice limits.
  //
  // `senderId` is required for the voice-URL ownership check below — the
  // signed-upload endpoint prefixes object paths with `${senderId}/`, so a
  // legitimate voice URL must contain that prefix. Without this check the
  // DTO's @IsUrl({require_tld:false, require_protocol:false}) accepts
  // arbitrary URLs (including `javascript:`, attacker hosts, or another
  // sender's object key) and the service would persist + render them. See
  // QA P0-V1.
  private assertSendablePayload(payload: SendMessagePayload, senderId: string): void {
    const trimmedBody = typeof payload.body === 'string' ? payload.body.trim() : '';
    const hasBody = trimmedBody.length > 0;
    const hasVoice = !!payload.voice;
    if (!hasBody && !hasVoice) {
      throw new BadRequestException({ error: 'MESSAGE_EMPTY' });
    }
    if (hasVoice && payload.voice) {
      this.assertVoiceWithinLimits(payload.voice);
      this.assertVoiceUrlInBucket(payload.voice.url, senderId);
    }
  }

  // Refuse voice URLs that the upload endpoint could not have produced:
  //   * Reject any non-http(s) scheme (blocks `javascript:`, `data:`, etc.).
  //   * Require the URL host to match SUPABASE_URL's host (the bucket lives
  //     there). In dev/test where SUPABASE_URL is unset the upload path
  //     returns 501 anyway, so this check is effectively skipped for those
  //     envs by allowing any https host but still forbidding non-http(s).
  //   * Require the object path to include `/<bucket>/<senderId>/` so a
  //     sender cannot replay another user's object key.
  private assertVoiceUrlInBucket(rawUrl: string, senderId: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException({ error: 'VOICE_URL_INVALID' });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException({ error: 'VOICE_URL_SCHEME_REJECTED' });
    }
    const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim();
    if (supabaseUrl) {
      try {
        const supaHost = new URL(supabaseUrl).host;
        if (parsed.host !== supaHost) {
          throw new BadRequestException({ error: 'VOICE_URL_HOST_REJECTED' });
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        // SUPABASE_URL didn't parse — treat as unconfigured, fall through
        // to the prefix check below.
      }
    }
    const bucket = this.voiceBucket();
    const requiredPrefix = `/${bucket}/${senderId}/`;
    if (!parsed.pathname.includes(requiredPrefix)) {
      throw new BadRequestException({ error: 'VOICE_URL_OBJECT_KEY_REJECTED' });
    }
  }

  // ---- helpers ----

  private clampLimit(limit?: number): number {
    if (!limit || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  private parseBefore(before?: string): Date | undefined {
    if (!before) return undefined;
    const d = new Date(before);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  // Look up a client and verify they belong to this coach. 404 on missing /
  // foreign — the existence of a foreign client must not leak. When the caller
  // is OWNER, the coach scoping check is bypassed (OWNER reads any thread).
  //
  // Phase 11: when the caller is a SUB-COACH (role='coach' AND coach_id !=
  // null), authorization requires an open SubCoachAssignment row for this
  // client. The returned `coach_id` is the head coach's id (the thread's
  // coach), NOT the sub-coach's id — so all subsequent prisma queries
  // continue to read/write under the head coach's namespace.
  private async assertClientOfCoach(
    coachId: string,
    clientId: string,
    opts: { ownerBypass?: boolean } = {},
  ): Promise<{ id: string; coach_id: string | null }> {
    if (opts.ownerBypass) {
      const client = await this.prisma.user.findFirst({
        where: { id: clientId, role: 'student' },
        select: { id: true, coach_id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return client;
    }

    // Fast path: caller is the head coach for this client.
    const direct = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (direct) return direct;

    // Phase 11 fallback: caller might be a sub-coach with an open
    // assignment for this client. Authorize via SubCoachAssignment.
    if (this.subCoachScope) {
      const headCoachId = await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
      if (headCoachId) {
        const open = await this.prisma.subCoachAssignment.findFirst({
          where: {
            sub_coach_id: coachId,
            client_id: clientId,
            head_coach_id: headCoachId,
            unassigned_at: null,
          },
          select: { id: true },
        });
        if (open) {
          // Confirm the client row exists / isn't soft-deleted and pin
          // the thread coach_id to the head coach.
          const client = await this.prisma.user.findFirst({
            where: { id: clientId, role: 'student', deleted_at: null },
            select: { id: true, coach_id: true },
          });
          if (client) {
            // The returned coach_id MUST be the head coach for the thread
            // namespace to resolve correctly.
            return { id: client.id, coach_id: headCoachId };
          }
        }
      }
    }

    throw new NotFoundException('Client not found');
  }

  // Load the current coach_id for a client. Throws 409 if no coach assigned —
  // callers map this to the NO_COACH_ASSIGNED contract.
  private async requireClientCoachId(clientId: string): Promise<string> {
    const me = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    if (!me?.coach_id) {
      throw new ConflictException({ error: 'NO_COACH_ASSIGNED' });
    }
    return me.coach_id;
  }

  // ---- thread read ----

  // Paginated thread, newest-first. `before` is a strict `<` on created_at so
  // the client can pass the oldest timestamp it has seen to fetch the next
  // page without duplicates. Composite index (coach_id, client_id, created_at)
  // makes this a single seek.
  private async listThread(coachId: string, clientId: string, opts: ListOpts) {
    const limit = this.clampLimit(opts.limit);
    const before = this.parseBefore(opts.before);
    return this.prisma.coachMessage.findMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        ...(before ? { created_at: { lt: before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async listThreadForCoach(coachId: string, clientId: string, opts: ListOpts) {
    const client = await this.assertClientOfCoach(coachId, clientId);
    // For sub-coaches, the thread's coach_id is the head coach's id —
    // returned in client.coach_id by assertClientOfCoach.
    const threadCoachId = client.coach_id ?? coachId;
    const rows = await this.listThread(threadCoachId, clientId, opts);
    return this.filterBlockedAuthors(coachId, clientId, rows);
  }

  async listThreadForClient(clientId: string, opts: ListOpts) {
    const coachId = await this.requireClientCoachId(clientId);
    const rows = await this.listThread(coachId, clientId, opts);
    return this.filterBlockedAuthors(clientId, coachId, rows);
  }

  /**
   * Drop messages authored by the other party in the thread when the caller
   * has blocked them. We only filter the *other* party's messages — the
   * caller still wants to see what they themselves wrote. This is the
   * server-side mirror of the mobile filterOutBlocked filter (defence in
   * depth, Engineering Rule 1 — never rely solely on the client).
   *
   * One round-trip: we look up the caller's blocklist once and apply it
   * in-memory. The mobile thread page is ≤ 100 messages so the filter cost
   * is negligible.
   */
  private async filterBlockedAuthors<T extends { sender_id: string | null }>(
    callerId: string,
    otherPartyId: string,
    rows: T[],
  ): Promise<T[]> {
    if (!otherPartyId || rows.length === 0) return rows;
    if (!this.safety) return rows; // Optional dep absent in legacy unit-test DI.
    const blocked = await this.safety.getBlockedIdsFor(callerId);
    if (blocked.length === 0) return rows;
    if (!blocked.includes(otherPartyId)) return rows;
    // Caller has blocked the other party — strip every message they
    // authored. The caller's own messages still render so they can see
    // what they last said before blocking.
    return rows.filter((m) => m.sender_id !== otherPartyId);
  }

  // ---- send ----

  async sendAsCoach(coachId: string, clientId: string, payload: SendMessagePayload | string) {
    // Back-compat: existing test fixtures and pre-Phase-6C call sites pass
    // a bare string. Normalize to the payload shape so the new code only
    // sees one form; the controllers always pass the structured form.
    const normalized: SendMessagePayload =
      typeof payload === 'string' ? { body: payload } : payload;
    const client = await this.assertClientOfCoach(coachId, clientId);
    this.assertSendablePayload(normalized, coachId);
    const trimmedBody = typeof normalized.body === 'string' ? normalized.body.trim() : '';
    const body = trimmedBody.length > 0 ? trimmedBody : null;
    const voice = normalized.voice;

    // Apple 1.2 — fail-closed block enforcement. The check runs BEFORE any
    // persistence or realtime fanout so a blocked send produces nothing:
    // no DB row, no realtime ping, no push. The mobile surfaces a clean
    // "Messages cannot be sent to blocked users" string from the 403.
    if (this.safety) {
      const blocked = await this.safety.isEitherSideBlocked(coachId, clientId);
      if (blocked) {
        throw new ForbiddenException({
          error: 'BLOCKED',
          message: 'Messages cannot be sent to blocked users',
        });
      }
    }

    // Phase 11: messages live under the head coach's coach_id namespace
    // so existing head-coach queries keep returning them. For sub-coaches
    // the sender_id captures who actually sent.
    const threadCoachId = client.coach_id ?? coachId;
    // H6 (D-H6-3): persist the message under withAuditLog() so the audit
    // row commits in the same transaction. afterState carries metadata
    // only (length, voice flag), never the raw body (R98).
    const coachMsgArgs = {
      data: {
        coach_id: threadCoachId,
        client_id: clientId,
        sender_id: coachId,
        body,
        voice_url: voice?.url ?? null,
        voice_duration_sec: voice?.duration_sec ?? null,
        voice_size_bytes: voice?.size_bytes ?? null,
        voice_content_type: voice?.content_type ?? null,
      },
    } as const;
    const created = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: threadCoachId,
            actorId: coachId,
            actorType: 'coach',
            action: 'create',
            resourceType: 'CoachMessage',
            resourceId: clientId,
            afterState: { body_length: body?.length ?? 0, has_voice: Boolean(voice) },
          },
          (tx) => tx.coachMessage.create(coachMsgArgs),
        )
      : await this.prisma.coachMessage.create(coachMsgArgs);
    // Realtime ping to the recipient (the client). No body is sent over the
    // wire — just a refresh signal. The mobile client refetches via the
    // authenticated REST endpoint when it receives the ping. Fire-and-
    // forget so a Realtime hiccup never delays the API response.
    void this.supabase.broadcastNewMessage(clientId);
    // Push notification — block check already ran above, so we can emit
    // unconditionally here. Fire-and-forget.
    void this.resolveSenderName(coachId).then((senderName) =>
      this.messageReceived.emit(clientId, {
        senderName,
        threadId: clientId,
      }),
    );
    void this.audit.write({
      action: 'messaging.sent',
      actorId: coachId,
      actorRole: 'coach',
      targetUserId: clientId,
      targetType: 'coach_message',
      targetId: created.id,
      tenantCoachId: coachId,
      metadata: {
        message_kind: voice ? 'voice' : 'text',
        body_length: body?.length ?? 0,
        voice_duration_sec: voice?.duration_sec ?? null,
      },
    });
    this.analytics.capture(coachId, Events.COACH_MESSAGE_SENT, {
      client_id: clientId,
      body_length: body?.length ?? 0,
      has_voice: !!voice,
      voice_duration_sec: voice?.duration_sec ?? null,
    });
    // Phase 1A — every coach->client send produces two PTM signals on the
    // client side (the PTM model scores clients only): message_received
    // (cadence) + coach_note_received (intent). Phase 6C — voice messages
    // emit value = duration_sec * 10 so a 30-second voice note registers
    // like a 300-char message; the text path uses body.length. Both are
    // fire-and-forget through PtmService.
    if (voice) {
      this.ptm.emit(clientId, 'message_received', voice.duration_sec * 10, {
        voice: true,
        duration_sec: voice.duration_sec,
      });
      this.ptm.emit(clientId, 'coach_note_received', 1, { voice: true });
    } else {
      this.ptm.emit(clientId, 'message_received', body?.length ?? 0, {
        voice: false,
      });
      this.ptm.emit(clientId, 'coach_note_received', 1, { voice: false });
    }
    // M2 — bust the client's AI context cache so the next chat reflects the
    // new coach message in last_coach_message_excerpt.
    this.aiContext.invalidateForUser(clientId);
    return created;
  }

  async sendAsClient(clientId: string, payload: SendMessagePayload | string) {
    // Back-compat: see sendAsCoach.
    const normalized: SendMessagePayload =
      typeof payload === 'string' ? { body: payload } : payload;
    const coachId = await this.requireClientCoachId(clientId);
    this.assertSendablePayload(normalized, clientId);
    const trimmedBody = typeof normalized.body === 'string' ? normalized.body.trim() : '';
    const body = trimmedBody.length > 0 ? trimmedBody : null;
    const voice = normalized.voice;

    // Apple 1.2 — fail-closed block enforcement. See sendAsCoach for rationale.
    if (this.safety) {
      const blocked = await this.safety.isEitherSideBlocked(coachId, clientId);
      if (blocked) {
        throw new ForbiddenException({
          error: 'BLOCKED',
          message: 'Messages cannot be sent to blocked users',
        });
      }
    }

    // H6 (D-H6-3): same-transaction audit for the client send path.
    const clientMsgArgs = {
      data: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: clientId,
        body,
        voice_url: voice?.url ?? null,
        voice_duration_sec: voice?.duration_sec ?? null,
        voice_size_bytes: voice?.size_bytes ?? null,
        voice_content_type: voice?.content_type ?? null,
      },
    } as const;
    const created = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: coachId,
            actorId: clientId,
            actorType: 'user',
            action: 'create',
            resourceType: 'CoachMessage',
            resourceId: clientId,
            afterState: { body_length: body?.length ?? 0, has_voice: Boolean(voice) },
          },
          (tx) => tx.coachMessage.create(clientMsgArgs),
        )
      : await this.prisma.coachMessage.create(clientMsgArgs);
    // Ping the coach.
    void this.supabase.broadcastNewMessage(coachId);
    // Push notification — block check already ran above.
    void this.resolveSenderName(clientId).then((senderName) =>
      this.messageReceived.emit(coachId, {
        senderName,
        threadId: clientId,
      }),
    );
    void this.audit.write({
      action: 'messaging.sent',
      actorId: clientId,
      actorRole: 'student',
      targetUserId: coachId,
      targetType: 'coach_message',
      targetId: created.id,
      tenantCoachId: coachId,
      metadata: {
        message_kind: voice ? 'voice' : 'text',
        body_length: body?.length ?? 0,
        voice_duration_sec: voice?.duration_sec ?? null,
      },
    });
    this.analytics.capture(clientId, Events.CLIENT_MESSAGE_SENT, {
      coach_id: coachId,
      body_length: body?.length ?? 0,
      has_voice: !!voice,
      voice_duration_sec: voice?.duration_sec ?? null,
    });
    if (voice) {
      this.ptm.emit(clientId, 'message_sent', voice.duration_sec * 10, {
        voice: true,
        duration_sec: voice.duration_sec,
      });
    } else {
      // Phase 1A: text-path emit. value = body length, no PII (no body).
      this.ptm.emit(clientId, 'message_sent', body?.length ?? 0, {
        voice: false,
      });
    }
    return created;
  }

  // ---- voice upload (signed URL) ----

  // Issue a Supabase Storage signed-upload URL for a voice attachment. The
  // server validates duration / size / content_type up-front so a signed URL
  // is never issued for a payload that would be rejected at message-send
  // time. Pre-signed uploads return a public URL that the client subsequently
  // attaches to a CreateMessageDto.voice payload.
  //
  // Auth scope is enforced at the controller layer (coach vs client). This
  // method is shared between both controllers because the storage path is
  // namespaced by user id.
  async createVoiceUpload(
    userId: string,
    request: SignedVoiceUploadRequest,
  ): Promise<SignedVoiceUploadResponse> {
    // Validate duration / size / content_type BEFORE issuing a signed URL so a
    // URL is never minted for a payload that would be rejected at send time.
    this.assertVoiceWithinLimits(request);

    // v3-3 typed extraction: the Supabase signed-upload mechanics (object-path
    // namespacing by owner id, the SDK version-skew runtime guard, and the
    // public-URL fallback) now live in the shared, typed VoiceUploadProvider.
    // The forbidden structural double-cast that used to live here is gone — the
    // provider expresses the structural SDK shape as a named interface while
    // preserving the `typeof fn !== 'function'` runtime version-skew guard.
    return this.voiceUploadProvider().createSignedUpload(userId, request);
  }

  // ---- read markers ----

  // Mark every message from the *other* party in this thread as read. We only
  // touch rows where read_at IS NULL so repeated calls are idempotent and the
  // original read timestamp survives.
  async markReadByCoach(coachId: string, clientId: string) {
    const client = await this.assertClientOfCoach(coachId, clientId);
    const threadCoachId = client.coach_id ?? coachId;
    // H6 (D-H6-3): a read acknowledgement mutates message state in a client
    // PII thread — audit it. afterState carries the count only (R98).
    const markReadArgs = {
      where: {
        coach_id: threadCoachId,
        client_id: clientId,
        sender_id: clientId,
        read_at: null,
      },
      data: { read_at: new Date() },
    } as const;
    const result = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: threadCoachId,
            actorId: coachId,
            actorType: 'coach',
            action: 'update',
            resourceType: 'CoachMessage',
            resourceId: clientId,
            reason: 'messaging.markReadByCoach',
          },
          (tx) => tx.coachMessage.updateMany(markReadArgs),
        )
      : await this.prisma.coachMessage.updateMany(markReadArgs);
    // ED.6 — stamp the per-thread coach-review marker so the client
    // CompetencePill can show "Your coach reviewed this thread {relative}.".
    // Most-recent semantics: every coach read re-stamps coach_reviewed_at to
    // now() (brief §Write paths). Keyed on the THREAD coach id (head coach for
    // sub-coach threads) so a single marker tracks the conversation. GATED on
    // FEATURE_ROMAN_COACH_REVIEWED_AT: while OFF no marker is ever written, so
    // the pill stays hidden. Best-effort: a marker failure must never fail the
    // read acknowledgement the coach app depends on.
    if (isCoachReviewedAtEnabled()) {
      try {
        await this.stampConversationReview(threadCoachId, clientId);
      } catch (err) {
        this.logger.warn(
          `ED.6 conversation-review stamp failed for coach=${threadCoachId} client=${clientId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { updated: result.count };
  }

  // ED.6 — upsert the (coach, client) thread review marker to now(). Idempotent
  // per thread via the (coach_id, client_id) unique key; concurrent reads just
  // re-stamp the same row (no read-modify-write race — the new value is now(),
  // independent of the old). Caller gates on the feature flag.
  private async stampConversationReview(coachId: string, clientId: string) {
    const now = new Date();
    await this.prisma.conversationReview.upsert({
      where: {
        ConversationReview_coach_client_key: {
          coach_id: coachId,
          client_id: clientId,
        },
      },
      update: { coach_reviewed_at: now },
      create: { coach_id: coachId, client_id: clientId, coach_reviewed_at: now },
    });
  }

  // ED.6 — read the coach-review timestamp for the requesting client's thread.
  // Returns { coachReviewedAt: ISO | null }. Null whenever no coach has reviewed
  // the thread yet OR the marker was never written (flag OFF) — the mobile
  // CompetencePill renders nothing on null. Resolves the client's assigned
  // coach the same way as the thread read (409 NO_COACH_ASSIGNED when none).
  async coachReviewForClient(clientId: string): Promise<{ coachReviewedAt: string | null }> {
    const coachId = await this.requireClientCoachId(clientId);
    const marker = await this.prisma.conversationReview.findUnique({
      where: {
        ConversationReview_coach_client_key: {
          coach_id: coachId,
          client_id: clientId,
        },
      },
      select: { coach_reviewed_at: true },
    });
    return {
      coachReviewedAt: marker ? marker.coach_reviewed_at.toISOString() : null,
    };
  }

  async markReadByClient(clientId: string) {
    const coachId = await this.requireClientCoachId(clientId);
    // Mark every non-client sender's message read in this thread. Filtering on
    // sender_id = coachId would miss sub-coach messages, since sub-coaches
    // send with sender_id = subCoachId (the head coach still owns the thread).
    // H6 (D-H6-3): a client read acknowledgement mutates message state in a
    // client PII thread — audit it. afterState carries the count only (R98).
    const markReadArgs = {
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: { not: clientId },
        read_at: null,
      },
      data: { read_at: new Date() },
    } as const;
    const result = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: coachId,
            actorId: clientId,
            actorType: 'user',
            action: 'update',
            resourceType: 'CoachMessage',
            resourceId: clientId,
            reason: 'messaging.markReadByClient',
          },
          (tx) => tx.coachMessage.updateMany(markReadArgs),
        )
      : await this.prisma.coachMessage.updateMany(markReadArgs);
    return { updated: result.count };
  }

  // ---- unread counts ----

  // Coach's unread inbox: messages where the coach is the recipient
  // (sender = client). Returns total + per-client breakdown so the coach UI
  // can badge each thread row without N extra round-trips.
  //
  // Phase 11: sub-coaches see only the unread counts for clients they're
  // currently assigned to, scoped through the SubCoachAssignment overlay.
  async unreadCountForCoach(coachId: string) {
    let threadCoachId = coachId;
    let clientFilter: { in: string[] } | undefined = undefined;
    if (this.subCoachScope) {
      const headCoachId = await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
      if (headCoachId) {
        // Sub-coach: messages live under the head coach; restrict to
        // assigned clients only.
        threadCoachId = headCoachId;
        const ids = await this.subCoachScope.getAuthorizedClientIds(coachId);
        if (ids.length === 0) return { total: 0, by_client: {} };
        clientFilter = { in: ids };
      }
    }
    // CC+SC P1c: a message is UNREAD-FOR-COACH only when it was sent by the
    // CLIENT, i.e. sender_id === the thread's client_id. The previous filter
    // `NOT: { sender_id: coachId }` excluded only the caller's own sends, so
    // a message sent by ANOTHER coach-side party (the head coach, or a
    // different sub-coach — sender_id = subCoachId) was mis-counted as
    // unread / client-side. Because a client only ever sends inside their
    // own thread, "client-authored" is exactly `sender_id IN <client set>`.
    // We resolve that client set via SubCoachScope for BOTH head coaches
    // (full roster) and sub-coaches (assigned clients); when the scope dep
    // is absent (legacy unit-test DI) we fall back to the prior
    // `NOT: { sender_id: coachId }` behaviour so those tests are unchanged.
    let senderFilter: Prisma.CoachMessageWhereInput;
    if (this.subCoachScope) {
      const clientIds =
        clientFilter?.in ?? (await this.subCoachScope.getAuthorizedClientIds(coachId));
      senderFilter = { sender_id: { in: clientIds } };
    } else {
      senderFilter = { NOT: { sender_id: coachId } };
    }
    const groups = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: {
        coach_id: threadCoachId,
        read_at: null,
        ...(clientFilter ? { client_id: clientFilter } : {}),
        ...senderFilter,
      },
      _count: { _all: true },
    });
    // Apple 1.2 — drop blocked clients from the unread count so the coach's
    // badge doesn't trail forever when they've blocked someone. Cheap lookup
    // once per call; map to a Set for O(1) per-row testing. `safety` is
    // optional in legacy unit-test DI; when absent we fall back to the
    // pre-existing un-filtered count.
    const blockedIds = this.safety
      ? new Set(await this.safety.getBlockedIdsFor(coachId))
      : new Set<string>();
    const by_client: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      if (g.client_id !== null && blockedIds.has(g.client_id)) {
        // Suppress entirely — both from per-client breakdown and grand total.
        continue;
      }
      // client_id is nullable after the SET NULL FK relaxation; rows
      // whose recipient has been hard-deleted are still counted in the
      // grand total but excluded from per-client breakdown (there is no
      // recipient to badge against).
      if (g.client_id !== null) {
        by_client[g.client_id] = g._count._all;
      }
      total += g._count._all;
    }
    return { total, by_client };
  }

  async unreadCountForClient(clientId: string) {
    const coachId = await this.prisma.user
      .findUnique({ where: { id: clientId }, select: { coach_id: true } })
      .then((u) => u?.coach_id ?? null);
    // No coach → nothing to read. We *don't* 409 here because the mobile client
    // polls this endpoint on every screen focus and a 409 would spam logs.
    if (!coachId) return { total: 0 };
    // Apple 1.2 — when the client has blocked their coach, suppress the
    // unread count so the bell never reflects messages the user has chosen
    // not to see. Cheap indexed lookup; runs once per call. Falls back to
    // an empty blocklist when the optional dep is absent (legacy DI).
    if (this.safety) {
      const blockedIds = await this.safety.getBlockedIdsFor(clientId);
      if (blockedIds.includes(coachId)) {
        return { total: 0 };
      }
    }
    // Count any non-client sender — sub-coach messages live under the head
    // coach's thread with sender_id = subCoachId, so a coach_id-only filter
    // would miss them.
    const total = await this.prisma.coachMessage.count({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: { not: clientId },
        read_at: null,
      },
    });
    return { total };
  }
}

// Re-export ForbiddenException so service consumers can distinguish authorization
// failures without importing from @nestjs/common themselves.
export { ForbiddenException };
