import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { DataExportCleanupCron } from './data-export-cleanup.cron';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * DataExportModule — GDPR Article 20 right to data portability.
 *
 * Exposes three endpoints:
 *   POST /me/data-export/request    — enqueue a new export job
 *   GET  /me/data-export/status     — poll the latest request status
 *   GET  /me/data-export/download   — redirect to signed S3 URL (token-gated)
 *
 * The heavy lift (building the JSON archive) runs inside DataExportService
 * which streams data per-model from Prisma so memory usage stays flat even
 * for users with tens of thousands of rows.
 *
 * GDPR dependency note: this module is a hard dependency for the GDPR delete
 * module (src/gdpr/). Users should export their data BEFORE deleting their
 * account. See docs/compliance/data-portability.md for the full contract.
 */
@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [DataExportController],
  providers: [DataExportService, DataExportCleanupCron],
  exports: [DataExportService],
})
export class DataExportModule {}
