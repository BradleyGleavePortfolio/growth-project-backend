import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { ConnectionsController } from './connections.controller';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { ConnectProviderDto } from './dto/connect-provider.dto';
import { OauthCallbackDto } from './dto/oauth-callback.dto';
import { DisconnectProviderParamDto } from './dto/disconnect-provider.dto';
import type { AuthedRequest } from '../../auth/auth-request';

// The @Throttle decorator stores per-bucket metadata under
// `THROTTLER:LIMIT<name>`; the unnamed `default` bucket uses the suffix
// `default` (see test/billing-throttle-metadata.spec.ts).
const THROTTLE_LIMIT_DEFAULT_KEY = 'THROTTLER:LIMITdefault';

interface ServiceShape {
  startOauth: jest.Mock;
  handleCallback: jest.Mock;
  list: jest.Mock;
  disconnect: jest.Mock;
}

function makeReq(userId: string): AuthedRequest {
  return { user: { id: userId } as AuthedRequest['user'] };
}

describe('ConnectionsController', () => {
  let service: ServiceShape;
  let controller: ConnectionsController;

  beforeEach(() => {
    service = {
      startOauth: jest.fn(),
      handleCallback: jest.fn(),
      list: jest.fn(),
      disconnect: jest.fn(),
    };
    controller = new ConnectionsController(service as never);
  });

  describe('route + guard registration', () => {
    it('mounts the controller at v1/wearables/connections', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ConnectionsController)).toBe(
        'v1/wearables/connections',
      );
    });

    it('applies JwtAuthGuard at the controller level (all routes authed)', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, ConnectionsController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    });

    it('POST oauth/start → 200 with a throttle limit', () => {
      const h = controller.startOauth;
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('oauth/start');
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, h)).toBe(200);
      const limit = Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, h);
      expect(limit).toBe(10);
    });

    it('GET oauth/callback → 200 with a throttle limit', () => {
      const h = controller.oauthCallback;
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('oauth/callback');
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, h)).toBe(200);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, h)).toBe(20);
    });

    it('GET / (list) is a GET route', () => {
      const h = controller.list;
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('/');
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    });

    it('DELETE :provider is a DELETE route returning 200', () => {
      const h = controller.disconnect;
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(':provider');
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.DELETE);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, h)).toBe(200);
    });
  });

  describe('handler delegation (user scoped from JWT, never the body)', () => {
    it('startOauth passes req.user.id + body.provider', async () => {
      service.startOauth.mockResolvedValue({ authorizationUrl: 'u', state: 's' });
      const res = await controller.startOauth(makeReq('user-9'), {
        provider: WearableProvider.OURA,
      });
      expect(service.startOauth).toHaveBeenCalledWith('user-9', WearableProvider.OURA);
      expect(res).toEqual({ authorizationUrl: 'u', state: 's' });
    });

    it('oauthCallback forwards code + state and returns the service result', async () => {
      service.handleCallback.mockResolvedValue({
        success: true,
        provider: WearableProvider.OURA,
      });
      const res = await controller.oauthCallback({ code: 'c1', state: 's1' });
      expect(service.handleCallback).toHaveBeenCalledWith({ code: 'c1', state: 's1' });
      expect(res).toEqual({ success: true, provider: WearableProvider.OURA });
    });

    it('list passes the caller id only', async () => {
      service.list.mockResolvedValue([]);
      await controller.list(makeReq('user-7'));
      expect(service.list).toHaveBeenCalledWith('user-7');
    });

    it('disconnect passes req.user.id + the validated provider', async () => {
      service.disconnect.mockResolvedValue({
        success: true,
        provider: WearableProvider.WHOOP,
      });
      const res = await controller.disconnect(makeReq('user-3'), WearableProvider.WHOOP);
      expect(service.disconnect).toHaveBeenCalledWith('user-3', WearableProvider.WHOOP);
      expect(res).toEqual({ success: true, provider: WearableProvider.WHOOP });
    });
  });

  describe('DTO validation (global ValidationPipe contract)', () => {
    it('ConnectProviderDto accepts a valid provider', async () => {
      const dto = plainToInstance(ConnectProviderDto, { provider: WearableProvider.OURA });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('ConnectProviderDto rejects an unknown provider', async () => {
      const dto = plainToInstance(ConnectProviderDto, { provider: 'NOT_A_PROVIDER' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints?.isEnum).toBeTruthy();
    });

    it('OauthCallbackDto accepts code + state and trims them', async () => {
      const dto = plainToInstance(OauthCallbackDto, { code: '  abc ', state: ' xyz ' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.code).toBe('abc');
      expect(dto.state).toBe('xyz');
    });

    it('OauthCallbackDto rejects an empty code', async () => {
      const dto = plainToInstance(OauthCallbackDto, { code: '', state: 'xyz' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'code')).toBe(true);
    });

    it('OauthCallbackDto rejects an oversized state (DoS bound)', async () => {
      const dto = plainToInstance(OauthCallbackDto, {
        code: 'c',
        state: 'x'.repeat(513),
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'state')).toBe(true);
    });

    it('DisconnectProviderParamDto rejects an unknown provider', async () => {
      const dto = plainToInstance(DisconnectProviderParamDto, { provider: 'BOGUS' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints?.isEnum).toBeTruthy();
    });
  });
});
