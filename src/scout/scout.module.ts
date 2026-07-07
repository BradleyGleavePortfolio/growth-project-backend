import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ScoutController } from './scout.controller';
import { ScoutService } from './scout.service';

// IMPORTER-E — scout progress + completion module (DESIGN.md v0.3 §10 + §2).
//
// PrismaService (PrismaModule) and AnalyticsService (AnalyticsModule) are
// @Global, so only NotificationsModule needs an explicit import to reach
// NotificationsService.pushToUser for the import.complete push. ScheduleModule
// is loaded once at the app root, so the service's @Interval flush tick is
// picked up without importing it here.
//
// NOTE (merge coordination): Lane 3's PR-B (IMPORTER-B) introduces the sibling
// POST /api/scout/ingest under the same src/scout module + FEATURE_SCOUT_INGEST
// flag. When both land, fold these providers/controllers into one ScoutModule.
@Module({
  imports: [NotificationsModule],
  controllers: [ScoutController],
  providers: [ScoutService],
})
export class ScoutModule {}
