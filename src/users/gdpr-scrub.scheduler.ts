import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GdprScrubService } from './gdpr-scrub.service';

// Daily cron tick that drives the GDPR PII-scrub worker. The scrub
// itself (selection, transactional tombstoning, audit emission) lives
// in GdprScrubService — this class is intentionally a thin wrapper
// whose only job is to fire once a day, log the report, and swallow
// any fatal error so a database hiccup never crashes the Nest process.
//
// Scheduled at 03:00 UTC: low-traffic window across the regions we
// serve, and well clear of the nightly Stripe webhook reconciliation
// (~02:00 UTC) so the two write-heavy jobs don't compete for the
// connection pool.
//
// Idempotency: GdprScrubService.run() selects only rows whose
// deletion_scheduled_at is past the 30-day cutoff AND whose deleted_at
// is still null — once a user is scrubbed, deleted_at is set and the
// row drops out of the candidate set. Re-running on the same tick (or
// catching up after a missed tick) is therefore safe.
export const GDPR_SCRUB_CRON_EXPRESSION = '0 3 * * *';

@Injectable()
export class GdprScrubScheduler {
  private readonly logger = new Logger(GdprScrubScheduler.name);

  constructor(private readonly scrub: GdprScrubService) {}

  @Cron(GDPR_SCRUB_CRON_EXPRESSION, {
    name: 'gdpr-scrub-daily',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    this.logger.log('GDPR scrub cron tick: starting daily run');
    try {
      const report = await this.scrub.run({});
      this.logger.log(
        `GDPR scrub cron tick: completed; scrubbed=${report.scrubbed} considered=${report.considered} errors=${report.errors.length}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`GDPR scrub cron tick: fatal error: ${message}`);
    }
  }
}
