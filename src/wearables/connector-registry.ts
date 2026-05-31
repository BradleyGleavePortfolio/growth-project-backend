import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WearableProvider } from '@prisma/client';
import { TokenSet } from './normalization/normalizer.types';
import {
  WearableAuthModel,
  WearableConnector,
} from './connectors/connector.interface';

/**
 * PR-HK-1 — provider-agnostic connector registry.
 *
 * ## Inversion of control: connectors register THEMSELVES (no registry edits)
 *
 * This file is provider-agnostic and ships EMPTY in PR-HK-1 — no provider is
 * registered here. Each connector PR (PR-HK-2.*) contributes its definition by
 * binding it to the {@link WEARABLE_CONNECTORS} injection token in its OWN
 * module file:
 *
 * ```ts
 * // src/wearables/connectors/oura/oura.module.ts  (owned by PR-HK-2.k)
 * @Module({
 *   providers: [
 *     { provide: WEARABLE_CONNECTORS, useValue: ouraConnectorDefinition },
 *   ],
 *   exports: [WEARABLE_CONNECTORS],
 * })
 * export class OuraConnectorModule {}
 * ```
 *
 * Because each connector lives in its own module, each module contributes its
 * own provider bound to the same token. The registry uses Nest's
 * {@link DiscoveryService} to enumerate EVERY provider whose injection token is
 * `WEARABLE_CONNECTORS` across all loaded modules and aggregates them at boot.
 *
 * **Connector PRs therefore NEVER edit this file** — they cannot create a
 * rebase collision on the registry. This is the §5 collision-avoidance
 * doctrine: the registry is written once (here) and connectors are additive
 * module bindings (Agent 2 §5; guards #15/#40 — single source of truth, no
 * shared-file edits).
 *
 * ### Implementation note (deviation from the spec's `multi: true`)
 *
 * The PR-HK-1 spec described the contribution as
 * `{ provide: WEARABLE_CONNECTORS, useValue: <def>, multi: true }` — an
 * Angular-style multi-provider. **NestJS (v11) has no `multi` provider flag**
 * (its `Provider` type — Class/Value/Factory/Existing — exposes no such
 * field, and binding the same token twice resolves last-wins, not an array).
 * The Nest-native equivalent that preserves the EXACT intent ("connectors
 * contribute to one collection from their own module, registry written once")
 * is `DiscoveryService` aggregation by token. The contribution API is
 * therefore the same minus the (non-existent) `multi: true` flag. This is
 * documented here so connector PRs use the correct, type-checking form.
 */

/**
 * DI token. Connector modules bind their {@link ConnectorDefinition} to this
 * token (one provider per connector module); the registry discovers every
 * such provider across all modules at boot.
 */
export const WEARABLE_CONNECTORS = 'WEARABLE_CONNECTORS';

/**
 * The OAuth-flow contract a cloud connector contributes, layered on top of the
 * PR-HK-0 {@link WearableConnector} base. PR-HK-1's generic connect/callback
 * flow needs a redirect-URI- and PKCE-aware authorization-URL builder and a
 * code exchange that accepts the PKCE verifier — richer than the base
 * interface's `buildAuthUrl(userId, state)`. A `ConnectorDefinition` extends
 * the base contract with these PR-HK-1 affordances; on-device connectors
 * supply only the base fields (their OAuth methods are never exercised).
 */
export interface ConnectorDefinition extends WearableConnector {
  /**
   * Human-readable provider label for connection-management UIs. Kept on the
   * definition (not hardcoded in the client) so the connect sheet renders one
   * canonical name per provider.
   */
  readonly displayName: string;

  /** True when the provider supports PKCE (server mints verifier/challenge). */
  readonly supportsPkce: boolean;

  /**
   * Build the provider authorization URL for the generic connect flow. Unlike
   * the base `buildAuthUrl(userId, state)`, this variant takes the server
   * redirect URI and an optional PKCE `code_challenge` (present iff
   * {@link supportsPkce}). Returns `null` for on-device providers.
   */
  buildAuthorizationUrl(
    redirectUri: string,
    state: string,
    pkceChallenge?: string,
  ): string | null;

  /**
   * Exchange an authorization code for a {@link TokenSet}, passing the PKCE
   * `code_verifier` when the provider uses PKCE. Cloud connectors implement
   * this; on-device connectors are never asked to.
   */
  exchangeCode(code: string, pkceVerifier?: string): Promise<TokenSet>;
}

