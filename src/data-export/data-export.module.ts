import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { DataExportCleanupCron } from './data-export-cleanup.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { SupabaseService } from '../supabase/supabase.service';
import { DATA_EXPORT_ARCHIVE_STORE, selectArchiveStore } from './data-export-archive.store';

/**
 * DataExportModule — GDPR Article 20 right to data portability.
 *
 * Exposes four endpoints:
 *   POST /v1/me/data-export/request        — enqueue a new export job
 *   GET  /v1/me/data-export/status         — poll the latest request status
 *   POST /v1/me/data-export/download-link  — mint a 5-minute link (owner only)
 *   GET  /v1/me/data-export/download       — stream the archive (link token)
 *
 * Archives live in the private Supabase Storage bucket `data-exports` in
 * production (DATA_EXPORT_ARCHIVE_STORE, see data-export-archive.store.ts);
 * the machine-local directory is for development and tests only.
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
  providers: [
    {
      provide: DATA_EXPORT_ARCHIVE_STORE,
      // SupabaseModule is @Global; production always gets the private bucket.
      useFactory: (supabase: SupabaseService) => selectArchiveStore(supabase),
      inject: [SupabaseService],
    },
    DataExportService,
    DataExportCleanupCron,
  ],
  exports: [DataExportService, DATA_EXPORT_ARCHIVE_STORE],
})
export class DataExportModule {}
