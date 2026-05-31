import { Module, Provider } from '@nestjs/common';
import { IngestionService } from '../../ingestion/ingestion.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { PolarConnector } from './polar.connector';
import { PolarWebhookController } from './polar-webhook.controller';
import { polarConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.g — standalone Polar connector module.
 *
 * Self-contained and file-disjoint: this module wires the Polar connector, its
 * webhook controller, and its registry contribution. It is intentionally NOT
 * imported by `wearables.module.ts` in this PR — wiring all landed connector
 * modules in one place is a coordinated, mutex-prone edit reserved for the
 * final integration PR (PR-HK-1-wire). See `index.ts` for the one-line wiring
 * instruction.
 *
 * Registry integration (PR-HK-1 owns `connector-registry.ts`): rather than
 * editing that file, this module CONTRIBUTES its {@link polarConnectorDef}
 * into the `WEARABLE_CONNECTORS` multi-provider collection via DI
 * multi-injection. Once PR-HK-1 + the wire PR land, the registry reads every
 * module's contribution through that token — no connector ever edits the
 * registry.
 *
 * Dependencies (`IngestionService`, `ProviderHttpClient`) are re-provided here
 * so the module is independently testable; when imported under WearablesModule
 * (which exports both), Nest reuses the singletons.
 */
@Module({
  controllers: [PolarWebhookController],
  providers: [
    ProviderHttpClient,
    IngestionService,
    PolarConnector,
    // Multi-injection contribution into the connector registry collection.
    // `multi` is a valid runtime option on Nest providers but is absent from
    // this @nestjs/common version's Provider typings, so we assert the shape.
    {
      provide: WEARABLE_CONNECTORS,
      useExisting: PolarConnector,
      multi: true,
    } as unknown as Provider,
  ],
  exports: [PolarConnector, WEARABLE_CONNECTORS],
})
export class PolarModule {
  /** Re-exported for convenience so a registry can read the def by value. */
  static readonly definition = polarConnectorDef;
}
