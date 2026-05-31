import { WearableProvider, WearableConnection } from '@prisma/client';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ConnectorRegistry,
  ConnectorDefinition,
  WEARABLE_CONNECTORS,
} from './connector-registry';
import { TokenSet, NormalizedSample, RawRecord } from './normalization/normalizer.types';

/** Build a minimal ConnectorDefinition test double for a given provider/auth model. */
function makeConnector(
  provider: WearableProvider,
  authModel: ConnectorDefinition['authModel'],
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    provider,
    authModel,
    displayName: `${provider} label`,
    supportsPkce: authModel === 'oauth2',
    buildAuthorizationUrl: (redirectUri, state) =>
      authModel === 'on-device'
        ? null
        : `https://provider.example/auth?state=${state}&redirect=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async (): Promise<TokenSet> => ({ refreshToken: 'rt' }),
    buildAuthUrl: () => null,
    refresh: async (_conn: WearableConnection): Promise<TokenSet> => ({ refreshToken: 'rt' }),
    backfill: async (): Promise<RawRecord[]> => [],
    normalize: (): NormalizedSample[] => [],
    ...overrides,
  };
}

describe('ConnectorRegistry', () => {
  describe('empty registry (PR-HK-1 default state)', () => {
    it('constructs with no connectors and lists nothing', () => {
      const reg = new ConnectorRegistry();
      reg.registerForTest([]);
      expect(reg.list()).toEqual([]);
      expect(reg.getOauthConnectors()).toEqual([]);
      expect(reg.getOnDeviceConnectors()).toEqual([]);
    });

    it('onModuleInit is a no-op when constructed without DiscoveryService', () => {
      const reg = new ConnectorRegistry();
      reg.onModuleInit();
      expect(reg.list()).toEqual([]);
    });

    it('has() is false and get() throws for an unregistered provider', () => {
      const reg = new ConnectorRegistry();
      reg.registerForTest([]);
      expect(reg.has(WearableProvider.OURA)).toBe(false);
      expect(() => reg.get(WearableProvider.OURA)).toThrow(
        /No wearable connector registered for provider "OURA"/,
      );
    });
  });

  describe('with registered connectors', () => {
    const oura = makeConnector(WearableProvider.OURA, 'oauth2');
    const whoop = makeConnector(WearableProvider.WHOOP, 'oauth2');
    const healthkit = makeConnector(WearableProvider.APPLE_HEALTHKIT, 'on-device', {
      supportsPkce: false,
    });
    const samsung = makeConnector(WearableProvider.SAMSUNG_HEALTH, 'on-device', {
      supportsPkce: false,
    });
    let reg: ConnectorRegistry;

    beforeEach(() => {
      reg = new ConnectorRegistry();
      reg.registerForTest([oura, whoop, healthkit, samsung]);
    });

    it('get() resolves the exact definition by provider', () => {
      expect(reg.get(WearableProvider.OURA)).toBe(oura);
      expect(reg.get(WearableProvider.WHOOP)).toBe(whoop);
    });

    it('list() returns all four in insertion order', () => {
      expect(reg.list().map((c) => c.provider)).toEqual([
        WearableProvider.OURA,
        WearableProvider.WHOOP,
        WearableProvider.APPLE_HEALTHKIT,
        WearableProvider.SAMSUNG_HEALTH,
      ]);
    });

    it('getOauthConnectors() returns only oauth2 connectors', () => {
      expect(reg.getOauthConnectors().map((c) => c.provider).sort()).toEqual(
        [WearableProvider.OURA, WearableProvider.WHOOP].sort(),
      );
    });

    it('getOnDeviceConnectors() returns only on-device connectors', () => {
      expect(reg.getOnDeviceConnectors().map((c) => c.provider).sort()).toEqual(
        [WearableProvider.APPLE_HEALTHKIT, WearableProvider.SAMSUNG_HEALTH].sort(),
      );
    });

    it('partitions are disjoint and cover the full list', () => {
      const oauth = reg.getOauthConnectors().length;
      const onDevice = reg.getOnDeviceConnectors().length;
      expect(oauth + onDevice).toBe(reg.list().length);
    });
  });

  describe('duplicate-provider guard', () => {
    it('throws when two connectors claim the same provider', () => {
      const a = makeConnector(WearableProvider.OURA, 'oauth2');
      const b = makeConnector(WearableProvider.OURA, 'oauth2');
      const reg = new ConnectorRegistry();
      expect(() => reg.registerForTest([a, b])).toThrow(
        /Duplicate wearable connector registered for provider "OURA"/,
      );
    });
  });

  describe('DiscoveryService aggregation (the connector-PR registration path)', () => {
    // Each connector lives in its OWN module binding the shared token — this
    // mirrors exactly how PR-HK-2.* connector modules contribute.
    const oura = makeConnector(WearableProvider.OURA, 'oauth2');
    const hk = makeConnector(WearableProvider.APPLE_HEALTHKIT, 'on-device');

    @Module({
      providers: [{ provide: WEARABLE_CONNECTORS, useValue: oura }],
      exports: [WEARABLE_CONNECTORS],
    })
    class OuraConnectorModule {}

    @Module({
      providers: [{ provide: WEARABLE_CONNECTORS, useValue: hk }],
      exports: [WEARABLE_CONNECTORS],
    })
    class HealthkitConnectorModule {}

    it('aggregates token bindings contributed by independent connector modules', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule, OuraConnectorModule, HealthkitConnectorModule],
        providers: [ConnectorRegistry],
      }).compile();
      await moduleRef.init();

      const reg = moduleRef.get(ConnectorRegistry);
      expect(reg.list().map((c) => c.provider).sort()).toEqual(
        [WearableProvider.OURA, WearableProvider.APPLE_HEALTHKIT].sort(),
      );
      expect(reg.getOauthConnectors()).toHaveLength(1);
      expect(reg.getOnDeviceConnectors()).toHaveLength(1);
      expect(reg.get(WearableProvider.OURA)).toBe(oura);
    });

    it('boots an EMPTY registry when no connector module is present', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule],
        providers: [ConnectorRegistry],
      }).compile();
      await moduleRef.init();
      const reg = moduleRef.get(ConnectorRegistry);
      expect(reg.list()).toEqual([]);
    });
  });
});
