import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { WithingsConnector, createWithingsConnector } from './withings.connector';

/**
 * PR-HK-2.i — Withings connector public surface + registry contribution.
 *
 * Connectors do NOT edit `connector-registry.ts` (owned by PR-HK-1). Instead
 * each connector binds a {@link ConnectorDefinition} value to PR-HK-1's
 * canonical {@link WEARABLE_CONNECTORS} token inside its OWN module
 * (`withings.module.ts`). PR-HK-1's {@link ConnectorRegistry} discovers every
 * such binding across all loaded modules via Nest's `DiscoveryService` and
 * indexes it by provider — so importing {@link WithingsModule} is sufficient to
 * make Withings discoverable/activatable through the generic connect flow, with
 * no edit to the registry file.
 *
 * ── WIRING (P0-0B) ─────────────────────────────────────────────────────────
 * Withings is wired into `src/wearables/wearables.module.ts` via
 * `imports: [WithingsModule]`.
 */

/**
 * Re-export PR-HK-1's canonical registry token so `withings.module.ts` binds
 * its contribution to the SAME token the registry discovers
 * (`connector-registry.ts:WEARABLE_CONNECTORS`). The token is the string
 * `'WEARABLE_CONNECTORS'`; binding to any other token (e.g. a local
 * `Symbol.for(...)`) would NOT be seen by `ConnectorRegistry` and Withings
 * would never activate. (P0-0B registry-token alignment — landmine fix.)
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Withings does not use PKCE in the connect flow (base OAuth2 authorization-code). */
const WITHINGS_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const WITHINGS_DISPLAY_NAME = 'Withings';

/** Webhook receive path mounted by {@link WithingsWebhookController}. */
export const WITHINGS_WEBHOOK_PATH = '/v1/wearables/webhooks/withings';

/**
 * Withings' registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it. The live behaviour lives on {@link WithingsConnector}; this
 * definition delegates to a lazily-constructed connector instance so the value
 * is self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}).
 */
class WithingsConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.WITHINGS;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = WITHINGS_DISPLAY_NAME;
  readonly supportsPkce: boolean = WITHINGS_SUPPORTS_PKCE;

  private connector: WithingsConnector | null = null;

  private get impl(): WithingsConnector {
    if (!this.connector) {
      this.connector = createWithingsConnector(new ProviderHttpClient());
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
 * Withings' registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const withingsConnectorDef: ConnectorDefinition =
  new WithingsConnectorDefinition();

export { WithingsConnector, createWithingsConnector } from './withings.connector';
export { WithingsModule } from './withings.module';
export {
  normalizeWithings,
  normalizeWithingsRecord,
} from './withings.normalizer';
export type { WithingsRawPayload } from './withings.normalizer';
export * from './withings.types';
