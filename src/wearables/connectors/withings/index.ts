import { InjectionToken } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { WearableAuthModel } from '../connector.interface';
import { createWithingsConnector } from './withings.connector';

/**
 * PR-HK-2.i — Withings connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector exports a side-effect-free {@link ConnectorDefinition} const
 * that the registry consumes, and contributes its instance into the
 * `WEARABLE_CONNECTORS` multi-provider collection (see `withings.module.ts`).
 *
 * ── WIRING (deferred to the final integration PR, NOT this PR) ──────────────
 * To activate Withings, the integration PR adds ONE import to
 * `src/wearables/wearables.module.ts`:
 *
 *     import { WithingsModule } from './connectors/withings/withings.module';
 *     @Module({ imports: [WithingsModule], ... }) export class WearablesModule {}
 *
 * This PR deliberately does NOT touch `wearables.module.ts` to stay strictly
 * file-disjoint (no mutex with the other PR-HK-2.* connector PRs).
 */

/**
 * Multi-injection DI token for the connector registry. PR-HK-1 defines the
 * canonical token; until it lands, this local symbol provides a stable seam so
 * `withings.module.ts` can contribute via `{ provide: WEARABLE_CONNECTORS,
 * useExisting: WithingsConnector, multi: true }`. The integration PR aliases
 * this to PR-HK-1's token if they differ.
 */
export const WEARABLE_CONNECTORS: InjectionToken =
  Symbol.for('WEARABLE_CONNECTORS');

/**
 * The shape the registry reads to describe a provider without instantiating
 * it. Mirrors the minimal metadata PR-HK-1's registry needs; the live
 * behaviour lives on {@link WithingsConnector} (injected via DI).
 */
export interface ConnectorDefinition {
  readonly provider: WearableProvider;
  readonly authModel: WearableAuthModel;
  /** Webhook receive path mounted by the connector's controller. */
  readonly webhookPath?: string;
  /** Factory so a non-DI registry can construct an instance if needed. */
  readonly create: typeof createWithingsConnector;
}

/** Withings' registry contribution (consumed by PR-HK-1's registry, by value). */
export const withingsConnectorDef: ConnectorDefinition = {
  provider: WearableProvider.WITHINGS,
  authModel: 'oauth2',
  webhookPath: '/v1/wearables/webhooks/withings',
  create: createWithingsConnector,
};

export { WithingsConnector, createWithingsConnector } from './withings.connector';
export { WithingsModule } from './withings.module';
export {
  normalizeWithings,
  normalizeWithingsRecord,
} from './withings.normalizer';
export type { WithingsRawPayload } from './withings.normalizer';
export * from './withings.types';
