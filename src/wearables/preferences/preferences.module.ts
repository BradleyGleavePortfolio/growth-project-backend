import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { InsightsModule } from '../insights/insights.module';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';

/**
 * PR-HK-3a / HK-6b — wearable preferred-source override module.
 *
 * Mounts `POST /v1/wearables/preferences` + `DELETE …/:metric`. The service
 * writes the PR-HK-0 `WearableUserMetricPreference` table (idempotent upsert
 * on the unique (user, metric) key). PrismaService is @Global. AuthModule is
 * imported for the JwtAuthGuard wiring.
 *
 * HK-6b: imports {@link InsightsModule} so the controller can inject the
 * already-exported {@link WearableInsightsService} and reuse its
 * `assertCoachOwnsClient` coach->client authorization for coach-on-behalf-of
 * writes — rather than duplicating the `user.coach_id` assignment check. The
 * dependency is one-directional (InsightsModule does not reference
 * PreferencesModule), so there is no circular-dependency risk.
 */
@Module({
  imports: [AuthModule, InsightsModule],
  controllers: [PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
