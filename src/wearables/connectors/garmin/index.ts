import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { KmsService } from '../../../common/kms/kms.service';
import { GarminConnector } from './garmin.connector';

/**
 * PR-HK-2.d — Garmin connector public surface + registry contribution.
 *
 * Barrel export so the integration PR can wire Garmin with a single import
 * (`import { GarminModule, GarminConnector } from './connectors/garmin'`)
 * without reaching into individual files.
 *
 * Registry integration (P0-0B): Garmin binds a canonical
 * {@link ConnectorDefinition} VALUE to PR-HK-1's {@link WEARABLE_CONNECTORS}
 * token in `garmin.module.ts`. PR-HK-1's `ConnectorRegistry` discovers it via
 * Nest's `DiscoveryService` and indexes it by provider at boot — previously the
 * Garmin module provided the connector but did NOT contribute a registry
 * binding, so OAuth discovery stayed empty for Garmin (landmine fix).
 */

/**
 * Re-export PR-HK-1's canonical registry token so `garmin.module.ts` binds its
 * contribution to the SAME token the registry discovers.
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** Garmin's connect flow does not thread a server-built PKCE challenge here. */
const GARMIN_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const GARMIN_DISPLAY_NAME = 'Garmin';

/** Webhook receive path mounted by {@link GarminWebhookController}. */
export const GARMIN_WEBHOOK_PATH = '/v1/wearables/webhooks/garmin';

/**
 * Garmin's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it. The live behaviour lives on {@link GarminConnector}; this
 * definition delegates to a lazily-constructed connector instance so the value
 * is self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}). KMS is only exercised by
 * refresh/backfill token handling, never by the OAuth-URL metadata path.
 */
class GarminConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.GARMIN;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = GARMIN_DISPLAY_NAME;
  readonly supportsPkce: boolean = GARMIN_SUPPORTS_PKCE;

  private connector: GarminConnector | null = null;

  private get impl(): GarminConnector {
    if (!this.connector) {
      this.connector = new GarminConnector(new ProviderHttpClient(), new KmsService());
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
 * Garmin's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const garminConnectorDef: ConnectorDefinition =
  new GarminConnectorDefinition();

export {
  GarminConnector,
  garminPushTokenHeader,
  hashGarminUserId,
} from './garmin.connector';
export { GarminWebhookController } from './garmin-webhook.controller';
export { GarminModule } from './garmin.module';
export {
  normalizeGarmin,
  garminDedupKey,
  offsetToSourceTz,
} from './garmin.normalizer';
export * from './garmin.types';
