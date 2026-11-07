/**
 * MONEY-ALARM-BE (owner #202-E3, "DECISIONS #202-S1 - op 1"): the daily money
 * check's own status, read by its own alarm (.github/workflows/
 * money-check-alarm.yml). Never /readyz, never the production-down issue.
 *
 * No new table or column: the status reads only the two rows the daily check
 * already writes when a run finishes (ReconciliationDailyCron.alertOwner):
 *   1. the day's inbox row: a Notification of kind coach_alert to the owner
 *      account, payload.type 'money_check', payload.day 'YYYY-MM-DD';
 *   2. the day's queued push: a PushOutbox row to the same account with
 *      dedupe_key 'money_daily:YYYY-MM-DD'.
 * A day counts as finished with a sent owner notice only when both exist. A
 * queued push is not proof that the owner received or read it.
 *
 *   on_time  the newest such day's inbox row is at most LATE_AFTER_MS old.
 *   late     none is: the timer never fired, the lease read failed, the run
 *            died before the end, there is no owner account, or the inbox row
 *            or the push could not be written.
 *   off      RECONCILIATION_DAILY_ENABLED is 'false' (its meaning is kept).
 *
 * Grace: on a database where the daily check has never started (no
 * reconciliation-daily CronLease row, the first day) the answer is on_time
 * for the first LATE_AFTER_MS after the serving machine started, so a new
 * deployment's first 11:00 UTC run can come. Once the check has started, a
 * new deployment gets no grace: the answer reads only rows a deployment does
 * not change, so a grace would only let a deploy hide a missed day.
 *
 * The answer is the state and the last finished day: no counts, amounts, ids,
 * verdicts, reasons or errors.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NotificationKind } from '../notifications/notification-kind';
import { DAILY_JOB_NAME, reconciliationDailyEnabled } from './reconciliation-daily.cron';

export type MoneyCheckState = 'on_time' | 'late' | 'off';

export interface MoneyCheckStatus {
  status: MoneyCheckState;
  /** The newest UTC day (YYYY-MM-DD) that finished with a sent owner notice, or null. */
  lastDay: string | null;
}

/** 24 hours plus 2: the run's 45-minute budget, the push queue and the schedule's delays. */
export const LATE_AFTER_MS = 26 * 60 * 60_000;
/** The day's push key, as the daily check writes it (reconciliation-daily.cron.ts, pushToUser's dedupeKey). */
export const MONEY_DAILY_PUSH_KEY = 'money_daily:';
/** Inbox rows read, newest first: about a month, the push outbox's own retention (RETENTION_MS). */
export const STATUS_SCAN = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** on_time, late or off from what the rows say. Pure; `now` and the machine start in ms. */
export function moneyCheckState(input: {
  enabled: boolean;
  lastNoticeAt: Date | null;
  everStarted: boolean;
  machineStartedAt: number;
  now: number;
}): MoneyCheckState {
  if (!input.enabled) return 'off';
  if (input.lastNoticeAt && input.now - input.lastNoticeAt.getTime() <= LATE_AFTER_MS) return 'on_time';
  if (!input.everStarted && input.now - input.machineStartedAt <= LATE_AFTER_MS) return 'on_time';
  return 'late';
}

@Injectable()
export class MoneyCheckStatusService {
  /** When this machine started: the new deployment's clock for the first-day grace. */
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /** Throws when the rows cannot be read; the route answers 503 then. */
  async status(now: Date = new Date(), machineStartedAt: number = this.startedAt): Promise<MoneyCheckStatus> {
    const last = await this.lastFinished();
    const everStarted =
      last !== null ||
      (await this.prisma.cronLease.findUnique({ where: { name: DAILY_JOB_NAME }, select: { name: true } })) !== null;
    const status = moneyCheckState({
      enabled: reconciliationDailyEnabled(),
      lastNoticeAt: last?.at ?? null,
      everStarted,
      machineStartedAt,
      now: now.getTime(),
    });
    return { status, lastDay: last?.day ?? null };
  }

  /** The newest day whose inbox row and queued push both exist, with the inbox row's time. */
  private async lastFinished(): Promise<{ day: string; at: Date } | null> {
    // The same owner account the daily check writes to (reconciliation-daily.cron.ts alertOwner).
    const owner = await this.prisma.user.findFirst({
      where: { role: 'owner', deleted_at: null, deletion_scheduled_at: null },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    if (!owner) return null;
    const rows = await this.prisma.notification.findMany({
      where: {
        user_id: owner.id,
        kind: NotificationKind.COACH_ALERT,
        payload: { path: ['type'], equals: 'money_check' },
      },
      orderBy: { created_at: 'desc' },
      take: STATUS_SCAN,
      select: { created_at: true, payload: true },
    });
    const days = rows.flatMap((r) => {
      const day = (r.payload as { day?: unknown } | null)?.day;
      return typeof day === 'string' && DAY.test(day) ? [{ day, at: r.created_at }] : [];
    });
    if (days.length === 0) return null;
    const queued = await this.prisma.pushOutbox.findMany({
      where: { user_id: owner.id, dedupe_key: { in: days.map((d) => MONEY_DAILY_PUSH_KEY + d.day) } },
      select: { dedupe_key: true },
    });
    const keys = new Set(queued.map((q) => q.dedupe_key));
    return days.find((d) => keys.has(MONEY_DAILY_PUSH_KEY + d.day)) ?? null;
  }
}
