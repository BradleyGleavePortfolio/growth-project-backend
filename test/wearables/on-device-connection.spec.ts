import 'reflect-metadata';
import {
  ArgumentMetadata,
  BadRequestException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import type { User } from '@prisma/client';
import { ConnectionsController } from '../../src/wearables/connections/connections.controller';
import {
  ConnectionsService,
  ON_DEVICE_ACCOUNT_ID,
} from '../../src/wearables/connections/connections.service';
import { RegisterOnDeviceDto } from '../../src/wearables/connections/dto/register-on-device.dto';
import { SAFE_CONNECTION_SELECT } from '../../src/wearables/connections/types';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { PrismaService } from '../../src/prisma.service';
import type { KmsService } from '../../src/common/kms/kms.service';
import type { ConnectorRegistry } from '../../src/wearables/connector-registry';
import type { OauthStateService } from '../../src/wearables/oauth/oauth-state.service';

// S14 — `POST /v1/wearables/connections/on-device`.
//
// The on-device lane had no way to create the WearableConnection row that
// `POST /v1/wearables/samples/ingest` requires (every sample's connectionId must
// be a live connection owned by the JWT user). These tests pin the new route:
// kill switch first, JWT-derived owner, on-device providers only, body
// validation that rejects a userId, and a single race-safe upsert that never
// selects token columns.

const USER = '11111111-1111-1111-1111-111111111111';

function reqFor(id: string): AuthedRequest {
  const user: Pick<User, 'id' | 'role'> = { id, role: 'student' as User['role'] };
  return { user: user as User };
}

function makeService(): { svc: ConnectionsService; upsert: jest.Mock } {
  const upsert = jest.fn().mockResolvedValue({
    id: '33333333-3333-3333-3333-333333333333',
    user_id: USER,
    provider: WearableProvider.APPLE_HEALTHKIT,
    status: 'connected',
  });
  const prisma = { wearableConnection: { upsert } };
  const svc = new ConnectionsService(
    // @ts-expect-error test double: registerOnDevice only calls wearableConnection.upsert
    prisma as PrismaService,
    {} as KmsService,
    {} as ConnectorRegistry,
    {} as OauthStateService,
  );
  return { svc, upsert };
}

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const bodyMeta: ArgumentMetadata = {
  type: 'body',
  metatype: RegisterOnDeviceDto,
  data: '',
};

describe('POST /v1/wearables/connections/on-device (S14)', () => {
  const originalFlag = process.env.FEATURE_WEARABLES_INGEST_POST;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.FEATURE_WEARABLES_INGEST_POST;
    else process.env.FEATURE_WEARABLES_INGEST_POST = originalFlag;
  });

  it('is mounted as POST on-device, student-only', () => {
    const handler = ConnectionsController.prototype.registerOnDevice;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('on-device');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['student']);
  });

  it('returns the typed 503 before any DB access when the flag is unset', async () => {
    delete process.env.FEATURE_WEARABLES_INGEST_POST;
    const { svc, upsert } = makeService();
    const ctrl = new ConnectionsController(svc);
    let caught: unknown;
    try {
      await ctrl.registerOnDevice(reqFor(USER), {
        provider: WearableProvider.APPLE_HEALTHKIT,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'wearables_ingest_disabled',
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upserts one row per (JWT user, provider) with the on-device sentinel and a token-free select', async () => {
    process.env.FEATURE_WEARABLES_INGEST_POST = 'true';
    const { svc, upsert } = makeService();
    const ctrl = new ConnectionsController(svc);
    const result = await ctrl.registerOnDevice(reqFor(USER), {
      provider: WearableProvider.HEALTH_CONNECT,
    });
    expect(result.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      WearableConnection_user_provider_account_key: {
        user_id: USER,
        provider: WearableProvider.HEALTH_CONNECT,
        external_account_id: ON_DEVICE_ACCOUNT_ID,
      },
    });
    expect(args.create).toEqual({
      user_id: USER,
      provider: WearableProvider.HEALTH_CONNECT,
      external_account_id: ON_DEVICE_ACCOUNT_ID,
      status: 'connected',
    });
    // Re-registering after a disconnect re-activates the same row.
    expect(args.update).toEqual({
      status: 'connected',
      last_error: null,
      disconnected_at: null,
    });
    expect(args.select).toBe(SAFE_CONNECTION_SELECT);
    expect(Object.keys(args.select).some((k) => k.startsWith('encrypted_'))).toBe(false);
  });

  it('service refuses a cloud provider even if called directly', async () => {
    const { svc, upsert } = makeService();
    await expect(
      // @ts-expect-error deliberately passing a non on-device provider
      svc.registerOnDevice(USER, WearableProvider.GARMIN),
    ).rejects.toThrow(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  describe('body validation (global ValidationPipe settings)', () => {
    it.each([WearableProvider.APPLE_HEALTHKIT, WearableProvider.HEALTH_CONNECT])(
      'accepts %s',
      async (provider) => {
        await expect(pipe.transform({ provider }, bodyMeta)).resolves.toMatchObject({
          provider,
        });
      },
    );

    it.each([WearableProvider.GARMIN, WearableProvider.SAMSUNG_HEALTH, 'NOT_A_PROVIDER'])(
      'rejects provider %s',
      async (provider) => {
        await expect(pipe.transform({ provider }, bodyMeta)).rejects.toThrow(BadRequestException);
      },
    );

    it('rejects a body userId (owner always comes from the JWT)', async () => {
      await expect(
        pipe.transform({ provider: WearableProvider.APPLE_HEALTHKIT, userId: USER }, bodyMeta),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
