// src/coach/brief/coach-brief.scheduler.ts
//
// Daily push dispatch for the Coach Brief. Runs every UTC minute; for
// each coach with preferences.enabled = true, fires a push if the
// current wall-clock minute in the coach's timezone equals their
// notification_time. The per-coach work runs through Promise.allSettled
// so one coach's failure cannot block the rest of the dispatch.
//
// Idempotency: brief generation itself is idempotent via the
// CoachBrief.(coach_id, brief_date) unique constraint. We do NOT yet
// gate the push side (a fast deploy cycle could deliver twice in the
// same minute); the spec marks a CoachBriefPushLog as a P1 follow-up.

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { CoachBriefService, bucketDateLocal } from './coach-brief.service';

@Injectable()
export class CoachBriefScheduler {
  private readonly logger = new Logger(CoachBriefScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly briefService: CoachBriefService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.COACH_BRIEF_CRON ?? '* * * * *', {
    name: 'coach-brief-dispatch',
    timeZone: 'UTC',
  })
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

      const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: prefs.timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(now);

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

      const brief = await this.briefService.getOrGenerateTodaysBrief(
        prefs.coach_id,
      );
      if (!brief.summary) return;

      const briefDate = bucketDateLocal(now, prefs.timezone);
      const notifBody = brief.summary.narrative.slice(0, 160);

      await this.notifications.pushToUser(
        prefs.coach_id,
        'Your daily brief is ready',
        notifBody,
        { deep_link: 'tgp://coach/brief/today', brief_date: briefDate },
      );

      this.logger.log(
        `coach brief push sent: coach=${prefs.coach_id} date=${briefDate}`,
      );
    } catch (err) {
      this.logger.error(
        `coach brief dispatch failed for coach=${prefs.coach_id}: ${(err as Error).message}`,
      );
    }
  }
}
