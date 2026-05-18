import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PtmService } from '../ptm/ptm.service';
import { MessageReceivedEmitter } from '../notifications/emitters/message-received.emitter';
import { AuditService } from '../audit/audit.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';

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

export interface SignedVoiceUploadRequest {
  duration_sec: number;
  size_bytes: number;
  content_type: string;
}

export interface SignedVoiceUploadResponse {
  upload_url: string;
  public_url: string;
  expires_at: string;
}

// Whitelist of accepted voice MIME types. Anything outside this set is
// rejected before we touch storage. iOS records m4a/aac, Android typically
// produces mp4/aac or webm/opus, web's MediaRecorder default is webm; ogg is
// supported for completeness.
export const VOICE_CONTENT_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/webm',
  'audio/ogg',
]);

const VOICE_DEFAULT_MAX_DURATION_SEC = 300;
const VOICE_DEFAULT_MAX_SIZE_MB = 5;
const VOICE_DURATION_CLAMP = { min: 10, max: 600 } as const;
const VOICE_SIZE_MB_CLAMP = { min: 1, max: 25 } as const;
const VOICE_DEFAULT_BUCKET = 'voice-notes';
const VOICE_UPLOAD_TTL_SEC = 600; // 10 minutes — matches Supabase signed-upload default.

// Cryptographic random token for storage object paths. Hex-only so the
// path stays URL-safe without escaping.
function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

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
  ) {}

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
    return Math.min(
      Math.max(raw, VOICE_DURATION_CLAMP.min),
      VOICE_DURATION_CLAMP.max,
    );
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
  private assertSendablePayload(
    payload: SendMessagePayload,
    senderId: string,
  ): void {
    const trimmedBody =
      typeof payload.body === 'string' ? payload.body.trim() : '';
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
  // The returned coach_id is the thread's coach (the client's assigned coach
  // for OWNERs; the caller for normal coaches).
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
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true, coach_id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
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
    await this.assertClientOfCoach(coachId, clientId);
    return this.listThread(coachId, clientId, opts);
  }

  async listThreadForClient(clientId: string, opts: ListOpts) {
    const coachId = await this.requireClientCoachId(clientId);
    return this.listThread(coachId, clientId, opts);
  }

  // ---- send ----

  async sendAsCoach(
    coachId: string,
    clientId: string,
    payload: SendMessagePayload | string,
  ) {
    // Back-compat: existing test fixtures and pre-Phase-6C call sites pass
    // a bare string. Normalize to the payload shape so the new code only
    // sees one form; the controllers always pass the structured form.
    const normalized: SendMessagePayload =
      typeof payload === 'string' ? { body: payload } : payload;
    await this.assertClientOfCoach(coachId, clientId);
    this.assertSendablePayload(normalized, coachId);
    const trimmedBody =
      typeof normalized.body === 'string' ? normalized.body.trim() : '';
    const body = trimmedBody.length > 0 ? trimmedBody : null;
    const voice = normalized.voice;

    const created = await this.prisma.coachMessage.create({
      data: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: coachId,
        body,
        voice_url: voice?.url ?? null,
        voice_duration_sec: voice?.duration_sec ?? null,
        voice_size_bytes: voice?.size_bytes ?? null,
        voice_content_type: voice?.content_type ?? null,
      },
    });
    // Realtime ping to the recipient (the client). No body is sent over the
    // wire — just a refresh signal. The mobile client refetches via the
    // authenticated REST endpoint when it receives the ping. Fire-and-
    // forget so a Realtime hiccup never delays the API response.
    void this.supabase.broadcastNewMessage(clientId);
    // Push notification. The threadId is the coach<->client pair; the mobile
    // client deep-links to /messages/<clientId>. Fire-and-forget — the
    // emitter swallows its own errors so a notification failure never
    // bubbles into the message-send response.
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
    const trimmedBody =
      typeof normalized.body === 'string' ? normalized.body.trim() : '';
    const body = trimmedBody.length > 0 ? trimmedBody : null;
    const voice = normalized.voice;

    const created = await this.prisma.coachMessage.create({
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
    });
    // Ping the coach.
    void this.supabase.broadcastNewMessage(coachId);
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
    this.assertVoiceWithinLimits(request);

    // SECURITY NOTE: The signed URL allows the client to upload any content to
    // this storage path within the URL's validity window. We validate the
    // client-claimed MIME type and size here, but we do not verify the actual
    // uploaded object's content-type or size after upload. Full remediation
    // requires a pending-upload tracking table and a post-upload verification
    // step before the object is accepted into a CoachMessage. This is tracked
    // as a known gap (R7 Finding 4.1).

    const supabase = this.supabase.getClient();
    const bucket = this.voiceBucket();
    const ext = this.contentTypeToExt(request.content_type);
    const objectPath = `${userId}/${Date.now()}-${randomToken(8)}.${ext}`;

    let signedUrl: string;
    try {
      const storage = supabase.storage.from(bucket);
      // The Supabase JS SDK exposes createSignedUploadUrl() since v2.30. The
      // method signature varies across minor versions; cast to a narrow shape
      // so a schema bump elsewhere does not break this call site.
      const fn = (
        storage as unknown as {
          createSignedUploadUrl?: (
            path: string,
          ) => Promise<{
            data: { signedUrl: string; token?: string } | null;
            error: { message: string } | null;
          }>;
        }
      ).createSignedUploadUrl;
      if (typeof fn !== 'function') {
        throw new NotImplementedException({
          error: 'VOICE_STORAGE_UNAVAILABLE',
          reason:
            'Supabase JS SDK in this build does not expose createSignedUploadUrl. Set SUPABASE_VOICE_BUCKET and upgrade @supabase/supabase-js to >=2.30.',
        });
      }
      const result = await fn.call(storage, objectPath);
      if (result.error || !result.data) {
        throw new NotImplementedException({
          error: 'VOICE_STORAGE_UNAVAILABLE',
          reason: result.error?.message ?? 'No signed URL returned',
        });
      }
      signedUrl = result.data.signedUrl;
    } catch (err) {
      if (err instanceof NotImplementedException) throw err;
      this.logger.warn(
        `Supabase voice signed-upload failed: ${(err as Error).message}`,
      );
      throw new NotImplementedException({
        error: 'VOICE_STORAGE_UNAVAILABLE',
        reason: (err as Error).message,
      });
    }

    // The public URL is deterministic in Supabase Storage when the bucket is
    // public; for private buckets the message render path issues a short-
    // lived download URL on demand. We return both fields so the client can
    // persist whichever the deployment uses.
    const publicUrlResult = supabase.storage
      .from(bucket)
      .getPublicUrl(objectPath);
    const publicUrl =
      (publicUrlResult.data as { publicUrl?: string } | null)?.publicUrl ??
      `${process.env.SUPABASE_URL ?? ''}/storage/v1/object/public/${bucket}/${objectPath}`;

    const expiresAt = new Date(Date.now() + VOICE_UPLOAD_TTL_SEC * 1000);
    return {
      upload_url: signedUrl,
      public_url: publicUrl,
      expires_at: expiresAt.toISOString(),
    };
  }

  // Map a whitelisted content_type to a file extension for the storage
  // object path. Keep this small and exact — anything outside the
  // allowlist has already been rejected by assertVoiceWithinLimits.
  private contentTypeToExt(contentType: string): string {
    switch (contentType) {
      case 'audio/mp4':
      case 'audio/m4a':
        return 'm4a';
      case 'audio/aac':
        return 'aac';
      case 'audio/webm':
        return 'webm';
      case 'audio/ogg':
        return 'ogg';
      default:
        return 'bin';
    }
  }

  // ---- read markers ----

  // Mark every message from the *other* party in this thread as read. We only
  // touch rows where read_at IS NULL so repeated calls are idempotent and the
  // original read timestamp survives.
  async markReadByCoach(coachId: string, clientId: string) {
    await this.assertClientOfCoach(coachId, clientId);
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: clientId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });
    return { updated: result.count };
  }

  async markReadByClient(clientId: string) {
    const coachId = await this.requireClientCoachId(clientId);
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: coachId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });
    return { updated: result.count };
  }

  // ---- unread counts ----

  // Coach's unread inbox: messages where the coach is the recipient
  // (sender = client). Returns total + per-client breakdown so the coach UI
  // can badge each thread row without N extra round-trips.
  async unreadCountForCoach(coachId: string) {
    const groups = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: {
        coach_id: coachId,
        read_at: null,
        NOT: { sender_id: coachId },
      },
      _count: { _all: true },
    });
    const by_client: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
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
    const total = await this.prisma.coachMessage.count({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: coachId,
        read_at: null,
      },
    });
    return { total };
  }
}

// Re-export ForbiddenException so service consumers can distinguish authorization
// failures without importing from @nestjs/common themselves.
export { ForbiddenException };
