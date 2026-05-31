import { Module, Provider } from '@nestjs/common';
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
 * editing that file, this module CONTRIBUTES its {@link wahooConnectorDef}
 * into the `WEARABLE_CONNECTORS` multi-provider collection via DI
 * multi-injection. No connector ever edits the registry.
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
    // Multi-injection contribution into the connector registry collection.
    // `multi` is a valid runtime option on Nest providers but is absent from
    // this @nestjs/common version's Provider typings, so we assert the shape.
    {
      provide: WEARABLE_CONNECTORS,
      useExisting: WahooConnector,
      multi: true,
    } as unknown as Provider,
  ],
  exports: [WahooConnector, WEARABLE_CONNECTORS],
})
export class WahooModule {
  /** Re-exported for convenience so a registry can read the def by value. */
  static readonly definition = wahooConnectorDef;
}
