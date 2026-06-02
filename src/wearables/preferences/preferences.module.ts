import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';

/**
 * PR-HK-3a — wearable preferred-source override module.
 *
 * Mounts `POST /v1/wearables/preferences` + `DELETE …/:metric`. The service
 * writes the PR-HK-0 `WearableUserMetricPreference` table (idempotent upsert
 * on the unique (user, metric) key). PrismaService is @Global. AuthModule is
 * imported for the JwtAuthGuard wiring.
 */
@Module({
  imports: [AuthModule],
  controllers: [PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
