/**
 * VideoModule — owner-facing Mux ingest + Mux webhook.
 *
 * Exports MuxService for consumption by ExerciseCatalogModule (detail
 * route mints playback URLs) and WorkoutBuilderModule (assignment reads
 * enrich exercises with playback URLs).
 */

import { Global, Module } from '@nestjs/common';
import { MuxService } from './mux.service';
import { MuxWebhookController } from './mux-webhook.controller';

@Global()
@Module({
  controllers: [MuxWebhookController],
  providers: [MuxService],
  exports: [MuxService],
})
export class VideoModule {}
