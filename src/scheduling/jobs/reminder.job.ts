import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoachingSession, SessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  BookingEmitter,
  inAppSettled,
  pushSettled,
} from '../../notifications/emitters/booking.emitter';
import type { BookingDeliveryOutcome } from '../../notifications/emitters/booking.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { PrismaService } from '../../prisma.service';
import { hasUsableLink } from '../scheduling.types';

// Per-recipient context the sweep hands to the emitter (S-SCHED-2): which
// side of the session the recipient is on (wording + tap target), the
// appointment type name, and whether the call link exists yet.
export interface ReminderRecipientContext {
  recipientRole: 'client' | 'coach';
  sessionTypeName: string | null;
  hasMeetingLink: boolean;
  /** S-SCHED-3 retry: channels an earlier attempt already delivered. */
  skipInApp?: boolean;
  skipPush?: boolean;
  notificationId?: string | null;
}

export interface ReminderSweepResult {
  scanned: number;
  /** Recipients whose reminder is now fully delivered (or settled by preference). */
  dispatched: number;
  /** Already delivered, owned by another replica, or the session changed. */
  skipped: number;
  /** A channel failed; the next sweep re-sends only that channel. */
  retrying: number;
  /** Claim could not be written, or attempts ran out. */
  failed: number;
  /**
   * S-SCHED-4 (B-634-2): sessions picked up from unfinished delivery work
   * after they left this sweep's due band (a retry or a dead worker's claim
   * from an earlier tick).
   */
  recovered: number;
  /** Unfinished delivery rows closed as gave_up because they can never be sent. */
  retired: number;
}

// S-SCHED-3 (B-634-2) delivery-claim tuning. The lease is shorter than the
// 5-minute 1h cron so a worker that died after claiming is picked up by the
// next sweep, and far longer than one delivery (push has its own timeout).
export const REMINDER_CLAIM_LEASE_MS = 4 * 60_000;
export const REMINDER_MAX_ATTEMPTS = 3;
// S-SCHED-4 (B-634-2): unfinished delivery rows read per sweep for
// recovery. Unfinished rows are only those whose last attempt failed or
// whose worker died, so this bounds the read, not the work: a larger
// backlog drains over the following ticks (oldest first).
export const REMINDER_RECOVERY_BATCH = 200;
// The 24h reminder says "tomorrow at <time>". Once the 1h reminder band has
// been reached, the 24h reminder is superseded and is retired, not sent late.
export const REMINDER_24H_RECOVERY_MIN_LEAD_MINUTES = 65;
const REMINDABLE_STATUSES: readonly SessionStatus[] = ['scheduled', 'pending_provider'];

interface ReminderClaim {
  id: string;
  token: string;
  attempts: number;
  inappDone: boolean;
  pushDone: boolean;
  notificationId: string | null;
  /** True when this claim inserted the row (nothing recorded before it). */
  fresh: boolean;
}

// Why an unfinished delivery row was closed without sending (last_error).
type RetireReason =
  | 'session_cancelled'
  | 'session_started'
  | 'superseded'
  | 'recipient_changed'
  | 'attempts_exhausted';

