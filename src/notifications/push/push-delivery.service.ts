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
import { quietHoursFor } from './push-quiet-hours';

// Device delivery for inbox notifications (C-643-2), through a durable
// outbox (B-NOTIF-5: B-648-1, B-648-6, C-648-4 / OR-113-5, C-648-5).
//
// enqueue() writes one PushOutbox row (inside the caller's transaction when
// it has one) and returns. Nothing in a request waits on Expo. The worker
// (drain) leases due rows with FOR UPDATE SKIP LOCKED, so any number of
// replicas send each row once, and calls Expo with a cancelling deadline.
//
// Guarantees:
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
//     only if it is still that exact token.
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
export const BATCH_SIZE = 50;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

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
  | 'burst-deferred';

interface OutboxRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data: Prisma.JsonValue;
  context: Prisma.JsonValue | null;
  urgent: boolean;
  attempts: number;
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
    // Exempt from the burst cap: explicit urgency, a quiet-hours bypass, and
    // every booking event (time-critical by nature, never more than a few).
    const urgent =
      push.urgent === true || quiet.reason === 'urgent' || push.kind.startsWith('booking_');
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

  /** Send every due row, in leased batches. Returns the number sent. */
  async drain(maxBatches = 20): Promise<number> {
    if (this.draining) {
      this.drainAgain = true;
      return 0;
    }
    this.draining = true;
    let sent = 0;
    try {
      for (let i = 0; i < maxBatches; i += 1) {
        const rows = await this.claimBatch();
        if (rows.length === 0) break;
        for (const row of rows) {
          if ((await this.sendOne(row)) === 'sent') sent += 1;
        }
        if (rows.length < BATCH_SIZE) break;
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

  private async claimBatch(): Promise<OutboxRow[]> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return this.prisma.$queryRaw<OutboxRow[]>`
      UPDATE "PushOutbox"
      SET "status" = 'sending', "lease_until" = ${leaseUntil}, "attempts" = "attempts" + 1, "updated_at" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "PushOutbox"
        WHERE "status" = 'pending' AND "not_before" <= ${now}
        ORDER BY "not_before" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "user_id", "kind", "title", "body", "data", "context", "urgent", "attempts"`;
  }

  /**
   * A row still `sending` after its lease belongs to a process that died
   * mid-send. Expo may have accepted it, so it is closed, never re-sent.
   */
  private async expireLeases(): Promise<number> {
    const now = this.now();
    const res = await this.prisma.pushOutbox.updateMany({
      where: { status: 'sending', lease_until: { lt: now } },
      data: { status: 'dropped', result_code: 'lease-expired', lease_until: null },
    });
    if (res.count > 0) this.logger.warn(`push outbox: ${res.count} expired lease(s) closed`);
    return res.count;
  }

  private async finish(
    row: OutboxRow,
    status: 'sent' | 'dropped',
    code: SendOutcome,
    extra: Prisma.PushOutboxUpdateManyMutationInput = {},
  ): Promise<SendOutcome> {
    await this.prisma.pushOutbox.updateMany({
      where: { id: row.id, status: 'sending' },
      data: { status, result_code: code, lease_until: null, ...extra },
    });
    return code;
  }

  private async later(
    row: OutboxRow,
    notBefore: Date,
    reason: 'burst_cap' | 'provider_retry',
    code: SendOutcome,
  ): Promise<SendOutcome> {
    await this.prisma.pushOutbox.updateMany({
      where: { id: row.id, status: 'sending' },
      data: {
        status: 'pending',
        not_before: notBefore,
        deferred_reason: reason,
        lease_until: null,
        result_code: code,
        ...(reason === 'burst_cap' ? { attempts: { decrement: 1 } } : {}),
      },
    });
    return code;
  }

  async sendOne(row: OutboxRow): Promise<SendOutcome> {
    const now = this.now();
    const context = asContext(row.context);
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
          at <= now.getTime()
        ) {
          return await this.finish(row, 'dropped', 'obsolete');
        }
      }

      if (!row.urgent) {
        const windowStart = new Date(now.getTime() - USER_WINDOW_MS);
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

      const copy = context
        ? lockScreenCopy(row.kind, row.body, context, now)
        : { title: row.title, body: row.body };
      const message: ExpoPushMessage = {
        to: token,
        title: copy.title || row.title,
        body: copy.body || row.body,
        data: { ...asData(row.data), kind: row.kind },
        sound: 'default',
        channelId: 'default',
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
          token,
          sent_at: now,
        });
      }
      const error = ticket.details?.error;
      if (error === 'MessageRateExceeded') {
        return await this.retryOrDrop(row, 'provider-unavailable');
      }
      const code = await this.handleError(error, row.user_id, token, 'ticket');
      return await this.finish(row, 'dropped', code, { token });
    } catch (err) {
      this.logger.warn(
        `push send failed: row=${row.id} user=${row.user_id} kind=${row.kind} error=${errorName(err)}`,
      );
      try {
        return await this.finish(row, 'dropped', 'transport-error');
      } catch {
        // The lease expires and expireLeases() closes the row.
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
      let checked = 0;
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
          await this.prisma.pushOutbox.updateMany({
            where: { id: entry.id },
            data: { receipt_checked_at: now, result_code: code },
          });
          checked += 1;
        }
      }
      await this.prisma.pushOutbox.deleteMany({
        where: {
          status: { in: ['sent', 'dropped'] },
          not_before: { lt: new Date(now.getTime() - RETENTION_MS) },
        },
      });
      return { checked, remaining: due.length - checked };
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
      await this.clearToken(userId, token);
      return 'device-not-registered';
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

  private async clearToken(userId: string, token: string): Promise<void> {
    try {
      // Only the token Expo rejected: a newer registration stays.
      await this.prisma.user.updateMany({
        where: { id: userId, expo_push_token: token },
        data: { expo_push_token: null },
      });
      this.logger.log(`push token cleared: user=${userId} reason=DeviceNotRegistered`);
    } catch (err) {
      this.logger.warn(`push token clear failed: user=${userId} error=${errorName(err)}`);
    }
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
