import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { WearableMetricBucket } from '@prisma/client';
import { WearableInsightsController } from './wearable-insights.controller';
import {
  CoachInsight,
  ClientInsight,
  emptyInsight,
  isEmptyInsight,
} from './insight-output.schema';
import {
  makeServiceDouble,
  makeApprovalDeps,
  makeController,
  makeAuthedRequest,
  type WearableInsightsServiceDouble,
  type ApprovalDeps,
} from './wearable-insights.controller.test-helpers';

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

// HK-6a R2 (P1-1): typed test doubles and a centralised controller factory
// live in `wearable-insights.controller.test-helpers.ts`. The previous
// type-laundering casts are gone; the suite now constructs the controller and
// its dependencies through named, narrowly-typed builders.
const DRAFT_ID = '99999999-9999-9999-9999-999999999999';

// Local convenience wrappers binding the shared builders to this suite's
// fixtures so each test reads the same as before.
function makeSvc(): WearableInsightsServiceDouble {
  return makeServiceDouble({
    coachInsight: coachInsight(),
    clientInsight: clientInsight(),
  });
}

function reqFor(role: string, id: string) {
  return makeAuthedRequest(role, id);
}

function approvalDeps(decideResult: Record<string, unknown>): ApprovalDeps {
  return makeApprovalDeps(DRAFT_ID, decideResult);
}

