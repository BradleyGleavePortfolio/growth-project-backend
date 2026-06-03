import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PreferencesController } from '../../src/wearables/preferences/preferences.controller';
import type { PreferencesService } from '../../src/wearables/preferences/preferences.service';
import type { WearableInsightsService } from '../../src/wearables/insights/wearable-insights.service';
import type { AuthedRequest } from '../../src/auth/auth-request';

// PR-HK-3a / HK-6b preferences controller contract: route/guard/throttle
// wiring, body + path + query validation (400 WEARABLE_PREFERENCE_PAYLOAD_
// INVALID), the default self-write path (no IDOR, #5), and the HK-6b
// coach-on-behalf-of authorization matrix (student-self, student-cross 403,
// coach-assigned 200, coach-unassigned 403, owner bypass) keyed off the
// reused WearableInsightsService.assertCoachOwnsClient.

const USER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const COACH = '33333333-3333-3333-3333-333333333333';
const OWNER = '44444444-4444-4444-4444-444444444444';

type Role = 'student' | 'coach' | 'owner';

function reqFor(id: string, role: Role = 'student'): AuthedRequest {
  const partial: Pick<AuthedRequest, 'user'> = {
    user: { id, role } as AuthedRequest['user'],
  };
  return partial as AuthedRequest;
}

type SvcDouble = jest.Mocked<Pick<PreferencesService, 'upsert' | 'remove'>>;
type InsightsDouble = jest.Mocked<
  Pick<WearableInsightsService, 'assertCoachOwnsClient'>
>;

