import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PreferencesController } from '../../src/wearables/preferences/preferences.controller';
import type { PreferencesService } from '../../src/wearables/preferences/preferences.service';
import type { AuthedRequest } from '../../src/auth/auth-request';

// PR-HK-3a preferences controller contract: route/guard/throttle wiring,
// body + path validation (400 WEARABLE_PREFERENCE_PAYLOAD_INVALID), and that
// the subject is ALWAYS req.user.id (no IDOR surface, #5).

const USER = '11111111-1111-1111-1111-111111111111';

function reqFor(id: string): AuthedRequest {
  return { user: { id, role: 'student' } as never };
}

function makeSvc(): jest.Mocked<Pick<PreferencesService, 'upsert' | 'remove'>> {
  return {
    upsert: jest.fn().mockResolvedValue({
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as never;
}

describe('PreferencesController', () => {
  it('mounts at v1/wearables/preferences', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PreferencesController)).toBe(
      'v1/wearables/preferences',
    );
  });

  it('POST is a POST and DELETE is a DELETE :metric', () => {
    expect(
      Reflect.getMetadata(METHOD_METADATA, PreferencesController.prototype.upsert),
    ).toBe(1); // POST
    expect(
      Reflect.getMetadata(METHOD_METADATA, PreferencesController.prototype.remove),
    ).toBe(3); // DELETE
    expect(
      Reflect.getMetadata(PATH_METADATA, PreferencesController.prototype.remove),
    ).toBe(':metric');
  });

  it('guards both handlers with JwtAuthGuard only', () => {
    const upsertGuards = Reflect.getMetadata(
      '__guards__',
      PreferencesController.prototype.upsert,
    );
    const removeGuards = Reflect.getMetadata(
      '__guards__',
      PreferencesController.prototype.remove,
    );
    expect(upsertGuards.length).toBe(1);
    expect(removeGuards.length).toBe(1);
  });

  it('upsert: validates body, delegates with the authed user id', async () => {
    const svc = makeSvc();
    const ctrl = new PreferencesController(svc as never);
    const out = await ctrl.upsert(reqFor(USER), {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    expect(svc.upsert).toHaveBeenCalledWith(USER, {
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
    });
    expect(out.preferred_provider).toBe(WearableProvider.OURA);
  });

  it('upsert: rejects an unknown body key (strict)', async () => {
    const svc = makeSvc();
    const ctrl = new PreferencesController(svc as never);
    await expect(
      ctrl.upsert(reqFor(USER), {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
        evil: true,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(svc.upsert).not.toHaveBeenCalled();
  });

  it('upsert: rejects an invalid provider with the locked error code', async () => {
    const svc = makeSvc();
    const ctrl = new PreferencesController(svc as never);
    try {
      await ctrl.upsert(reqFor(USER), {
        metric: WearableMetricType.STEPS,
        preferred_provider: 'NINTENDO',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const resp = (err as BadRequestException).getResponse() as { error: string };
      expect(resp.error).toBe('WEARABLE_PREFERENCE_PAYLOAD_INVALID');
    }
  });

  it('remove: validates the :metric param and delegates', async () => {
    const svc = makeSvc();
    const ctrl = new PreferencesController(svc as never);
    await ctrl.remove(reqFor(USER), { metric: WearableMetricType.STEPS });
    expect(svc.remove).toHaveBeenCalledWith(USER, WearableMetricType.STEPS);
  });

  it('remove: rejects a garbage :metric segment', async () => {
    const svc = makeSvc();
    const ctrl = new PreferencesController(svc as never);
    await expect(
      ctrl.remove(reqFor(USER), { metric: 'garbage' }),
    ).rejects.toThrow(BadRequestException);
    expect(svc.remove).not.toHaveBeenCalled();
  });
});
