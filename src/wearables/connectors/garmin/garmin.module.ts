import { Module } from '@nestjs/common';
import { WearablesModule } from '../../wearables.module';
import { GarminConnector } from './garmin.connector';
import { GarminWebhookController } from './garmin-webhook.controller';

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
 * Wiring this module into AppModule (and registering the connector in the
 * registry) is a one-line shared edit performed by the integration PR, NOT
 * here — keeping this PR's footprint inside `connectors/garmin/`.
 */
@Module({
  imports: [WearablesModule],
  controllers: [GarminWebhookController],
  providers: [GarminConnector],
  exports: [GarminConnector],
})
export class GarminModule {}
