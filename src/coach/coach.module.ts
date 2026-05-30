import { Module, forwardRef } from '@nestjs/common';
import { CoachController } from './coach.controller';
import { CoachService } from './coach.service';
import { CoachEffectivenessService } from './coach-effectiveness.service';
import { CoachEffectivenessScheduler } from './coach-effectiveness.scheduler';
import { CoachAlertsService } from './coach-alerts.service';
import { CoachAlertsController } from './coach-alerts.controller';
import { CoachOnboardingService } from './coach-onboarding.service';
import { CoachOnboardingController } from './coach-onboarding.controller';
// Stage 3 — coach-facing cross-pillar federation. Reuses FederationService
// and FinanceAdminClient from AdminModule (already imported via forwardRef).
import { CrossPillarController } from './cross-pillar/cross-pillar.controller';
import { CrossPillarService } from './cross-pillar/cross-pillar.service';
import { CrossPillarPracticeGuard } from './cross-pillar/cross-pillar-practice.guard';
import { PracticeTypeController } from './practice-type/practice-type.controller';
import { PracticeTypeService } from './practice-type/practice-type.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminModule } from '../admin/admin.module';
// EFF-3: SubCoachScopeService resolves the authorized client roster for a
// coach (head → full roster; sub → assigned). SubCoachModule is @Global so
// the provider is reachable, but we import it explicitly here so the
// CoachEffectivenessService dependency is declared at the module we own.
import { SubCoachModule } from '../sub-coach/sub-coach.module';
// EFF-2: coach-facing self-service effectiveness route.
import { CoachEffectivenessController } from './coach-effectiveness.controller';
// LTV metrics suite — Coach Command Center revenue dashboard
import { LtvMetricsController } from './command-center/ltv-metrics.controller';
import { LtvMetricsService } from './command-center/ltv-metrics.service';
// Coach Command Center — 5 P0 endpoints + churn intervention flow
import { CommandCenterController } from './command-center/command-center.controller';
import { CommandCenterService } from './command-center/command-center.service';
import { ChurnInterventionService } from './command-center/churn-intervention.service';

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
//
// LTV metrics addition:
//   * LtvMetricsService — computes the LTV metrics suite from ClientPurchase data
//   * LtvMetricsController — exposes GET /coach/command-center/ltv-metrics
@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    forwardRef(() => AdminModule),
    SubCoachModule,
  ],
  controllers: [
    CoachController,
    CoachAlertsController,
    CoachOnboardingController,
    // EFF-2 — GET /coach/my-effectiveness (coach-role-guarded)
    CoachEffectivenessController,
    // Stage 3
    CrossPillarController,
    PracticeTypeController,
    // LTV metrics
    LtvMetricsController,
    // Command Center P0 endpoints
    CommandCenterController,
  ],
  providers: [
    CoachService,
    CoachEffectivenessService,
    CoachEffectivenessScheduler,
    CoachAlertsService,
    CoachOnboardingService,
    // Stage 3
    CrossPillarService,
    CrossPillarPracticeGuard,
    PracticeTypeService,
    // LTV metrics
    LtvMetricsService,
    // Command Center
    CommandCenterService,
    ChurnInterventionService,
  ],
  exports: [
    CoachEffectivenessService,
    CoachAlertsService,
    CoachOnboardingService,
  ],
})
export class CoachModule {}