interface DeliveryLogRow {
  id: string;
  session_id?: string;
  user_id?: string;
  status: string;
  attempts: number;
  lease_until: Date | null;
  claim_token: string | null;
  session_start_at: Date | null;
  inapp_done_at: Date | null;
  push_done_at: Date | null;
  notification_id: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

function reminderContext(ctx: ReminderRecipientContext | undefined): {
  recipientRole?: 'client' | 'coach';
  sessionTypeName?: string | null;
  hasMeetingLink?: boolean;
  skipInApp?: boolean;
  skipPush?: boolean;
  notificationId?: string | null;
} {
  if (!ctx) return {};
  return {
    recipientRole: ctx.recipientRole,
    sessionTypeName: ctx.sessionTypeName,
    hasMeetingLink: ctx.hasMeetingLink,
    skipInApp: ctx.skipInApp,
    skipPush: ctx.skipPush,
    notificationId: ctx.notificationId,
  };
}

// Session reminder sweep. Two cron handlers:
//
//   1h reminder  — runs every 5 minutes, sweeps [now+55m, now+65m].
//   24h reminder — runs every 15 minutes, sweeps [now+23h45m, now+24h15m].
//
// Idempotency and recovery (S-SCHED-3 B-634-2): every fan-out claims a
// NotificationDeliveryLog row keyed (session_id, user_id, kind) with a lease,
// a claim token and the session start it is for, then records which
// channels landed. Two replicas never both send (the unique key plus a
// compare-and-set takeover); a transient failure or a worker that died
// after claiming is retried by the next sweep, re-sending only the channel
// that did not land; only P2002 counts as "already claimed".
//
// The sweeps are deliberately wider than the cron interval so a missed
// tick from a redeploy still catches every session.
//
// Recovery is not tied to the band (S-SCHED-4 B-634-2): each sweep also
// reads its kind's unfinished rows ('retry', or 'sending' with an expired
// lease) directly, so work claimed at the band's last tick is retried after
// the session has left the band, while it is still upcoming. Rows that can
// never be sent correctly are closed as 'gave_up' with a retired:<reason>.
//
// Status filter: confirmed sessions only (`scheduled`, and
// `pending_provider` which is confirmed but waiting on a call link).
// Terminal statuses and unapproved `requested` sessions are skipped; the
// test suite asserts this.
//
// Delivery (S-SCHED-2): BookingEmitter writes the in-app row and sends a
// real push through NotificationsService.pushToUser. A reschedule clears the
// session's reminder claims so the new time is reminded again. When the
// session has no call link, the coach's reminder asks them to add one and
// the client's says the coach will add it.
//
// The reminder body always names the OTHER party: clients see "session
// with $coach", coaches see "session with $client".

@Injectable()
export class SessionReminderJob {
  private readonly logger = new Logger(SessionReminderJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingEmitter: BookingEmitter,
  ) {}

  // Returns the sessions that fall in the [now, now + windowMinutes]
  // band and are still in `scheduled` state.
  async findDueReminders(windowMinutes = 60): Promise<CoachingSession[]> {
    const now = new Date();
    const upper = new Date(now.getTime() + windowMinutes * 60 * 1000);
    return this.prisma.coachingSession.findMany({
      where: {
        status: 'scheduled',
        start_at: { gte: now, lte: upper },
      },
      orderBy: { start_at: 'asc' },
    });
  }

