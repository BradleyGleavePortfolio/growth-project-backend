import { Module, forwardRef } from '@nestjs/common';
import { CoachController } from './coach.controller';
import { CoachService } from './coach.service';
import { CoachEffectivenessService } from './coach-effectiveness.service';
import { CoachEffectivenessScheduler } from './coach-effectiveness.scheduler';
import { CoachAlertsService } from './coach-alerts.service';
import { CoachAlertsController } from './coach-alerts.controller';
import { CoachOnboardingService } from './coach-onboarding.service';
import { CoachOnboardingController } from './coach-onboarding.controller';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminModule } from '../admin/admin.module';

// PrismaService provided globally via PrismaModule.
//
// Phase 6A/6B additions:
//   * CoachEffectivenessService — per-coach scalar score (admin-only consumer)
//   * CoachEffectivenessScheduler — nightly recompute (05:00 UTC default)
//   * CoachAlertsService — proactive red-flag alert writer + ack flow
//   * CoachAlertsController — coach-facing /coach/alerts surface
//
// Phase 6B push delivery: NotificationsModule imported so CoachAlertsService
// can inject NotificationsService.pushToCoach.
//
// Phase 6D additions:
//   * CoachOnboardingService — 6-step wizard state machine; exported so
//     AdminModule.promoteUser can call startWizard() at promote time.
//   * CoachOnboardingController — coach-scoped /coach/onboarding endpoints.
//
// Phase 1E addition:
//   * AdminModule is imported with forwardRef() to break the
//     CoachModule ↔ AdminModule circular reference. CoachModule needs
//     AdminPtmService (for the coach-scoped risk board); AdminModule
//     needs CoachModule (for CoachOnboardingService and CoachAlertsService).
//   * AdminPtmService is resolved from the AdminModule export rather
//     than re-declared here so the bucket logic stays in one place.
//
// CoachAlertsService, CoachEffectivenessService, and CoachOnboardingService are
// exported so AdminModule (admin endpoints) and PtmModule (PTM-recompute →
// alert hook) can inject them.
@Module({
  imports: [AuthModule, NotificationsModule, forwardRef(() => AdminModule)],
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
