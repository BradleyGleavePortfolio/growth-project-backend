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

const CRON_JOB_NAME = 'coach-brief-dispatch';
const DEFAULT_CRON = '* * * * *';
const PUSH_TIMEOUT_MS = 10_000;

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

      let localParts: Intl.DateTimeFormatPart[];
      try {
        localParts = new Intl.DateTimeFormat('en-US', {
          timeZone: prefs.timezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(now);
      } catch {
        // Invalid IANA tz persisted on this row. New writes are blocked
        // by IsValidTimezone, but legacy/manual rows could still trip
        // this. Skip dispatch and warn — never let a single bad row
        // wedge the cron loop.
        this.logger.warn(
          `coach=${prefs.coach_id} has invalid timezone="${prefs.timezone}" — skipping brief dispatch`,
        );
        return;
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

      const briefDate = bucketDateLocal(now, prefs.timezone);

      // Atomic dedup claim. On a multi-instance deploy every Fly.io
      // machine runs this cron; without a claim each would send a push.
      // updateMany WHERE last_push_date != today flips exactly one row
      // and returns count=1 to the winner; losers get count=0 and exit.
      const claim = await this.prisma.coachBriefPreferences.updateMany({
        where: {
          coach_id: prefs.coach_id,
          OR: [
            { last_push_date: null },
            { last_push_date: { not: briefDate } },
          ],
        },
        data: { last_push_date: briefDate },
      });
      if (claim.count === 0) {
        this.logger.debug(
          `coach brief push already claimed for coach=${prefs.coach_id} date=${briefDate}`,
        );
        return;
      }

      const brief = await this.briefService.getOrGenerateTodaysBrief(
        prefs.coach_id,
      );
      if (!brief.summary) return;

      const notifBody = brief.summary.narrative.slice(0, 160);

      // External call timeout — a stalled Expo round-trip must not
      // hold the scheduler indefinitely. We swallow the error here so
      // the cron tick keeps running for other coaches; the dedup
      // claim guarantees we don't retry-spam on the next tick.
      await Promise.race([
        this.notifications.pushToUser(
          prefs.coach_id,
          'Your daily brief is ready',
          notifBody,
          { deep_link: 'tgp://coach/brief/today', brief_date: briefDate },
        ),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('Push timeout')),
            PUSH_TIMEOUT_MS,
          ),
        ),
      ]).catch((err) => {
        this.logger.warn(
          `coach brief push timed out or failed: coach=${prefs.coach_id} ${errorMessageOf(err)}`,
        );
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
