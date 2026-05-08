import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataExportService } from './data-export.service';

/**
 * Nightly cron that marks READY exports past their expiry as EXPIRED and
 * deletes the corresponding file from storage. Runs at 03:00 UTC each night
 * (one hour after the PTM recompute cron at 02:00 UTC).
 *
 * Uses DataExportService.expireOldExports() so the business logic and storage
 * deletion stay in one place and are independently testable.
 */
@Injectable()
export class DataExportCleanupCron {
  private readonly logger = new Logger(DataExportCleanupCron.name);

  constructor(private readonly dataExportService: DataExportService) {}

  @Cron('0 3 * * *', { name: 'data-export-cleanup', timeZone: 'UTC' })
  async handleCleanup(): Promise<void> {
    this.logger.log('Starting nightly data export cleanup');
    try {
      await this.dataExportService.expireOldExports();
      this.logger.log('Nightly data export cleanup complete');
    } catch (err) {
      this.logger.error(
        `Nightly data export cleanup failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
