import 'reflect-metadata';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { ROLES_KEY } from '../../../src/common/decorators/roles.decorator';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import type { ScoutRunStartDto } from '../../../src/scout/lifecycle/lifecycle.dto';
import { ScoutRunController } from '../../../src/scout/lifecycle/run.controller';

// S7-L2 — the two lifecycle routes delegate by TOKEN identity and carry the same
// role / throttle / status metadata posture as ScoutController (same key
// convention as src/scout/scout.controller.spec.ts).
const THROTTLE_LIMIT_DEFAULT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_DEFAULT_KEY = 'THROTTLER:TTLdefault';

const INTENT = '3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

function makeReq(userId: string): AuthedRequest {
  return { user: { id: userId } as AuthedRequest['user'] };
}

describe('ScoutRunController', () => {
  let start: jest.Mock;
  let cancel: jest.Mock;
  let controller: ScoutRunController;

  beforeEach(() => {
    start = jest.fn().mockResolvedValue({
      intent_id: INTENT,
      mode: 'server',
      phase: 'discovering',
      execution_epoch: 1,
      accepted_start_at: '2026-09-24T10:00:00.000Z',
      deadline_at: '2026-09-24T10:05:00.000Z',
    });
    cancel = jest
      .fn()
      .mockResolvedValue({ intent_id: INTENT, status: 'cancelled', execution_epoch: 2 });
    const lifecycle = Object.assign(
      Object.create(ScoutLifecycleService.prototype) as ScoutLifecycleService,
      { start, cancel },
    );
    controller = new ScoutRunController(lifecycle);
  });

  describe('POST /api/scout/runs/start', () => {
    it('delegates (coach from the token, intent from the body) and returns the service body', async () => {
      const res = await controller.postStart(makeReq('coach-42'), { import_intent_id: INTENT });
      expect(start).toHaveBeenCalledWith('coach-42', INTENT);
      expect(res).toMatchObject({ intent_id: INTENT, mode: 'server', phase: 'discovering' });
    });

    it('never reads an account field from the body — identity is the token', async () => {
      // Over-posted body: a structural superset of the DTO (no cast needed).
      const overPosted: ScoutRunStartDto & { coach_id: string } = {
        import_intent_id: INTENT,
        coach_id: 'attacker',
      };
      await controller.postStart(makeReq('coach-token'), overPosted);
      expect(start.mock.calls[0][0]).toBe('coach-token');
    });

    it('is a POST on `runs/start`, 200, coach|owner, 30/min', () => {
      const handler = ScoutRunController.prototype.postStart;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runs/start');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, handler)).toBe(30);
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, handler)).toBe(60_000);
    });
  });

  describe('POST /api/scout/runs/cancel', () => {
    it('delegates by token identity and returns the cancel body', async () => {
      const res = await controller.postCancel(makeReq('coach-42'), { intent_id: INTENT });
      expect(cancel).toHaveBeenCalledWith('coach-42', INTENT);
      expect(res).toEqual({ intent_id: INTENT, status: 'cancelled', execution_epoch: 2 });
    });

    it('is a POST on `runs/cancel`, 200, coach|owner, 30/min', () => {
      const handler = ScoutRunController.prototype.postCancel;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runs/cancel');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, handler)).toBe(30);
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, handler)).toBe(60_000);
    });
  });

  it('mounts under the same `scout` controller prefix (dark with FEATURE_SCOUT_INGEST)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ScoutRunController)).toBe('scout');
  });
});
