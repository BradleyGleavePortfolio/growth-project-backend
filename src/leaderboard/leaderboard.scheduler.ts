// Phase 7C — Leaderboard nightly scheduler.
//
// Recomputes combined scores for every opted-in user at 06:00 UTC.
// Schedule is configurable via LEADERBOARD_RECOMPUTE_CRON env var.
// Feature-flag kill switch: LEADERBOARD_ENABLED=off skips the run.
//
// Runs one hour after the Coach Effectiveness scheduler (05:00 UTC) to
// avoid database contention.
//
// Idempotency: the score cache is write-through — duplicate ticks simply
// refresh the cache entry. The underlying Prisma reads are non-destructive.

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeaderboardService } from './leaderboard.service';

export const LEADERBOARD_RECOMPUTE_CRON_DEFAULT = '0 6 * * *';

function resolveCron(): string {
  const raw = process.env.LEADERBOARD_RECOMPUTE_CRON;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return LEADERBOARD_RECOMPUTE_CRON_DEFAULT;
}

@Injectable()
export class LeaderboardScheduler {
  private readonly logger = new Logger(LeaderboardScheduler.name);

  constructor(private readonly leaderboard: LeaderboardService) {}

  @Cron(resolveCron(), {
    name: 'leaderboard-nightly-recompute',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if ((process.env.LEADERBOARD_ENABLED ?? 'on').toLowerCase() === 'off') {
      this.logger.log('Leaderboard scoring disabled by env flag — skipping nightly run');
      return;
    }

    this.logger.log('Leaderboard nightly recompute: starting');
    try {
      const { computed, errors } = await this.leaderboard.recomputeAll();
      this.logger.log(
        `Leaderboard nightly recompute: completed; computed=${computed} errors=${errors}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Leaderboard nightly recompute: fatal error: ${msg}`);
    }
  }
}
