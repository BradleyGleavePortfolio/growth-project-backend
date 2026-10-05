import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../../prisma.service';
import { NotificationKind } from '../notification-kind';
import {
  EXPO_RECEIPT_CHUNK,
  ExpoHttpError,
  ExpoPushClient,
  FetchExpoPushClient,
  deadlineSignal,
} from './expo-push-client';
import { PushContext, lockScreenCopy } from './lock-screen-copy';
import { androidChannelFor } from './push-channels';
import { quietHoursFor } from './push-quiet-hours';
import { pushAllowedByPreferences } from './push-preferences';
import { usableTimeZone } from '../local-time';
import { resolveRecipientTimeZone } from '../recipient-timezone';

// Device delivery for inbox notifications (C-643-2), through a durable
// outbox (B-NOTIF-5: B-648-1, B-648-6, C-648-4 / OR-113-5, C-648-5).
//
// enqueue() writes one PushOutbox row (inside the caller's transaction when
// it has one) and returns. Nothing in a request waits on Expo. The worker
// (drain) leases ONE due row at a time with FOR UPDATE SKIP LOCKED, right
// before it works on it, so any number of replicas send each row once, and
// calls Expo with a cancelling deadline.
//
// Guarantees:
//   - Lease authority (B-648-8). Every claim gets a fresh lease_token, and
//     every write the worker makes afterwards is a compare-and-set on it.
//     Right before the Expo call the worker renews the lease and stamps
//     handed_off_at in one CAS; if that fails (another worker took the row
//     back) it does not send. A lapsed lease WITHOUT handed_off_at was never
//     started and goes back to pending; WITH it the send is unknown and the
//     row is closed (at most once). A lost CAS is never reported as sent.
//   - Every decision is re-made at the moment of sending, not only at
//     enqueue (B-648-9, B-648-10): the recipient's current preferences
//     (`muted`, `<kind>_push`), quiet hours in the recipient's CURRENT zone,
//     and the burst cap. A push whose switch was turned off while it waited
//     is suppressed; one that would now land inside quiet hours waits for
//     08:00 local again, without spending a provider retry attempt. The
//     switches and the device token are read once more AFTER the handoff
//     write, so a mute or sign-out committed at any point before the handoff
//     stops the send (Sol B-648-9, round 5).
//   - Lock screen (B-692-1): title and body come only from the per-kind
//     templates (lock-screen-copy.ts), rendered at the moment of sending; the
//     Android channel is one the app creates (push-channels.ts, B-693-1).
//   - Distinct events are never dropped by a rate limit (B-648-1). A booking
//     event has an exactly-once identity (dedupe_key: kind, session, start
//     time). Repeats in one conversation collapse: while a push for the same
//     thread is unsent it takes the newest copy, and a repeat within
//     COLLAPSE_WINDOW_MS of a sent one is folded into it (the inbox row still
//     exists). A per-user burst cap (USER_WINDOW_MAX per USER_WINDOW_MS)
//     DEFERS non-urgent pushes to when the window has room; it never drops.
//   - Quiet hours (OR-113-5): 21:00-08:00 in the recipient's zone, non-urgent
//     pushes wait until 08:00 local; urgent ones go now (push-quiet-hours.ts).
//     A deferred booking reminder is re-checked when it is sent (the session
//     must still be scheduled at that time) and its lock-screen line is
//     rendered then, so "today" / "tomorrow" stay true.
//   - Deadlines (B-648-6): every Expo call is aborted after SEND_DEADLINE_MS /
//     RECEIPT_DEADLINE_MS. A timed-out send is not retried (Expo may have
//     accepted it: at most once). HTTP 429/5xx means Expo did not accept the
//     request, so it is retried with backoff up to MAX_ATTEMPTS.
//   - Tokens: DeviceNotRegistered (ticket or receipt) clears the user's token
//     only if it is still that exact token. A clear that fails is never
//     settled (B-693-2): the row keeps result_code token-cleanup-pending and
//     the receipt sweep retries the clear (never the send) until it succeeds.
//   - Android without the FCM V1 key: Expo answers InvalidCredentials. The
//     token is kept, the push is recorded as provider-not-configured (never
//     as sent), and the operator gets one PUSH_PROVIDER_NOT_CONFIGURED line
//     per hour per process. iOS delivery is not affected.
//   - Receipts are read from the outbox rows 2+ minutes after the send, so a
//     restart loses none (C-648-5). Rows are kept RETENTION_MS, then deleted.

