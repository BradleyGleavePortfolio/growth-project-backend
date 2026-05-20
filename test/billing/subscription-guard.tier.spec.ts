/**
 * test/billing/subscription-guard.tier.spec.ts
 *
 * Tier-specific behaviour of SubscriptionGuard (spec §10).
 * 10 required cases from spec §10.
 *
 * Setup:
 *   - Prisma is mocked via jest.fn() on coachSubscription.findUnique.
 *   - Reflector is mocked via jest.fn() on getAllAndOverride to control
 *     the @RequiresTier metadata seen by the guard.
 *   - BILLING_ENFORCEMENT is set/unset per test via process.env.
 *   - ExecutionContext mock includes getHandler + getClass so
 *     Reflector.getAllAndOverride resolves correctly.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionGuard } from '../../src/billing/subscription.guard';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePrisma(sub: Record<string, unknown> | null) {
  return {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

/** Reflector that returns `undefined` → guard treats endpoint as 'free'. */
function freeReflector(): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as any;
}

/** Reflector that returns `'pro'` → guard treats endpoint as Pro-locked. */
function proReflector(): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue('pro') } as any;
}

/** Reflector that returns `'enterprise'` → guard treats endpoint as enterprise-locked. */
function enterpriseReflector(): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue('enterprise') } as any;
}

