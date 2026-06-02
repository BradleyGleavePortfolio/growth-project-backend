import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { IngestionService } from '../ingestion/ingestion.service';
import { WearableSamplesController } from './wearable-samples.controller';
import { WearableSamplesService } from './wearable-samples.service';

/**
 * PR-HK-3a — wearable samples read module.
 *
 * Mounts `GET /v1/wearables/samples`. The service composes:
 *  - {@link IngestionService} (PR-HK-0) for the read-time `resolveBest`
 *    precedence policy — provided here so this module is self-contained and
 *    independently mountable (PrismaService is @Global, so IngestionService
 *    constructs without importing PrismaModule).
 *  - PrismaService (@Global) for the direct sample / connection / metric-def
 *    reads + the date_trunc aggregation.
 *
 * AuthModule is imported for the JwtAuthGuard wiring (same pattern as the
 * insights + connections modules).
 */
@Module({
  imports: [AuthModule],
  controllers: [WearableSamplesController],
  providers: [WearableSamplesService, IngestionService],
  exports: [WearableSamplesService],
})
export class SamplesModule {}
