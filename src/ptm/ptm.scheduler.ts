import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PtmRecomputeService } from './ptm-recompute.service';

// Nightly cron tick driving the PTM recompute orchestrator. The scoring
// itself lives in PtmRecomputeService — this class is a thin wrapper
// whose only job is to fire once a night, log the report, and swallow
// any fatal error so a database hiccup never crashes the Nest process.
//
// Scheduled at 04:00 UTC by default: low-traffic window, and one hour
// after the GDPR scrub at 03:00 UTC so the two write-heavy jobs don't
// compete for the connection pool. Override with PTM_SCORING_CRON.
//
// Idempotency: PtmPrediction is APPEND-ONLY. Re-running on the same
// tick (or catching up after a missed tick) writes additional rows
// rather than corrupting state. The risk board UI reads
// ORDER BY computed_at DESC LIMIT 1 so duplicate rows are harmless.
//
// Disable: set PTM_SCORING_ENABLED='false'. The cron handler logs and
// returns without invoking PtmRecomputeService — useful as a kill
// switch when a heuristic regression ships.

export const PTM_SCORING_CRON_DEFAULT = '0 4 * * *';

function resolveCronExpression(): string {
  const raw = process.env.PTM_SCORING_CRON;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return PTM_SCORING_CRON_DEFAULT;
}

@Injectable()
export class PtmScheduler {
  private readonly logger = new Logger(PtmScheduler.name);

  constructor(private readonly recompute: PtmRecomputeService) {}

  // Cron expression at decoration time is read from env at module-load.
  // The constant default is the canonical fallback so the @Cron metadata
  // is stable for tests; PTM_SCORING_CRON is honored at runtime by the
  // resolver below (re-decoration would require a Nest dynamic module).
  @Cron(resolveCronExpression(), {
    name: 'ptm-recompute-nightly',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if ((process.env.PTM_SCORING_ENABLED ?? '').toLowerCase() === 'false') {
      this.logger.log('PTM scoring disabled by env flag');
      return;
    }
    this.logger.log('PTM recompute cron tick: starting nightly run');
    try {
      const report = await this.recompute.recomputeBatch();
      this.logger.log(
        `PTM recompute cron tick: completed; considered=${report.considered} recomputed=${report.recomputed} errors=${report.errors}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`PTM recompute cron tick: fatal error: ${message}`);
    }
  }
}
