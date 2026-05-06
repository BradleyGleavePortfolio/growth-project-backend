import { Module } from '@nestjs/common';
import { CoachController } from './coach.controller';
import { CoachService } from './coach.service';
import { CoachEffectivenessService } from './coach-effectiveness.service';
import { CoachEffectivenessScheduler } from './coach-effectiveness.scheduler';
import { CoachAlertsService } from './coach-alerts.service';
import { CoachAlertsController } from './coach-alerts.controller';
import { CoachOnboardingService } from './coach-onboarding.service';
import { CoachOnboardingController } from './coach-onboarding.controller';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
//
// Phase 6A/6B additions:
//   * CoachEffectivenessService — per-coach scalar score (admin-only consumer)
//   * CoachEffectivenessScheduler — nightly recompute (05:00 UTC default)
//   * CoachAlertsService — proactive red-flag alert writer + ack flow
//   * CoachAlertsController — coach-facing /coach/alerts surface
//
// Phase 6D additions:
//   * CoachOnboardingService — 6-step wizard state machine; exported so
//     AdminModule.promoteUser can call startWizard() at promote time.
//   * CoachOnboardingController — coach-scoped /coach/onboarding endpoints.
//
// CoachAlertsService, CoachEffectivenessService, and CoachOnboardingService are
// exported so AdminModule (admin endpoints) and PtmModule (PTM-recompute →
// alert hook) can inject them.
@Module({
  imports: [AuthModule],
  controllers: [CoachController, CoachAlertsController, CoachOnboardingController],
  providers: [
    CoachService,
    CoachEffectivenessService,
    CoachEffectivenessScheduler,
    CoachAlertsService,
    CoachOnboardingService,
  ],
  exports: [
    CoachEffectivenessService,
    CoachAlertsService,
    CoachOnboardingService,
  ],
})
export class CoachModule {}