export const EXPO_PUSH_CLIENT = Symbol('EXPO_PUSH_CLIENT');
export type { ExpoPushClient } from './expo-push-client';

export const COLLAPSE_WINDOW_MS = 60_000;
export const USER_WINDOW_MS = 10 * 60_000;
export const USER_WINDOW_MAX = 8;
export const RECEIPT_MIN_AGE_MS = 2 * 60_000;
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000;
export const PROVIDER_ALERT_INTERVAL_MS = 60 * 60_000;
export const SEND_DEADLINE_MS = 10_000;
export const RECEIPT_DEADLINE_MS = 15_000;
export const LEASE_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
/** Rows one drain works through at most (the next sweep takes the rest). */
export const MAX_ROWS_PER_DRAIN = 500;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Failed token clears one receipt sweep retries at most (B-693-2). */
export const TOKEN_CLEANUP_BATCH = 100;
const CLEANUP_PENDING: SendOutcome = 'token-cleanup-pending';

export type EnqueueCode = 'queued' | 'deferred' | 'duplicate' | 'collapsed';

export interface EnqueueResult {
  code: EnqueueCode;
  /** When the worker may send it (08:00 local for a quiet-hours deferral). */
  notBefore: Date;
}

export interface EnqueuePush {
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** Tap routing for the mobile pushTapRouter: ids and enums only, never user text. */
  data: Record<string, unknown>;
  context?: PushContext | null;
  /** Exactly-once identity of the event, when it has one. */
  dedupeKey?: string | null;
  /** Same-conversation repeats share this key. */
  collapseKey: string;
  urgent?: boolean;
  /** The recipient's zone for quiet hours (recipient-timezone.ts). */
  timeZone: string | null;
}

export type SendOutcome =
  | 'sent'
  | 'no-token'
  | 'invalid-token'
  | 'device-not-registered'
  | 'provider-not-configured'
  | 'rejected'
  | 'transport-timeout'
  | 'transport-error'
  | 'provider-unavailable'
  | 'obsolete'
  | 'lease-expired'
  | 'retry-scheduled'
  | 'burst-deferred'
  | 'quiet-deferred'
  | 'preference-off'
  | 'token-cleanup-pending'
  | 'lease-lost';

interface OutboxRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data: Prisma.JsonValue;
  context: Prisma.JsonValue | null;
  urgent: boolean;
  time_zone: string | null;
  attempts: number;
  lease_token: string;
}

type Db = Pick<PrismaService, 'pushOutbox'> | Prisma.TransactionClient;

const REMINDER_KINDS: ReadonlySet<string> = new Set([
  NotificationKind.BOOKING_REMINDER_24H,
  NotificationKind.BOOKING_REMINDER_1H,
]);

function asContext(v: Prisma.JsonValue | null): PushContext | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  return {
    sessionId: str('sessionId'),
    scheduledAt: str('scheduledAt'),
    newScheduledAt: str('newScheduledAt'),
    oldScheduledAt: str('oldScheduledAt'),
    timeZone: str('timeZone') ?? null,
    otherPartyDisplayName: str('otherPartyDisplayName'),
  };
}

