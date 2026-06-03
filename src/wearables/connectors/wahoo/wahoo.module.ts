import { Module } from '@nestjs/common';
import { IngestionService } from '../../ingestion/ingestion.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { WahooConnector } from './wahoo.connector';
import { WahooWebhookController } from './wahoo-webhook.controller';
import { wahooConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.h — standalone Wahoo connector module.
 *
 * Self-contained and file-disjoint: this module wires the Wahoo connector, its
 * webhook controller, and its registry contribution. It is intentionally NOT
 * imported by `wearables.module.ts` in this PR — wiring all landed connector
 * modules in one place is a coordinated, mutex-prone edit reserved for the
 * final integration PR. See `index.ts` for the one-line wiring instruction.
 *
 * Registry integration (PR-HK-1 owns `connector-registry.ts`): rather than
 * editing that file, this module CONTRIBUTES its {@link wahooConnectorDef} by
 * binding it as a VALUE to PR-HK-1's canonical {@link WEARABLE_CONNECTORS}
 * token. PR-HK-1's `ConnectorRegistry` enumerates every provider whose
 * injection token is `WEARABLE_CONNECTORS` across all loaded modules via Nest's
 * `DiscoveryService` and indexes the discovered {@link ConnectorDefinition}s by
 * provider at boot — no edit to the registry file, no local token.
 *
 * Dependencies (`IngestionService`, `ProviderHttpClient`) are re-provided here
 * so the module is independently testable; when imported under WearablesModule
 * (which exports both), Nest reuses the singletons.
 */
@Module({
  controllers: [WahooWebhookController],
  providers: [
    ProviderHttpClient,
    IngestionService,
    WahooConnector,
    // Registry contribution: bind Wahoo's canonical ConnectorDefinition VALUE to
    // PR-HK-1's `WEARABLE_CONNECTORS` token. `DiscoveryService` discovers it by
    // token at boot (connector-registry.ts); the registry fails loud on
    // duplicate providers, so each connector binds exactly one definition.
    { provide: WEARABLE_CONNECTORS, useValue: wahooConnectorDef },
  ],
  exports: [WahooConnector, WEARABLE_CONNECTORS],
})
export class WahooModule {
  /** Re-exported for convenience so a registry can read the def by value. */
  static readonly definition = wahooConnectorDef;
}
