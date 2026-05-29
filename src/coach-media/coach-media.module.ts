/**
 * PR-12 — CoachMediaModule.
 *
 * Wires the coach-media upload pipeline:
 *   - STORAGE_PROVIDER → SupabaseStorageProvider (decision #5 binding).
 *     If we ever switch to S3, only this binding changes.
 *   - CoachMediaService — orchestrates PDF + Mux flows behind the seam.
 *   - CoachMediaController — owner endpoints.
 *   - CoachMediaMuxWebhookController — Mux webhook (sig + durable
 *     idempotency via MuxProcessedEvent).
 *
 * Exports CoachMediaService so PR-13 (mobile delivery endpoints) and any
 * future buyer-facing controller can inject it and call
 * getBuyerSignedUrl(). Marked @Global so consumers don't need to import
 * this module explicitly.
 *
 * Module imports: nothing — Prisma, Supabase, Mux, and SubCoachScope are
 * all @Global. The guards used by the controller come from the @Global
 * SecurityGuardsModule already wired in AppModule.
 */

import { Global, Module } from '@nestjs/common';
import { CoachMediaController } from './coach-media.controller';
import { CoachMediaMuxWebhookController } from './coach-media-mux-webhook.controller';
import { CoachMediaService } from './coach-media.service';
import { SupabaseStorageProvider } from './supabase-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider';

@Global()
@Module({
  imports: [],
  controllers: [CoachMediaController, CoachMediaMuxWebhookController],
  providers: [
    SupabaseStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      useExisting: SupabaseStorageProvider,
    },
    CoachMediaService,
  ],
  exports: [CoachMediaService, STORAGE_PROVIDER],
})
export class CoachMediaModule {}
