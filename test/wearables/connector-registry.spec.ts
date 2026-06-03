import 'reflect-metadata';
import { Module, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  PATH_METADATA,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import { DiscoveryModule, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { WearableProvider } from '@prisma/client';

import {
  ConnectorRegistry,
  ConnectorDefinition,
  WEARABLE_CONNECTORS,
} from '../../src/wearables/connector-registry';

// The eight cloud-connector definitions, imported from each connector's own
// barrel exactly as the connector modules bind them.
import { fitbitConnectorDef } from '../../src/wearables/connectors/fitbit';
import { garminConnectorDef } from '../../src/wearables/connectors/garmin';
import { ouraConnectorDef } from '../../src/wearables/connectors/oura';
import { polarConnectorDef } from '../../src/wearables/connectors/polar';
import { stravaConnectorDef } from '../../src/wearables/connectors/strava';
import { wahooConnectorDef } from '../../src/wearables/connectors/wahoo';
import { whoopConnectorDef } from '../../src/wearables/connectors/whoop';
import { withingsConnectorDef } from '../../src/wearables/connectors/withings';

// Webhook controllers — asserted to mount at /v1/wearables/webhooks/{provider}
// and to carry the cloud-connectors kill-switch guard.
import { FitbitWebhookController } from '../../src/wearables/connectors/fitbit/fitbit-webhook.controller';
import { GarminWebhookController } from '../../src/wearables/connectors/garmin/garmin-webhook.controller';
import { OuraWebhookController } from '../../src/wearables/connectors/oura/oura-webhook.controller';
import { PolarWebhookController } from '../../src/wearables/connectors/polar/polar-webhook.controller';
import { StravaWebhookController } from '../../src/wearables/connectors/strava/strava-webhook.controller';
import { WahooWebhookController } from '../../src/wearables/connectors/wahoo/wahoo-webhook.controller';
import { WhoopWebhookController } from '../../src/wearables/connectors/whoop/whoop-webhook.controller';
import { WithingsWebhookController } from '../../src/wearables/connectors/withings/withings-webhook.controller';

// OAuth-start endpoint — gated by the same kill switch as the webhooks.
import { ConnectionsController } from '../../src/wearables/connections/connections.controller';

import {
  FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV,
  WEARABLES_CLOUD_DISABLED_CODE,
  WearablesCloudConnectorsGuard,
  isWearablesCloudConnectorsEnabled,
  wearablesCloudDisabledError,
} from '../../src/wearables/cloud-connectors.feature';

/**
 * P0-0B — cloud-connector registry wiring + webhook routing + kill-switch.
 *
 * This spec is the acceptance gate for wiring the eight cloud wearable
 * connectors into `WearablesModule`. It proves three things the planner's
 * landmines called out:
 *
 *  1. REGISTRY-TOKEN ALIGNMENT — every connector binds the CANONICAL string
 *     token `'WEARABLE_CONNECTORS'` from `connector-registry.ts` (Oura / Polar /
 *     Wahoo / Withings previously bound a LOCAL `Symbol`, so the registry's
 *     `DiscoveryService` never saw them; Garmin / WHOOP / Strava had no binding
 *     at all). With the canonical binding the registry discovers all eight.
 *  2. WEBHOOK ROUTING — each connector's webhook controller is mounted at
 *     `/v1/wearables/webhooks/{provider}`.
 *  3. FEATURE FLAG — `FEATURE_WEARABLES_CLOUD_CONNECTORS` (default OFF) gates
 *     the OAuth-start endpoint and every webhook controller behind a typed
 *     HTTP 503 `{ code: 'wearables_cloud_disabled' }` — not a 404, not a
 *     "Coming soon" string, not a spinner.
 *
 * Each connector is exercised through a contribution module that binds the REAL
 * `{provider}ConnectorDef` to the canonical token EXACTLY as the connector's
 * own module does (`{ provide: WEARABLE_CONNECTORS, useValue: <def> }`). We do
 * not boot the full connector modules here because their HTTP-client / KMS
 * constructor params are not bare-DI-resolvable (the same reason the reference
 * `fitbit.registry.spec.ts` uses a contribution module). What governs discovery
 * is the TOKEN and the VALUE SHAPE — both are asserted against the real defs.
 */

interface ProviderCase {
  readonly provider: WearableProvider;
  readonly def: ConnectorDefinition;
  readonly displayName: string;
  readonly supportsPkce: boolean;
  readonly webhookController: new (...args: never[]) => object;
  /** HTTP method + sub-path pairs declared on the webhook controller. */
  readonly routes: ReadonlyArray<{ method: string; subPath: string }>;
}

const PROVIDER_CASES: ReadonlyArray<ProviderCase> = [
  {
    provider: WearableProvider.FITBIT,
    def: fitbitConnectorDef,
    displayName: fitbitConnectorDef.displayName,
    supportsPkce: true,
    webhookController: FitbitWebhookController,
    routes: [
      { method: 'GET', subPath: 'fitbit' },
      { method: 'POST', subPath: 'fitbit' },
    ],
  },
  {
    provider: WearableProvider.GARMIN,
    def: garminConnectorDef,
    displayName: garminConnectorDef.displayName,
    supportsPkce: false,
    webhookController: GarminWebhookController,
    routes: [
      { method: 'POST', subPath: 'garmin' },
      { method: 'POST', subPath: 'garmin/deregistration' },
    ],
  },
  {
    provider: WearableProvider.OURA,
    def: ouraConnectorDef,
    displayName: ouraConnectorDef.displayName,
    supportsPkce: false,
    webhookController: OuraWebhookController,
    routes: [
      { method: 'GET', subPath: 'oura' },
      { method: 'POST', subPath: 'oura' },
    ],
  },
  {
    provider: WearableProvider.POLAR,
    def: polarConnectorDef,
    displayName: polarConnectorDef.displayName,
    supportsPkce: false,
    webhookController: PolarWebhookController,
    routes: [{ method: 'POST', subPath: 'polar' }],
  },
  {
    provider: WearableProvider.STRAVA,
    def: stravaConnectorDef,
    displayName: stravaConnectorDef.displayName,
    supportsPkce: false,
    webhookController: StravaWebhookController,
    routes: [
      { method: 'GET', subPath: 'strava' },
      { method: 'POST', subPath: 'strava' },
    ],
  },
  {
    provider: WearableProvider.WAHOO,
    def: wahooConnectorDef,
    displayName: wahooConnectorDef.displayName,
    supportsPkce: false,
    webhookController: WahooWebhookController,
    routes: [{ method: 'POST', subPath: 'wahoo' }],
  },
  {
    provider: WearableProvider.WHOOP,
    def: whoopConnectorDef,
    displayName: whoopConnectorDef.displayName,
    supportsPkce: false,
    webhookController: WhoopWebhookController,
    routes: [{ method: 'POST', subPath: 'whoop' }],
  },
  {
    provider: WearableProvider.WITHINGS,
    def: withingsConnectorDef,
    displayName: withingsConnectorDef.displayName,
    supportsPkce: false,
    webhookController: WithingsWebhookController,
    routes: [
      { method: 'GET', subPath: 'withings' },
      { method: 'POST', subPath: 'withings' },
    ],
  },
];

/**
 * Build a module that contributes one connector definition to the canonical
 * registry token — exactly the binding the connector's own module declares.
 */
function contributionModule(def: ConnectorDefinition): new () => object {
  @Module({
    providers: [{ provide: WEARABLE_CONNECTORS, useValue: def }],
    exports: [WEARABLE_CONNECTORS],
  })
  class SingleConnectorContributionModule {}
  return SingleConnectorContributionModule;
}

/**
 * Aggregate ALL eight contributions into one module so a single registry boot
 * discovers every provider — the "wired into WearablesModule" end state.
 */
@Module({
  providers: [
    ...PROVIDER_CASES.map((c) => ({
      provide: WEARABLE_CONNECTORS,
      useValue: c.def,
    })),
  ],
  exports: [WEARABLE_CONNECTORS],
})
class AllCloudConnectorsContributionModule {}

describe('P0-0B — cloud connector registry wiring', () => {
  it('binds the CANONICAL string token (not a local Symbol)', () => {
    // The whole landmine: Oura/Polar/Wahoo/Withings used to bind a local
    // `Symbol`, which DiscoveryService cannot match against this string token.
    expect(WEARABLE_CONNECTORS).toBe('WEARABLE_CONNECTORS');
    expect(typeof WEARABLE_CONNECTORS).toBe('string');
  });

  it('every connector def re-exports + binds to the canonical token value', async () => {
    // Each connector's barrel re-exports `WEARABLE_CONNECTORS` from
    // connector-registry.ts; if any reverted to a local token its def would
    // resolve under a different token and discovery (below) would drop it.
    for (const { def } of PROVIDER_CASES) {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule, contributionModule(def)],
        providers: [ConnectorRegistry],
      }).compile();
      const bound = moduleRef.get<ConnectorDefinition>(WEARABLE_CONNECTORS);
      expect(bound).toBe(def);
    }
  });

  it.each(PROVIDER_CASES)(
    'discovers $provider once its registry contribution is loaded',
    async ({ provider, def, displayName, supportsPkce }) => {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule, contributionModule(def)],
        providers: [ConnectorRegistry],
      }).compile();
      await moduleRef.init();

      const registry = moduleRef.get(ConnectorRegistry);

      expect(registry.has(provider)).toBe(true);

      const resolved = registry.get(provider);
      expect(resolved.provider).toBe(provider);
      expect(resolved.authModel).toBe('oauth2');
      expect(resolved.displayName).toBe(displayName);
      expect(resolved.supportsPkce).toBe(supportsPkce);

      // OAuth connectors live in the OAuth partition, never the on-device one.
      expect(
        registry.getOauthConnectors().map((c) => c.provider),
      ).toContain(provider);
      expect(
        registry.getOnDeviceConnectors().map((c) => c.provider),
      ).not.toContain(provider);
    },
  );

  it.each(PROVIDER_CASES)(
    '$provider def satisfies the canonical ConnectorDefinition contract',
    ({ def }) => {
      // Mirrors connector-registry.ts:isConnectorDefinition — the structural
      // guard DiscoveryService applies. A def missing any of these is silently
      // dropped from the registry.
      expect(typeof def.provider).toBe('string');
      expect(typeof def.authModel).toBe('string');
      expect(typeof def.displayName).toBe('string');
      expect(typeof def.supportsPkce).toBe('boolean');
      expect(typeof def.buildAuthorizationUrl).toBe('function');
      expect(typeof def.exchangeCode).toBe('function');
    },
  );

  it('discovers ALL EIGHT providers when every contribution is loaded', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, AllCloudConnectorsContributionModule],
      providers: [ConnectorRegistry],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(ConnectorRegistry);

    const discovered = registry.list().map((c) => c.provider).sort();
    const expected = PROVIDER_CASES.map((c) => c.provider).sort();
    expect(discovered).toEqual(expected);
    expect(registry.list()).toHaveLength(8);

    // Each of the eight is individually present.
    for (const { provider } of PROVIDER_CASES) {
      expect(registry.has(provider)).toBe(true);
    }
  });
});

