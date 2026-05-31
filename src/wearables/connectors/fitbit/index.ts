import { InjectionToken } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { WearableAuthModel } from '../connector.interface';
import { createFitbitConnector } from './fitbit.connector';

/**
 * PR-HK-2.e — Fitbit connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector exports a side-effect-free {@link ConnectorDefinition} const
 * that the registry consumes, and contributes its instance into the
 * `WEARABLE_CONNECTORS` multi-provider collection (see `fitbit.module.ts`).
 *
 * ── WIRING (deferred to the final integration PR, NOT this PR) ──────────────
 * To activate Fitbit, the integration PR adds ONE import to
 * `src/wearables/wearables.module.ts`:
 *
 *     import { FitbitModule } from './connectors/fitbit/fitbit.module';
 *     @Module({ imports: [FitbitModule], ... }) export class WearablesModule {}
 *
 * This PR deliberately does NOT touch `wearables.module.ts` to stay strictly
 * file-disjoint (no mutex with the other PR-HK-2.* connector PRs).
 */

/**
 * Multi-injection DI token for the connector registry. PR-HK-1 defines the
 * canonical token; until it lands, this `Symbol.for('WEARABLE_CONNECTORS')`
 * provides a stable, cross-module-identical seam so `fitbit.module.ts` can
 * contribute via `{ provide: WEARABLE_CONNECTORS, useExisting: FitbitConnector,
 * multi: true }`. The integration PR aliases this to PR-HK-1's token if they
 * differ. (Each connector module declares the same `Symbol.for(...)` so the
 * registry reads every contribution through one collection.)
 */
export const WEARABLE_CONNECTORS: InjectionToken =
  Symbol.for('WEARABLE_CONNECTORS');

/**
 * The shape the registry reads to describe a provider without instantiating
 * it. Mirrors the minimal metadata PR-HK-1's registry needs; the live
 * behaviour lives on {@link FitbitConnector} (injected via DI).
 */
export interface ConnectorDefinition {
  readonly provider: WearableProvider;
  readonly authModel: WearableAuthModel;
  /** Webhook receive path mounted by the connector's controller. */
  readonly webhookPath?: string;
  /** Factory so a non-DI registry can construct an instance if needed. */
  readonly create: typeof createFitbitConnector;
}

/** Fitbit's registry contribution (consumed by PR-HK-1's registry, by value). */
export const fitbitConnectorDef: ConnectorDefinition = {
  provider: WearableProvider.FITBIT,
  authModel: 'oauth2',
  webhookPath: '/v1/wearables/webhooks/fitbit',
  create: createFitbitConnector,
};

export {
  FitbitConnector,
  createFitbitConnector,
  redactErrorMessage,
  generateCodeVerifier,
  deriveCodeChallenge,
} from './fitbit.connector';
export { FitbitModule } from './fitbit.module';
export { normalizeFitbit, normalizeFitbitRecord } from './fitbit.normalizer';
export type { FitbitRawPayload } from './fitbit.normalizer';
export * from './fitbit.types';
