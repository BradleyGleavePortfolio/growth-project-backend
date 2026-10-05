import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { CoachingSession } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { AuditService } from '../../audit/audit.service';
import {
  BookingEmitter,
  inAppSettled,
  pushSettled,
  type BookingDeliveryOutcome,
} from '../../notifications/emitters/booking.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { PrismaService } from '../../prisma.service';
import { SchedulingOpenSlotsService } from '../scheduling-open-slots.service';
import { REQUEST_EXPIRED_END_REASON } from '../scheduling.types';
import { auditExpired, expireRequest, type LapsedRow } from '../request-expiry';
import { describeError } from './reminder.job';
import { SchedulingJobLeaseService } from './scheduling-job-lease.service';

// S-SCHED-5 auto-expiry sweep (OR-112-5). Every 5 minutes, on one machine
// (SchedulingJobLease "booking-request-expiry"):
//
//  1. Expire: every `requested` row whose request_expires_at has passed is
//     closed as `expired` by compare-and-set (src/scheduling/request-expiry.ts).
//     The exclusion constraint no longer counts it, so the slot is free. One
//     audit row per closed request (system actor). Keyset-paged over the
//     whole backlog (bounded pages per tick; the rest is next tick's work).
//  2. Recover (runs before 3): notice rows left `retry`, or `sending` with an
//     expired lease (a worker died), are re-sent for the channel that did not
//     land, at most NOTICE_MAX_ATTEMPTS times, then `gave_up` with a safe
//     last_error.
//  3. Notify: each request closed in the last NOTICE_FRESH_HOURS (by this
//     sweep or by a booking transaction) that has no notice rows yet gets one
//     calm notice per side (client and coach), claimed first as
//     NotificationDeliveryLog rows (kind booking_request_expired, unique per
//     session+user+kind) in one transaction, so two runners or a retry can
//     never notify twice. Older closures (a sweep outage, or pending requests
//     from before this feature whose time passed long ago) close quietly.
//
// Idempotent end to end: re-running a tick changes nothing that is already
// done; every write is conditional on the state it read.

export const REQUEST_EXPIRY_LEASE_NAME = 'booking-request-expiry';
export const REQUEST_EXPIRY_LEASE_TTL_MS = 4 * 60_000;
export const REQUEST_EXPIRY_PAGE = 200;
/** Pages of the expire pass per tick (the lease is 4 minutes). */
export const REQUEST_EXPIRY_MAX_PAGES = 10;
/** A closed request is announced only while its clear time is this recent. */
export const REQUEST_EXPIRY_NOTICE_FRESH_HOURS = 24;
export const REQUEST_EXPIRY_NOTICE_LEASE_MS = 4 * 60_000;
export const REQUEST_EXPIRY_NOTICE_MAX_ATTEMPTS = 3;

export interface RequestExpirySweepResult {
  lease: 'acquired' | 'held';
  expired: number;
  notified: number;
  retrying: number;
  gave_up: number;
  recovered: number;
  failed: number;
}

interface NoticeRow {
  id: string;
  session_id: string;
  user_id: string;
  status: string;
  attempts: number;
  claim_token: string | null;
  lease_until: Date | null;
  inapp_done_at: Date | null;
  push_done_at: Date | null;
  notification_id: string | null;
}

