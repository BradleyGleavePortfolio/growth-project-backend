import { Module } from '@nestjs/common';
import { WearablesModule } from '../../wearables.module';
import { WhoopConnector } from './whoop.connector';
import { WhoopWebhookController } from './whoop-webhook.controller';

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
 * Wiring this module into AppModule (and registering the connector in the
 * registry) is a one-line shared edit performed by the integration PR, NOT
 * here — keeping this PR's footprint inside `connectors/whoop/`.
 */
@Module({
  imports: [WearablesModule],
  controllers: [WhoopWebhookController],
  providers: [WhoopConnector],
  exports: [WhoopConnector],
})
export class WhoopModule {}
