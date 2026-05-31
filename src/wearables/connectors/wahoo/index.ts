import { InjectionToken } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { WearableAuthModel } from '../connector.interface';
import { createWahooConnector } from './wahoo.connector';

/**
 * PR-HK-2.h — Wahoo connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector exports a side-effect-free {@link ConnectorDefinition} const
 * that the registry consumes, and contributes its instance into the
 * `WEARABLE_CONNECTORS` multi-provider collection (see `wahoo.module.ts`).
 *
 * ── WIRING (deferred to the final integration PR, NOT this PR) ──────────────
 * To activate Wahoo, the integration PR adds ONE import to
 * `src/wearables/wearables.module.ts`:
 *
 *     import { WahooModule } from './connectors/wahoo/wahoo.module';
 *     @Module({ imports: [WahooModule], ... }) export class WearablesModule {}
 *
 * This PR deliberately does NOT touch `wearables.module.ts` to stay strictly
 * file-disjoint (no mutex with the other PR-HK-2.* connector PRs).
 */

/**
 * Multi-injection DI token for the connector registry. PR-HK-1 defines the
 * canonical token; until it lands, this local symbol provides a stable seam so
 * `wahoo.module.ts` can contribute via `{ provide: WEARABLE_CONNECTORS,
 * useExisting: WahooConnector, multi: true }`. The integration PR aliases this
 * to PR-HK-1's token if they differ.
 */
export const WEARABLE_CONNECTORS: InjectionToken =
  Symbol.for('WEARABLE_CONNECTORS');

/**
 * The shape the registry reads to describe a provider without instantiating
 * it. The live behaviour lives on {@link WahooConnector} (injected via DI).
 */
export interface ConnectorDefinition {
  readonly provider: WearableProvider;
  readonly authModel: WearableAuthModel;
  /** Webhook receive path mounted by the connector's controller. */
  readonly webhookPath?: string;
  /** Factory so a non-DI registry can construct an instance if needed. */
  readonly create: typeof createWahooConnector;
}

/** Wahoo's registry contribution (consumed by PR-HK-1's registry, by value). */
export const wahooConnectorDef: ConnectorDefinition = {
  provider: WearableProvider.WAHOO,
  authModel: 'oauth2',
  webhookPath: '/v1/wearables/webhooks/wahoo',
  create: createWahooConnector,
};

export {
  WahooConnector,
  createWahooConnector,
  redactErrorMessage,
  computeWahooDedupKey,
  hashForLog,
} from './wahoo.connector';
export { WahooModule } from './wahoo.module';
export { normalizeWahoo, normalizeWahooWorkout } from './wahoo.normalizer';
export type { WahooRawPayload } from './wahoo.normalizer';
export { WahooWebhookController } from './wahoo-webhook.controller';
export * from './wahoo.types';
