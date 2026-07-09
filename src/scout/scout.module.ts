import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { ScoutController } from './scout.controller';
import { ScoutService } from './scout.service';
import { ScoutIngestController } from './scout-ingest.controller';
import { ScoutIngestService } from './scout-ingest.service';

// IMPORTER-E + IMPORTER-B — unified scout module (DESIGN.md v0.3 §10 + §2).
//
// Two sibling extension surfaces now live under one ScoutModule:
//   - progress mirroring + terminal completion (ScoutController / ScoutService)
//   - POST /api/scout/ingest crawl-envelope receiver (ScoutIngestController /
//     ScoutIngestService), FEATURE_SCOUT_INGEST flag.
//
// PrismaService, AnalyticsService, and PtmService are @Global. NotificationsModule
// is imported for NotificationsService.pushToUser (import.complete push).
// Providing JwtAuthGuard / RolesGuard / JwksVerifierService locally mirrors
// MacrosModule and avoids the circular-import risk of pulling AuthModule.
// ScheduleModule is loaded once at the app root, so the service's @Interval
// flush tick is picked up without importing it here.
@Module({
  imports: [NotificationsModule],
  controllers: [ScoutController, ScoutIngestController],
  providers: [
    ScoutService,
    ScoutIngestService,
    PrismaService,
    JwtAuthGuard,
    RolesGuard,
    JwksVerifierService,
  ],
  exports: [ScoutIngestService],
})
export class ScoutModule {}
