import { Module } from '@nestjs/common';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagsTelemetry } from './feature-flags.telemetry';

/**
 * D5 = B+γ — server-evaluated feature flags (GET /me/feature-flags).
 *
 * JwtAuthGuard + RolesGuard are registered globally as APP_GUARD (Phase 10),
 * so no AuthModule import is needed here. AnalyticsModule is @Global, so
 * FeatureFlagsTelemetry can inject AnalyticsService without an explicit import.
 */
@Module({
  controllers: [FeatureFlagsController],
  providers: [FeatureFlagsService, FeatureFlagsTelemetry],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
