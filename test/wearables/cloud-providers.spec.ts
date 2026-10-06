import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { ConnectionsController } from '../../src/wearables/connections/connections.controller';
import { ConnectionsService } from '../../src/wearables/connections/connections.service';
import { OauthCallbackDto } from '../../src/wearables/connections/dto/oauth-callback.dto';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import type { PrismaService } from '../../src/prisma.service';
import type { KmsService } from '../../src/common/kms/kms.service';
import type { ConnectorRegistry } from '../../src/wearables/connector-registry';
import type { OauthStateService } from '../../src/wearables/oauth/oauth-state.service';
import {
  CLOUD_PROVIDER_ENV,
  CLOUD_PROVIDERS,
  connectableCloudProviders,
} from '../../src/wearables/connections/cloud-availability';

// B-WEARLIST-125: a cloud tracker is listed only when it is really
// connectable: master switch on, shared OAuth settings and every credential
// that provider reads present, and its connector registered.
const SHARED = {
  WEARABLES_OAUTH_REDIRECT_BASE_URL: 'https://api.example.test/api',
  KMS_MASTER_KEY: 'k',
};
const OURA = {
  OURA_CLIENT_ID: 'id',
  OURA_CLIENT_SECRET: 'secret',
  OURA_REDIRECT_URI: 'https://api.example.test/cb',
};
const all = () => true;

describe('connectableCloudProviders (B-WEARLIST-125)', () => {
  it('lists nothing while the master switch is off, even with every key set', () => {
    expect(connectableCloudProviders(all, { ...SHARED, ...OURA }, false)).toEqual([]);
  });

  it('lists nothing when no provider keys are set (production today)', () => {
    expect(connectableCloudProviders(all, { ...SHARED }, true)).toEqual([]);
  });

  it('lists a provider once all of its credentials are present', () => {
    expect(connectableCloudProviders(all, { ...SHARED, ...OURA }, true)).toEqual([
      WearableProvider.OURA,
    ]);
  });

  it('skips a provider with any credential missing or blank', () => {
    for (const name of Object.keys(OURA)) {
      const env: Record<string, string | undefined> = { ...SHARED, ...OURA, [name]: '  ' };
      expect(connectableCloudProviders(all, env, true)).toEqual([]);
      delete env[name];
      expect(connectableCloudProviders(all, env, true)).toEqual([]);
    }
  });

  it('lists nothing when a shared OAuth setting is missing', () => {
    for (const name of Object.keys(SHARED)) {
      const env: Record<string, string | undefined> = { ...SHARED, ...OURA };
      delete env[name];
      expect(connectableCloudProviders(all, env, true)).toEqual([]);
    }
  });

  it('skips a provider whose connector is not registered', () => {
    expect(connectableCloudProviders(() => false, { ...SHARED, ...OURA }, true)).toEqual([]);
  });

  it('lists every cloud provider in a stable order when all keys are set', () => {
    const env: Record<string, string> = { ...SHARED };
    for (const provider of CLOUD_PROVIDERS) {
      for (const name of CLOUD_PROVIDER_ENV[provider]) env[name] = 'set';
    }
    expect(connectableCloudProviders(all, env, true)).toEqual([...CLOUD_PROVIDERS]);
  });

  it('reads the master switch from FEATURE_WEARABLES_CLOUD_CONNECTORS by default', () => {
    const prev = process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS;
    try {
      delete process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS;
      expect(connectableCloudProviders(all, { ...SHARED, ...OURA })).toEqual([]);
      process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS = 'true';
      expect(connectableCloudProviders(all, { ...SHARED, ...OURA })).toEqual([
        WearableProvider.OURA,
      ]);
    } finally {
      if (prev === undefined) delete process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS;
      else process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS = prev;
    }
  });
});

// The service method reads the real registry: on-device connectors never count.
describe('ConnectionsService.connectableCloudProviders (B-WEARLIST-125)', () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });

  function serviceWith(models: Partial<Record<WearableProvider, string>>): ConnectionsService {
    const registry: Pick<ConnectorRegistry, 'has' | 'get'> = {
      has: (p: WearableProvider) => p in models,
      get: (p: WearableProvider) => {
        const authModel = models[p];
        if (!authModel) throw new Error('not registered');
        return { authModel } as ReturnType<ConnectorRegistry['get']>;
      },
    };
    return new ConnectionsService(
      {} as PrismaService,
      {} as KmsService,
      registry as ConnectorRegistry,
      {} as OauthStateService,
    );
  }

  it('lists Oura once the switch is on and its keys are set; not before', () => {
    const svc = serviceWith({ OURA: 'oauth2' });
    process.env.FEATURE_WEARABLES_CLOUD_CONNECTORS = 'true';
    Object.assign(process.env, SHARED);
    expect(svc.connectableCloudProviders()).toEqual([]);
    Object.assign(process.env, OURA);
    expect(svc.connectableCloudProviders()).toEqual([WearableProvider.OURA]);
  });
});