@Injectable()
export class BookingRequestExpiryJob {
  private readonly logger = new Logger(BookingRequestExpiryJob.name);
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingEmitter: BookingEmitter,
    private readonly audit: AuditService,
    private readonly lease: SchedulingJobLeaseService,
    @Optional() private readonly openSlots?: SchedulingOpenSlotsService,
  ) {}

  @Cron('*/5 * * * *', { name: 'booking-request-expiry', timeZone: 'UTC' })
  async runScheduledSweep(): Promise<void> {
    try {
      const res = await this.sweep();
      if (res.lease === 'acquired' && (res.expired || res.notified || res.failed || res.gave_up)) {
        this.logger.log(
          `request expiry: expired=${res.expired} notified=${res.notified} retrying=${res.retrying} gave_up=${res.gave_up} failed=${res.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(`request expiry sweep failed: ${describeError(err)}`);
    }
  }

  async sweep(now: Date = new Date()): Promise<RequestExpirySweepResult> {
    const result: RequestExpirySweepResult = {
      lease: 'held',
      expired: 0,
      notified: 0,
      retrying: 0,
      gave_up: 0,
      recovered: 0,
      failed: 0,
    };
    const lease = await this.lease.tryAcquire(
      REQUEST_EXPIRY_LEASE_NAME,
      this.holder,
      REQUEST_EXPIRY_LEASE_TTL_MS,
      now,
    );
    if (!lease.acquired) return result;
    result.lease = 'acquired';
    try {
      await this.expirePass(now, result);
      // Recovery before new notices: a notice that failed in this tick waits
      // for the next one instead of being retried at once.
      await this.recoveryPass(now, result);
      await this.noticePass(now, result);
    } finally {
      try {
        await this.lease.release(REQUEST_EXPIRY_LEASE_NAME, this.holder);
      } catch (err) {
        this.logger.warn(`request expiry lease release failed: ${describeError(err)}`);
      }
    }
    return result;
  }

  // 1. ───────────────────────────────────────────────────────────────────
  private async expirePass(now: Date, result: RequestExpirySweepResult): Promise<void> {
    let cursor: { at: Date; id: string } | null = null;
    for (let page = 0; page < REQUEST_EXPIRY_MAX_PAGES; page++) {
      const rows: LapsedRow[] = await this.prisma.coachingSession.findMany({
        where: {
          status: 'requested',
          request_expires_at: { lte: now },
          ...(cursor
            ? {
                OR: [
                  { request_expires_at: { gt: cursor.at } },
                  { request_expires_at: cursor.at, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ request_expires_at: 'asc' }, { id: 'asc' }],
        take: REQUEST_EXPIRY_PAGE,
        select: {
          id: true,
          coach_id: true,
          client_id: true,
          start_at: true,
          end_at: true,
          request_expires_at: true,
        },
      });
      if (rows.length === 0) return;
      const last = rows[rows.length - 1];
      cursor = { at: last.request_expires_at ?? now, id: last.id };
      const closed: LapsedRow[] = [];
      for (const row of rows) {
        try {
          if (await expireRequest(this.prisma, row, now)) closed.push(row);
        } catch (err) {
          result.failed += 1;
          this.logger.warn(`request expiry write failed: session=${row.id} ${describeError(err)}`);
        }
      }
      result.expired += closed.length;
      for (const coachId of new Set(closed.map((r) => r.coach_id))) {
        this.openSlots?.invalidateCoach(coachId);
      }
      try {
        await auditExpired(this.audit, closed, 'sweep');
      } catch (err) {
        this.logger.warn(`request expiry audit failed: ${describeError(err)}`);
      }
      if (rows.length < REQUEST_EXPIRY_PAGE) return;
    }
  }

  // 3. ───────────────────────────────────────────────────────────────────
  private async noticePass(now: Date, result: RequestExpirySweepResult): Promise<void> {
    const since = new Date(now.getTime() - REQUEST_EXPIRY_NOTICE_FRESH_HOURS * 3_600_000);
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const page: CoachingSession[] = await this.prisma.coachingSession.findMany({
        where: {
          status: 'expired',
          end_reason: REQUEST_EXPIRED_END_REASON,
          request_expires_at: { gte: since, lte: now },
          ...(cursor
            ? {
                OR: [
                  { request_expires_at: { gt: cursor.at } },
                  { request_expires_at: cursor.at, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ request_expires_at: 'asc' }, { id: 'asc' }],
        take: REQUEST_EXPIRY_PAGE,
      });
      if (page.length === 0) return;
      const last = page[page.length - 1];
      cursor = { at: last.request_expires_at ?? now, id: last.id };
      const logs = await this.prisma.notificationDeliveryLog.findMany({
        where: {
          kind: NotificationKind.BOOKING_REQUEST_EXPIRED,
          session_id: { in: page.map((s) => s.id) },
        },
        select: { session_id: true },
      });
      const announced = new Set(logs.map((l) => l.session_id));
      for (const session of page) {
        if (announced.has(session.id)) continue;
        const claims = await this.claimNotices(session, now, result);
        for (const claim of claims) await this.deliver(session, claim, now, result);
      }
      if (page.length < REQUEST_EXPIRY_PAGE) return;
    }
  }

  // Both sides' notice rows in one transaction: all or none.
  private async claimNotices(
    session: CoachingSession,
    now: Date,
    result: RequestExpirySweepResult,
  ): Promise<NoticeRow[]> {
    const recipients = [session.client_id, session.coach_id].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    const token = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows: NoticeRow[] = [];
        for (const userId of recipients) {
          const row = await tx.notificationDeliveryLog.create({
            data: {
              session_id: session.id,
              user_id: userId,
              kind: NotificationKind.BOOKING_REQUEST_EXPIRED,
              status: 'sending',
              attempts: 1,
              lease_until: new Date(now.getTime() + REQUEST_EXPIRY_NOTICE_LEASE_MS),
              claim_token: token,
              start_at: session.start_at,
            },
          });
          rows.push(row);
        }
        return rows;
      });
    } catch (err) {
      // P2002: another runner claimed these notices first. Anything else is
      // a failed claim; the session stays unannounced and is retried next tick.
      if ((err as { code?: unknown })?.code !== 'P2002') {
        result.failed += 1;
        this.logger.warn(
          `request expiry notice claim failed: session=${session.id} ${describeError(err)}`,
        );
      }
      return [];
    }
  }

  private async deliver(
    session: CoachingSession,
    claim: NoticeRow,
    now: Date,
    result: RequestExpirySweepResult,
  ): Promise<void> {
    const isClient = claim.user_id === session.client_id;
    const otherId = isClient ? session.coach_id : session.client_id;
    let outcome: BookingDeliveryOutcome;
    try {
      const [otherName, typeName] = await Promise.all([
        this.displayName(otherId, isClient ? 'Your coach' : 'Your client'),
        this.typeName(session.session_type_id),
      ]);
      outcome = await this.bookingEmitter.emitRequestExpired({
        recipientUserId: claim.user_id,
        recipientRole: isClient ? 'client' : 'coach',
        otherPartyDisplayName: otherName,
        sessionId: session.id,
        sessionTypeName: typeName,
        scheduledAt: session.start_at,
        skipInApp: claim.inapp_done_at !== null,
        skipPush: claim.push_done_at !== null,
        notificationId: claim.notification_id,
      });
    } catch (err) {
      this.logger.warn(`request expiry notice failed: session=${session.id} ${describeError(err)}`);
      outcome = { inapp: 'failed', push: 'failed', notificationId: claim.notification_id };
    }
    const inappOk = claim.inapp_done_at !== null || inAppSettled(outcome.inapp);
    const pushOk = claim.push_done_at !== null || pushSettled(outcome.push);
    const state: 'sent' | 'retry' | 'gave_up' =
      inappOk && pushOk
        ? 'sent'
        : claim.attempts >= REQUEST_EXPIRY_NOTICE_MAX_ATTEMPTS
          ? 'gave_up'
          : 'retry';
    try {
      await this.prisma.notificationDeliveryLog.updateMany({
        where: { id: claim.id, claim_token: claim.claim_token },
        data: {
          status: state,
          lease_until: null,
          inapp_done_at: claim.inapp_done_at ?? (inAppSettled(outcome.inapp) ? now : null),
          push_done_at: claim.push_done_at ?? (pushSettled(outcome.push) ? now : null),
          notification_id: outcome.notificationId ?? claim.notification_id,
          last_error:
            state === 'sent' ? null : `inapp:${outcome.inapp}/push:${outcome.push}`.slice(0, 120),
        },
      });
    } catch (err) {
      result.failed += 1;
      this.logger.warn(
        `request expiry notice settle failed: row=${claim.id} ${describeError(err)}`,
      );
      return;
    }
    if (state === 'sent') result.notified += 1;
    else if (state === 'retry') result.retrying += 1;
    else result.gave_up += 1;
  }

  // 2. ───────────────────────────────────────────────────────────────────
  private async recoveryPass(now: Date, result: RequestExpirySweepResult): Promise<void> {
    const rows: NoticeRow[] = await this.prisma.notificationDeliveryLog.findMany({
      where: {
        kind: NotificationKind.BOOKING_REQUEST_EXPIRED,
        OR: [
          { status: 'retry' },
          { status: 'sending', OR: [{ lease_until: null }, { lease_until: { lt: now } }] },
        ],
      },
      orderBy: { created_at: 'asc' },
      take: REQUEST_EXPIRY_PAGE,
    });
    if (rows.length === 0) return;
    const sessions = await this.prisma.coachingSession.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.session_id))] } },
    });
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const row of rows) {
      const session = byId.get(row.session_id);
      const exhausted = row.attempts >= REQUEST_EXPIRY_NOTICE_MAX_ATTEMPTS;
      const gone = !session || session.status !== 'expired';
      if (exhausted || gone) {
        const reason = gone ? 'session_changed' : 'attempts_exhausted';
        const closed = await this.prisma.notificationDeliveryLog.updateMany({
          where: {
            id: row.id,
            status: row.status,
            attempts: row.attempts,
            claim_token: row.claim_token,
          },
          data: { status: 'gave_up', lease_until: null, last_error: `retired:${reason}` },
        });
        if (closed.count === 1) result.gave_up += 1;
        continue;
      }
      const token = randomUUID();
      const taken = await this.prisma.notificationDeliveryLog.updateMany({
        where: {
          id: row.id,
          status: row.status,
          attempts: row.attempts,
          claim_token: row.claim_token,
        },
        data: {
          status: 'sending',
          attempts: row.attempts + 1,
          claim_token: token,
          lease_until: new Date(now.getTime() + REQUEST_EXPIRY_NOTICE_LEASE_MS),
        },
      });
      if (taken.count !== 1) continue;
      result.recovered += 1;
      await this.deliver(
        session,
        { ...row, attempts: row.attempts + 1, claim_token: token },
        now,
        result,
      );
    }
  }

  private async displayName(userId: string | null, fallback: string): Promise<string> {
    if (!userId) return fallback;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const name = typeof u?.name === 'string' ? u.name.trim() : '';
    return name || fallback;
  }

  private async typeName(sessionTypeId: string | null): Promise<string | null> {
    if (!sessionTypeId) return null;
    const t = await this.prisma.sessionType.findUnique({
      where: { id: sessionTypeId },
      select: { name: true },
    });
    return t?.name ?? null;
  }
}
