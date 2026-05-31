import { Module, Provider } from '@nestjs/common';
import { IngestionService } from '../../ingestion/ingestion.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { OuraConnector } from './oura.connector';
import { OuraWebhookController } from './oura-webhook.controller';
import { ouraConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.k — standalone Oura connector module.
 *
 * Self-contained and file-disjoint: this module wires the Oura connector, its
 * webhook controller, and its registry contribution. It is intentionally NOT
 * imported by `wearables.module.ts` in this PR — wiring all landed connector
 * modules in one place is a coordinated, mutex-prone edit reserved for the
 * final integration PR (PR-HK-1-wire). See `index.ts` for the one-line wiring
 * instruction.
 *
 * Registry integration (PR-HK-1 owns `connector-registry.ts`): rather than
 * editing that file, this module CONTRIBUTES its {@link ouraConnectorDef} into
 * the `WEARABLE_CONNECTORS` multi-provider collection via DI multi-injection.
 * Once PR-HK-1 + the wire PR land, the registry reads every module's
 * contribution through that token — no connector ever edits the registry.
 *
 * Dependencies (`IngestionService`, `ProviderHttpClient`) are re-provided here
 * so the module is independently testable; when imported under WearablesModule
 * (which exports both), Nest reuses the singletons.
 */
@Module({
  controllers: [OuraWebhookController],
  providers: [
    ProviderHttpClient,
    IngestionService,
    OuraConnector,
    // Multi-injection contribution into the connector registry collection.
    // `multi` is a valid runtime option on Nest providers but is absent from
    // this @nestjs/common version's Provider typings, so we assert the shape.
    {
      provide: WEARABLE_CONNECTORS,
      useExisting: OuraConnector,
      multi: true,
    } as unknown as Provider,
  ],
  exports: [OuraConnector, WEARABLE_CONNECTORS],
})
export class OuraModule {
  /** Re-exported for convenience so a registry can read the def by value. */
  static readonly definition = ouraConnectorDef;
}
