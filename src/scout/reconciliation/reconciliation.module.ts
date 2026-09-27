import { Module } from '@nestjs/common';
import { ReconciliationFactsService } from './facts.service';

/**
 * S9-B — the reconciliation facts module (S9-DOC D-S9-1 "a facts service collects its input").
 *
 * Provides and exports {@link ReconciliationFactsService} only. It is imported by nothing at this
 * head: S9-C owns the wiring into `ScoutModule` / the S8-G settle transaction and the status read
 * path (D-S9-8 path list), so `scout.module.ts`, the lifecycle hooks, the status DTO and the
 * contract generator are untouched by S9-B. The service's registries default to the
 * repository-resident source-mapping specs and native rule sets; a consumer that needs another
 * registry provides `RECONCILIATION_FACTS_OPTIONS` (`@Optional()` in the service) alongside this
 * module — the same seam the unit spec and the G2 proof worker use. No controller, no writer, no
 * persistence (D-S9-5, no report table).
 */
@Module({
  providers: [ReconciliationFactsService],
  exports: [ReconciliationFactsService],
})
export class ReconciliationModule {}