describe('GET /v1/wearables/connections/providers (B-WEARLIST-125)', () => {
  it('is an authenticated GET route for clients and coaches', () => {
    const h = ConnectionsController.prototype.providers;
    expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('providers');
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, h)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(['student', 'coach']);
  });

  it('returns provider names only', () => {
    const svc: Pick<ConnectionsService, 'connectableCloudProviders'> = {
      connectableCloudProviders: () => [WearableProvider.OURA, WearableProvider.POLAR],
    };
    const ctrl = new ConnectionsController(svc as ConnectionsService);
    expect(ctrl.providers()).toEqual({
      providers: [WearableProvider.OURA, WearableProvider.POLAR],
    });
  });
});

// A provider redirect carries no app JWT: before this fix the callback was a
// 401 for every person, so no cloud tracker could ever finish connecting.
describe('GET /v1/wearables/connections/oauth/callback (B-WEARLIST-125)', () => {
  function makeCtrl(handleCallback: jest.Mock) {
    const svc: Pick<ConnectionsService, 'handleCallback'> = { handleCallback };
    return new ConnectionsController(svc as ConnectionsService);
  }

  it('is public (the single-use state names the user) and keeps no role gate', () => {
    const h = ConnectionsController.prototype.oauthCallback;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, h)).toBe(true);
    expect(Reflect.getMetadata(ROLES_KEY, h)).toBeUndefined();
    for (const other of [
      ConnectionsController.prototype.startOauth,
      ConnectionsController.prototype.list,
      ConnectionsController.prototype.disconnect,
      ConnectionsController.prototype.registerOnDevice,
    ]) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, other)).toBeUndefined();
    }
  });

  it('completes the exchange and sends the browser back to the app', async () => {
    const handleCallback = jest
      .fn()
      .mockResolvedValue({ success: true, provider: WearableProvider.OURA });
    const res = { redirect: jest.fn() };
    await makeCtrl(handleCallback).oauthCallback({ code: 'c1', state: 's1' }, res);
    expect(handleCallback).toHaveBeenCalledWith({ code: 'c1', state: 's1' });
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'tgp://wearables/connected?status=ok&provider=OURA',
    );
  });

  it('sends a bad state or failed exchange back to the app as an error', async () => {
    const handleCallback = jest
      .fn()
      .mockRejectedValue(new BadRequestException('Invalid or expired OAuth state.'));
    const res = { redirect: jest.fn() };
    await makeCtrl(handleCallback).oauthCallback({ code: 'c1', state: 'bad' }, res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'tgp://wearables/connected?status=error');
  });

  it('sends a declined consent back as an error with no exchange', async () => {
    const handleCallback = jest.fn();
    const res = { redirect: jest.fn() };
    await makeCtrl(handleCallback).oauthCallback({ state: 's1', error: 'access_denied' }, res);
    expect(handleCallback).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, 'tgp://wearables/connected?status=error');
  });

  describe('query validation under the global pipe (forbidNonWhitelisted)', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta: ArgumentMetadata = { type: 'query', metatype: OauthCallbackDto, data: '' };

    it('accepts the scope Strava, WHOOP and Oura add to a normal callback', async () => {
      await expect(
        pipe.transform({ code: 'c', state: 's', scope: 'read,activity:read_all' }, meta),
      ).resolves.toMatchObject({ code: 'c', state: 's' });
    });

    it('accepts a declined consent with no code', async () => {
      await expect(
        pipe.transform({ state: 's', error: 'access_denied', error_description: 'denied' }, meta),
      ).resolves.toMatchObject({ state: 's', error: 'access_denied' });
    });

    it('still rejects a missing state and unknown parameters', async () => {
      await expect(pipe.transform({ code: 'c' }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        pipe.transform({ code: 'c', state: 's', userId: 'u' }, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
