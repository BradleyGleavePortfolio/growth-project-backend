import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WearableProcessedEventPruneService } from './wearable-processed-event-prune.service';

// Daily cron tick that drives the WearableProcessedEvent retention prune. The
// prune itself (cutoff math + deleteMany) lives in
// WearableProcessedEventPruneService — this class is intentionally a thin
// wrapper whose only job is to fire once a day, log the report, and swallow any
// fatal error so a database hiccup never crashes the Nest process. This is the
// same shape as GdprScrubScheduler and BloodworkStaleScheduler.
//
// Scheduled at 04:00 UTC: the original nightly stagger filled 03:00–03:45, so
// this prune takes the next free 15-minute slot. The stagger keeps the
// connection pool from being hit by several write-heavy sweeps at once.
//
// Stagger policy (alphabetical by class name, 15-minute windows):
//   AccountDeletionService               -> 03:00
//   BloodworkStaleScheduler              -> 03:15
//   DataExportCleanupCron                -> 03:30
//   GdprScrubScheduler                   -> 03:45
//   WearableProcessedEventPruneScheduler -> 04:00 (this)
//
// (The 03:45 slot is taken by GdprScrubScheduler; 'W' sorts last and rolls
// over into the next free 15-minute window at 04:00.)
//
// Idempotency: prune() deletes only rows already past the retention cutoff.
// Once a row is deleted it can never re-enter the candidate set, so re-running
// on the same tick — or catching up after a missed tick — is safe and a no-op
// for already-pruned rows.
export const WEARABLE_PROCESSED_EVENT_PRUNE_CRON_EXPRESSION = '0 4 * * *';

@Injectable()
export class WearableProcessedEventPruneScheduler {
  private readonly logger = new Logger(
    WearableProcessedEventPruneScheduler.name,
  );

  constructor(
    private readonly prune: WearableProcessedEventPruneService,
  ) {}

  @Cron(WEARABLE_PROCESSED_EVENT_PRUNE_CRON_EXPRESSION, {
    name: 'wearable-processed-event-prune-daily',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    try {
      const { deleted, cutoff } = await this.prune.prune(new Date());
      this.logger.log({
        event: 'wearable_processed_event_prune',
        deleted_count: deleted,
        cutoff_iso: cutoff.toISOString(),
      });
    } catch (err) {
      this.logger.error({
        event: 'wearable_processed_event_prune_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