function ctxFor(
  user: Record<string, unknown>,
): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SubscriptionGuard — tier logic (spec §10)', () => {
  const ORIGINAL_ENV = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = ORIGINAL_ENV;
  });

  // Case 1: free coach + free endpoint → allow (no sub row needed)
  it('free coach + free endpoint → allow (no sub row needed)', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const guard = new SubscriptionGuard(makePrisma(null) as any, freeReflector());
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  // Case 2: free coach + @RequiresTier('pro'), BILLING_ENFORCEMENT=enforce
  //         → 403 TIER_UPGRADE_REQUIRED, current_tier='free'
  it('free coach + @RequiresTier("pro") endpoint, enforce → 403 TIER_UPGRADE_REQUIRED current_tier="free"', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    // No sub row → treated as free tier
    const guard = new SubscriptionGuard(makePrisma(null) as any, proReflector());
    let caught: ForbiddenException | undefined;
    try {
      await guard.canActivate(ctxFor({ id: 'c', role: 'coach' }));
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = caught?.getResponse() as Record<string, unknown>;
    expect(body.error).toBe('TIER_UPGRADE_REQUIRED');
    expect(body.required_tier).toBe('pro');
    expect(body.current_tier).toBe('free');
  });

  // Case 3: free coach + @RequiresTier('pro'), BILLING_ENFORCEMENT=observe
  //         → 200 (allowed) + telemetry logged
  it('free coach + @RequiresTier("pro") endpoint, observe → 200 + telemetry logged', async () => {
    delete process.env.BILLING_ENFORCEMENT; // observe mode
    const capture = jest.fn();
    const analytics: any = { capture };
    const guard = new SubscriptionGuard(
      makePrisma(null) as any,
      proReflector(),
      analytics,
    );
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
    expect(capture).toHaveBeenCalledWith(
      'c',
      'server_billing_enforcement_observed',
      expect.objectContaining({
        currentState: 'none',
        reason: 'missing_subscription',
      }),
    );
  });

  // Case 4: pro coach (tier='pro') + active subscription + @RequiresTier('pro') → allow
  it('pro coach + active subscription + @RequiresTier("pro") → allow', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const guard = new SubscriptionGuard(
      makePrisma({ tier: 'pro', status: 'active', last_payment_failed_at: null }) as any,
      proReflector(),
    );
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  // Case 5: pro coach + canceled subscription + @RequiresTier('pro'), enforce
  //         → 403 SUBSCRIPTION_INACTIVE
  it('pro coach + canceled subscription + @RequiresTier("pro"), enforce → 403 SUBSCRIPTION_INACTIVE', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const guard = new SubscriptionGuard(
      makePrisma({ tier: 'pro', status: 'canceled', last_payment_failed_at: null }) as any,
      proReflector(),
    );
    let caught: ForbiddenException | undefined;
    try {
      await guard.canActivate(ctxFor({ id: 'c', role: 'coach' }));
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = caught?.getResponse() as Record<string, unknown>;
    expect(body.error).toBe('SUBSCRIPTION_INACTIVE');
  });

  // Case 6: pro coach + past_due subscription within 7 days + @RequiresTier('pro') → allow
  it('pro coach + past_due within 7 days + @RequiresTier("pro") → allow (grace window)', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const guard = new SubscriptionGuard(
      makePrisma({
        tier: 'pro',
        status: 'past_due',
        last_payment_failed_at: sixDaysAgo,
      }) as any,
      proReflector(),
    );
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  // Case 7: pro coach + past_due subscription older than 7 days + @RequiresTier('pro'), enforce
  //         → 403 SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED
  it('pro coach + past_due > 7 days + @RequiresTier("pro"), enforce → 403 SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const guard = new SubscriptionGuard(
      makePrisma({
        tier: 'pro',
        status: 'past_due',
        last_payment_failed_at: eightDaysAgo,
      }) as any,
      proReflector(),
    );
    let caught: ForbiddenException | undefined;
    try {
      await guard.canActivate(ctxFor({ id: 'c', role: 'coach' }));
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = caught?.getResponse() as Record<string, unknown>;
    expect(body.error).toBe('SUBSCRIPTION_PAST_DUE_GRACE_EXPIRED');
  });

  // Case 8: owner role + any endpoint (including @RequiresTier('pro')) → allow (OWNER bypass)
  it('owner role + @RequiresTier("pro") endpoint → allow (OWNER bypass, no sub lookup)', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    const prisma = makePrisma(null);
    const guard = new SubscriptionGuard(prisma as any, proReflector());
    await expect(
      guard.canActivate(ctxFor({ id: 'o', role: 'owner' })),
    ).resolves.toBe(true);
    // Owner bypass is first — Prisma should never be called.
    expect(prisma.coachSubscription.findUnique).not.toHaveBeenCalled();
  });

  // Case 9: class-level @RequiresTier('pro') is inherited by all handlers
  it('class-level @RequiresTier("pro") is inherited by all handlers on the class', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    // Simulate Reflector.getAllAndOverride returning 'pro' from class-level metadata
    // (handler has no decorator — falls back to class).
    const reflector: Reflector = {
      getAllAndOverride: jest.fn((key, [handler, cls]) => {
        // handler has no metadata, class has 'pro'
        void handler; void cls;
        return 'pro';
      }),
    } as any;
    const guard = new SubscriptionGuard(
      makePrisma(null) as any, // no sub → treated as free
      reflector,
    );
    let caught: ForbiddenException | undefined;
    try {
      await guard.canActivate(ctxFor({ id: 'c', role: 'coach' }));
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = caught?.getResponse() as Record<string, unknown>;
    expect(body.error).toBe('TIER_UPGRADE_REQUIRED');
    expect(body.required_tier).toBe('pro');
  });

  // Case 10: handler-level @RequiresTier overrides class-level @RequiresTier
  it('handler-level @RequiresTier("enterprise") overrides class-level @RequiresTier("pro")', async () => {
    process.env.BILLING_ENFORCEMENT = 'enforce';
    // Simulate: class has 'pro', handler has 'enterprise'.
    // getAllAndOverride returns handler value first (it wins).
    const reflector: Reflector = {
      getAllAndOverride: jest.fn().mockReturnValue('enterprise'),
    } as any;
    const guard = new SubscriptionGuard(
      // Sub with tier='pro' — not enough for 'enterprise' endpoint.
      makePrisma({ tier: 'pro', status: 'active', last_payment_failed_at: null }) as any,
      reflector,
    );
    let caught: ForbiddenException | undefined;
    try {
      await guard.canActivate(ctxFor({ id: 'c', role: 'coach' }));
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = caught?.getResponse() as Record<string, unknown>;
    expect(body.error).toBe('TIER_UPGRADE_REQUIRED');
    expect(body.required_tier).toBe('enterprise');
    expect(body.current_tier).toBe('pro');
  });
});
