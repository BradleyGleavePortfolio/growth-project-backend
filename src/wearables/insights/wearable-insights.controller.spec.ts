import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WearableMetricBucket } from '@prisma/client';
import { WearableInsightsController } from './wearable-insights.controller';
import type { WearableInsightsService } from './wearable-insights.service';
import type { AuthedRequest } from '../../auth/auth-request';
import {
  CoachInsight,
  ClientInsight,
  emptyInsight,
  isEmptyInsight,
} from './insight-output.schema';

// PR-HK-4 controller contract tests: route registration, guard wiring,
// query validation, coach-owns-client authorization, and the dual-role
// schema isolation (coach handler returns coach schema; client handler
// returns client schema and never coach-only fields).

const COACH = 'coach-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

function coachInsight(): CoachInsight {
  return {
    observation: 'obs',
    hypothesis: 'hyp',
    suggested_action: 'act',
    suggested_message_draft: 'draft',
    confidence_level: 'fairly_sure',
    source_metrics: ['HRV_MS'],
  };
}

function clientInsight(): ClientInsight {
  return {
    observation: 'obs',
    norm_comparison: 'norm',
    intervention: 'do this',
    optional_cta: null,
    confidence_level: 'i_think',
    source_metrics: ['SLEEP_TOTAL_MIN'],
  };
}

function makeSvc(): jest.Mocked<Pick<WearableInsightsService, 'assertCoachOwnsClient' | 'generateForCoach' | 'generateForClient'>> {
  return {
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
    generateForCoach: jest.fn().mockResolvedValue(coachInsight()),
    generateForClient: jest.fn().mockResolvedValue(clientInsight()),
  } as never;
}

function reqFor(role: string, id: string): AuthedRequest {
  return { user: { id, role } as never };
}

describe('WearableInsightsController', () => {
  describe('route registration', () => {
    it('mounts the controller at v1/wearables/insights', () => {
      const base = Reflect.getMetadata(PATH_METADATA, WearableInsightsController);
      expect(base).toBe('v1/wearables/insights');
    });

    it('registers GET coach and GET client routes', () => {
      const coachPath = Reflect.getMetadata(
        PATH_METADATA,
        WearableInsightsController.prototype.getCoachInsight,
      );
      const clientPath = Reflect.getMetadata(
        PATH_METADATA,
        WearableInsightsController.prototype.getClientInsight,
      );
      expect(coachPath).toBe('coach');
      expect(clientPath).toBe('client');
      // Both are GET (RequestMethod.GET === 0).
      expect(
        Reflect.getMetadata(METHOD_METADATA, WearableInsightsController.prototype.getCoachInsight),
      ).toBe(0);
      expect(
        Reflect.getMetadata(METHOD_METADATA, WearableInsightsController.prototype.getClientInsight),
      ).toBe(0);
    });

    it('applies guards: coach handler has guards metadata, both have throttle', () => {
      const coachGuards = Reflect.getMetadata(
        '__guards__',
        WearableInsightsController.prototype.getCoachInsight,
      );
      const clientGuards = Reflect.getMetadata(
        '__guards__',
        WearableInsightsController.prototype.getClientInsight,
      );
      expect(Array.isArray(coachGuards)).toBe(true);
      // Coach endpoint stacks JwtAuthGuard + CoachGuard (2 guards).
      expect(coachGuards.length).toBe(2);
      // Client endpoint stacks JwtAuthGuard (1 guard).
      expect(Array.isArray(clientGuards)).toBe(true);
      expect(clientGuards.length).toBe(1);
    });

    it('declares coach/owner roles on the coach handler', () => {
      const roles = Reflect.getMetadata(
        'roles',
        WearableInsightsController.prototype.getCoachInsight,
      );
      expect(roles).toEqual(['coach', 'owner']);
    });
  });

  describe('getCoachInsight', () => {
    it('validates query, checks ownership, returns coach schema', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      const out = await ctrl.getCoachInsight(reqFor('coach', COACH), {
        clientId: CLIENT,
        bucket: WearableMetricBucket.SLEEP_RECOVERY,
      });
      expect(svc.assertCoachOwnsClient).toHaveBeenCalledWith(COACH, CLIENT, 'coach');
      expect(svc.generateForCoach).toHaveBeenCalledWith(
        COACH,
        CLIENT,
        WearableMetricBucket.SLEEP_RECOVERY,
      );
      // Coach schema fields present (full-insight branch of the union).
      expect(isEmptyInsight(out)).toBe(false);
      expect((out as CoachInsight).hypothesis).toBe('hyp');
      expect((out as CoachInsight).suggested_message_draft).toBe('draft');
    });

    it('rejects an invalid clientId with 400', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      await expect(
        ctrl.getCoachInsight(reqFor('coach', COACH), {
          clientId: 'not-a-uuid',
          bucket: WearableMetricBucket.SLEEP_RECOVERY,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(svc.generateForCoach).not.toHaveBeenCalled();
    });

    it('rejects an invalid bucket with 400', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      await expect(
        ctrl.getCoachInsight(reqFor('coach', COACH), {
          clientId: CLIENT,
          bucket: 'NONSENSE',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getClientInsight', () => {
    it('validates query and returns client schema for the authed user', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      const out = await ctrl.getClientInsight(reqFor('student', CLIENT), {
        bucket: WearableMetricBucket.HEALTH_FITNESS,
      });
      expect(svc.generateForClient).toHaveBeenCalledWith(
        CLIENT,
        WearableMetricBucket.HEALTH_FITNESS,
      );
      // Client schema — coach-only fields absent.
      expect(isEmptyInsight(out)).toBe(false);
      expect((out as ClientInsight).norm_comparison).toBe('norm');
      expect((out as unknown as Record<string, unknown>).hypothesis).toBeUndefined();
      expect(
        (out as unknown as Record<string, unknown>).suggested_message_draft,
      ).toBeUndefined();
    });

    it('returns the strict empty state when the service degrades', async () => {
      const svc = makeSvc();
      svc.generateForClient.mockResolvedValue(emptyInsight() as never);
      const ctrl = new WearableInsightsController(svc as never);
      const out = await ctrl.getClientInsight(reqFor('student', CLIENT), {
        bucket: WearableMetricBucket.HEALTH_FITNESS,
      });
      // The controller .parse() must accept the empty branch of the union
      // and pass it through unchanged.
      expect(isEmptyInsight(out)).toBe(true);
      expect((out as Record<string, unknown>).is_empty).toBe(true);
      expect((out as Record<string, unknown>).source_metrics).toEqual([]);
    });

    it('rejects a missing bucket with 400', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      await expect(
        ctrl.getClientInsight(reqFor('student', CLIENT), {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never calls the coach generator from the client endpoint', async () => {
      const svc = makeSvc();
      const ctrl = new WearableInsightsController(svc as never);
      await ctrl.getClientInsight(reqFor('student', CLIENT), {
        bucket: WearableMetricBucket.HEALTH_FITNESS,
      });
      expect(svc.generateForCoach).not.toHaveBeenCalled();
      expect(svc.assertCoachOwnsClient).not.toHaveBeenCalled();
    });
  });
});
