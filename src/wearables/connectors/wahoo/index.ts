import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { WahooConnector, createWahooConnector } from './wahoo.connector';

/**
 * PR-HK-2.h — Wahoo connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector binds a {@link ConnectorDefinition} value to PR-HK-1's
 * canonical {@link WEARABLE_CONNECTORS} token inside its OWN module
 * (`wahoo.module.ts`). PR-HK-1's {@link ConnectorRegistry} discovers every such
 * binding across all loaded modules via Nest's `DiscoveryService` and indexes
 * it by provider — so importing {@link WahooModule} is sufficient to make Wahoo
 * discoverable/activatable through the generic connect flow, with no edit to
 * the registry file.
 *
 * ── WIRING (P0-0B) ─────────────────────────────────────────────────────────
 * Wahoo is wired into `src/wearables/wearables.module.ts` via `imports: [WahooModule]`.
 */

/**
 * Re-export PR-HK-1's canonical registry token so `wahoo.module.ts` binds its
 * contribution to the SAME token the registry discovers
 * (`connector-registry.ts:WEARABLE_CONNECTORS`). The token is the string
 * `'WEARABLE_CONNECTORS'`; binding to any other token (e.g. a local
 * `Symbol.for(...)`) would NOT be seen by `ConnectorRegistry` and Wahoo would
 * never activate. (P0-0B registry-token alignment — landmine fix.)
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Wahoo does not use PKCE in the connect flow (base OAuth2 authorization-code). */
const WAHOO_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const WAHOO_DISPLAY_NAME = 'Wahoo';

/** Webhook receive path mounted by {@link WahooWebhookController}. */
export const WAHOO_WEBHOOK_PATH = '/v1/wearables/webhooks/wahoo';

/**
 * Wahoo's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it. The live behaviour lives on {@link WahooConnector}; this
 * definition delegates to a lazily-constructed connector instance so the value
 * is self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}).
 */
class WahooConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.WAHOO;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = WAHOO_DISPLAY_NAME;
  readonly supportsPkce: boolean = WAHOO_SUPPORTS_PKCE;

  private connector: WahooConnector | null = null;

  private get impl(): WahooConnector {
    if (!this.connector) {
      this.connector = createWahooConnector(new ProviderHttpClient());
    }
    return this.connector;
  }

  buildAuthorizationUrl(
    _redirectUri: string,
    state: string,
    _pkceChallenge?: string,
  ): string | null {
    return this.impl.buildAuthUrl('', state);
  }

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
 * Wahoo's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const wahooConnectorDef: ConnectorDefinition = new WahooConnectorDefinition();

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
