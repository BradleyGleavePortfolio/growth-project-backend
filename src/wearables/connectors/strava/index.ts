import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { StravaConnector } from './strava.connector';

/**
 * PR-HK-2.f — Strava connector public barrel + registry contribution.
 *
 * The single import surface for the Strava connector folder. The connector
 * registry / sync worker import the connector + module from here; nothing
 * reaches inside the folder past this barrel.
 *
 * Registry integration (P0-0B): Strava binds a canonical
 * {@link ConnectorDefinition} VALUE to PR-HK-1's {@link WEARABLE_CONNECTORS}
 * token in `strava.module.ts`. PR-HK-1's `ConnectorRegistry` discovers it via
 * Nest's `DiscoveryService` and indexes it by provider at boot — previously the
 * Strava module provided connector services but did NOT contribute a registry
 * binding, so OAuth discovery stayed empty for Strava (landmine fix).
 */

/**
 * Re-export PR-HK-1's canonical registry token so `strava.module.ts` binds its
 * contribution to the SAME token the registry discovers.
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Strava's connect flow does not thread a server-built PKCE challenge here. */
const STRAVA_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const STRAVA_DISPLAY_NAME = 'Strava';

/** Webhook receive path mounted by {@link StravaWebhookController}. */
export const STRAVA_WEBHOOK_PATH = '/v1/wearables/webhooks/strava';

/**
 * Strava's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it. The live behaviour lives on {@link StravaConnector}; this
 * definition delegates to a lazily-constructed connector instance (its ctor
 * takes an optional deps bag, so production binds a fresh ProviderHttpClient +
 * `process.env`) so the value is self-describing for the registry while routing
 * OAuth/backfill through the real implementation.
 */
class StravaConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.STRAVA;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = STRAVA_DISPLAY_NAME;
  readonly supportsPkce: boolean = STRAVA_SUPPORTS_PKCE;

  private connector: StravaConnector | null = null;

  private get impl(): StravaConnector {
    if (!this.connector) {
      this.connector = new StravaConnector();
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
 * Strava's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const stravaConnectorDef: ConnectorDefinition =
  new StravaConnectorDefinition();

export { StravaConnector } from './strava.connector';
export type { StravaConnectorDeps } from './strava.connector';
export { normalizeStravaActivities, computeStravaDedupKey } from './strava.normalizer';
export { StravaConnectorModule } from './strava.module';
export {
  StravaWebhookController,
  StravaActivityFetchQueue,
} from './strava-webhook.controller';
export {
  STRAVA_SCOPES,
} from './strava.types';
export type {
  StravaActivity,
  StravaWebhookEvent,
  StravaWebhookVerifyQuery,
  StravaTokenResponse,
} from './strava.types';
