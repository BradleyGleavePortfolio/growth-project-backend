import { InjectionToken } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { WearableAuthModel } from '../connector.interface';
import { createOuraConnector } from './oura.connector';

/**
 * PR-HK-2.k — Oura connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector exports a side-effect-free {@link ConnectorDefinition} const
 * that the registry consumes, and contributes its instance into the
 * `WEARABLE_CONNECTORS` multi-provider collection (see `oura.module.ts`).
 *
 * ── WIRING (deferred to the final integration PR, NOT this PR) ──────────────
 * To activate Oura, the integration PR adds ONE import to
 * `src/wearables/wearables.module.ts`:
 *
 *     import { OuraModule } from './connectors/oura/oura.module';
 *     @Module({ imports: [OuraModule], ... }) export class WearablesModule {}
 *
 * This PR deliberately does NOT touch `wearables.module.ts` to stay strictly
 * file-disjoint (no mutex with the other PR-HK-2.* connector PRs).
 */

/**
 * Multi-injection DI token for the connector registry. PR-HK-1 defines the
 * canonical token; until it lands, this local symbol provides a stable seam so
 * `oura.module.ts` can contribute via `{ provide: WEARABLE_CONNECTORS,
 * useExisting: OuraConnector, multi: true }`. The integration PR aliases this
 * to PR-HK-1's token if they differ.
 */
export const WEARABLE_CONNECTORS: InjectionToken =
  Symbol.for('WEARABLE_CONNECTORS');

/**
 * The shape the registry reads to describe a provider without instantiating
 * it. Mirrors the minimal metadata PR-HK-1's registry needs; the live
 * behaviour lives on {@link OuraConnector} (injected via DI).
 */
export interface ConnectorDefinition {
  readonly provider: WearableProvider;
  readonly authModel: WearableAuthModel;
  /** Webhook receive path mounted by the connector's controller. */
  readonly webhookPath?: string;
  /** Factory so a non-DI registry can construct an instance if needed. */
  readonly create: typeof createOuraConnector;
}

/** Oura's registry contribution (consumed by PR-HK-1's registry, by value). */
export const ouraConnectorDef: ConnectorDefinition = {
  provider: WearableProvider.OURA,
  authModel: 'oauth2',
  webhookPath: '/v1/wearables/webhooks/oura',
  create: createOuraConnector,
};

export { OuraConnector, createOuraConnector } from './oura.connector';
export { OuraModule } from './oura.module';
export { normalizeOura, normalizeOuraRecord } from './oura.normalizer';
export type { OuraRawPayload } from './oura.normalizer';
export * from './oura.types';
