// test/workout-program-controller-entitlement.spec.ts
//
// Owner TM-P1 (2026-10-12): "There should be zero locks - there is no free
// or paid plan". The MWB-1 WorkoutProgramController write surface (fork /
// clone / fan-out assign) has no coach plan gate:
//   (1) Contract: no SubscriptionGuard and no @RequiresTier on the class.
//   (2) Behaviour: the guard driven with the controller's real metadata
//       still lets a coach and an owner through.
//
// Read endpoints: WorkoutProgramController has no read endpoints (it is a
// write-only surface). Coach plan READS live on WorkoutBuilderController and
// client-facing READS on AssignmentController, both unchanged by this fix.

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
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
// [handler, class]), so the test fails if a tier is ever put back.
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

describe('WorkoutProgramController — no coach plan gate (TM-P1)', () => {
  const ORIGINAL_ENV = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = ORIGINAL_ENV;
  });

  describe('contract: no plan guard or tier on the class', () => {
    it('does not mount SubscriptionGuard', () => {
      const guards = classGuards(WorkoutProgramController);
      expect(guardListIncludes(guards, SubscriptionGuard)).toBe(false);
    });

    it('keeps the auth + role guards as well (defense in depth)', () => {
      const guards = classGuards(WorkoutProgramController);
      expect(guardListIncludes(guards, JwtAuthGuard)).toBe(true);
      expect(guardListIncludes(guards, RolesGuard)).toBe(true);
    });

    it('carries no @RequiresTier', () => {
      const tier = Reflect.getMetadata(
        REQUIRES_TIER_KEY,
        WorkoutProgramController,
      );
      expect(tier).toBeUndefined();
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
