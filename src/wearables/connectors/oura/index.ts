import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { OuraConnector, createOuraConnector } from './oura.connector';

/**
 * PR-HK-2.k — Oura connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector binds a {@link ConnectorDefinition} value to PR-HK-1's
 * canonical {@link WEARABLE_CONNECTORS} token inside its OWN module
 * (`oura.module.ts`). PR-HK-1's {@link ConnectorRegistry} discovers every such
 * binding across all loaded modules via Nest's `DiscoveryService` and indexes
 * it by provider — so importing {@link OuraModule} is sufficient to make Oura
 * discoverable/activatable through the generic connect flow, with no edit to
 * the registry file.
 *
 * ── WIRING (P0-0B) ─────────────────────────────────────────────────────────
 * Oura is wired into `src/wearables/wearables.module.ts` via `imports: [OuraModule]`.
 */

/**
 * Re-export PR-HK-1's canonical registry token so `oura.module.ts` binds its
 * contribution to the SAME token the registry discovers
 * (`connector-registry.ts:WEARABLE_CONNECTORS`). The token is the string
 * `'WEARABLE_CONNECTORS'`; binding to any other token (e.g. a local
 * `Symbol.for(...)`) would NOT be seen by `ConnectorRegistry` and Oura would
 * never activate. (P0-0B registry-token alignment — landmine fix.)
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Oura does not use PKCE in the connect flow (base OAuth2 authorization-code). */
const OURA_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const OURA_DISPLAY_NAME = 'Oura';

/** Webhook receive path mounted by {@link OuraWebhookController}. */
export const OURA_WEBHOOK_PATH = '/v1/wearables/webhooks/oura';

/**
 * Oura's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract (provider, authModel, displayName,
 * supportsPkce, the redirect-aware `buildAuthorizationUrl`, and the
 * verifier-aware `exchangeCode`) so {@link ConnectorRegistry} discovers and
 * activates it. The live behaviour lives on {@link OuraConnector}; this
 * definition delegates to a lazily-constructed connector instance so the value
 * is self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}).
 */
class OuraConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.OURA;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = OURA_DISPLAY_NAME;
  readonly supportsPkce: boolean = OURA_SUPPORTS_PKCE;

  private connector: OuraConnector | null = null;

  private get impl(): OuraConnector {
    if (!this.connector) {
      this.connector = createOuraConnector(new ProviderHttpClient());
    }
    return this.connector;
  }

  /**
   * Canonical redirect-aware authorization URL builder. Oura does not use
   * PKCE, so `pkceChallenge` is ignored; the underlying connector reads
   * `OURA_REDIRECT_URI` from env, so the supplied `redirectUri` is recorded for
   * parity with the generic contract while the env value remains the source of
   * truth used in the issued URL.
   */
  buildAuthorizationUrl(
    _redirectUri: string,
    state: string,
    _pkceChallenge?: string,
  ): string | null {
    return this.impl.buildAuthUrl('', state);
  }

  /** Canonical code exchange (Oura ignores PKCE verifiers). */
  exchangeCode(code: string, _pkceVerifier?: string): Promise<TokenSet> {
    return this.impl.exchangeCode(code);
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
 * Oura's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const ouraConnectorDef: ConnectorDefinition = new OuraConnectorDefinition();

export { OuraConnector, createOuraConnector } from './oura.connector';
export { OuraModule } from './oura.module';
export { normalizeOura, normalizeOuraRecord } from './oura.normalizer';
export type { OuraRawPayload } from './oura.normalizer';
export * from './oura.types';