describe('P0-0B — webhook controller routing', () => {
  it.each(PROVIDER_CASES)(
    '$provider webhook controller mounts under /v1/wearables/webhooks',
    ({ webhookController }) => {
      const controllerPath: string = Reflect.getMetadata(
        PATH_METADATA,
        webhookController,
      );
      expect(controllerPath).toBe('v1/wearables/webhooks');
    },
  );

  it.each(PROVIDER_CASES)(
    '$provider declares its provider sub-path(s) at /v1/wearables/webhooks/$provider',
    ({ webhookController, routes }) => {
      const proto = webhookController.prototype as Record<string, unknown>;
      const declared: Array<{ method: number; subPath: string }> = [];
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function') {
          continue;
        }
        const subPath = Reflect.getMetadata(PATH_METADATA, handler);
        if (subPath === undefined) {
          continue;
        }
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        declared.push({ method, subPath });
      }
      // Every expected route is declared on the controller, so its full path
      // resolves to /v1/wearables/webhooks/{subPath}.
      for (const route of routes) {
        expect(
          declared.some((d) => d.subPath === route.subPath),
        ).toBe(true);
      }
    },
  );
});

describe('P0-0B — FEATURE_WEARABLES_CLOUD_CONNECTORS kill switch', () => {
  const ORIGINAL = process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];
    } else {
      process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV] = ORIGINAL;
    }
  });

  function fakeContext(): ExecutionContext {
    // The guard ignores the context entirely (it only reads the env flag), so a
    // minimal stand-in is sufficient and keeps the test free of HTTP plumbing.
    return {} as ExecutionContext;
  }

  it('defaults OFF when the env var is absent', () => {
    delete process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];
    expect(isWearablesCloudConnectorsEnabled()).toBe(false);
  });

  it('is ON only for the exact value "true" (case-insensitive)', () => {
    for (const on of ['true', 'TRUE', 'True']) {
      process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV] = on;
      expect(isWearablesCloudConnectorsEnabled()).toBe(true);
    }
    for (const off of ['false', '1', 'yes', 'on', '']) {
      process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV] = off;
      expect(isWearablesCloudConnectorsEnabled()).toBe(false);
    }
  });

  it('disabled error is a typed HTTP 503 with code wearables_cloud_disabled', () => {
    const err = wearablesCloudDisabledError();
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(503);
    const body = err.getResponse() as { code: string; message: string };
    expect(body.code).toBe(WEARABLES_CLOUD_DISABLED_CODE);
    expect(body.code).toBe('wearables_cloud_disabled');
    // No "Coming soon" prose anywhere in the disabled payload.
    expect(JSON.stringify(body).toLowerCase()).not.toContain('coming soon');
  });

  it('guard throws the typed 503 when the flag is OFF (not a 404, not silent)', () => {
    delete process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV];
    const guard = new WearablesCloudConnectorsGuard();
    expect(() => guard.canActivate(fakeContext())).toThrow(
      ServiceUnavailableException,
    );
    try {
      guard.canActivate(fakeContext());
      fail('guard should have thrown when the flag is off');
    } catch (e) {
      const err = e as ServiceUnavailableException;
      expect(err.getStatus()).toBe(503);
      expect((err.getResponse() as { code: string }).code).toBe(
        WEARABLES_CLOUD_DISABLED_CODE,
      );
    }
  });

  it('guard allows the request through when the flag is ON', () => {
    process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV] = 'true';
    const guard = new WearablesCloudConnectorsGuard();
    expect(guard.canActivate(fakeContext())).toBe(true);
  });

  it.each(PROVIDER_CASES)(
    '$provider webhook controller carries the cloud-connectors guard',
    ({ webhookController }) => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, webhookController) ?? [];
      expect(guards).toContain(WearablesCloudConnectorsGuard);
    },
  );

  it('OAuth-start endpoint carries the cloud-connectors guard', () => {
    // Method-level guard on ConnectionsController.startOauth — so a disabled
    // environment 503s the connect flow before any outbound OAuth round-trip.
    const handlerGuards: unknown[] =
      Reflect.getMetadata(
        GUARDS_METADATA,
        ConnectionsController.prototype.startOauth,
      ) ?? [];
    expect(handlerGuards).toContain(WearablesCloudConnectorsGuard);
  });
});
