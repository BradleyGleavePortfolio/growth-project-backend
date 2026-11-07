/**
 * MONEY-DAILY (owner, agent 199): the money check runs every day over every
 * purchase and tells the owner "clean" or "needs review".
 *
 * Once a day (11:00 UTC: 03:00 PST / 04:00 PDT, so the push lands before
 * 06:00 Pacific) one machine takes the "reconciliation-daily" CronLease row
 * until the next UTC midnight (dayLeaseUntil) and never hands it back early:
 * one run, one inbox row and one push per UTC day, however many machines tick
 * or how late a second one starts (LS-1225 B1, LO-1225 C3). It then calls ReconciliationService.runSweep in batches of BATCH with
 * staleBefore = the run's start. Every purchase checked in the run gets a
 * snapshot newer than that time, so the next batch holds only purchases not
 * yet reached. The run stops on:
 *   - a short batch (fewer than BATCH): every purchase was reached;
 *   - a batch that adds no new purchase id: every purchase left keeps
 *     failing (a check that throws writes no snapshot, so it would come back
 *     forever); the alert says the check stopped early;
 *   - the time budget (RUN_BUDGET_MS), also asked inside a batch before each
 *     purchase and each page of Stripe invoices (FIX-1225R4); the alert says
 *     the check stopped early.
 * PACE_MS between batches keeps the Stripe reads (sequential, one purchase at
 * a time inside runSweep) far below Stripe's read limit.
 *
 * When the run ends the owner-role account gets one inbox row and one push,
 * counts only: no names, no amounts, no purchase ids. No deep link: the app
 * has no money-check screen yet (the admin route is POST /v1/admin/payments/
 * reconciliation/run-sweeper).
 *
 * Off switch: RECONCILIATION_DAILY_ENABLED. Unset = on; only "false" turns the
 * daily run off (the admin "run the money check" button is not affected).
 * No new table: the lease is a CronLease row, the alert is a Notification row.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { ReconciliationService } from '../connect/fees/reconciliation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { CronLeaseService } from './cron-lease.service';

export const DAILY_JOB_NAME = 'reconciliation-daily';
/** 11:00 UTC = 03:00 PST / 04:00 PDT. */
export const DAILY_CRON = '0 11 * * *';
export const BATCH = 50;
export const RUN_BUDGET_MS = 45 * 60_000;
/** The shortest lease: longer than the budget, so a slow run never loses its lease mid-run. */
export const LEASE_TTL_MS = 60 * 60_000;

/**
 * The day's lease runs to the next UTC midnight (never shorter than
 * LEASE_TTL_MS). It is not released when the run ends: a second machine, or
 * a retry, later the same UTC day finds it held and does nothing.
 */
export function dayLeaseUntil(now: Date): Date {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(Math.max(nextMidnight, now.getTime() + LEASE_TTL_MS));
}
export const PACE_MS = 1_000;

export const DAILY_LOG_CODES = {
  disabled: 'MONEY_DAILY_DISABLED',
  lockHeld: 'MONEY_DAILY_SKIPPED_LOCK_HELD',
  lockError: 'MONEY_DAILY_LOCK_ERROR',
  failed: 'MONEY_DAILY_FAILED',
  stoppedEarly: 'MONEY_DAILY_STOPPED_EARLY',
  noOwner: 'MONEY_DAILY_NO_OWNER',
  alertFailed: 'MONEY_DAILY_ALERT_FAILED',
  done: 'MONEY_DAILY_DONE',
} as const;

export interface DailyTally {
  checked: number;
  ok: number;
  drift: number;
  unknown: number;
  failed: number;
  /** Why the run ended before reaching every purchase, if it did. */
  stopped: 'time_limit' | 'no_progress' | 'error' | null;
}

export type DailyRunResult =
  | { ran: false; reason: 'disabled' | 'lock_held' | 'lock_error' }
  | { ran: true; verdict: 'clean' | 'needs_review'; tally: DailyTally; batches: number; alerted: boolean };

