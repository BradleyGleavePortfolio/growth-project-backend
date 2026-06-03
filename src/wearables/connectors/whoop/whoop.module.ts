import { Module, forwardRef } from '@nestjs/common';
import { WearablesModule } from '../../wearables.module';
import { WhoopConnector } from './whoop.connector';
import { WhoopWebhookController } from './whoop-webhook.controller';
import { whoopConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.l — WHOOP connector module.
 *
 * Self-contained, file-disjoint provider module (same isolation pattern as
 * Oura PR-HK-2.k): it provides the {@link WhoopConnector} and mounts the
 * {@link WhoopWebhookController}. It does NOT edit `wearables.module.ts` or a
 * connector registry — those shared touches are out of this PR's write-set,
 * so 14+ connector PRs land in parallel without merge conflicts.
 *
 * Dependencies:
 *  - {@link WearablesModule} exports {@link ProviderHttpClient} (the single
 *    hardened HTTP client) — imported so the connector can inject it.
 *  - PrismaService is global (@Global PrismaModule) — the webhook controller
 *    injects it directly for dedup + revocation.
 *
 * Registry integration (P0-0B): this module CONTRIBUTES {@link whoopConnectorDef}
 * by binding it as a VALUE to PR-HK-1's canonical {@link WEARABLE_CONNECTORS}
 * token; PR-HK-1's `ConnectorRegistry` discovers it by token via Nest's
 * `DiscoveryService` and indexes it by provider at boot.
 *
 * Module cycle (P0-0B): this module imports {@link WearablesModule} (for the
 * shared `ProviderHttpClient` seam) while `WearablesModule` now imports
 * `WhoopModule` to mount the connector — a two-way reference. Both sides use
 * `forwardRef(() => …)` so Nest resolves the cycle at boot rather than throwing
 * an undefined-module error.
 */
@Module({
  imports: [forwardRef(() => WearablesModule)],
  controllers: [WhoopWebhookController],
  providers: [
    WhoopConnector,
    // Registry contribution: bind WHOOP's canonical ConnectorDefinition VALUE
    // to PR-HK-1's `WEARABLE_CONNECTORS` token (discovered by token at boot).
    { provide: WEARABLE_CONNECTORS, useValue: whoopConnectorDef },
  ],
  exports: [WhoopConnector, WEARABLE_CONNECTORS],
})
export class WhoopModule {}
