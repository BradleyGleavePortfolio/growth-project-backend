import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  HttpStatus,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CoachMessage } from '@prisma/client';
import {
  VoiceUploadProvider,
  type SignedVoiceUploadRequest as ProviderSignedVoiceUploadRequest,
  type SignedVoiceUploadResponse as ProviderSignedVoiceUploadResponse,
} from '../community/voice/voice-upload.provider';
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
import { holdWelcomeLease, WelcomeLeaseLostError } from '../engagement/welcome-lease-fence';
import { describeFailure } from '../observability/log-pii';
import { isMessagingCoreV2Enabled } from './messaging-core.feature';
import { coachBroadcastsEnabled } from '../broadcasts/broadcasts.feature';
import { messagingError, MESSAGING_ERRORS } from './messaging-errors';
import {
  broadcastThreadUpdated,
  type ThreadUpdateKind,
} from './messaging-realtime';

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
  // A3-MSG-CORE: device-minted idempotency key (offline send queue). A replay
  // with the same (sender, key) returns the original row with no side effects.
  client_message_id?: string;
  // A3-MSG-CORE: swipe-reply target, validated to be in the same thread and
  // not deleted. Requires FEATURE_MESSAGING_CORE_V2.
  reply_to_id?: string;
}

/**
 * A3-MSG-CORE — a resolved canonical 1:1 thread from one participant's side.
 * `coachId` is the THREAD coach (the head coach for sub-coach threads);
 * `actorId` is the caller; `otherPartyId` is who receives pings and pushes.
 */
export interface ResolvedThread {
  coachId: string;
  clientId: string;
  actorId: string;
  actorSide: 'coach' | 'client';
  otherPartyId: string;
}

/** Max quoted-preview length carried on `reply_to` (characters). */
export const REPLY_PREVIEW_MAX = 160;

/** Wire shape of the quoted message on a reply (null when unavailable). */
export interface ReplyPreview {
  id: string;
  sender_id: string | null;
  kind: 'text' | 'voice' | 'deleted' | 'unavailable';
  preview: string;
}

type ReplyRow = Pick<
  CoachMessage,
  'id' | 'sender_id' | 'body' | 'voice_url' | 'deleted_at'
>;

