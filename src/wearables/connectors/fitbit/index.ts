import { WearableProvider, WearableConnection } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { FitbitConnector, createFitbitConnector } from './fitbit.connector';

/**
 * PR-HK-2.e — Fitbit connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector binds a {@link ConnectorDefinition} value to PR-HK-1's
 * canonical {@link WEARABLE_CONNECTORS} token inside its OWN module
 * (`fitbit.module.ts`). PR-HK-1's {@link ConnectorRegistry} discovers every
 * such binding across all loaded modules via Nest's `DiscoveryService` and
 * indexes it by provider — so importing {@link FitbitModule} is sufficient to
 * make Fitbit discoverable/activatable through the generic connect flow, with
 * no edit to the registry file.
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
 * Re-export PR-HK-1's canonical registry token so `fitbit.module.ts` can bind
 * its contribution to the SAME token the registry discovers
 * (`connector-registry.ts:WEARABLE_CONNECTORS`). The token is the string
 * `'WEARABLE_CONNECTORS'`; binding to any other token (e.g. a local
 * `Symbol.for(...)`) would NOT be seen by `ConnectorRegistry` and Fitbit would
 * never activate.
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Fitbit OAuth uses PKCE (S256). */
const FITBIT_SUPPORTS_PKCE = true;

/** Human-readable provider label for connection-management UIs. */
const FITBIT_DISPLAY_NAME = 'Fitbit';

/** Webhook receive path mounted by {@link FitbitWebhookController}. */
export const FITBIT_WEBHOOK_PATH = '/v1/wearables/webhooks/fitbit';

/**
 * Fitbit's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it: it supplies `provider`, `authModel`, `displayName`,
 * `supportsPkce`, the PKCE-/redirect-aware `buildAuthorizationUrl`, and the
 * verifier-aware `exchangeCode`, alongside the base {@link WearableConnector}
 * methods.
 *
 * The live behaviour lives on {@link FitbitConnector}; this definition
 * delegates to a lazily-constructed connector instance so the value is
 * self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}).
 */
class FitbitConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.FITBIT;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = FITBIT_DISPLAY_NAME;
  readonly supportsPkce: boolean = FITBIT_SUPPORTS_PKCE;

  private connector: FitbitConnector | null = null;

  /**
   * Lazily construct the underlying connector. The definition is bound to the
   * registry by value; the registry only reads metadata + invokes the OAuth
   * methods, so the HTTP client is constructed on first use with production
   * defaults (global `fetch` + real timers). Under DI the connector singleton
   * is provided separately by {@link FitbitModule}; this self-contained
   * instance keeps the by-value definition usable without a container.
   */
  private get impl(): FitbitConnector {
    if (!this.connector) {
      this.connector = createFitbitConnector(new ProviderHttpClient());
    }
    return this.connector;
  }

  /**
   * Canonical PKCE-/redirect-aware authorization URL builder. `redirectUri` is
   * threaded by PR-HK-1's connect lane; the underlying connector reads
   * `FITBIT_REDIRECT_URI` from env, so the supplied `redirectUri` is recorded
   * for parity with the generic contract while the env value remains the
   * source of truth used in the issued URL.
   */
  buildAuthorizationUrl(
    _redirectUri: string,
    state: string,
    pkceChallenge?: string,
  ): string | null {
    return this.impl.buildAuthUrlPkce('', state, pkceChallenge);
  }

  /** Canonical code exchange; threads the PKCE `code_verifier` when present. */
  exchangeCode(code: string, pkceVerifier?: string): Promise<TokenSet> {
    return this.impl.exchangeCode(code, { codeVerifier: pkceVerifier });
  }

  // ── base WearableConnector surface (delegated) ─────────────────────────────

  buildAuthUrl(userId: string, state: string): string | null {
    return this.impl.buildAuthUrl(userId, state);
  }

  refresh(conn: WearableConnection): Promise<TokenSet> {
    return this.impl.refresh(conn);
  }

  backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]> {
    return this.impl.backfill(conn, since);
  }

  normalize(raw: RawRecord[]): NormalizedSample[] {
    return this.impl.normalize(raw);
  }
}

/**
 * Fitbit's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const fitbitConnectorDef: ConnectorDefinition =
  new FitbitConnectorDefinition();

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
