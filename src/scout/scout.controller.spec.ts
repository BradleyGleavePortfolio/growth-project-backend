import 'reflect-metadata';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ScoutController } from './scout.controller';
import { ScoutService } from './scout.service';
import { ScoutFeatureFlagGuard } from './scout-feature-flag.guard';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';

// @Throttle stores per-bucket metadata under `THROTTLER:LIMIT<name>` /
// `THROTTLER:TTL<name>`; the unnamed `default` bucket uses the `default` suffix
// (same convention as src/feature-flags/__tests__).
const THROTTLE_LIMIT_DEFAULT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_DEFAULT_KEY = 'THROTTLER:TTLdefault';

function makeReq(userId: string): AuthedRequest {
  return { user: { id: userId } as AuthedRequest['user'] };
}

const PROGRESS: ScoutProgressDto = {
  intent_id: 'intent-1',
  progress: [{ entity_type: 'clients', count_committed: 1, total_estimated: 5 }],
};

const COMPLETE: ScoutCompleteDto = {
  intent_id: 'intent-1',
  terminal_status: 'success',
};

describe('ScoutController', () => {
  let recordProgress: jest.Mock;
  let complete: jest.Mock;
  let service: ScoutService;
  let controller: ScoutController;

  beforeEach(() => {
    recordProgress = jest.fn();
    complete = jest.fn().mockResolvedValue({
      acknowledged: true,
      intent_id: 'intent-1',
    });
    service = Object.assign(Object.create(ScoutService.prototype) as ScoutService, {
      recordProgress,
      complete,
    });
    controller = new ScoutController(service);
  });

  describe('POST /api/scout/progress', () => {
    it('delegates the snapshot to the service keyed by the token identity', () => {
      controller.postProgress(makeReq('coach-42'), PROGRESS);
      expect(recordProgress).toHaveBeenCalledWith('coach-42', PROGRESS);
    });

    it('returns nothing (204 has no body)', () => {
      const res = controller.postProgress(makeReq('coach-42'), PROGRESS);
      expect(res).toBeUndefined();
    });

    it('does not read any account field from the body — identity is the token', () => {
      controller.postProgress(makeReq('coach-token'), PROGRESS);
      expect(recordProgress.mock.calls[0][0]).toBe('coach-token');
    });

    it('is registered as a POST on the `progress` sub-path', () => {
      const handler = ScoutController.prototype.postProgress;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('progress');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    });

    it('responds 204 No Content', () => {
      const handler = ScoutController.prototype.postProgress;
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(204);
    });

    it('is gated to coach/owner roles', () => {
      const handler = ScoutController.prototype.postProgress;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    });

    it('carries a per-caller throttle budget', () => {
      const handler = ScoutController.prototype.postProgress;
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, handler)).toBeDefined();
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, handler)).toBeDefined();
    });
  });

  describe('POST /api/scout/ingest/complete', () => {
    it('delegates to the service keyed by the token identity', async () => {
      await controller.postComplete(makeReq('coach-42'), COMPLETE);
      expect(complete).toHaveBeenCalledWith('coach-42', COMPLETE);
    });

    it('returns the service acknowledgement verbatim', async () => {
      const res = await controller.postComplete(makeReq('coach-42'), COMPLETE);
      expect(res).toEqual({ acknowledged: true, intent_id: 'intent-1' });
    });

    it('is registered as a POST on the `ingest/complete` sub-path', () => {
      const handler = ScoutController.prototype.postComplete;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('ingest/complete');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    });

    it('responds 200 OK', () => {
      const handler = ScoutController.prototype.postComplete;
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    });

    it('is gated to coach/owner roles', () => {
      const handler = ScoutController.prototype.postComplete;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['coach', 'owner']);
    });

    it('carries a stricter per-caller throttle budget than progress', () => {
      const complete = ScoutController.prototype.postComplete;
      const progress = ScoutController.prototype.postProgress;
      const completeLimit = Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, complete);
      const progressLimit = Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, progress);
      expect(completeLimit).toBeDefined();
      expect(progressLimit).toBeDefined();
    });
  });

  describe('feature gate', () => {
    it('mounts the ScoutFeatureFlagGuard at the controller level', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, ScoutController) ?? [];
      expect(guards).toContain(ScoutFeatureFlagGuard);
    });

    it('is mounted under the scout base path (global `api` prefix is applied by main.ts)', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ScoutController)).toBe('scout');
    });
  });
});
