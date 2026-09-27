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
import { ScoutReconstructController } from './scout-reconstruct.controller';
import { ScoutReconstructService } from './scout-reconstruct.service';
import { ScoutRosterController } from './scout-roster.controller';
import { ScoutRosterService } from './scout-roster.service';
import { ScoutEntitiesController } from './scout-entities.controller';
import { ScoutEntitiesService } from './scout-entities.service';
import { ScoutLifecycleService } from './lifecycle/lifecycle.service';
import { ScoutRunController } from './lifecycle/run.controller';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ObservationModule } from './induction/observation.module';

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
//
// S7-L: ScoutRunController / ScoutLifecycleService own the server-run lifecycle
// (POST /api/scout/runs/start|cancel, the writer gate, fences and the one
// terminal write). ScoutService and ScoutIngestService take the lifecycle
// service as an optional dependency: absent (as in their pre-S7-L unit specs)
// they construct their own, so legacy behaviour is unchanged either way.
//
// S9-C: ReconciliationModule provides the read-only ReconciliationFactsService
// the lifecycle service reconciles from (settle tail and recompute-on-read);
// it is another optional constructor dependency with the same fallback rule.
//
// S10-C: ObservationModule mounts the two induction routes (POST
// /api/scout/runs/declaration|observation; S10-DOC D-S10-4, D-S10-7 row S10-C).
// It is self-contained (its own guards, PrismaService and lifecycle provider)
// and imports no notification, drip, email or messaging module (D-S10-6
// invariant 5); this import is the only S10 change to ScoutModule.
@Module({
  imports: [NotificationsModule, ReconciliationModule, ObservationModule],
  controllers: [
    ScoutController,
    ScoutIngestController,
    ScoutReconstructController,
    ScoutRosterController,
    ScoutEntitiesController,
    ScoutRunController,
  ],
  providers: [
    ScoutLifecycleService,
    ScoutService,
    ScoutIngestService,
    ScoutReconstructService,
    ScoutRosterService,
    ScoutEntitiesService,
    PrismaService,
    JwtAuthGuard,
    RolesGuard,
    JwksVerifierService,
  ],
  exports: [ScoutIngestService],
})
export class ScoutModule {}