/** RECONCILIATION_DAILY_ENABLED: unset = on; only "false" turns the daily run off. */
export function reconciliationDailyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RECONCILIATION_DAILY_ENABLED !== 'false';
}

/** Clean only when every purchase was reached and every one matched. */
export function dailyVerdict(t: DailyTally): 'clean' | 'needs_review' {
  return t.drift === 0 && t.unknown === 0 && t.failed === 0 && t.stopped === null ? 'clean' : 'needs_review';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The alert words: counts only, nothing that names a person, an amount or a purchase. */
export function dailyAlertCopy(t: DailyTally): { title: string; body: string } {
  const verdict = dailyVerdict(t);
  const checked = `Checked ${plural(t.checked, 'purchase', 'purchases')} against Stripe.`;
  if (verdict === 'clean') {
    return {
      title: 'Money check: clean',
      body: t.checked === 0 ? 'No purchases to check today.' : `${checked} Every one matches.`,
    };
  }
  const parts: string[] = [];
  if (t.drift > 0) parts.push(`${plural(t.drift, "doesn't match", "don't match")}`);
  if (t.unknown > 0) parts.push(`${t.unknown} could not be confirmed yet`);
  if (t.failed > 0) parts.push(`${t.failed} could not be checked`);
  const sentences = [checked];
  if (parts.length > 0) sentences.push(`${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()));
  if (t.stopped === 'time_limit') sentences.push('The check hit its time limit before it reached every purchase.');
  if (t.stopped === 'no_progress' || t.stopped === 'error')
    sentences.push('The check stopped early before it reached every purchase.');
  return { title: 'Money check: needs review', body: sentences.join(' ') };
}

@Injectable()
export class ReconciliationDailyCron {
  private readonly logger = new Logger(ReconciliationDailyCron.name);
  private readonly holder = `${process.env.FLY_MACHINE_ID ?? hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly lease: CronLeaseService,
    private readonly reconciliation: ReconciliationService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(DAILY_CRON, { name: DAILY_JOB_NAME, timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.runOnce();
  }

  /** One guarded run. Never throws. `pause` and `clock` are seams for tests. */
  async runOnce(
    now: Date = new Date(),
    holder: string = this.holder,
    pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    clock: () => number = () => Date.now(),
  ): Promise<DailyRunResult> {
    if (!reconciliationDailyEnabled()) {
      this.logger.warn(
        `${DAILY_LOG_CODES.disabled} RECONCILIATION_DAILY_ENABLED=false; the daily money check is off. The admin "run the money check" button still works.`,
      );
      return { ran: false, reason: 'disabled' };
    }
    let acquired = false;
    try {
      const ttlMs = dayLeaseUntil(now).getTime() - now.getTime();
      acquired = (await this.lease.tryAcquire(DAILY_JOB_NAME, holder, ttlMs, now)).acquired;
    } catch (err) {
      this.logger.error(
        `${DAILY_LOG_CODES.lockError} alert=true could not read the money-check lease; today's run is skipped: ${(err as Error)?.name ?? 'error'}`,
      );
      return { ran: false, reason: 'lock_error' };
    }
    if (!acquired) {
      this.logger.debug(`${DAILY_LOG_CODES.lockHeld} the money check already ran or is running today (UTC)`);
      return { ran: false, reason: 'lock_held' };
    }
    // No release: the lease is the day's one-run record and ends at the next UTC midnight.
    const { tally, batches } = await this.sweepAll(now, pause, clock);
    const verdict = dailyVerdict(tally);
    if (tally.stopped) {
      this.logger.warn(`${DAILY_LOG_CODES.stoppedEarly} reason=${tally.stopped} checked=${tally.checked}`);
    }
    this.logger.log(
      `${DAILY_LOG_CODES.done} verdict=${verdict} checked=${tally.checked} ok=${tally.ok} drift=${tally.drift} unknown=${tally.unknown} failed=${tally.failed} batches=${batches}`,
    );
    const alerted = await this.alertOwner(tally, now);
    return { ran: true, verdict, tally, batches, alerted };
  }

  /** Batches of BATCH until a short batch, a batch with no new id, the time budget, or an error. */
  private async sweepAll(
    runStart: Date,
    pause: (ms: number) => Promise<void>,
    clock: () => number,
  ): Promise<{ tally: DailyTally; batches: number }> {
    const deadline = clock() + RUN_BUDGET_MS;
    // Last outcome per purchase: a purchase that fails in two batches counts once.
    const seen = new Map<string, 'ok' | 'drift' | 'unknown' | 'failed'>();
    let stopped: DailyTally['stopped'] = null;
    let batches = 0;
    for (;;) {
      if (batches > 0) {
        if (clock() >= deadline) {
          stopped = 'time_limit';
          break;
        }
        await pause(PACE_MS);
      }
      let batch;
      try {
        // FIX-1225R4: the budget is also asked inside the batch, before each
        // purchase and each page of Stripe invoices (no endless paging).
        batch = await this.reconciliation.runSweep(BATCH, {
          staleBefore: runStart,
          outOfTime: () => clock() >= deadline,
        });
      } catch (err) {
        this.logger.error(
          `${DAILY_LOG_CODES.failed} alert=true a money-check batch failed; the alert reports what was checked: ${(err as Error)?.name ?? 'error'}`,
        );
        stopped = 'error';
        break;
      }
      batches += 1;
      let added = 0;
      for (const o of batch.outcomes) {
        if (!seen.has(o.purchase_id)) added += 1;
        seen.set(o.purchase_id, o.status);
      }
      if (batch.timedOut) {
        stopped = 'time_limit';
        break;
      }
      if (batch.scanned < BATCH) break;
      if (added === 0) {
        stopped = 'no_progress';
        break;
      }
    }
    const tally: DailyTally = { checked: seen.size, ok: 0, drift: 0, unknown: 0, failed: 0, stopped };
    for (const status of seen.values()) tally[status] += 1;
    return { tally, batches };
  }

  /** One inbox row and one push to the owner-role account. Never throws; false when nothing was sent. */
  private async alertOwner(tally: DailyTally, now: Date): Promise<boolean> {
    try {
      const owner = await this.prisma.user.findFirst({
        where: { role: 'owner', deleted_at: null, deletion_scheduled_at: null },
        orderBy: { created_at: 'asc' },
        select: { id: true },
      });
      if (!owner) {
        this.logger.error(`${DAILY_LOG_CODES.noOwner} alert=true no owner account; the money-check result was not sent`);
        return false;
      }
      const { title, body } = dailyAlertCopy(tally);
      const day = now.toISOString().slice(0, 10);
      const verdict = dailyVerdict(tally);
      // payload.title: the phone's inbox shows it as the row title (without it a coach_alert row reads "Update").
      const payload = {
        type: 'money_check',
        title,
        verdict,
        checked: tally.checked,
        drift: tally.drift,
        unknown: tally.unknown,
        failed: tally.failed,
        day,
      };
      await this.notifications.createNotification({
        user_id: owner.id,
        kind: NotificationKind.COACH_ALERT,
        body,
        payload,
        channel: 'inapp',
        // LS-1225 B3 / LO-1225 C2: the inbox keeps the whole body, the same words as the push.
        sender_words: true,
      });
      await this.notifications.pushToUser(
        owner.id,
        title,
        body,
        { type: 'money_check', verdict },
        undefined,
        // Money: passes Mute all (README note 1); one push per day, a rerun never posts twice.
        { kind: NotificationKind.COACH_ALERT, passesMuteAll: true, dedupeKey: `money_daily:${day}` },
      );
      return true;
    } catch (err) {
      this.logger.error(
        `${DAILY_LOG_CODES.alertFailed} alert=true the money-check result could not be sent: ${(err as Error)?.name ?? 'error'}`,
      );
      return false;
    }
  }
}
