/**
 * MONEY-ALARM-BE (owner #202-E3, "DECISIONS #202-S1 - op 1"): the daily money
 * check's own status, read by its own alarm (.github/workflows/
 * money-check-alarm.yml). Never /readyz, never the production-down issue.
 *
 * MONEY-NOTICE-BE (owner #203-E117, 203-D1 op 1): no new table or column. The
 * status reads one row, the reconciliation-daily CronLease row, and its
 * cursor: the record of the last counted day (reconciliation-daily.cron.ts,
 * dailyRecord). A run writes it only when it reached every purchase, read at
 * least one (or had none to read) and its result reached the owner: the email
 * provider accepted the email to OWNER_ALERT_EMAIL (MONEY-EMAIL-BE), or the
 * inbox row in the app was written, whether or not a phone got the push, or
 * his in-app setting skipped the row and the push was queued. A queued push
 * or an accepted email is not proof that the owner received or read it.
 *
 *   on_time  the record's finish time is at most LATE_AFTER_MS ago.
 *   late     it is not: the timer never fired, the lease read failed, the run
 *            died or stopped before the end, it read no purchase, no email was
 *            accepted and nothing he can read in the app holds the result, or
 *            the record could not be written. A cursor that does not parse, or a
 *            finish time more than CLOCK_SKEW_MS ahead of this machine's
 *            clock, is no record.
 *   off      RECONCILIATION_DAILY_ENABLED is 'false' (its meaning is kept).
 *
 * Grace: on a database where the daily check has never started (no
 * reconciliation-daily CronLease row, the first day) the answer is on_time
 * for the first LATE_AFTER_MS after the serving machine started, so a new
 * deployment's first 11:00 UTC run can come. Once the check has started, a
 * new deployment gets no grace: the answer reads only a row a deployment does
 * not change, so a grace would only let a deploy hide a missed day.
 *
 * The answer is the state and the last counted day: no counts, amounts, ids,
 * verdicts, reasons or errors.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  DAILY_JOB_NAME,
  type DailyRecord,
  parseDailyRecord,
  reconciliationDailyEnabled,
} from './reconciliation-daily.cron';

export type MoneyCheckState = 'on_time' | 'late' | 'off';

export interface MoneyCheckStatus {
  status: MoneyCheckState;
  /** The newest counted UTC day (YYYY-MM-DD): finished with its result emailed (accepted) or saved for the owner; or null. */
  lastDay: string | null;
}

/** 24 hours plus 2: the run's 45-minute budget and the schedule's delays. */
export const LATE_AFTER_MS = 26 * 60 * 60_000;
/** A finish time further ahead of the reading machine's clock is no record (clock skew between machines). */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The counted day a lease cursor holds, or null (it does not parse, or it finished too far ahead). Pure. */
export function countedRecord(cursor: string | null | undefined, now: Date): DailyRecord | null {
  const record = parseDailyRecord(cursor);
  return record && record.finishedAt.getTime() - now.getTime() <= CLOCK_SKEW_MS ? record : null;
}

/** on_time, late or off from what the row says. Pure; `now` and the machine start in ms. */
export function moneyCheckState(input: {
  enabled: boolean;
  /** The last counted day's finish time. */
  lastNoticeAt: Date | null;
  everStarted: boolean;
  machineStartedAt: number;
  now: number;
}): MoneyCheckState {
  if (!input.enabled) return 'off';
  if (input.lastNoticeAt && input.now - input.lastNoticeAt.getTime() <= LATE_AFTER_MS)
    return 'on_time';
  if (!input.everStarted && input.now - input.machineStartedAt <= LATE_AFTER_MS) return 'on_time';
  return 'late';
}

@Injectable()
export class MoneyCheckStatusService {
  /** When this machine started: the new deployment's clock for the first-day grace. */
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /** Throws when the row cannot be read; the route answers 503 then. */
  async status(
    now: Date = new Date(),
    machineStartedAt: number = this.startedAt,
  ): Promise<MoneyCheckStatus> {
    // The finish time is the record's own; the row's acquired_at and updated_at move with the next day's lease.
    const row = await this.prisma.cronLease.findUnique({
      where: { name: DAILY_JOB_NAME },
      select: { name: true, cursor: true },
    });
    const last = countedRecord(row?.cursor, now);
    const status = moneyCheckState({
      enabled: reconciliationDailyEnabled(),
      lastNoticeAt: last?.finishedAt ?? null,
      everStarted: row !== null,
      machineStartedAt,
      now: now.getTime(),
    });
    return { status, lastDay: last?.day ?? null };
  }
}