function asData(v: Prisma.JsonValue): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);
  private readonly client: ExpoPushClient;
  private lastProviderAlertAt = Number.NEGATIVE_INFINITY;
  private draining = false;
  private drainAgain = false;
  private receiptSweepRunning = false;
  /** Tests switch the post-enqueue kick off and drive drain() directly. */
  autoDrain = true;
  sendDeadlineMs = SEND_DEADLINE_MS;
  receiptDeadlineMs = RECEIPT_DEADLINE_MS;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(EXPO_PUSH_CLIENT) client?: ExpoPushClient,
  ) {
    this.client = client ?? new FetchExpoPushClient();
  }

  protected now(): Date {
    return new Date();
  }

  /**
   * Queue one device push. Never throws to an emitter for a duplicate; a
   * database error propagates so a caller's transaction rolls back with it.
   */
  async enqueue(push: EnqueuePush, tx?: Prisma.TransactionClient): Promise<EnqueueResult> {
    const db: Db = tx ?? this.prisma;
    const now = this.now();
    const quiet = quietHoursFor({
      kind: push.kind,
      timeZone: push.timeZone,
      context: push.context,
      urgent: push.urgent,
      now,
    });
    // The row keeps only the caller's explicit urgency; quiet hours and the
    // burst cap are re-decided when it is sent (B-648-10).
    const urgent = push.urgent === true;
    const row = {
      user_id: push.userId,
      kind: push.kind,
      dedupe_key: push.dedupeKey ?? null,
      collapse_key: push.collapseKey,
      title: push.title.slice(0, 120),
      body: push.body.slice(0, 160),
      data: { ...push.data, kind: push.kind } as Prisma.InputJsonValue,
      context: (push.context ?? undefined) as Prisma.InputJsonValue | undefined,
      urgent,
      time_zone: usableTimeZone(push.timeZone),
      not_before: quiet.deliverAt,
      deferred_reason: quiet.deferred ? 'quiet_hours' : null,
    };

    const code: EnqueueCode = quiet.deferred ? 'deferred' : 'queued';
    if (push.dedupeKey) {
      const inserted = await db.pushOutbox.createMany({ data: [row], skipDuplicates: true });
      if (inserted.count === 0) return { code: 'duplicate', notBefore: quiet.deliverAt };
    } else {
      const latest = await db.pushOutbox.findFirst({
        where: {
          user_id: push.userId,
          collapse_key: push.collapseKey,
          created_at: { gte: new Date(now.getTime() - RECEIPT_MAX_AGE_MS) },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true, status: true, sent_at: true, not_before: true },
      });
      if (latest && latest.status === 'pending') {
        // Unsent push for the same conversation: it carries the newest copy.
        await db.pushOutbox.updateMany({
          where: { id: latest.id, status: 'pending' },
          data: { title: row.title, body: row.body, data: row.data, context: row.context },
        });
        return { code: 'collapsed', notBefore: latest.not_before };
      }
      if (latest?.sent_at && now.getTime() - latest.sent_at.getTime() < COLLAPSE_WINDOW_MS) {
        return { code: 'collapsed', notBefore: latest.sent_at };
      }
      await db.pushOutbox.create({ data: row });
    }
    // Inside a caller's transaction the row is not visible until it commits;
    // the minute sweep sends it then.
    if (!tx && !quiet.deferred) this.kick();
    return { code, notBefore: quiet.deliverAt };
  }

  /** Start a drain soon, outside the caller's request. */
  kick(): void {
    if (!this.autoDrain) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    setImmediate(() => {
      this.drain().catch((err: unknown) =>
        this.logger.warn(`push drain failed: error=${errorName(err)}`),
      );
    });
  }

  /** Every minute: deferred (quiet hours, burst cap, retry) rows and anything a kick missed. */
  @Cron('* * * * *', { name: 'push-outbox', timeZone: 'UTC' })
  async sweep(): Promise<{ sent: number; expired: number }> {
    const expired = await this.expireLeases();
    const sent = await this.drain();
    return { sent, expired };
  }

  /**
   * Send every due row. Each row is leased just before it is worked on
   * (B-648-8), so a lease never has to outlive a batch. Returns the number
   * whose send was recorded (a lost compare-and-set never counts).
   */
  async drain(maxRows = MAX_ROWS_PER_DRAIN): Promise<number> {
    if (this.draining) {
      this.drainAgain = true;
      return 0;
    }
    this.draining = true;
    let sent = 0;
    try {
      for (let i = 0; i < maxRows; i += 1) {
        const row = await this.claimNext();
        if (!row) break;
        if ((await this.sendOne(row)) === 'sent') sent += 1;
      }
    } finally {
      this.draining = false;
    }
    if (this.drainAgain) {
      this.drainAgain = false;
      this.kick();
    }
    return sent;
  }

  /** Lease the next due row (one row, a fresh lease_token). */
  private async claimNext(): Promise<OutboxRow | null> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    const leaseToken = randomUUID();
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      UPDATE "PushOutbox"
      SET "status" = 'sending', "lease_until" = ${leaseUntil}, "lease_token" = ${leaseToken},
          "handed_off_at" = NULL, "attempts" = "attempts" + 1, "updated_at" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "PushOutbox"
        WHERE "status" = 'pending' AND "not_before" <= ${now}
        ORDER BY "not_before" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "user_id", "kind", "title", "body", "data", "context", "urgent", "time_zone",
                "attempts", "lease_token"`;
    return rows[0] ?? null;
  }

  /**
   * A row still `sending` after its lease (B-648-8):
   *   - never handed to Expo (handed_off_at null): the worker stopped before
   *     sending, so it goes back to pending and its attempt is not counted;
   *   - handed to Expo: Expo may have accepted it, so it is closed as
   *     lease-expired, never re-sent (at most once).
   */
  private async expireLeases(): Promise<number> {
    const now = this.now();
    const released = await this.prisma.pushOutbox.updateMany({
      where: { status: 'sending', lease_until: { lt: now }, handed_off_at: null },
      data: {
        status: 'pending',
        lease_until: null,
        lease_token: null,
        result_code: 'lease-released',
        attempts: { decrement: 1 },
      },
    });
    const closed = await this.prisma.pushOutbox.updateMany({
      where: { status: 'sending', lease_until: { lt: now }, handed_off_at: { not: null } },
      data: { status: 'dropped', result_code: 'lease-expired', lease_until: null },
    });
    if (released.count > 0) {
      this.logger.warn(`push outbox: ${released.count} unstarted lease(s) returned to the queue`);
    }
    if (closed.count > 0) {
      this.logger.warn(`push outbox: ${closed.count} expired in-flight lease(s) closed`);
    }
    return released.count + closed.count;
  }

  /** The fence every worker write uses: this claim, still in flight. */
  private fence(row: OutboxRow): Prisma.PushOutboxWhereInput {
    return { id: row.id, status: 'sending', lease_token: row.lease_token };
  }

  private lost(row: OutboxRow, step: string): SendOutcome {
    this.logger.warn(`push outbox: lease lost row=${row.id} step=${step} (another worker owns it)`);
    return 'lease-lost';
  }

  private async finish(
    row: OutboxRow,
    status: 'sent' | 'dropped',
    code: SendOutcome,
    extra: Prisma.PushOutboxUpdateManyMutationInput = {},
  ): Promise<SendOutcome> {
    const data = { status, result_code: code, lease_until: null, ...extra };
    const res = await this.prisma.pushOutbox.updateMany({ where: this.fence(row), data });
    if (res.count === 1) return code;
    if (status === 'sent') {
      // Expo accepted it, but a sweep closed the row as lease-expired while
      // the call ran. Still this claim's row: record the truth (and the
      // ticket, so its receipt is read). Nobody re-sends a closed row.
      const late = await this.prisma.pushOutbox.updateMany({
        where: {
          id: row.id,
          lease_token: row.lease_token,
          status: 'dropped',
          result_code: 'lease-expired',
        },
        data,
      });
      if (late.count === 1) return code;
    }
    return this.lost(row, `finish:${code}`);
  }

  private async later(
    row: OutboxRow,
    notBefore: Date,
    reason: 'burst_cap' | 'provider_retry' | 'quiet_hours' | 'worker_retry',
    code: SendOutcome,
  ): Promise<SendOutcome> {
    const res = await this.prisma.pushOutbox.updateMany({
      where: this.fence(row),
      data: {
        status: 'pending',
        not_before: notBefore,
        deferred_reason: reason,
        lease_until: null,
        lease_token: null,
        handed_off_at: null,
        result_code: code,
        // Waiting for room or for the morning is not a delivery attempt.
        ...(reason === 'burst_cap' || reason === 'quiet_hours'
          ? { attempts: { decrement: 1 } }
          : {}),
      },
    });
    return res.count === 1 ? code : this.lost(row, `later:${reason}`);
  }

  /**
   * Renew the lease and record the handoff in one CAS, right before the
   * Expo call (B-648-8). False: this worker no longer owns the row.
   */
  private async handOff(row: OutboxRow): Promise<boolean> {
    const now = this.now();
    const res = await this.prisma.pushOutbox.updateMany({
      where: { ...this.fence(row), lease_until: { gt: now } },
      data: { handed_off_at: now, lease_until: new Date(now.getTime() + LEASE_MS) },
    });
    return res.count === 1;
  }

  async sendOne(row: OutboxRow): Promise<SendOutcome> {
    const context = asContext(row.context);
    let handedOff = false;
    try {
      // A reminder that waited (quiet hours, burst cap, retry) is only sent
      // if the session is still scheduled at that time and still ahead.
      if (REMINDER_KINDS.has(row.kind) && context?.sessionId && context.scheduledAt) {
        const session = await this.prisma.coachingSession.findUnique({
          where: { id: context.sessionId },
          select: { status: true, start_at: true },
        });
        const at = new Date(context.scheduledAt).getTime();
        if (
          !session ||
          session.status !== 'scheduled' ||
          session.start_at.getTime() !== at ||
          at <= this.now().getTime()
        ) {
          return await this.finish(row, 'dropped', 'obsolete');
        }
      }

      // B-648-9: the recipient's CURRENT switches, the same rule as enqueue.
      const prefs = await this.prisma.notificationPreferences.findUnique({
        where: { user_id: row.user_id },
      });
      if (!pushAllowedByPreferences(prefs as Record<string, unknown> | null, row.kind)) {
        return await this.finish(row, 'dropped', 'preference-off');
      }

      // B-648-10: quiet hours at the moment of sending, in the recipient's
      // CURRENT zone (falling back to the zone known at enqueue), on a clock
      // read after the awaited reads above (and again at the handoff below).
      const timeZone =
        (await resolveRecipientTimeZone(this.prisma, row.user_id, context?.sessionId)) ??
        usableTimeZone(row.time_zone);
      const quietAt = (now: Date) =>
        quietHoursFor({ kind: row.kind, timeZone, context, urgent: row.urgent, now });
      const quiet = quietAt(this.now());
      if (quiet.deferred) {
        return await this.later(row, quiet.deliverAt, 'quiet_hours', 'quiet-deferred');
      }

      // Exempt from the burst cap: explicit urgency, a quiet-hours bypass,
      // and every booking event (time-critical, never more than a few).
      const capExempt = row.urgent || quiet.reason === 'urgent' || row.kind.startsWith('booking_');
      if (!capExempt) {
        const windowStart = new Date(this.now().getTime() - USER_WINDOW_MS);
        const recent = await this.prisma.pushOutbox.findMany({
          where: { user_id: row.user_id, status: 'sent', sent_at: { gt: windowStart } },
          orderBy: { sent_at: 'asc' },
          select: { sent_at: true },
          take: USER_WINDOW_MAX,
        });
        if (recent.length >= USER_WINDOW_MAX && recent[0].sent_at) {
          const room = new Date(recent[0].sent_at.getTime() + USER_WINDOW_MS);
          return await this.later(row, room, 'burst_cap', 'burst-deferred');
        }
      }

      const user = await this.prisma.user.findUnique({
        where: { id: row.user_id },
        select: { expo_push_token: true },
      });
      const token = user?.expo_push_token ?? null;
      if (!token) return await this.finish(row, 'dropped', 'no-token');
      if (!Expo.isExpoPushToken(token)) {
        this.logger.warn(
          `push skipped: user=${row.user_id} has a token that is not an Expo push token`,
        );
        return await this.finish(row, 'dropped', 'invalid-token');
      }

      // B-648-8: prove and renew authority right before the handoff.
      if (!(await this.handOff(row))) return this.lost(row, 'handoff');

      // Sol B-648-9 (round 5): consent at the handoff. These reads start
      // after the handoff write, so a mute, a switch turned off or a sign-out
      // committed during the slow reads above is seen here. Nothing has
      // reached Expo yet: the push is suppressed and no attempt is spent.
      const [prefsAtSend, userAtSend] = await Promise.all([
        this.prisma.notificationPreferences.findUnique({ where: { user_id: row.user_id } }),
        this.prisma.user.findUnique({
          where: { id: row.user_id },
          select: { expo_push_token: true },
        }),
      ]);
      if (!pushAllowedByPreferences(prefsAtSend as Record<string, unknown> | null, row.kind)) {
        return await this.finish(row, 'dropped', 'preference-off');
      }
      const to = userAtSend?.expo_push_token ?? null;
      if (!to) return await this.finish(row, 'dropped', 'no-token');
      if (!Expo.isExpoPushToken(to)) return await this.finish(row, 'dropped', 'invalid-token');

      // B-648-10 (round 4): the clock at the Expo handoff. If the window
      // opened during the reads or the handoff write, nothing has reached
      // Expo yet: back to pending for the morning, attempt refunded.
      const sendAt = this.now();
      const atSend = quietAt(sendAt);
      if (atSend.deferred) {
        return await this.later(row, atSend.deliverAt, 'quiet_hours', 'quiet-deferred');
      }
      handedOff = true;

      // B-692-1: the lock screen shows only the kind's template, whatever
      // text the row holds.
      const copy = lockScreenCopy(
        row.kind,
        row.body,
        context ? { ...context, timeZone: timeZone ?? context.timeZone } : null,
        sendAt,
      );
      const message: ExpoPushMessage = {
        to,
        title: copy.title,
        body: copy.body,
        data: { ...asData(row.data), kind: row.kind },
        sound: 'default',
        channelId: androidChannelFor(row.kind),
        priority: 'high',
      };

      let ticket: ExpoPushTicket | undefined;
      const deadline = deadlineSignal(this.sendDeadlineMs);
      try {
        ticket = (await this.client.send([message], deadline.signal))[0];
      } catch (err) {
        return await this.transportFailure(row, err, deadline.signal.aborted);
      } finally {
        deadline.clear();
      }

      if (!ticket) {
        this.logger.warn(`push rejected: user=${row.user_id} kind=${row.kind} reason=no-ticket`);
        return await this.finish(row, 'dropped', 'rejected');
      }
      if (ticket.status === 'ok') {
        return await this.finish(row, 'sent', 'sent', {
          ticket_id: ticket.id,
          token: to,
          sent_at: sendAt,
        });
      }
      const error = ticket.details?.error;
      if (error === 'MessageRateExceeded') {
        return await this.retryOrDrop(row, 'provider-unavailable');
      }
      // A failed token clear is recorded as token-cleanup-pending, which the
      // receipt sweep retries (B-693-2); the push itself is never re-sent.
      const code = await this.handleError(error, row.user_id, to, 'ticket');
      return await this.finish(row, 'dropped', code, { token: to });
    } catch (err) {
      this.logger.warn(
        `push send failed: row=${row.id} user=${row.user_id} kind=${row.kind} error=${errorName(err)}`,
      );
      try {
        // Before the handoff nothing reached Expo: a database hiccup gets a
        // bounded retry instead of losing the push. After it, delivery is
        // unknown, so the row is closed (at most once).
        if (!handedOff && row.attempts < MAX_ATTEMPTS) {
          const wait = RETRY_BACKOFF_MS[Math.min(row.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
          return await this.later(
            row,
            new Date(this.now().getTime() + wait),
            'worker_retry',
            'retry-scheduled',
          );
        }
        return await this.finish(row, 'dropped', 'transport-error');
      } catch {
        // The lease lapses; expireLeases() returns an unstarted row to the
        // queue and closes a handed-off one.
        return 'transport-error';
      }
    }
  }

  private async transportFailure(
    row: OutboxRow,
    err: unknown,
    timedOut: boolean,
  ): Promise<SendOutcome> {
    if (err instanceof ExpoHttpError && err.retryable) {
      return this.retryOrDrop(row, 'provider-unavailable');
    }
    if (err instanceof ExpoHttpError) {
      this.logger.warn(
        `push rejected by Expo: user=${row.user_id} kind=${row.kind} status=${err.status} code=${err.code ?? 'none'}`,
      );
      return this.finish(row, 'dropped', 'rejected');
    }
    // Timeout or network failure: Expo may have accepted the message, so it
    // is not sent again (at most once).
    const code: SendOutcome = timedOut ? 'transport-timeout' : 'transport-error';
    this.logger.warn(
      `push ${code}: user=${row.user_id} kind=${row.kind} error=${errorName(err)} (not retried: delivery unknown)`,
    );
    return this.finish(row, 'dropped', code);
  }

  private async retryOrDrop(row: OutboxRow, code: SendOutcome): Promise<SendOutcome> {
    if (row.attempts >= MAX_ATTEMPTS) {
      this.logger.warn(
        `push dropped after ${row.attempts} attempts: user=${row.user_id} kind=${row.kind} reason=${code}`,
      );
      return this.finish(row, 'dropped', code);
    }
    const wait = RETRY_BACKOFF_MS[Math.min(row.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    await this.later(
      row,
      new Date(this.now().getTime() + wait),
      'provider_retry',
      'retry-scheduled',
    );
    return 'retry-scheduled';
  }

  /** Every 5 minutes: read receipts 2+ minutes after the send, and prune old rows. */
  @Cron('*/5 * * * *', { name: 'push-receipts', timeZone: 'UTC' })
  async checkReceipts(): Promise<{ checked: number; remaining: number }> {
    if (this.receiptSweepRunning) return { checked: 0, remaining: 0 };
    this.receiptSweepRunning = true;
    try {
      const now = this.now();
      // B-693-2: clears that failed earlier (ticket or receipt) come first.
      const cleaned = await this.retryTokenCleanup();
      let checked = 0;
      const due = await this.prisma.pushOutbox.findMany({
        where: {
          status: 'sent',
          receipt_checked_at: null,
          ticket_id: { not: null },
          sent_at: {
            lte: new Date(now.getTime() - RECEIPT_MIN_AGE_MS),
            gte: new Date(now.getTime() - RECEIPT_MAX_AGE_MS),
          },
        },
        orderBy: { sent_at: 'asc' },
        take: EXPO_RECEIPT_CHUNK,
        select: { id: true, user_id: true, ticket_id: true, token: true },
      });
      if (due.length > 0) {
        const byTicket = new Map(due.map((r) => [r.ticket_id ?? '', r]));
        const deadline = deadlineSignal(this.receiptDeadlineMs);
        let receipts: Awaited<ReturnType<ExpoPushClient['getReceipts']>> = {};
        try {
          receipts = await this.client.getReceipts([...byTicket.keys()], deadline.signal);
        } catch (err) {
          // Not settled: the rows stay due and the next sweep asks again.
          this.logger.warn(
            `push receipts fetch failed: error=${errorName(err)}${deadline.signal.aborted ? ' (deadline)' : ''}`,
          );
        } finally {
          deadline.clear();
        }
        for (const [ticketId, receipt] of Object.entries(receipts)) {
          const entry = byTicket.get(ticketId);
          if (!entry) continue;
          let code: string = 'delivered-to-provider';
          if (receipt.status === 'error') {
            code = entry.token
              ? await this.handleError(
                  receipt.details?.error,
                  entry.user_id,
                  entry.token,
                  'receipt',
                )
              : 'rejected';
          }
          // Another replica may have read the same receipt: count only ours.
          // B-693-2: when the token clear failed the receipt is read but the
          // row stays token-cleanup-pending, unsettled and not counted, until
          // retryTokenCleanup clears the token on a later sweep.
          const res = await this.prisma.pushOutbox.updateMany({
            where: { id: entry.id, receipt_checked_at: null },
            data: { receipt_checked_at: now, result_code: code },
          });
          if (res.count === 1 && code !== CLEANUP_PENDING) checked += 1;
        }
      }
      await this.prisma.pushOutbox.deleteMany({
        where: {
          status: { in: ['sent', 'dropped'] },
          not_before: { lt: new Date(now.getTime() - RETENTION_MS) },
        },
      });
      return { checked: checked + cleaned, remaining: due.length - checked };
    } finally {
      this.receiptSweepRunning = false;
    }
  }

  private async handleError(
    error: string | undefined,
    userId: string,
    token: string,
    stage: 'ticket' | 'receipt',
  ): Promise<SendOutcome> {
    if (error === 'DeviceNotRegistered') {
      return (await this.clearToken(userId, token)) ? 'device-not-registered' : CLEANUP_PENDING;
    }
    if (error === 'InvalidCredentials') {
      this.alertProviderNotConfigured();
      return 'provider-not-configured';
    }
    this.logger.warn(
      `push ${stage} error: user=${userId} error=${error ?? 'unknown'} (dropped, not retried)`,
    );
    return 'rejected';
  }

  /**
   * Clear the token Expo rejected, only if it is still the user's token (a
   * newer registration stays). True once that is proven: cleared now, or the
   * user no longer holds it. False when the write failed (B-693-2).
   */
  private async clearToken(userId: string, token: string): Promise<boolean> {
    try {
      const res = await this.prisma.user.updateMany({
        where: { id: userId, expo_push_token: token },
        data: { expo_push_token: null },
      });
      if (res.count > 0) {
        this.logger.log(`push token cleared: user=${userId} reason=DeviceNotRegistered`);
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `push token clear failed: user=${userId} error=${errorName(err)} (retried by the receipt sweep)`,
      );
      return false;
    }
  }

  /**
   * B-693-2: retry the token clears that failed (rows marked
   * token-cleanup-pending at the ticket or the receipt). Only the clear is
   * retried, never the push. A row is settled (device-not-registered,
   * receipt read) once its clear succeeds; returns how many this sweep
   * settled (a row another replica settled first is not counted).
   */
  private async retryTokenCleanup(): Promise<number> {
    const pending = await this.prisma.pushOutbox.findMany({
      where: { result_code: CLEANUP_PENDING, token: { not: null } },
      orderBy: { updated_at: 'asc' },
      take: TOKEN_CLEANUP_BATCH,
      select: { id: true, user_id: true, token: true },
    });
    let settled = 0;
    for (const row of pending) {
      if (!row.token || !(await this.clearToken(row.user_id, row.token))) continue;
      const res = await this.prisma.pushOutbox.updateMany({
        where: { id: row.id, result_code: CLEANUP_PENDING },
        data: { result_code: 'device-not-registered' },
      });
      if (res.count === 1) settled += 1;
    }
    return settled;
  }

  private alertProviderNotConfigured(): void {
    const now = this.now().getTime();
    if (now - this.lastProviderAlertAt < PROVIDER_ALERT_INTERVAL_MS) return;
    this.lastProviderAlertAt = now;
    this.logger.error(
      'PUSH_PROVIDER_NOT_CONFIGURED: Expo answered InvalidCredentials, so pushes to these devices (Android until the ' +
        'FCM V1 key is uploaded) are not delivered and are recorded as provider-not-configured. Fix: upload the FCM V1 ' +
        'service-account key in Expo (eas credentials -> Android -> Push Notifications: FCM V1). iOS delivery is not ' +
        'affected. This line repeats at most once an hour.',
    );
  }
}
