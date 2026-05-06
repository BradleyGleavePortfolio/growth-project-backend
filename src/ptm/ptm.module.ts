import { Global, Module } from '@nestjs/common';
import { PtmService } from './ptm.service';
import { PtmHeuristicService } from './ptm-heuristic.service';
import { PtmWeightedService } from './ptm-weighted.service';
import { PtmRecomputeService } from './ptm-recompute.service';
import { PtmScheduler } from './ptm.scheduler';

/**
 * PTM module — Phase 1 Predictive Tracking Model.
 *
 * Marked @Global so the six signal-emitting modules (check-ins, weight,
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
 */
@Global()
@Module({
  providers: [
    PtmService,
    PtmHeuristicService,
    PtmWeightedService,
    PtmRecomputeService,
    PtmScheduler,
  ],
  exports: [
    PtmService,
    PtmHeuristicService,
    PtmWeightedService,
    PtmRecomputeService,
  ],
})
export class PtmModule {}
