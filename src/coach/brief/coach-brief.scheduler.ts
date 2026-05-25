// src/coach/brief/coach-brief.scheduler.ts
//
// Daily push dispatch for the Coach Brief. Runs every UTC minute; for
// each coach with preferences.enabled = true, fires a push if the
// current wall-clock minute in the coach's timezone equals their
// notification_time. The per-coach work runs through Promise.allSettled
// so one coach's failure cannot block the rest of the dispatch.
//
// Race-safety on multi-instance deploys:
//   * Brief generation is gated by an atomic status='generating' claim in
//     CoachBriefService.generateBrief.
//   * Push dispatch is gated by an atomic updateMany on
//     CoachBriefPreferences.last_push_date — only the first instance
//     that flips last_push_date to today's brief_date wins and sends.
//
// External call safety:
//   * notifications.pushToUser is wrapped in Promise.race against a
//     10s timeout so a stalled Expo client cannot wedge the scheduler.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { CoachBriefService, bucketDateLocal } from './coach-brief.service';
import { coachBriefEnabled } from './coach-brief-enabled.guard';

const CRON_JOB_NAME = 'coach-brief-dispatch';
const DEFAULT_CRON = '* * * * *';
const PUSH_TIMEOUT_MS = 10_000;

// R44: typed internal error for the push-timeout reject path. Carrying a
// `code` lets observability distinguish "Expo round-trip slow" from a
// real downstream Expo failure without parsing message text.
class CoachBriefPushTimeoutError extends Error {
  readonly code = 'COACH_BRIEF_PUSH_TIMEOUT' as const;
  constructor(message = 'push timeout') {
    super(message);
    this.name = 'CoachBriefPushTimeoutError';
  }
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

@Injectable()
export class CoachBriefScheduler implements OnModuleInit {
  private readonly logger = new Logger(CoachBriefScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly briefService: CoachBriefService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    // SchedulerRegistry is optional so unit tests that construct the
    // scheduler directly (without a Nest test module) don't need to
    // stub it. onModuleInit only runs under a real Nest bootstrap.
    private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  // Register the cron at bootstrap so the schedule expression can come
  // from ConfigService (validated env) rather than a raw process.env
  // read at decorator-evaluation time.
  onModuleInit(): void {
    if (!this.schedulerRegistry) return;
    const cronExpr =
      this.config.get<string>('COACH_BRIEF_CRON')?.trim() || DEFAULT_CRON;

    let job: CronJob;
    try {
      job = new CronJob(
        cronExpr,
        () => {
          this.dispatchDailyBriefs().catch((err) => {
            this.logger.error(
              `coach brief dispatch tick failed: ${errorMessageOf(err)}`,
            );
          });
        },
        null,
        false,
        'UTC',
      );
    } catch (err) {
      this.logger.error(
        `invalid COACH_BRIEF_CRON="${cronExpr}" — refusing to register: ${errorMessageOf(err)}`,
      );
      return;
    }

    // Replace any prior registration (hot-reload safe).
    try {
      this.schedulerRegistry.deleteCronJob(CRON_JOB_NAME);
    } catch {
      /* no prior job registered — fine */
    }
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job as never);
    job.start();
  }

  async dispatchDailyBriefs(): Promise<void> {
    // P1-2 — master kill switch. When COACH_BRIEF_ENABLED=off the cron is
    // a no-op; this short-circuits BEFORE we read the prefs table so an
    // operator who disables the feature does not generate scheduler load.
    if (!coachBriefEnabled(this.config)) {
      this.logger.debug(
        'coach brief scheduler skipped — COACH_BRIEF_ENABLED=off',
      );
      return;
    }

    const enabled =
      this.config.get<string>('COACH_BRIEF_NOTIFICATIONS_ENABLED') !== 'off';
    if (!enabled) {
      this.logger.debug(
        'coach brief notifications skipped — COACH_BRIEF_NOTIFICATIONS_ENABLED=off',
      );
      return;
    }

    const now = new Date();
    const allPrefs = await this.prisma.coachBriefPreferences.findMany({
      where: { enabled: true },
      include: {
        coach: { select: { id: true, name: true, expo_push_token: true } },
      },
    });

    await Promise.allSettled(
      allPrefs.map((prefs) => this.maybeDispatch(prefs, now)),
    );
  }

