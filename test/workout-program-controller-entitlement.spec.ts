// test/workout-program-controller-entitlement.spec.ts
//
// R31 Gate 8 — entitlement gating on the MWB-1 WorkoutProgramController.
//
// The new coach-tier WRITE surface (fork / clone / fan-out assign) MUST be
// gated behind a paid plan, parity with the other coach-tier write
// controllers (CoachMediaController, the coach-AI controllers). Before this
// fix the controller carried only JwtAuthGuard + RolesGuard + @Roles, so a
// coach on the FREE tier could fork/clone/assign programs without an active
// paid subscription. The audit (R1) flagged this as a Gate 8 failure.
//
// This spec pins two things so a future refactor cannot silently strip the
// paywall:
//   (1) Contract: SubscriptionGuard is mounted at the class level and the
//       class carries @RequiresTier('pro'). (Static metadata assertions —
//       no app bootstrap, no DB.)
//   (2) Behaviour: driving the real SubscriptionGuard with the controller's
//       actual @RequiresTier metadata, a free-tier coach is denied (403
//       TIER_UPGRADE_REQUIRED) on each of the 3 write routes in enforce
//       mode, while a pro-tier coach with an active subscription is allowed
//       through (the guard does not block downstream logic).
//
// Read endpoints: WorkoutProgramController has no read endpoints (it is a
// write-only surface). Coach plan READS live on WorkoutBuilderController and
// client-facing READS on AssignmentController, both unchanged by this fix.

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { REQUIRES_TIER_KEY } from '../src/billing/requires-tier.decorator';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { WorkoutProgramController } from '../src/workout-builder/workout-builder.controller';

// The 3 coach-tier write handlers on the controller.
const WRITE_HANDLERS = ['fork', 'clone', 'assignProgram'] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function classGuards(ctor: object): unknown[] {
  return (
    (Reflect.getMetadata(GUARDS_METADATA, ctor) as unknown[] | undefined) ??
    (Reflect.getMetadata('__guards__', ctor) as unknown[] | undefined) ??
    []
  );
}

function guardListIncludes(guards: unknown[], guard: { name: string }): boolean {
  return guards.some(
    (g) =>
      g === guard ||
      (typeof g === 'function' && (g as { name?: string }).name === guard.name),
  );
}

function makePrisma(sub: Record<string, unknown> | null) {
  return {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

// A Reflector that reads the controller class's real @RequiresTier metadata
// the same way the guard does at runtime (getAllAndOverride over
// [handler, class]). This exercises the ACTUAL decorator wiring rather than a
// hand-mocked 'pro' value, so the test fails if the @RequiresTier('pro')
// decorator is ever removed from the class.
function realReflector(handlerName: (typeof WRITE_HANDLERS)[number]): Reflector {
  const reflector = new Reflector();
  const proto = WorkoutProgramController.prototype as unknown as Record<
    string,
    unknown
  >;
  const handler = proto[handlerName] as (...args: unknown[]) => unknown;
  // Wrap so callers that pass [getHandler(), getClass()] resolve correctly.
  return {
    getAllAndOverride: (key: string) =>
      reflector.getAllAndOverride(key, [handler, WorkoutProgramController]),
  } as unknown as Reflector;
}

function ctxFor(
  user: Record<string, unknown>,
  handlerName: (typeof WRITE_HANDLERS)[number],
): ExecutionContext {
  const req = { user, method: 'POST', url: `/workout-programs/x/${handlerName}` };
  const proto = WorkoutProgramController.prototype as unknown as Record<
    string,
    unknown
  >;
  const handler = proto[handlerName];
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => WorkoutProgramController,
  } as unknown as ExecutionContext;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WorkoutProgramController — entitlement gating (R31 Gate 8)', () => {
  const ORIGINAL_ENV = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = ORIGINAL_ENV;
  });

  describe('contract: paywall guard + tier are mounted on the class', () => {
    it('mounts SubscriptionGuard at the class level', () => {
      const guards = classGuards(WorkoutProgramController);
      expect(guardListIncludes(guards, SubscriptionGuard)).toBe(true);
    });

    it('keeps the auth + role guards as well (defense in depth)', () => {
      const guards = classGuards(WorkoutProgramController);
      expect(guardListIncludes(guards, JwtAuthGuard)).toBe(true);
      expect(guardListIncludes(guards, RolesGuard)).toBe(true);
    });

    it("carries @RequiresTier('pro') so SubscriptionGuard enforces a paid plan", () => {
      const tier = Reflect.getMetadata(
        REQUIRES_TIER_KEY,
        WorkoutProgramController,
      );
      expect(tier).toBe('pro');
    });
  });

  describe('behaviour: free-tier coach is denied 403 on every write route (enforce)', () => {
    for (const handler of WRITE_HANDLERS) {
      it(`denies a free-tier coach on ${handler}() with TIER_UPGRADE_REQUIRED`, async () => {
        process.env.BILLING_ENFORCEMENT = 'enforce';
        // No CoachSubscription row → guard treats the coach as free tier.
        const guard = new SubscriptionGuard(
          makePrisma(null) as never,
          realReflector(handler),
        );
        let caught: ForbiddenException | undefined;
        try {
          await guard.canActivate(ctxFor({ id: 'coach-1', role: 'coach' }, handler));
        } catch (e) {
          caught = e as ForbiddenException;
        }
        expect(caught).toBeInstanceOf(ForbiddenException);
        const body = caught?.getResponse() as Record<string, unknown>;
        expect(body.code).toBe('TIER_UPGRADE_REQUIRED');
        expect(body.required_tier).toBe('pro');
        expect(body.current_tier).toBe('free');
      });
    }

    it('also denies a coach whose subscription is canceled (inactive plan)', async () => {
      process.env.BILLING_ENFORCEMENT = 'enforce';
      const guard = new SubscriptionGuard(
        makePrisma({
          tier: 'pro',
          status: 'canceled',
          last_payment_failed_at: null,
        }) as never,
        realReflector('clone'),
      );
      let caught: ForbiddenException | undefined;
      try {
        await guard.canActivate(ctxFor({ id: 'coach-1', role: 'coach' }, 'clone'));
      } catch (e) {
        caught = e as ForbiddenException;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      const body = caught?.getResponse() as Record<string, unknown>;
      expect(body.error).toBe('SUBSCRIPTION_INACTIVE');
    });
  });

  describe('behaviour: paid coach + owner are allowed through on every write route', () => {
    for (const handler of WRITE_HANDLERS) {
      it(`allows a pro-tier coach with an active subscription on ${handler}()`, async () => {
        process.env.BILLING_ENFORCEMENT = 'enforce';
        const guard = new SubscriptionGuard(
          makePrisma({
            tier: 'pro',
            status: 'active',
            last_payment_failed_at: null,
          }) as never,
          realReflector(handler),
        );
        await expect(
          guard.canActivate(ctxFor({ id: 'coach-1', role: 'coach' }, handler)),
        ).resolves.toBe(true);
      });

      it(`allows an OWNER on ${handler}() without any subscription lookup`, async () => {
        process.env.BILLING_ENFORCEMENT = 'enforce';
        const prisma = makePrisma(null);
        const guard = new SubscriptionGuard(prisma as never, realReflector(handler));
        await expect(
          guard.canActivate(ctxFor({ id: 'owner-1', role: 'owner' }, handler)),
        ).resolves.toBe(true);
        expect(prisma.coachSubscription.findUnique).not.toHaveBeenCalled();
      });
    }
  });
});
