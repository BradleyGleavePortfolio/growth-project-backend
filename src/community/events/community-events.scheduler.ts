import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommunityEventsService } from './community-events.service';
import { resolveEventsFlag } from './community-events-flag.guard';

// "tomorrow" promotion window: a scheduled event whose start falls within the
// next 24h is promoted to `tomorrow` and its going/maybe RSVPs get a reminder.
const TOMORROW_WINDOW_MS = 24 * 60 * 60 * 1000;
// Batch ceiling per tick — keeps a backlog (e.g. after a cron outage) draining
// over consecutive minutes without overlapping a 60s budget. Mirrors the
// drip-dispatcher sizing convention.
const TICK_BATCH_SIZE = 250;

/**
 * community-events.scheduler.ts — the v2-3 lifecycle transition cron.
 *
 * Two automatic, time-driven promotions (the coach drives replay/reflect by
 * hand):
 *   1. `scheduled` → `tomorrow` when start is within TOMORROW_WINDOW_MS, plus a
 *      "starting soon" reminder push to each going/maybe RSVP (idempotent via
 *      reminded_at).
 *   2. `scheduled`/`tomorrow` → `live` when start time has passed.
 *
 * CONCURRENCY: like every existing @Cron in this repo (drip-dispatcher,
 * coach-brief, dunning) there is no external queue; we use an in-process
 * tick-overlap guard and the SchedulerService's own atomic state writes. A
 * promotion is a single conditional UPDATE guarded by the state machine
 * (canTransition), so two replicas contending re-read the same state and the
 * loser's transition is a no-op (the row already moved). Reminders are
 * idempotent because the fan-out stamps reminded_at.
 *
 * FLAG GATING: the cron NEVER promotes while FEATURE_COMMUNITY_EVENTS is off —
 * the kill switch must freeze the lifecycle, not just the write endpoints, so a
 * disabled feature cannot silently mutate state or fire pushes. NODE_ENV=test
 * also short-circuits the @Cron tick so unit tests drive runOnce() directly.
 */
@Injectable()
export class CommunityEventsScheduler {
  private readonly logger = new Logger(CommunityEventsScheduler.name);
  private running = false;

  constructor(private readonly events: CommunityEventsService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'community-events-transitions' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    // Kill switch: a disabled feature freezes the lifecycle entirely.
    if (!resolveEventsFlag()) return;
    if (this.running) {
      this.logger.warn(
        'community-events transition tick skipped: prior tick still running',
      );
      return;
    }
    this.running = true;
    try {
      const stats = await this.runOnce();
      if (stats.promotedTomorrow > 0 || stats.promotedLive > 0) {
        this.logger.log(
          `community-events transitions: tomorrow=${stats.promotedTomorrow} live=${stats.promotedLive}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `community-events transition tick crashed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Public entrypoint for tests + ops. Runs the live sweep FIRST (so an event
   * past start is moved straight to `live` and never mislabeled `tomorrow`),
   * then the tomorrow promotion for the upcoming window.
   */
  async runOnce(
    now: Date = new Date(),
  ): Promise<{ promotedLive: number; promotedTomorrow: number }> {
    const promotedLive = await this.events.runLivePromotion(now, TICK_BATCH_SIZE);
    const promotedTomorrow = await this.events.runTomorrowPromotion(
      now,
      TOMORROW_WINDOW_MS,
      TICK_BATCH_SIZE,
    );
    return { promotedLive, promotedTomorrow };
  }
}

// Constants exported for tests.
export const __communityEventsSchedulerConsts = {
  TOMORROW_WINDOW_MS,
  TICK_BATCH_SIZE,
};
