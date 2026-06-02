import { InjectionToken } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { WearableAuthModel } from '../connector.interface';
import { createPolarConnector } from './polar.connector';

/**
 * PR-HK-2.g — Polar connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector exports a side-effect-free {@link ConnectorDefinition} const
 * that the registry consumes, and contributes its instance into the
 * `WEARABLE_CONNECTORS` multi-provider collection (see `polar.module.ts`).
 *
 * ── WIRING (deferred to the final integration PR, NOT this PR) ──────────────
 * To activate Polar, the integration PR adds ONE import to
 * `src/wearables/wearables.module.ts`:
 *
 *     import { PolarModule } from './connectors/polar/polar.module';
 *     @Module({ imports: [PolarModule], ... }) export class WearablesModule {}
 *
 * This PR deliberately does NOT touch `wearables.module.ts` to stay strictly
 * file-disjoint (no mutex with the other PR-HK-2.* connector PRs).
 */

/**
 * Multi-injection DI token for the connector registry. PR-HK-1 defines the
 * canonical token; until it lands, this `Symbol.for` provides a stable,
 * process-global seam so `polar.module.ts` can contribute via
 * `{ provide: WEARABLE_CONNECTORS, useExisting: PolarConnector, multi: true }`.
 * The integration PR aliases this to PR-HK-1's token if they differ.
 */
export const WEARABLE_CONNECTORS: InjectionToken =
  Symbol.for('WEARABLE_CONNECTORS');

/**
 * The shape the registry reads to describe a provider without instantiating
 * it. Mirrors the minimal metadata PR-HK-1's registry needs; the live
 * behaviour lives on {@link PolarConnector} (injected via DI).
 */
export interface ConnectorDefinition {
  readonly provider: WearableProvider;
  readonly authModel: WearableAuthModel;
  /** Webhook receive path mounted by the connector's controller. */
  readonly webhookPath?: string;
  /** Factory so a non-DI registry can construct an instance if needed. */
  readonly create: typeof createPolarConnector;
}

/** Polar's registry contribution (consumed by PR-HK-1's registry, by value). */
export const polarConnectorDef: ConnectorDefinition = {
  provider: WearableProvider.POLAR,
  authModel: 'oauth2',
  webhookPath: '/v1/wearables/webhooks/polar',
  create: createPolarConnector,
};

export { PolarConnector, createPolarConnector } from './polar.connector';
export { PolarModule } from './polar.module';
export {
  normalizePolar,
  normalizePolarRecord,
  parseIso8601DurationToMinutes,
} from './polar.normalizer';
export type { PolarRawPayload } from './polar.normalizer';
export * from './polar.types';