/** Auth models that go through the server-side OAuth connect/callback flow. */
const OAUTH_AUTH_MODELS: ReadonlySet<WearableAuthModel> = new Set<WearableAuthModel>([
  'oauth2',
]);

/**
 * Auth models handled on-device (no server OAuth): the mobile app reads device
 * data and POSTs samples to the ingest endpoint (PR-HK-2.a/2.b/2.c). These
 * providers do NOT use the connect/callback/disconnect OAuth API.
 */
const ON_DEVICE_AUTH_MODELS: ReadonlySet<WearableAuthModel> = new Set<WearableAuthModel>([
  'on-device',
]);

/** Minimal structural guard that a discovered provider is a connector def. */
function isConnectorDefinition(value: unknown): value is ConnectorDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Partial<ConnectorDefinition>;
  return (
    typeof v.provider === 'string' &&
    typeof v.authModel === 'string' &&
    typeof v.buildAuthorizationUrl === 'function' &&
    typeof v.exchangeCode === 'function'
  );
}

@Injectable()
export class ConnectorRegistry implements OnModuleInit {
  private byProvider: ReadonlyMap<WearableProvider, ConnectorDefinition> = new Map();

  /**
   * @param discovery Nest's provider-discovery service. Optional in the
   *   constructor signature for unit tests that construct the registry
   *   directly with {@link registerForTest}; in the Nest container it is
   *   always injected.
   */
  constructor(private readonly discovery?: DiscoveryService) {}

  /**
   * Boot-time aggregation: enumerate every provider whose injection token is
   * {@link WEARABLE_CONNECTORS} across all loaded modules and index them by
   * provider. Runs once at startup; the registry is immutable thereafter.
   */
  onModuleInit(): void {
    if (!this.discovery) {
      return; // direct-construction (unit test) path — see registerForTest.
    }
    const defs = this.discovery
      .getProviders()
      .filter((w) => w.token === WEARABLE_CONNECTORS && w.instance != null)
      .map((w) => w.instance)
      .filter(isConnectorDefinition);
    this.byProvider = ConnectorRegistry.index(defs);
  }

  /**
   * Test-only seam: index a fixed set of definitions without the Nest
   * container. Production code uses {@link onModuleInit} discovery.
   */
  registerForTest(defs: ConnectorDefinition[]): void {
    this.byProvider = ConnectorRegistry.index(defs);
  }

  private static index(
    defs: ConnectorDefinition[],
  ): ReadonlyMap<WearableProvider, ConnectorDefinition> {
    const map = new Map<WearableProvider, ConnectorDefinition>();
    for (const def of defs) {
      if (map.has(def.provider)) {
        // Two connectors claiming the same provider is a wiring bug — fail
        // loud rather than silently shadowing one (50-Failures #43).
        throw new Error(
          `Duplicate wearable connector registered for provider "${def.provider}".`,
        );
      }
      map.set(def.provider, def);
    }
    return map;
  }

  /**
   * Resolve the connector for a provider.
   * @throws Error (generic, provider-named) when no connector is registered —
   *   e.g. a connect request for a provider whose PR-HK-2 connector has not
   *   landed yet.
   */
  get(provider: WearableProvider): ConnectorDefinition {
    const def = this.byProvider.get(provider);
    if (!def) {
      throw new Error(
        `No wearable connector registered for provider "${provider}".`,
      );
    }
    return def;
  }

  /** True when a connector is registered for the provider (no throw). */
  has(provider: WearableProvider): boolean {
    return this.byProvider.has(provider);
  }

  /** All registered connector definitions (stable insertion order). */
  list(): ConnectorDefinition[] {
    return Array.from(this.byProvider.values());
  }

  /**
   * Cloud OAuth connectors only (`authModel === 'oauth2'`). These are the
   * providers the connect/callback OAuth API serves.
   */
  getOauthConnectors(): ConnectorDefinition[] {
    return this.list().filter((c) => OAUTH_AUTH_MODELS.has(c.authModel));
  }

  /**
   * On-device connectors (HealthKit / Health Connect / Samsung Health). These
   * do NOT use the OAuth API — their "connection" is tracked by the ingest
   * endpoint (PR-HK-2.a). Exposed so UIs can render device permission flows
   * distinctly from cloud-OAuth connect buttons.
   */
  getOnDeviceConnectors(): ConnectorDefinition[] {
    return this.list().filter((c) => ON_DEVICE_AUTH_MODELS.has(c.authModel));
  }
}