/** Collapse whitespace and cap a body for a quoted/inbox preview. */
export function previewText(body: string | null, max: number): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
      const headCoachId =
        await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
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

  // ---- A3-MSG-CORE: shared thread resolution ----

  /**
   * Resolve the thread a coach (head coach, sub-coach with an open assignment,
   * never a foreign coach) has with `clientId`. 404 for a foreign client,
   * exactly like every other coach-side thread route.
   */
  async resolveThreadForCoach(
    coachId: string,
    clientId: string,
  ): Promise<ResolvedThread> {
    const client = await this.assertClientOfCoach(coachId, clientId);
    return {
      coachId: client.coach_id ?? coachId,
      clientId,
      actorId: coachId,
      actorSide: 'coach',
      otherPartyId: clientId,
    };
  }

  /** Resolve the client's single thread (409 NO_COACH_ASSIGNED when none). */
  async resolveThreadForClient(clientId: string): Promise<ResolvedThread> {
    const coachId = await this.requireClientCoachId(clientId);
    return {
      coachId,
      clientId,
      actorId: clientId,
      actorSide: 'client',
      otherPartyId: coachId,
    };
  }

  /** Users `callerId` has blocked (empty when the optional dep is absent). */
  async blockedIdsFor(callerId: string): Promise<string[]> {
    if (!this.safety) return [];
    return this.safety.getBlockedIdsFor(callerId);
  }

  /** True when either side of the pair has blocked the other. */
  async isEitherSideBlocked(a: string, b: string): Promise<boolean> {
    if (!this.safety) return false;
    return this.safety.isEitherSideBlocked(a, b);
  }

  /**
   * After a thread mutation that is not a new message (edit, delete, pin,
   * read): ping the other participant with an empty `thread-updated` event
   * (B-709-1: public channel, so no ids; `_kind` / `_messageId` document the
   * call site only) and, when coach-authored content changed, bust the
   * client's AI context cache so Roman never quotes an edited or deleted
   * coach message. Fire-and-forget; never fails the request.
   */
  notifyThreadUpdated(
    thread: ResolvedThread,
    _kind: ThreadUpdateKind,
    _messageId: string | null,
    opts: { coachContentChanged?: boolean } = {},
  ): void {
    void broadcastThreadUpdated(this.supabase, thread.otherPartyId);
    if (opts.coachContentChanged) {
      this.aiContext.invalidateForUser(thread.clientId);
    }
  }

  /**
   * Map a stored row to its wire shape for the v2 thread surface: the quoted
   * message preview on replies (hidden when the caller blocked its author or
   * it was deleted) and an explicit `deleted` flag. Content columns of a
   * tombstone are already NULL in the database; nothing is re-derived here.
   */
  serializeMessage<T extends CoachMessage & { reply_to?: ReplyRow | null }>(
    row: T,
    blocked: ReadonlySet<string>,
  ): Omit<T, 'reply_to'> & { reply_to: ReplyPreview | null; deleted: boolean } {
    const { reply_to: target, ...rest } = row;
    let reply: ReplyPreview | null = null;
    if (row.reply_to_id) {
      if (!target || (target.sender_id && blocked.has(target.sender_id))) {
        reply = { id: row.reply_to_id, sender_id: null, kind: 'unavailable', preview: '' };
      } else if (target.deleted_at) {
        reply = { id: target.id, sender_id: target.sender_id, kind: 'deleted', preview: '' };
      } else {
        reply = {
          id: target.id,
          sender_id: target.sender_id,
          kind: target.body ? 'text' : target.voice_url ? 'voice' : 'text',
          preview: previewText(target.body, REPLY_PREVIEW_MAX),
        };
      }
    }
    return { ...rest, reply_to: reply, deleted: row.deleted_at !== null };
  }

  /** Whether `userId` has this thread muted right now (v2 only). */
  private async isThreadMutedFor(
    userId: string,
    coachId: string,
    clientId: string,
  ): Promise<boolean> {
    try {
      const state = await this.prisma.coachThreadState.findUnique({
        where: {
          CoachThreadState_user_thread_key: {
            user_id: userId,
            coach_id: coachId,
            client_id: clientId,
          },
        },
        select: { muted_until: true },
      });
      return !!state?.muted_until && state.muted_until.getTime() > Date.now();
    } catch (err) {
      // Fail OPEN to delivery: a lookup failure must never swallow a push.
      this.logger.warn(`mute lookup failed: ${describeFailure(err)}`);
      return false;
    }
  }

  /**
   * Push the new-message notification unless the recipient muted the thread
   * (v2). With the flag OFF this is exactly the legacy emit.
   */
  private notifyNewMessage(
    recipientId: string,
    senderId: string,
    coachId: string,
    clientId: string,
  ): void {
    const emit = () =>
      this.resolveSenderName(senderId).then((senderName) =>
        this.messageReceived.emit(recipientId, {
          senderName,
          threadId: clientId,
        }),
      );
    if (!isMessagingCoreV2Enabled()) {
      void emit();
      return;
    }
    void this.isThreadMutedFor(recipientId, coachId, clientId).then((muted) =>
      muted ? undefined : emit(),
    );
  }

  /**
   * Idempotent, reply-validated insert shared by both send paths.
   *
   * - `client_message_id` set: an existing row for (sender, key) in the SAME
   *   thread is returned as a replay (no side effects run); in another thread
   *   it is 409 `messaging.idempotency_key_reused`. A concurrent duplicate that
   *   loses the unique-index race (P2002) re-reads and replays the winner.
   * - `reply_to_id` set: requires the v2 flag; the target must be a live
   *   message in the same thread, else 409 `messaging.reply_target_unavailable`.
   */
  private async insertThreadMessage(
    thread: { coachId: string; clientId: string },
    senderId: string,
    data: Omit<Prisma.CoachMessageUncheckedCreateInput, 'coach_id' | 'client_id' | 'sender_id'>,
    payload: SendMessagePayload,
  ): Promise<{ row: CoachMessage; replayed: boolean }> {
    const key = payload.client_message_id;
    const findReplay = async (): Promise<CoachMessage | null> => {
      if (!key) return null;
      const existing = await this.prisma.coachMessage.findFirst({
        where: { sender_id: senderId, client_message_id: key },
      });
      if (!existing) return null;
      if (
        existing.coach_id !== thread.coachId ||
        existing.client_id !== thread.clientId
      ) {
        throw messagingError(
          HttpStatus.CONFLICT,
          MESSAGING_ERRORS.IDEMPOTENCY_KEY_REUSED,
        );
      }
      return existing;
    };
    const replay = await findReplay();
    if (replay) return { row: replay, replayed: true };

    if (payload.reply_to_id) {
      if (!isMessagingCoreV2Enabled()) {
        throw messagingError(
          HttpStatus.SERVICE_UNAVAILABLE,
          MESSAGING_ERRORS.FEATURE_DISABLED,
        );
      }
      const target = await this.prisma.coachMessage.findFirst({
        where: {
          id: payload.reply_to_id,
          coach_id: thread.coachId,
          client_id: thread.clientId,
          deleted_at: null,
        },
        select: { id: true },
      });
      if (!target) {
        throw messagingError(
          HttpStatus.CONFLICT,
          MESSAGING_ERRORS.REPLY_TARGET_UNAVAILABLE,
        );
      }
    }

    try {
      const row = await this.prisma.coachMessage.create({
        data: {
          coach_id: thread.coachId,
          client_id: thread.clientId,
          sender_id: senderId,
          ...data,
          ...(key ? { client_message_id: key } : {}),
          ...(payload.reply_to_id ? { reply_to_id: payload.reply_to_id } : {}),
        },
      });
      return { row, replayed: false };
    } catch (err) {
      if (
        key &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await findReplay();
        if (winner) return { row: winner, replayed: true };
      }
      throw err;
    }
  }

  // ---- thread read ----

  // Paginated thread, newest-first. `before` is a strict `<` on created_at so
  // the client can pass the oldest timestamp it has seen to fetch the next
  // page without duplicates. Composite index (coach_id, client_id, created_at)
  // makes this a single seek.
  private async listThread(coachId: string, clientId: string, opts: ListOpts) {
    const limit = this.clampLimit(opts.limit);
    const before = this.parseBefore(opts.before);
    const v2 = isMessagingCoreV2Enabled();
    const withCards = coachBroadcastsEnabled();
    return this.prisma.coachMessage.findMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        ...(before ? { created_at: { lt: before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
      // A4 — rich card (workout, meal plan, booking, package, check-in) as a
      // server-validated snapshot, read only while FEATURE_COACH_BROADCASTS is
      // on. A3-MSG-CORE: the quoted message for swipe-replies (v2 only). With
      // both flags off the query is byte-identical to the legacy one.
      ...(withCards && v2
        ? {
            include: {
              card: { select: { card_type: true, ref_id: true, snapshot: true } },
              reply_to: {
                select: {
                  id: true,
                  sender_id: true,
                  body: true,
                  voice_url: true,
                  deleted_at: true,
                },
              },
            },
          }
        : withCards
          ? {
              include: {
                card: { select: { card_type: true, ref_id: true, snapshot: true } },
              },
            }
          : v2
            ? {
                include: {
                  reply_to: {
                    select: {
                      id: true,
                      sender_id: true,
                      body: true,
                      voice_url: true,
                      deleted_at: true,
                    },
                  },
                },
              }
            : {}),
    });
  }

  // A3-MSG-CORE: v2 adds `reply_to` + `deleted` to each row (flag-gated).
  private async serializeThreadPage(
    callerId: string,
    rows: Awaited<ReturnType<MessagingService['listThread']>>,
  ) {
    if (!isMessagingCoreV2Enabled()) return rows;
    const blocked = new Set(await this.blockedIdsFor(callerId));
    return rows.map((r) => this.serializeMessage(r, blocked));
  }

  async listThreadForCoach(coachId: string, clientId: string, opts: ListOpts) {
    const client = await this.assertClientOfCoach(coachId, clientId);
    // For sub-coaches, the thread's coach_id is the head coach's id —
    // returned in client.coach_id by assertClientOfCoach.
    const threadCoachId = client.coach_id ?? coachId;
    const rows = await this.listThread(threadCoachId, clientId, opts);
    const visible = await this.filterBlockedAuthors(coachId, clientId, rows);
    return this.serializeThreadPage(coachId, visible);
  }

  async listThreadForClient(clientId: string, opts: ListOpts) {
    const coachId = await this.requireClientCoachId(clientId);
    const rows = await this.listThread(coachId, clientId, opts);
    const visible = await this.filterBlockedAuthors(clientId, coachId, rows);
    return this.serializeThreadPage(clientId, visible);
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

  async sendAsCoach(
    coachId: string,
    clientId: string,
    payload: SendMessagePayload | string,
    // Internal callers only (never bound to a request body). `welcome` is the
    // coach welcome scheduler's job id + lease (B-609-3). The row is written
    // with CoachMessage.welcome_job_id = jobId (@unique), and a second send for
    // the same job returns the already-persisted message without a second
    // realtime ping, push, audit, analytics or PTM signal. The INSERT commits
    // only while the caller still holds the job's lease (holdWelcomeLease);
    // otherwise WelcomeLeaseLostError is thrown before any persistence or
    // fan-out.
    options: { welcome?: { jobId: string; lease: string } } = {},
  ) {
    // Back-compat: existing test fixtures and pre-Phase-6C call sites pass
    // a bare string. Normalize to the payload shape so the new code only
    // sees one form; the controllers always pass the structured form.
    const normalized: SendMessagePayload =
      typeof payload === 'string' ? { body: payload } : payload;
    const client = await this.assertClientOfCoach(coachId, clientId);
    this.assertSendablePayload(normalized, coachId);
    const trimmedBody =
      typeof normalized.body === 'string' ? normalized.body.trim() : '';
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
    const messageData = {
      body,
      voice_url: voice?.url ?? null,
      voice_duration_sec: voice?.duration_sec ?? null,
      voice_size_bytes: voice?.size_bytes ?? null,
      voice_content_type: voice?.content_type ?? null,
    };
    // Main merge (B-609-3 + A3-MSG-CORE): a welcome-job send (internal only,
    // never carries client_message_id or reply_to_id) keeps the lease-fenced
    // insert keyed on welcome_job_id; every other send takes the idempotent,
    // reply-validated insert.
    const { row: created, duplicate } = options.welcome
      ? await this.persistCoachMessage(
          {
            coach_id: threadCoachId,
            client_id: clientId,
            sender_id: coachId,
            ...messageData,
          },
          options.welcome,
        )
      : await this.insertThreadMessage(
          { coachId: threadCoachId, clientId },
          coachId,
          messageData,
          normalized,
        ).then(({ row, replayed }) => ({ row, duplicate: replayed }));
    // B-609-3: another worker already persisted this job's welcome. Hand back
    // that row and skip every side effect below, so the client gets exactly
    // one message, one ping and one push.
    // A3-MSG-CORE: an idempotent replay likewise returns the original row and
    // runs NO side effects (no second ping, push, audit, analytics or PTM signal).
    if (duplicate) return created;
    // Realtime ping to the recipient (the client). No body is sent over the
    // wire — just a refresh signal. The mobile client refetches via the
    // authenticated REST endpoint when it receives the ping. Fire-and-
    // forget so a Realtime hiccup never delays the API response.
    void this.supabase.broadcastNewMessage(clientId);
    // Push notification — block check already ran above. Skipped when the
    // client muted this thread (v2). Fire-and-forget.
    this.notifyNewMessage(clientId, coachId, threadCoachId, clientId);
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

  /**
   * Insert one CoachMessage. With a welcome job the row carries
   * CoachMessage.welcome_job_id (@unique) and is inserted in one transaction
   * with holdWelcomeLease, so it commits only while the caller's lease is live
   * (B-609-3 persistence fence); a lost lease throws WelcomeLeaseLostError and
   * inserts nothing. When the key is already taken the existing row is
   * returned with duplicate=true instead of a second insert.
   */
  private async persistCoachMessage(
    data: Prisma.CoachMessageUncheckedCreateInput,
    welcome?: { jobId: string; lease: string },
  ) {
    if (!welcome) {
      return { row: await this.prisma.coachMessage.create({ data }), duplicate: false };
    }
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (!(await holdWelcomeLease(tx, welcome.jobId, welcome.lease))) {
          throw new WelcomeLeaseLostError(welcome.jobId);
        }
        return tx.coachMessage.create({ data: { ...data, welcome_job_id: welcome.jobId } });
      });
      return { row, duplicate: false };
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      const existing = await this.prisma.coachMessage.findUnique({
        where: { welcome_job_id: welcome.jobId },
      });
      if (!existing) throw err;
      return { row: existing, duplicate: true };
    }
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

    const { row: created, replayed } = await this.insertThreadMessage(
      { coachId, clientId },
      clientId,
      {
        body,
        voice_url: voice?.url ?? null,
        voice_duration_sec: voice?.duration_sec ?? null,
        voice_size_bytes: voice?.size_bytes ?? null,
        voice_content_type: voice?.content_type ?? null,
      },
      normalized,
    );
    // A3-MSG-CORE: replay → original row, no side effects (see sendAsCoach).
    if (replayed) return created;
    // Ping the coach.
    void this.supabase.broadcastNewMessage(coachId);
    // Push notification — block check already ran above. Skipped when the
    // coach muted this thread (v2).
    this.notifyNewMessage(coachId, clientId, coachId, clientId);
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
  async markReadByCoach(
    coachId: string,
    clientId: string,
    opts: { upToMessageId?: string } = {},
  ) {
    const client = await this.assertClientOfCoach(coachId, clientId);
    const threadCoachId = client.coach_id ?? coachId;
    const upTo = await this.readCutoff(threadCoachId, clientId, opts.upToMessageId);
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: threadCoachId,
        client_id: clientId,
        sender_id: clientId,
        read_at: null,
        ...(upTo ? { created_at: { lte: upTo } } : {}),
      },
      data: { read_at: new Date() },
    });
    // A3-MSG-CORE: live read receipt for the client (v2, ID-only ping).
    if (result.count > 0 && isMessagingCoreV2Enabled()) {
      this.notifyThreadUpdated(
        {
          coachId: threadCoachId,
          clientId,
          actorId: coachId,
          actorSide: 'coach',
          otherPartyId: clientId,
        },
        'read',
        opts.upToMessageId ?? null,
      );
    }
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
  async coachReviewForClient(
    clientId: string,
  ): Promise<{ coachReviewedAt: string | null }> {
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

  /**
   * A3-MSG-CORE read-up-to: resolve the cutoff timestamp for a partial read
   * (the message the reader scrolled to). v2 only; the message must be in this
   * thread, else 404 `messaging.message_not_found`. No id → mark everything.
   */
  private async readCutoff(
    coachId: string,
    clientId: string,
    upToMessageId: string | undefined,
  ): Promise<Date | null> {
    if (!upToMessageId) return null;
    if (!isMessagingCoreV2Enabled()) {
      throw messagingError(
        HttpStatus.SERVICE_UNAVAILABLE,
        MESSAGING_ERRORS.FEATURE_DISABLED,
      );
    }
    const target = await this.prisma.coachMessage.findFirst({
      where: { id: upToMessageId, coach_id: coachId, client_id: clientId },
      select: { created_at: true },
    });
    if (!target) {
      throw messagingError(HttpStatus.NOT_FOUND, MESSAGING_ERRORS.MESSAGE_NOT_FOUND);
    }
    return target.created_at;
  }

  async markReadByClient(
    clientId: string,
    opts: { upToMessageId?: string } = {},
  ) {
    const coachId = await this.requireClientCoachId(clientId);
    const upTo = await this.readCutoff(coachId, clientId, opts.upToMessageId);
    // Mark every non-client sender's message read in this thread. Filtering on
    // sender_id = coachId would miss sub-coach messages, since sub-coaches
    // send with sender_id = subCoachId (the head coach still owns the thread).
    const result = await this.prisma.coachMessage.updateMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        sender_id: { not: clientId },
        read_at: null,
        ...(upTo ? { created_at: { lte: upTo } } : {}),
      },
      data: { read_at: new Date() },
    });
    // A3-MSG-CORE: live read receipt for the coach (v2, ID-only ping).
    if (result.count > 0 && isMessagingCoreV2Enabled()) {
      this.notifyThreadUpdated(
        {
          coachId,
          clientId,
          actorId: clientId,
          actorSide: 'client',
          otherPartyId: coachId,
        },
        'read',
        opts.upToMessageId ?? null,
      );
    }
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
      const headCoachId =
        await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
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
        clientFilter?.in ??
        (await this.subCoachScope.getAuthorizedClientIds(coachId));
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
        // A3-MSG-CORE: a message deleted for everyone never counts as unread.
        ...(isMessagingCoreV2Enabled() ? { deleted_at: null } : {}),
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
        // A3-MSG-CORE: a message deleted for everyone never counts as unread.
        ...(isMessagingCoreV2Enabled() ? { deleted_at: null } : {}),
      },
    });
    return { total };
  }
}

// Re-export ForbiddenException so service consumers can distinguish authorization
// failures without importing from @nestjs/common themselves.
export { ForbiddenException };

/** Prisma P2002 (unique constraint) without importing the runtime error class. */
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
