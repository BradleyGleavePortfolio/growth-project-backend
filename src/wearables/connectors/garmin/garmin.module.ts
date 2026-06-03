import { Module, forwardRef } from '@nestjs/common';
import { WearablesModule } from '../../wearables.module';
import { GarminConnector } from './garmin.connector';
import { GarminWebhookController } from './garmin-webhook.controller';
import { garminConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.d — Garmin connector module.
 *
 * Self-contained, file-disjoint provider module (same isolation pattern as
 * Oura PR-HK-2.k / WHOOP PR-HK-2.l): it provides the {@link GarminConnector}
 * and mounts the {@link GarminWebhookController}. It does NOT edit
 * `wearables.module.ts` or a connector registry — those shared touches are out
 * of this PR's write-set, so the connector PRs land in parallel without merge
 * conflicts.
 *
 * Dependencies:
 *  - {@link WearablesModule} exports {@link ProviderHttpClient} (the single
 *    hardened HTTP client), {@link IngestionService}, and {@link KmsService}
 *    wiring — imported so the connector + webhook controller can inject them.
 *  - PrismaService is global (@Global PrismaModule) — the webhook controller
 *    injects it directly for idempotency + revocation.
 *
 * Registry integration (P0-0B): this module CONTRIBUTES {@link garminConnectorDef}
 * by binding it as a VALUE to PR-HK-1's canonical {@link WEARABLE_CONNECTORS}
 * token; PR-HK-1's `ConnectorRegistry` discovers it by token via Nest's
 * `DiscoveryService` and indexes it by provider at boot.
 *
 * Module cycle (P0-0B): this module imports {@link WearablesModule} (for the
 * shared `ProviderHttpClient` / `IngestionService` seam) while `WearablesModule`
 * now imports `GarminModule` to mount the connector — a two-way reference. Both
 * sides use `forwardRef(() => …)` so Nest resolves the cycle at boot rather than
 * throwing an undefined-module error.
 */
@Module({
  imports: [forwardRef(() => WearablesModule)],
  controllers: [GarminWebhookController],
  providers: [
    GarminConnector,
    // Registry contribution: bind Garmin's canonical ConnectorDefinition VALUE
    // to PR-HK-1's `WEARABLE_CONNECTORS` token (discovered by token at boot).
    { provide: WEARABLE_CONNECTORS, useValue: garminConnectorDef },
  ],
  exports: [GarminConnector, WEARABLE_CONNECTORS],
})
export class GarminModule {}
