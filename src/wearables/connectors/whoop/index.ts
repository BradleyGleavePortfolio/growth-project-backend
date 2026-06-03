import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../../normalization/normalizer.types';
import { ConnectorDefinition } from '../../connector-registry';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { KmsService } from '../../../common/kms/kms.service';
import { WhoopConnector } from './whoop.connector';

/**
 * PR-HK-2.l — WHOOP connector public surface + registry contribution.
 *
 * Barrel export so the integration PR can wire WHOOP with a single import
 * (`import { WhoopModule, WhoopConnector } from './connectors/whoop'`) without
 * reaching into individual files.
 *
 * Registry integration (P0-0B): WHOOP binds a canonical
 * {@link ConnectorDefinition} VALUE to PR-HK-1's {@link WEARABLE_CONNECTORS}
 * token in `whoop.module.ts`. PR-HK-1's `ConnectorRegistry` discovers it via
 * Nest's `DiscoveryService` and indexes it by provider at boot — previously the
 * WHOOP module provided the connector but did NOT contribute a registry
 * binding, so OAuth discovery stayed empty for WHOOP (landmine fix). This def
 * lives in the barrel (which does NOT import the module) so it introduces no
 * module cycle.
 */

/**
 * Re-export PR-HK-1's canonical registry token so `whoop.module.ts` binds its
 * contribution to the SAME token the registry discovers.
 */
export { WEARABLE_CONNECTORS, ConnectorDefinition } from '../../connector-registry';

/** WHOOP's connect flow does not thread a server-built PKCE challenge here. */
const WHOOP_SUPPORTS_PKCE = false;

/** Human-readable provider label for connection-management UIs. */
const WHOOP_DISPLAY_NAME = 'WHOOP';

/** Webhook receive path mounted by {@link WhoopWebhookController}. */
export const WHOOP_WEBHOOK_PATH = '/v1/wearables/webhooks/whoop';

/**
 * WHOOP's registry contribution. Satisfies PR-HK-1's canonical
 * {@link ConnectorDefinition} contract so {@link ConnectorRegistry} discovers
 * and activates it. The live behaviour lives on {@link WhoopConnector}; this
 * definition delegates to a lazily-constructed connector instance so the value
 * is self-describing for the registry while routing OAuth/backfill through the
 * real implementation (which reads client credentials from env and routes all
 * HTTP through {@link ProviderHttpClient}). KMS is only exercised by
 * refresh/backfill token handling, never by the OAuth-URL metadata path.
 */
class WhoopConnectorDefinition implements ConnectorDefinition {
  readonly provider: WearableProvider = WearableProvider.WHOOP;
  readonly authModel = 'oauth2' as const;
  readonly displayName: string = WHOOP_DISPLAY_NAME;
  readonly supportsPkce: boolean = WHOOP_SUPPORTS_PKCE;

  private connector: WhoopConnector | null = null;

  private get impl(): WhoopConnector {
    if (!this.connector) {
      this.connector = new WhoopConnector(new ProviderHttpClient(), new KmsService());
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
 * WHOOP's registry contribution (consumed by PR-HK-1's {@link
 * ConnectorRegistry}, by value, via the {@link WEARABLE_CONNECTORS} token).
 */
export const whoopConnectorDef: ConnectorDefinition =
  new WhoopConnectorDefinition();

export { WhoopConnector, signWhoopWebhook } from './whoop.connector';
export { WhoopWebhookController } from './whoop-webhook.controller';
export { WhoopModule } from './whoop.module';
export { normalizeWhoop, whoopDedupKey } from './whoop.normalizer';
export * from './whoop.types';
