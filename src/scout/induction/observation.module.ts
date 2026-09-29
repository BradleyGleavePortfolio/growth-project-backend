import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { JwksVerifierService } from '../../auth/jwks.service';
import { RolesGuard } from '../../auth/roles.guard';
import { ScoutLifecycleService } from '../lifecycle/lifecycle.service';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { SourceRegistryModule } from '../reconstruct/source-registry.module';
import { ScoutReconstructService } from '../scout-reconstruct.service';
import { ObservationController } from './observation.controller';
import { ObservationService } from './observation.service';

// S10-B — the induction routes (POST /api/scout/runs/declaration|observation;
// docs/decisions/2026-09-26-s10-induction.md D-S10-4). Self-contained like ScoutModule: the
// guards are provided locally (the MacrosModule pattern); PrismaService comes from the @Global
// PrismaModule (S10-C, review B A1: one shared PrismaClient and pool, not a module-local one);
// AnalyticsService is @Global; ScoutLifecycleService is provided here for the shared run
// refusals (`classifyClosed` / `closedConflict`) and is never asked to settle from this module. It imports NO notification, drip, email, messaging,
// workout-builder, AI or billing module (D-S10-6 invariant 5, R38).
//
// Registration: the doc assigns the ScoutModule import of this module to S10-C (D-S10-7);
// S10-C imports it from ScoutModule, which is what mounts the routes.
//
// L2a: the induction registry is the `induction` partition of the one SourceRegistryProvider
// (D-L0-5), shared through SourceRegistryModule.
//
// L2a r2 (R588-B-2): the lifecycle no longer constructs its own engine or facts service (those
// held a process-default registry that could never see a run's pin). Its interpreters are
// required and injected here: the engine is provided in this module and the facts service comes
// from ReconciliationModule, both over the one module-shared SourceRegistryProvider. Neither
// module is a messaging/notification/AI/billing module (invariant 5 unchanged).
@Module({
  imports: [SourceRegistryModule, ReconciliationModule],
  controllers: [ObservationController],
  providers: [
    ObservationService,
    ScoutLifecycleService,
    ScoutReconstructService,
    JwtAuthGuard,
    RolesGuard,
    JwksVerifierService,
  ],
  exports: [ObservationService],
})
export class ObservationModule {}
