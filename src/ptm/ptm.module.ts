import { Global, Module, forwardRef } from '@nestjs/common';
import { PtmService } from './ptm.service';
import { PtmHeuristicService } from './ptm-heuristic.service';
import { PtmWeightedService } from './ptm-weighted.service';
import { PtmRecomputeService } from './ptm-recompute.service';
import { PtmScheduler } from './ptm.scheduler';
import { CoachModule } from '../coach/coach.module';
import { COACH_ALERTS_SERVICE } from './ptm-recompute.service';
import { CoachAlertsService } from '../coach/coach-alerts.service';

/**
 * PTM module — Phase 1 Predictive Tracking Model.
 *
 * Marked @Global so the signal-emitting modules (check-ins, weight,
 * workout, food/log, messaging, finance — and any future caller) can
 * inject `PtmService` without first listing PtmModule among their
 * imports. PrismaService is already global, so this module needs no
 * imports of its own.
 *
 * Public surface:
 *   - PtmService           — fire-and-forget recordSignal + score reads (1A)
 *   - PtmHeuristicService  — heuristic_v1 scoring engine (1B)
 *   - PtmWeightedService   — weighted_v2 scoring engine, activates at >=20 outcomes (1D)
 *   - PtmRecomputeService  — orchestrator: chooses engine, writes prediction row (1B/1D)
 *   - PtmScheduler         — nightly @Cron tick driving PtmRecomputeService (1B)
 *
 * The OWNER-only admin teaching endpoints (POST /admin/clients/:id/outcome,
 * GET /admin/ptm/risk-board, etc.) live in src/admin/ptm/ and import
 * the services exported here — see src/ptm/README.md for the surface map.
 *
 * Phase 6B — coach red-flag alert hook. CoachModule is imported and the
 * COACH_ALERTS_SERVICE token is bound to CoachAlertsService so
 * PtmRecomputeService can inject the alert writer with
 * @Optional() @Inject(COACH_ALERTS_SERVICE). The token + structural
 * interface live next to the recompute service so downstream tests can
 * stand in a minimal fake without pulling Coach DI.
 */
@Global()
@Module({
  imports: [forwardRef(() => CoachModule)],
  providers: [
    PtmService,
    PtmHeuristicService,
    PtmWeightedService,
    PtmRecomputeService,
    PtmScheduler,
    {
      provide: COACH_ALERTS_SERVICE,
      useExisting: CoachAlertsService,
    },
  ],
  exports: [
    PtmService,
    PtmHeuristicService,
    PtmWeightedService,
    PtmRecomputeService,
    COACH_ALERTS_SERVICE,
  ],
})
export class PtmModule {}