  // 1h reminder cron — runs every 5 minutes.
  @Cron(process.env.BOOKING_REMINDER_1H_CRON ?? '*/5 * * * *', {
    name: 'booking-reminder-1h',
    timeZone: 'UTC',
  })
  async runOneHourReminderSweep(): Promise<void> {
    const enabled = process.env.BOOKING_REMINDERS_ENABLED === 'on';
    if (!enabled) {
      this.logger.debug('1h reminder cron skipped — set BOOKING_REMINDERS_ENABLED=on to enable');
      return;
    }
    await this.dispatchWindow({
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient, otherName, session, ctx) =>
        this.bookingEmitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: session.id,
          scheduledAt: session.start_at,
          ...reminderContext(ctx),
        }),
    });
  }

  // 24h reminder cron — runs every 15 minutes.
  @Cron(process.env.BOOKING_REMINDER_24H_CRON ?? '*/15 * * * *', {
    name: 'booking-reminder-24h',
    timeZone: 'UTC',
  })
  async runTwentyFourHourReminderSweep(): Promise<void> {
    const enabled = process.env.BOOKING_REMINDERS_ENABLED === 'on';
    if (!enabled) {
      this.logger.debug('24h reminder cron skipped — set BOOKING_REMINDERS_ENABLED=on to enable');
      return;
    }
    await this.dispatchWindow({
      lowerOffsetMinutes: 60 * 24 - 15,
      upperOffsetMinutes: 60 * 24 + 15,
      recoverMinLeadMinutes: REMINDER_24H_RECOVERY_MIN_LEAD_MINUTES,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      emit: (recipient, otherName, session, ctx) =>
        this.bookingEmitter.emitReminder24h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: session.id,
          scheduledAt: session.start_at,
          ...reminderContext(ctx),
        }),
    });
  }

  // Shared sweep helper. Public so tests can drive it deterministically
  // without faking the cron clock.
  async dispatchWindow(args: {
    lowerOffsetMinutes: number;
    upperOffsetMinutes: number;
    /**
     * S-SCHED-4: unfinished work is recovered only while the session starts
     * more than this many minutes from now (default 0: until it starts).
     */
    recoverMinLeadMinutes?: number;
    kind: string;
    emit: (
      recipientUserId: string,
      otherPartyDisplayName: string,
      session: CoachingSession,
      ctx: ReminderRecipientContext,
    ) => Promise<BookingDeliveryOutcome | void | undefined>;
  }): Promise<ReminderSweepResult> {
    const now = new Date();
    const lower = new Date(now.getTime() + args.lowerOffsetMinutes * 60 * 1000);
    const upper = new Date(now.getTime() + args.upperOffsetMinutes * 60 * 1000);
    // S-SCHED-2: confirmed sessions only. pending_provider is confirmed too
    // (waiting on a call link), so it is reminded, and its coach is told the
    // link is still missing.
    const due = await this.prisma.coachingSession.findMany({
      where: {
        status: { in: [...REMINDABLE_STATUSES] },
        start_at: { gte: lower, lte: upper },
      },
      orderBy: { start_at: 'asc' },
    });

    const result: ReminderSweepResult = {
      scanned: due.length,
      dispatched: 0,
      skipped: 0,
      retrying: 0,
      failed: 0,
      recovered: 0,
      retired: 0,
    };

    // S-SCHED-4 (B-634-2): unfinished delivery work is selected on its own,
    // not only through the due band. A session claimed at the last tick of
    // its band (a channel failed, or the worker died holding the lease) has
    // left the band by the next tick; without this its retry would never run.
    const recovery = await this.collectRecoverableWork({
      kind: args.kind,
      now,
      lower,
      upper,
      minLeadMs: (args.recoverMinLeadMinutes ?? 0) * 60 * 1000,
      dueIds: new Set(due.map((d) => d.id)),
    });
    result.retired += recovery.retired;
    result.recovered = recovery.sessions.length;
    result.scanned += recovery.sessions.length;

    const work: Array<{ session: CoachingSession; onlyUsers: Set<string> | null }> = [
      ...due.map((session) => ({ session, onlyUsers: null })),
      ...recovery.sessions,
    ];
    for (const { session, onlyUsers } of work) {
      const participants: Array<{
        userId: string;
        otherUserId: string | null;
        role: 'client' | 'coach';
      }> = [];
      if (session.client_id) {
        participants.push({
          userId: session.client_id,
          otherUserId: session.coach_id,
          role: 'client',
        });
      }
      participants.push({
        userId: session.coach_id,
        otherUserId: session.client_id,
        role: 'coach',
      });
      const sessionTypeName = await this.resolveTypeName(session.session_type_id);

      for (const p of participants) {
        // A recovered session re-sends only to recipients with unfinished
        // work; nobody else is newly claimed outside the band.
        if (onlyUsers && !onlyUsers.has(p.userId)) continue;
        const claim = await this.claimDelivery(session, p.userId, args.kind);
        if (claim === 'duplicate') {
          result.skipped += 1;
          continue;
        }
        if (claim === 'error') {
          result.failed += 1;
          continue;
        }
        // Fence: the session may have been cancelled or moved after the
        // sweep read it. Never remind a time that no longer exists; a moved
        // session is reminded for its new time by a later sweep.
        const current = await this.prisma.coachingSession.findUnique({
          where: { id: session.id },
        });
        if (
          !current ||
          !REMINDABLE_STATUSES.includes(current.status) ||
          current.start_at.getTime() !== session.start_at.getTime() ||
          current.start_at.getTime() <= Date.now()
        ) {
          // A claim this sweep inserted is simply released. A taken-over row
          // keeps its per-channel receipts and is closed instead.
          if (claim.fresh) await this.releaseClaim(claim);
          else await this.retireClaim(claim, current);
          result.skipped += 1;
          continue;
        }
        const otherName = await this.resolveDisplayName(p.otherUserId);
        let outcome: BookingDeliveryOutcome | void | undefined;
        try {
          outcome = await args.emit(p.userId, otherName, current, {
            recipientRole: p.role,
            sessionTypeName,
            hasMeetingLink: hasUsableLink(current.video_url),
            skipInApp: claim.inappDone,
            skipPush: claim.pushDone,
            notificationId: claim.notificationId,
          });
        } catch (err) {
          this.logger.warn(
            `reminder dispatch threw: session=${session.id} user=${p.userId} kind=${args.kind} err=${(err as Error).message}`,
          );
          outcome = { inapp: 'failed', push: 'failed' };
        }
        const state = await this.settleClaim(claim, outcome);
        if (state === 'sent') result.dispatched += 1;
        else if (state === 'retry') result.retrying += 1;
        else result.failed += 1;
      }
    }

    if (result.scanned > 0 || result.retired > 0) {
      this.logger.log(
        `reminder sweep kind=${args.kind} scanned=${result.scanned} recovered=${result.recovered} dispatched=${result.dispatched} skipped=${result.skipped} retrying=${result.retrying} failed=${result.failed} retired=${result.retired}`,
      );
    }
    return result;
  }

  // S-SCHED-4 (B-634-2): read this kind's unfinished delivery rows ('retry',
  // or 'sending' whose lease has expired) and sort each into:
  //  - recover: the session is still confirmed, at the same start the row
  //    was claimed for, still ahead of the recovery cutoff, the recipient is
  //    still one of its two participants, and attempts remain. Sessions that
  //    are back in the due band are left to the band pass (no double claim).
  //  - retire: it can never be sent correctly (cancelled or finished
  //    session, started / past the cutoff, superseded by a move the band
  //    pass will not reach, recipient no longer on the session, attempts
  //    exhausted). It is closed as 'gave_up' with the reason in last_error
  //    by a compare-and-set, so a concurrent owner keeps it. Per-channel
  //    receipts are left untouched.
  //  - leave: a live lease (another worker owns it) or a claim whose session
  //    was moved to a time that is still ahead of its band (the band pass
  //    re-arms it there).
  private async collectRecoverableWork(args: {
    kind: string;
    now: Date;
    lower: Date;
    upper: Date;
    minLeadMs: number;
    dueIds: Set<string>;
  }): Promise<{
    sessions: Array<{ session: CoachingSession; onlyUsers: Set<string> }>;
    retired: number;
  }> {
    const empty = { sessions: [], retired: 0 };
    let rows: DeliveryLogRow[];
    try {
      rows = await this.prisma.notificationDeliveryLog.findMany({
        where: {
          kind: args.kind,
          OR: [
            { status: 'retry' },
            {
              status: 'sending',
              OR: [{ lease_until: null }, { lease_until: { lte: args.now } }],
            },
          ],
        },
        orderBy: { created_at: 'asc' },
        take: REMINDER_RECOVERY_BATCH,
      });
    } catch (err) {
      this.logger.error(
        `reminder recovery read failed: kind=${args.kind} err=${(err as Error).message}`,
      );
      return empty;
    }
    if (rows.length === 0) return empty;

    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(isString))];
    const sessions = await this.prisma.coachingSession.findMany({
      where: { id: { in: sessionIds } },
    });
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const cutoff = args.now.getTime() + args.minLeadMs;
    const recover = new Map<string, { session: CoachingSession; onlyUsers: Set<string> }>();
    let retired = 0;

    for (const row of rows) {
      const session = row.session_id ? byId.get(row.session_id) : undefined;
      const reason = this.retireReason(
        row,
        session,
        args.now.getTime(),
        cutoff,
        args.lower.getTime(),
      );
      if (reason) {
        if (await this.retireRow(row, reason)) retired += 1;
        continue;
      }
      if (!session || !row.user_id) continue;
      const forStart = row.session_start_at ?? null;
      if (forStart !== null && forStart.getTime() !== session.start_at.getTime()) {
        // Moved to a later time: the band pass re-arms this row when the new
        // time enters the band (claimDelivery resets a stale revision).
        continue;
      }
      if (args.dueIds.has(session.id)) continue;
      // Claimed inside this band earlier, so the start is at most the band's
      // upper edge; anything later is not this sweep's work.
      if (session.start_at.getTime() > args.upper.getTime()) continue;
      const entry = recover.get(session.id) ?? { session, onlyUsers: new Set<string>() };
      entry.onlyUsers.add(row.user_id);
      recover.set(session.id, entry);
    }
    return {
      sessions: [...recover.values()].sort(
        (a, b) => a.session.start_at.getTime() - b.session.start_at.getTime(),
      ),
      retired,
    };
  }

  private retireReason(
    row: DeliveryLogRow,
    session: CoachingSession | undefined,
    nowMs: number,
    cutoffMs: number,
    lowerMs: number,
  ): RetireReason | null {
    if (!session || !REMINDABLE_STATUSES.includes(session.status)) return 'session_cancelled';
    if (row.user_id !== session.client_id && row.user_id !== session.coach_id) {
      return 'recipient_changed';
    }
    if ((row.attempts ?? 1) >= REMINDER_MAX_ATTEMPTS) return 'attempts_exhausted';
    const startMs = session.start_at.getTime();
    if (startMs <= nowMs) return 'session_started';
    // Ahead of now but inside the recovery cutoff: a 24h reminder the 1h
    // reminder has taken over, or a claim for an older start whose new time
    // has already passed its band. Either way it can never be sent correctly.
    if (startMs <= cutoffMs) return 'superseded';
    const forStart = row.session_start_at ?? null;
    if (forStart !== null && forStart.getTime() !== startMs && startMs < lowerMs) {
      return 'superseded';
    }
    return null;
  }

  private async retireRow(row: DeliveryLogRow, reason: RetireReason): Promise<boolean> {
    try {
      const res = await this.prisma.notificationDeliveryLog.updateMany({
        where: {
          id: row.id,
          status: row.status,
          attempts: row.attempts,
          claim_token: row.claim_token ?? null,
        },
        data: { status: 'gave_up', lease_until: null, last_error: `retired:${reason}` },
      });
      if (res.count !== 1) return false;
    } catch (err) {
      this.logger.warn(`reminder claim ${row.id} retire failed: ${(err as Error).message}`);
      return false;
    }
    const log = `reminder retired: claim=${row.id} session=${row.session_id ?? 'unknown'} reason=${reason} attempts=${row.attempts}`;
    if (reason === 'attempts_exhausted') this.logger.error(log);
    else this.logger.log(log);
    return true;
  }

  // S-SCHED-3 (B-634-2): durable, recoverable delivery claim per
  // (session, recipient, kind), fenced to the session's start time.
  //  - New: INSERT a 'sending' row with a lease and a random claim token.
  //  - P2002 (row exists): take it over with one compare-and-set UPDATE only
  //    when it is not finished for this revision: a 'retry' row, a 'sending'
  //    row whose lease expired (the worker died after claiming), or a row for
  //    an older start time (a move the reschedule cleanup did not catch).
  //    A live lease, 'sent' or 'gave_up' is a duplicate (another replica or
  //    an earlier sweep owns it). Legacy rows read as 'sent'.
  //  - Any other database error is a real failure: logged, counted, retried
  //    next sweep; never mistaken for a duplicate.
  private async claimDelivery(
    session: CoachingSession,
    userId: string,
    kind: string,
  ): Promise<ReminderClaim | 'duplicate' | 'error'> {
    const now = new Date();
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + REMINDER_CLAIM_LEASE_MS);
    try {
      const row = await this.prisma.notificationDeliveryLog.create({
        data: {
          session_id: session.id,
          user_id: userId,
          kind,
          status: 'sending',
          attempts: 1,
          lease_until: leaseUntil,
          claim_token: token,
          session_start_at: session.start_at,
        },
      });
      return {
        id: row.id,
        token,
        attempts: 1,
        inappDone: false,
        pushDone: false,
        notificationId: null,
        fresh: true,
      };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        this.logger.error(
          `reminder claim failed: session=${session.id} user=${userId} kind=${kind} err=${(err as Error).message}`,
        );
        return 'error';
      }
    }

    let existing: DeliveryLogRow | null;
    try {
      existing = await this.prisma.notificationDeliveryLog.findFirst({
        where: { session_id: session.id, user_id: userId, kind },
      });
    } catch (err) {
      this.logger.error(
        `reminder claim lookup failed: session=${session.id} user=${userId} kind=${kind} err=${(err as Error).message}`,
      );
      return 'error';
    }
    if (!existing) return 'duplicate';
    // Rows written before the delivery-state columns read as settled.
    const status = existing.status ?? 'sent';
    const priorAttempts = existing.attempts ?? 1;
    const forStart = existing.session_start_at ?? null;
    const lease = existing.lease_until ?? null;
    const staleRevision = forStart !== null && forStart.getTime() !== session.start_at.getTime();
    const leaseExpired =
      status === 'sending' && (lease === null || lease.getTime() <= now.getTime());
    const retryable =
      !staleRevision &&
      (status === 'retry' || leaseExpired) &&
      priorAttempts < REMINDER_MAX_ATTEMPTS;
    if (!staleRevision && !retryable) return 'duplicate';

    const attempts = staleRevision ? 1 : priorAttempts + 1;
    const took = await this.prisma.notificationDeliveryLog.updateMany({
      where: {
        id: existing.id,
        status,
        attempts: priorAttempts,
        claim_token: existing.claim_token ?? null,
      },
      data: {
        status: 'sending',
        attempts,
        lease_until: leaseUntil,
        claim_token: token,
        session_start_at: session.start_at,
        ...(staleRevision
          ? { inapp_done_at: null, push_done_at: null, notification_id: null, last_error: null }
          : {}),
      },
    });
    if (took.count !== 1) return 'duplicate';
    return {
      id: existing.id,
      token,
      attempts,
      inappDone: !staleRevision && (existing.inapp_done_at ?? null) !== null,
      pushDone: !staleRevision && (existing.push_done_at ?? null) !== null,
      notificationId: staleRevision ? null : (existing.notification_id ?? null),
      fresh: false,
    };
  }

  // Record what each channel did. Both settled -> 'sent'. Otherwise 'retry'
  // (the next sweep re-sends only the channel that did not land) until
  // REMINDER_MAX_ATTEMPTS, then 'gave_up' with an error log.
  private async settleClaim(
    claim: ReminderClaim,
    outcome: BookingDeliveryOutcome | void | undefined,
  ): Promise<'sent' | 'retry' | 'gave_up'> {
    const now = new Date();
    // An emitter that reports nothing is treated as delivered (test doubles
    // and legacy callers); the real BookingEmitter always reports.
    const inappOk = outcome ? inAppSettled(outcome.inapp) : true;
    const pushOk = outcome ? pushSettled(outcome.push) : true;
    const state: 'sent' | 'retry' | 'gave_up' =
      inappOk && pushOk ? 'sent' : claim.attempts >= REMINDER_MAX_ATTEMPTS ? 'gave_up' : 'retry';
    const failedChannels = [!inappOk ? 'inapp' : null, !pushOk ? 'push' : null].filter(Boolean);
    try {
      const res = await this.prisma.notificationDeliveryLog.updateMany({
        where: { id: claim.id, claim_token: claim.token },
        data: {
          status: state,
          lease_until: null,
          ...(inappOk && !claim.inappDone ? { inapp_done_at: now } : {}),
          ...(pushOk && !claim.pushDone ? { push_done_at: now } : {}),
          ...(outcome && outcome.notificationId ? { notification_id: outcome.notificationId } : {}),
          last_error:
            state === 'sent'
              ? null
              : `${failedChannels.join('+')}:${outcome ? `${outcome.inapp}/${outcome.push}` : 'unknown'}`.slice(
                  0,
                  120,
                ),
        },
      });
      if (res.count !== 1) {
        this.logger.warn(`reminder claim ${claim.id} was taken over before it settled`);
      }
    } catch (err) {
      // The lease expires and the next sweep retries the channels that are
      // not recorded as done; nothing is marked delivered that was not.
      this.logger.error(`reminder claim ${claim.id} settle failed: ${(err as Error).message}`);
    }
    if (state === 'gave_up') {
      this.logger.error(
        `reminder gave up after ${claim.attempts} attempts: claim=${claim.id} channels=${failedChannels.join('+')}`,
      );
    }
    return state;
  }

  private async retireClaim(claim: ReminderClaim, current: CoachingSession | null): Promise<void> {
    const reason: RetireReason =
      !current || !REMINDABLE_STATUSES.includes(current.status)
        ? 'session_cancelled'
        : current.start_at.getTime() <= Date.now()
          ? 'session_started'
          : 'superseded';
    try {
      // A moved session's row was already removed by the reschedule (and a
      // stale revision is re-armed by the band pass), so this only matches
      // while this sweep still owns the claim.
      await this.prisma.notificationDeliveryLog.updateMany({
        where: { id: claim.id, claim_token: claim.token },
        data: { status: 'gave_up', lease_until: null, last_error: `retired:${reason}` },
      });
    } catch (err) {
      this.logger.warn(`reminder claim ${claim.id} retire failed: ${(err as Error).message}`);
    }
  }

  private async releaseClaim(claim: ReminderClaim): Promise<void> {
    try {
      await this.prisma.notificationDeliveryLog.deleteMany({
        where: { id: claim.id, claim_token: claim.token },
      });
    } catch (err) {
      this.logger.warn(`reminder claim ${claim.id} release failed: ${(err as Error).message}`);
    }
  }

  private async resolveTypeName(sessionTypeId: string | null): Promise<string | null> {
    if (!sessionTypeId) return null;
    const t = await this.prisma.sessionType.findUnique({
      where: { id: sessionTypeId },
      select: { name: true },
    });
    return t?.name ?? null;
  }

  private async resolveDisplayName(userId: string | null): Promise<string> {
    if (!userId) return 'Someone';
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!u || !u.name) return 'Someone';
    return u.name.slice(0, 32);
  }
}
