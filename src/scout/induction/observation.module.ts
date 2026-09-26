import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { JwksVerifierService } from '../../auth/jwks.service';
import { RolesGuard } from '../../auth/roles.guard';
import { PrismaService } from '../../prisma.service';
import { ScoutLifecycleService } from '../lifecycle/lifecycle.service';
import { ObservationController } from './observation.controller';
import { ObservationService } from './observation.service';

// S10-B — the induction routes (POST /api/scout/runs/declaration|observation;
// docs/decisions/2026-09-26-s10-induction.md D-S10-4). Self-contained like ScoutModule: the
// guards and PrismaService are provided locally (the MacrosModule pattern), AnalyticsService is
// @Global, and ScoutLifecycleService is provided here for the shared run refusals
// (`classifyClosed` / `closedConflict`); it constructs its own reconstruct engine and is never
// asked to settle from this module. It imports NO notification, drip, email, messaging,
// workout-builder, AI or billing module (D-S10-6 invariant 5, R38).
//
// Registration: the doc assigns the ScoutModule import of this module to S10-C (D-S10-7), so
// S10-B ships it unregistered and the routes stay unmounted until S10-C lands.
@Module({
  controllers: [ObservationController],
  providers: [
    ObservationService,
    ScoutLifecycleService,
    PrismaService,
    JwtAuthGuard,
    RolesGuard,
    JwksVerifierService,
  ],
  exports: [ObservationService],
})
export class ObservationModule {}