function ctrlWithApprovals(
  svc: WearableInsightsServiceDouble,
  deps: ApprovalDeps,
): WearableInsightsController {
  return makeController({ svc, approvals: deps.approvals, prisma: deps.prisma });
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
      const ctrl = makeController({ svc });
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
      const ctrl = makeController({ svc });
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
      const ctrl = makeController({ svc });
      await expect(
        ctrl.getCoachInsight(reqFor('coach', COACH), {
          clientId: CLIENT,
          bucket: 'NONSENSE',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('route registration — approve', () => {
    it('registers POST approve (RequestMethod.POST === 1)', () => {
      const approvePath = Reflect.getMetadata(
        PATH_METADATA,
        WearableInsightsController.prototype.approveInsight,
      );
      expect(approvePath).toBe('approve');
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          WearableInsightsController.prototype.approveInsight,
        ),
      ).toBe(1);
    });

    it('stacks JwtAuthGuard + CoachGuard and declares coach/owner roles', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        WearableInsightsController.prototype.approveInsight,
      );
      expect(Array.isArray(guards)).toBe(true);
      expect(guards.length).toBe(2);
      const roles = Reflect.getMetadata(
        'roles',
        WearableInsightsController.prototype.approveInsight,
      );
      expect(roles).toEqual(['coach', 'owner']);
    });

    it('carries the throttle metadata on the approve handler', () => {
      // The COACH_AI_GENERATION throttle decorator writes named-throttler
      // metadata; we assert it exists rather than re-testing the limiter.
      const keys = Reflect.getMetadataKeys(
        WearableInsightsController.prototype.approveInsight,
      );
      // @nestjs/throttler writes keys prefixed with `THROTTLER:` (e.g.
      // `THROTTLER:LIMITcoach-ai-generation`).
      const hasThrottle = keys.some(
        (k) => typeof k === 'string' && k.startsWith('THROTTLER:'),
      );
      expect(hasThrottle).toBe(true);
    });
  });

  describe('approveInsight', () => {
    const MATERIALISED = '2026-01-01T00:00:00.000Z';

    function approveBody(action: 'approve' | 'edit' | 'reject', body: string) {
      return {
        client_id: CLIENT,
        bucket: WearableMetricBucket.SLEEP_RECOVERY,
        draft_body: body,
        action,
      };
    }

    it('approve → creates draft, decides approved, returns ok shape', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({
        materialised_at: new Date(MATERIALISED),
        decided_at: new Date(MATERIALISED),
      });
      const ctrl = ctrlWithApprovals(svc, deps);
      const out = await ctrl.approveInsight(
        reqFor('coach', COACH),
        approveBody('approve', 'Great recovery week — protect that sleep.'),
      );

      expect(svc.assertCoachOwnsClient).toHaveBeenCalledWith(
        COACH,
        CLIENT,
        'coach',
      );
      // Draft created with the coach as tenant and a null requester (so the
      // self-approval guard in decide() stays inert).
      const createArg = deps.create.mock.calls[0][0];
      expect(createArg.data.tenant_coach_id).toBe(COACH);
      expect(createArg.data.requester_id).toBeNull();
      expect(createArg.data.payload.body).toBe(
        'Great recovery week — protect that sleep.',
      );
      // Decided as approved, no edit note.
      expect(deps.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          draftId: DRAFT_ID,
          decision: 'approved',
          decider: { id: COACH, role: 'coach' },
          note: undefined,
        }),
      );
      expect(out).toEqual({
        status: 'ok',
        draft_id: DRAFT_ID,
        materialised_at: MATERIALISED,
      });
    });

    it('edit → persists the edited body and records the edit note', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({
        materialised_at: new Date(MATERIALISED),
      });
      const ctrl = ctrlWithApprovals(svc, deps);
      const edited = 'Edited: keep the wind-down routine going.';
      const out = await ctrl.approveInsight(
        reqFor('coach', COACH),
        approveBody('edit', edited),
      );

      const createArg = deps.create.mock.calls[0][0];
      // The persisted body is the EDITED text, not a stored original.
      expect(createArg.data.payload.body).toBe(edited);
      expect(deps.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'approved',
          note: 'Coach edited body before approve',
        }),
      );
      expect(out.status).toBe('ok');
    });

    it('reject → decides rejected, no materialiser dispatch, null materialised_at', async () => {
      const svc = makeSvc();
      // P1-3: a rejected draft has no materialised_at, so the wire field is
      // null (nothing was materialised). decided_at is present on the row but
      // is deliberately NOT used as a materialisation timestamp fallback.
      const deps = approvalDeps({
        materialised_at: null,
        decided_at: new Date(MATERIALISED),
      });
      const ctrl = ctrlWithApprovals(svc, deps);
      const out = await ctrl.approveInsight(
        reqFor('coach', COACH),
        approveBody('reject', 'Not relevant this week.'),
      );

      expect(deps.decide).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'rejected' }),
      );
      expect(out).toEqual({
        status: 'ok',
        draft_id: DRAFT_ID,
        materialised_at: null,
      });
    });

    it('rejects a malformed body (missing bucket) with 400 before any write', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({});
      const ctrl = ctrlWithApprovals(svc, deps);
      await expect(
        ctrl.approveInsight(reqFor('coach', COACH), {
          client_id: CLIENT,
          draft_body: 'hello',
          action: 'approve',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.decide).not.toHaveBeenCalled();
    });

    it('propagates the ownership failure and never creates a draft', async () => {
      const svc = makeSvc();
      svc.assertCoachOwnsClient.mockRejectedValue(
        new BadRequestException('not your client'),
      );
      const deps = approvalDeps({});
      const ctrl = ctrlWithApprovals(svc, deps);
      await expect(
        ctrl.approveInsight(
          reqFor('coach', COACH),
          approveBody('approve', 'hello'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.decide).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only draft_body with 400', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({});
      const ctrl = ctrlWithApprovals(svc, deps);
      await expect(
        ctrl.approveInsight(reqFor('coach', COACH), approveBody('approve', '   ')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.create).not.toHaveBeenCalled();
    });

    it('rejects a draft_body longer than 1000 chars with 400', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({});
      const ctrl = ctrlWithApprovals(svc, deps);
      await expect(
        ctrl.approveInsight(
          reqFor('coach', COACH),
          approveBody('approve', 'x'.repeat(1001)),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown body key (strict schema) with 400', async () => {
      const svc = makeSvc();
      const deps = approvalDeps({});
      const ctrl = ctrlWithApprovals(svc, deps);
      await expect(
        ctrl.approveInsight(reqFor('coach', COACH), {
          ...approveBody('approve', 'hello'),
          smuggled: 'nope',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(deps.create).not.toHaveBeenCalled();
    });
  });

  describe('getClientInsight', () => {
    it('validates query and returns client schema for the authed user', async () => {
      const svc = makeSvc();
      const ctrl = makeController({ svc });
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
      svc.generateForClient.mockResolvedValue(emptyInsight());
      const ctrl = makeController({ svc });
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
      const ctrl = makeController({ svc });
      await expect(
        ctrl.getClientInsight(reqFor('student', CLIENT), {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never calls the coach generator from the client endpoint', async () => {
      const svc = makeSvc();
      const ctrl = makeController({ svc });
      await ctrl.getClientInsight(reqFor('student', CLIENT), {
        bucket: WearableMetricBucket.HEALTH_FITNESS,
      });
      expect(svc.generateForCoach).not.toHaveBeenCalled();
      expect(svc.assertCoachOwnsClient).not.toHaveBeenCalled();
    });
  });
});