  async maybeDispatch(
    prefs: {
      coach_id: string;
      notification_time: string;
      timezone: string;
      coach: {
        id: string;
        name: string;
        expo_push_token: string | null;
      };
    },
    now: Date,
  ): Promise<void> {
    try {
      const [prefHour, prefMinute] = prefs.notification_time
        .split(':')
        .map((s) => parseInt(s, 10));
      if (Number.isNaN(prefHour) || Number.isNaN(prefMinute)) return;

      // Invalid IANA tz on this row — new writes are blocked by
      // IsValidTimezone, but legacy/manual rows could still trip this.
      // Fall back to UTC and continue dispatch rather than skipping
      // the coach entirely.
      let effectiveTimezone = prefs.timezone;
      let localParts: Intl.DateTimeFormatPart[];
      try {
        localParts = new Intl.DateTimeFormat('en-US', {
          timeZone: effectiveTimezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(now);
      } catch {
        this.logger.warn(
          `Invalid timezone '${prefs.timezone}' for coach ${prefs.coach_id} — falling back to UTC`,
        );
        effectiveTimezone = 'UTC';
        localParts = new Intl.DateTimeFormat('en-US', {
          timeZone: effectiveTimezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(now);
      }

      const hourStr = localParts.find((p) => p.type === 'hour')?.value ?? '0';
      const minuteStr =
        localParts.find((p) => p.type === 'minute')?.value ?? '0';
      let localHour = parseInt(hourStr, 10);
      const localMinute = parseInt(minuteStr, 10);
      // Intl can emit '24' for midnight on some platforms; normalise.
      if (localHour === 24) localHour = 0;

      if (localHour !== prefHour || localMinute !== prefMinute) return;

      // No expo token — generation still happens via getOrGenerateTodaysBrief
      // when the coach opens the app, so skip the push silently.
      if (!prefs.coach.expo_push_token) return;

      const briefDate = bucketDateLocal(now, effectiveTimezone);

      // P1-2: don't claim the attempt slot until we know there's
      // actually something to push. Generation can be in-flight (status
      // 'generating', summary null) on this minute — claiming the
      // attempt here would exhaust the slot for the whole day even
      // though we never call pushToUser. Generate (or read the cached
      // row) first; only proceed when a non-null summary exists.
      const brief = await this.briefService.getOrGenerateTodaysBrief(
        prefs.coach_id,
      );
      if (!brief.summary) {
        this.logger.debug(
          `coach brief push deferred for coach=${prefs.coach_id} — summary not ready yet`,
        );
        return;
      }

      // Idempotent pre-send claim against the server-only push ledger
      // (P1-9). On a multi-instance deploy every Fly.io machine runs
      // this cron; without a claim each would call pushToUser and the
      // coach would receive duplicate notifications. upsert + then
      // updateMany WHERE last_push_attempt_date != today flips exactly
      // one row and returns count=1 to the winner; losers get count=0
      // and exit. last_push_date is set separately AFTER push success
      // so observability can tell "attempted today" from "delivered
      // today". The ledger is server-only — coaches have no RLS write
      // policy on it, so they can't poison the dedup state.
      await this.prisma.coachBriefPushLedger.upsert({
        where: { coach_id: prefs.coach_id },
        create: { coach_id: prefs.coach_id },
        update: {},
      });
      const attemptClaim = await this.prisma.coachBriefPushLedger.updateMany({
        where: {
          coach_id: prefs.coach_id,
          OR: [
            { last_push_attempt_date: null },
            { last_push_attempt_date: { not: briefDate } },
          ],
        },
        data: { last_push_attempt_date: briefDate },
      });
      if (attemptClaim.count === 0) {
        this.logger.debug(
          `coach brief push already attempted for coach=${prefs.coach_id} date=${briefDate}`,
        );
        return;
      }

      const notifBody = brief.summary.narrative.slice(0, 160);

      // P2-6: AbortController feeds the same signal into pushToUser AND
      // the timeout, so when the 10s deadline trips we actually cancel
      // the in-flight Expo round-trip rather than letting it complete
      // silently after the scheduler has moved on.
      const abortController = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new CoachBriefPushTimeoutError();
          abortController.abort(err);
          reject(err);
        }, PUSH_TIMEOUT_MS);
      });

      let pushSucceeded = false;
      try {
        await Promise.race([
          this.notifications.pushToUser(
            prefs.coach_id,
            'Your daily brief is ready',
            notifBody,
            { deep_link: 'tgp://coach/brief/today', brief_date: briefDate },
            abortController.signal,
          ),
          timeoutPromise,
        ]);
        pushSucceeded = true;
      } catch (err) {
        this.logger.warn(
          `coach brief push failed or timed out for coach ${prefs.coach_id} on ${briefDate}: ${errorMessageOf(err)}`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!pushSucceeded) return;

      // Confirmed-success marker. last_push_date is the observability
      // sentinel for "this coach received their brief today"; the
      // attempt claim above already guarantees we don't double-send.
      await this.prisma.coachBriefPushLedger.updateMany({
        where: { coach_id: prefs.coach_id },
        data: { last_push_date: briefDate },
      });

      this.logger.log(
        `coach brief push sent: coach=${prefs.coach_id} date=${briefDate}`,
      );
    } catch (err) {
      this.logger.error(
        `coach brief dispatch failed for coach=${prefs.coach_id}: ${errorMessageOf(err)}`,
      );
    }
  }
}
