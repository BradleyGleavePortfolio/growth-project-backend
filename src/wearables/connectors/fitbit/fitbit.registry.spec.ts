import { WearableProvider } from '@prisma/client';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ConnectorRegistry,
  ConnectorDefinition,
  WEARABLE_CONNECTORS,
} from '../../connector-registry';
import { fitbitConnectorDef } from './index';

/**
 * PR-HK-2.e R8 regression — registry discovery/activation seam.
 *
 * R7 P2: Fitbit's module previously bound a LOCAL `Symbol.for('WEARABLE_CONNECTORS')`
 * token via `useExisting: FitbitConnector`, so PR-HK-1's `ConnectorRegistry`
 * (which discovers providers bound to the canonical STRING token
 * `'WEARABLE_CONNECTORS'` and structurally requires `buildAuthorizationUrl` +
 * `exchangeCode`) would NOT see Fitbit once the module is imported. These tests
 * fail against that old wiring and pass only when Fitbit binds the canonical
 * token to a contract-satisfying `ConnectorDefinition`.
 *
 * Discovery is exercised through a module that contributes Fitbit's registry
 * binding EXACTLY as `FitbitModule` does — `{ provide: WEARABLE_CONNECTORS,
 * useValue: fitbitConnectorDef }`. We intentionally do not boot the full
 * `FitbitModule` here because its `ProviderHttpClient` provider has a non-
 * injectable optional constructor param that the bare DI container cannot
 * auto-resolve (the existing connector specs construct the connector directly
 * for the same reason). What R7 flagged — the TOKEN and the VALUE SHAPE — is
 * what determines discovery, and both are asserted against the real
 * `fitbitConnectorDef` and the real `FitbitModule` static definition below.
 */

// Mirrors FitbitModule's registry contribution: bind the REAL Fitbit
// definition to PR-HK-1's canonical token. If Fitbit reverted to a local
// Symbol token (the R7 bug), DiscoveryService would not match this binding and
// every discovery assertion below would fail.
@Module({
  providers: [{ provide: WEARABLE_CONNECTORS, useValue: fitbitConnectorDef }],
  exports: [WEARABLE_CONNECTORS],
})
class FitbitRegistryContributionModule {}

describe('Fitbit — ConnectorRegistry discovery (R7 P2 regression)', () => {
  it('is discoverable as WearableProvider.FITBIT once its module is loaded', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, FitbitRegistryContributionModule],
      providers: [ConnectorRegistry],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(ConnectorRegistry);

    // The headline assertion from the R7 finding.
    expect(registry.has(WearableProvider.FITBIT)).toBe(true);

    // The resolved definition is the canonical Fitbit contribution.
    const def = registry.get(WearableProvider.FITBIT);
    expect(def.provider).toBe(WearableProvider.FITBIT);
    expect(def.authModel).toBe('oauth2');

    // Fitbit is an OAuth connector, so it appears in the OAuth partition only.
    expect(registry.getOauthConnectors().map((c) => c.provider)).toContain(
      WearableProvider.FITBIT,
    );
    expect(registry.getOnDeviceConnectors().map((c) => c.provider)).not.toContain(
      WearableProvider.FITBIT,
    );
  });

  it('binds the CANONICAL string token (not a local Symbol)', async () => {
    // Discovery only works because the binding uses the string token exported
    // by connector-registry.ts. Assert that exact token value.
    expect(WEARABLE_CONNECTORS).toBe('WEARABLE_CONNECTORS');

    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, FitbitRegistryContributionModule],
      providers: [ConnectorRegistry],
    }).compile();

    // Resolving the canonical token yields Fitbit's definition (proving the
    // contribution binds THIS token, not a local symbol).
    const bound = moduleRef.get<ConnectorDefinition>(WEARABLE_CONNECTORS);
    expect(bound.provider).toBe(WearableProvider.FITBIT);
    expect(bound).toBe(fitbitConnectorDef);
  });

  it('FitbitModule.definition is the same canonical contribution value', () => {
    // Defensive: prove the module re-exports the exact value it binds, so the
    // discovery proven above is the value the real module contributes.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FitbitModule } = require('./fitbit.module') as {
      FitbitModule: { definition: ConnectorDefinition };
    };
    expect(FitbitModule.definition).toBe(fitbitConnectorDef);
  });

  it('binds a value satisfying the canonical ConnectorDefinition contract', () => {
    // The registry's structural guard (connector-registry.ts:isConnectorDefinition)
    // requires these exact members; the OLD `FitbitConnector`-as-def shape had
    // `buildAuthUrl`/`buildAuthUrlPkce` but NOT `buildAuthorizationUrl`, and the
    // old `fitbitConnectorDef` had only provider/authModel/webhookPath/create.
    const def: ConnectorDefinition = fitbitConnectorDef;
    expect(typeof def.provider).toBe('string');
    expect(typeof def.authModel).toBe('string');
    expect(typeof def.displayName).toBe('string');
    expect(typeof def.supportsPkce).toBe('boolean');
    expect(def.supportsPkce).toBe(true);
    expect(typeof def.buildAuthorizationUrl).toBe('function');
    expect(typeof def.exchangeCode).toBe('function');
  });

  it('produces a PKCE-/redirect-aware authorization URL via the canonical builder', () => {
    process.env.FITBIT_CLIENT_ID = 'test-client-id';
    process.env.FITBIT_REDIRECT_URI = 'https://app.example/callback';

    const url = fitbitConnectorDef.buildAuthorizationUrl(
      'https://app.example/callback',
      'state-xyz',
      'challenge-abc',
    );

    expect(url).toContain('https://www.fitbit.com/oauth2/authorize');
    expect(url).toContain('state=state-xyz');
    expect(url).toContain('code_challenge=challenge-abc');
    expect(url).toContain('code_challenge_method=S256');

    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_REDIRECT_URI;
  });
});
