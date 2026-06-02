import { Module } from '@nestjs/common';
import { IngestionService } from '../../ingestion/ingestion.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { FitbitConnector } from './fitbit.connector';
import { FitbitWebhookController } from './fitbit-webhook.controller';
import { fitbitConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.e — standalone Fitbit connector module.
 *
 * Self-contained and file-disjoint: this module wires the Fitbit connector, its
 * webhook controller, and its registry contribution. It is intentionally NOT
 * imported by `wearables.module.ts` in this PR — wiring all landed connector
 * modules in one place is a coordinated, mutex-prone edit reserved for the
 * final integration PR (PR-HK-1-wire). See `index.ts` for the one-line wiring
 * instruction.
 *
 * Registry integration (PR-HK-1 owns `connector-registry.ts`): rather than
 * editing that file, this module CONTRIBUTES its {@link fitbitConnectorDef} by
 * binding it as a VALUE to PR-HK-1's canonical {@link WEARABLE_CONNECTORS}
 * token. PR-HK-1's `ConnectorRegistry` enumerates every provider whose
 * injection token is `WEARABLE_CONNECTORS` across all loaded modules via Nest's
 * `DiscoveryService` and indexes the discovered {@link ConnectorDefinition}s by
 * provider at boot. Binding the canonical token to a value satisfying that
 * contract is therefore sufficient for `ConnectorRegistry.has(FITBIT)` to be
 * true once this module is loaded — no edit to the registry file, no local
 * token.
 *
 * Dependencies (`IngestionService`, `ProviderHttpClient`) are re-provided here
 * so the module is independently testable; when imported under WearablesModule
 * (which exports both), Nest reuses the singletons.
 */
@Module({
  controllers: [FitbitWebhookController],
  providers: [
    ProviderHttpClient,
    IngestionService,
    FitbitConnector,
    // Registry contribution: bind Fitbit's ConnectorDefinition VALUE to
    // PR-HK-1's canonical `WEARABLE_CONNECTORS` token. `DiscoveryService`
    // discovers it by token at boot (connector-registry.ts) — last-wins is a
    // non-issue because each provider binds exactly one definition and the
    // registry fails loud on duplicate providers.
    { provide: WEARABLE_CONNECTORS, useValue: fitbitConnectorDef },
  ],
  exports: [FitbitConnector, WEARABLE_CONNECTORS],
})
export class FitbitModule {
  /** Re-exported for convenience so a registry can read the def by value. */
  static readonly definition = fitbitConnectorDef;
}