function makeSvc(): SvcDouble {
  const double: SvcDouble = {
    upsert: jest.fn().mockResolvedValue({
      metric: WearableMetricType.STEPS,
      preferred_provider: WearableProvider.OURA,
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  return double;
}

function makeInsights(): InsightsDouble {
  const double: InsightsDouble = {
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
  };
  return double;
}

function makeController(
  svc: SvcDouble,
  insights: InsightsDouble,
): PreferencesController {
  const svcWide = svc as Pick<
    PreferencesService,
    'upsert' | 'remove'
  > as PreferencesService;
  const insightsWide = insights as Pick<
    WearableInsightsService,
    'assertCoachOwnsClient'
  > as WearableInsightsService;
  return new PreferencesController(svcWide, insightsWide);
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

  // ── upsert: self-write path ──────────────────────────────────────────
  describe('upsert — self write', () => {
    it('student, no target_user_id: writes own row (effective === caller)', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      const out = await ctrl.upsert(reqFor(USER, 'student'), {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
      });
      expect(svc.upsert).toHaveBeenCalledWith(USER, USER, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
      });
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
      expect(out.preferred_provider).toBe(WearableProvider.OURA);
    });

    it('student, target_user_id === self: canonicalised to own row, no auth check', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.upsert(reqFor(USER, 'student'), {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
        target_user_id: USER,
      });
      expect(svc.upsert).toHaveBeenCalledWith(USER, USER, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
        target_user_id: USER,
      });
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
    });
  });

  // ── upsert: coach-on-behalf-of authorization matrix ──────────────────
  describe('upsert — coach-on-behalf-of authorization', () => {
    it('student, foreign target_user_id: 403 CROSS_USER_FORBIDDEN, service not called', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      try {
        await ctrl.upsert(reqFor(USER, 'student'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: WearableProvider.OURA,
          target_user_id: CLIENT,
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const resp = (err as ForbiddenException).getResponse() as {
          error: string;
          target_user_id: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN');
        expect(resp.target_user_id).toBe(CLIENT);
      }
      expect(svc.upsert).not.toHaveBeenCalled();
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
    });

    it('coach, assigned client: 200, writes target row, audited by caller', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.upsert(reqFor(COACH, 'coach'), {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.WHOOP,
        target_user_id: CLIENT,
      });
      expect(insights.assertCoachOwnsClient).toHaveBeenCalledWith(
        COACH,
        CLIENT,
        'coach',
      );
      expect(svc.upsert).toHaveBeenCalledWith(CLIENT, COACH, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.WHOOP,
        target_user_id: CLIENT,
      });
    });

    it('coach, UNassigned client: 403 from assertCoachOwnsClient, service not called', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      insights.assertCoachOwnsClient.mockRejectedValueOnce(
        new ForbiddenException('Client is not assigned to this coach'),
      );
      const ctrl = makeController(svc, insights);
      try {
        await ctrl.upsert(reqFor(COACH, 'coach'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: WearableProvider.WHOOP,
          target_user_id: CLIENT,
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const resp = (err as ForbiddenException).getResponse() as {
          error: string;
          target_user_id: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN');
        expect(resp.target_user_id).toBe(CLIENT);
      }
      expect(svc.upsert).not.toHaveBeenCalled();
    });

    it('owner, any target_user_id: 200 (platform-admin bypass)', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.upsert(reqFor(OWNER, 'owner'), {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
        target_user_id: CLIENT,
      });
      // assertCoachOwnsClient is invoked but short-circuits for owners.
      expect(insights.assertCoachOwnsClient).toHaveBeenCalledWith(
        OWNER,
        CLIENT,
        'owner',
      );
      expect(svc.upsert).toHaveBeenCalledWith(CLIENT, OWNER, {
        metric: WearableMetricType.STEPS,
        preferred_provider: WearableProvider.OURA,
        target_user_id: CLIENT,
      });
    });

    it('403 body never includes the caller id (#12 PII)', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      try {
        await ctrl.upsert(reqFor(USER, 'student'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: WearableProvider.OURA,
          target_user_id: CLIENT,
        });
        throw new Error('should have thrown');
      } catch (err) {
        const resp = (err as ForbiddenException).getResponse() as Record<
          string,
          unknown
        >;
        expect(JSON.stringify(resp)).not.toContain(USER);
      }
    });
  });

  // ── upsert: DTO validation ───────────────────────────────────────────
  describe('upsert — DTO validation', () => {
    it('rejects an unknown body key (strict) with the locked code', async () => {
      const svc = makeSvc();
      const ctrl = makeController(svc, makeInsights());
      try {
        await ctrl.upsert(reqFor(USER, 'student'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: WearableProvider.OURA,
          evil: true,
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const resp = (err as BadRequestException).getResponse() as {
          error: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_PAYLOAD_INVALID');
      }
      expect(svc.upsert).not.toHaveBeenCalled();
    });

    it('rejects an invalid provider with the locked error code', async () => {
      const svc = makeSvc();
      const ctrl = makeController(svc, makeInsights());
      try {
        await ctrl.upsert(reqFor(USER, 'student'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: 'NINTENDO',
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const resp = (err as BadRequestException).getResponse() as {
          error: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_PAYLOAD_INVALID');
      }
    });

    it('rejects a malformed target_user_id (not a UUID) with the locked code', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      try {
        await ctrl.upsert(reqFor(COACH, 'coach'), {
          metric: WearableMetricType.STEPS,
          preferred_provider: WearableProvider.OURA,
          target_user_id: 'not-a-uuid',
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const resp = (err as BadRequestException).getResponse() as {
          error: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_PAYLOAD_INVALID');
      }
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
      expect(svc.upsert).not.toHaveBeenCalled();
    });
  });

  // ── remove: parallel matrix via the ?target_user_id query param ──────
  describe('remove — self delete', () => {
    it('student, no query: deletes own row, no auth check', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.remove(
        reqFor(USER, 'student'),
        { metric: WearableMetricType.STEPS },
        {},
      );
      expect(svc.remove).toHaveBeenCalledWith(
        USER,
        USER,
        WearableMetricType.STEPS,
      );
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
    });

    it('rejects a garbage :metric segment with the locked code', async () => {
      const svc = makeSvc();
      const ctrl = makeController(svc, makeInsights());
      await expect(
        ctrl.remove(
          reqFor(USER, 'student'),
          { metric: 'garbage' },
          {},
        ),
      ).rejects.toThrow(BadRequestException);
      expect(svc.remove).not.toHaveBeenCalled();
    });
  });

  describe('remove — coach-on-behalf-of authorization', () => {
    it('student, foreign target_user_id query: 403, service not called', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      try {
        await ctrl.remove(
          reqFor(USER, 'student'),
          { metric: WearableMetricType.STEPS },
          { target_user_id: CLIENT },
        );
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const resp = (err as ForbiddenException).getResponse() as {
          error: string;
        };
        expect(resp.error).toBe('WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN');
      }
      expect(svc.remove).not.toHaveBeenCalled();
    });

    it('coach, assigned client query: 204, deletes target row, audited by caller', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.remove(
        reqFor(COACH, 'coach'),
        { metric: WearableMetricType.STEPS },
        { target_user_id: CLIENT },
      );
      expect(insights.assertCoachOwnsClient).toHaveBeenCalledWith(
        COACH,
        CLIENT,
        'coach',
      );
      expect(svc.remove).toHaveBeenCalledWith(
        CLIENT,
        COACH,
        WearableMetricType.STEPS,
      );
    });

    it('coach, UNassigned client query: 403, service not called', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      insights.assertCoachOwnsClient.mockRejectedValueOnce(
        new ForbiddenException('Client is not assigned to this coach'),
      );
      const ctrl = makeController(svc, insights);
      await expect(
        ctrl.remove(
          reqFor(COACH, 'coach'),
          { metric: WearableMetricType.STEPS },
          { target_user_id: CLIENT },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.remove).not.toHaveBeenCalled();
    });

    it('owner, any target_user_id query: 204 (bypass)', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await ctrl.remove(
        reqFor(OWNER, 'owner'),
        { metric: WearableMetricType.STEPS },
        { target_user_id: CLIENT },
      );
      expect(svc.remove).toHaveBeenCalledWith(
        CLIENT,
        OWNER,
        WearableMetricType.STEPS,
      );
    });

    it('rejects a malformed target_user_id query value with the locked code', async () => {
      const svc = makeSvc();
      const insights = makeInsights();
      const ctrl = makeController(svc, insights);
      await expect(
        ctrl.remove(
          reqFor(COACH, 'coach'),
          { metric: WearableMetricType.STEPS },
          { target_user_id: 'not-a-uuid' },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(insights.assertCoachOwnsClient).not.toHaveBeenCalled();
      expect(svc.remove).not.toHaveBeenCalled();
    });
  });
});
