import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionGuard } from '../src/billing/subscription.guard';

// Helper: build a mock ExecutionContext for a given user.
// Includes getHandler/getClass so Reflector.getAllAndOverride works.
function ctxFor(user: any): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function makePrismaWithSub(sub: any | null) {
  return {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

// Free-tier reflector: no @RequiresTier decorator → guard treats as 'free'.
function makeFreeReflector(): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as any;
}

// Pro-tier reflector: simulates @RequiresTier('pro') on the route.
function makeProReflector(): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue('pro') } as any;
}

describe('SubscriptionGuard', () => {
  const ORIGINAL_ENV = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = ORIGINAL_ENV;
  });

  it('owner bypasses every check', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub(null) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'o', role: 'owner' })),
    ).resolves.toBe(true);
  });

  it('rejects students even without enforcement (defense in depth)', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub(null) as any,
      makeFreeReflector(),
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 's', role: 'student' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('coach with no mirror row is allowed during rollout', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub(null) as any,
      makeFreeReflector(),
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('coach with active subscription is allowed', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'active', tier: 'free', last_payment_failed_at: null }) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('coach with trialing subscription is allowed', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'trialing', tier: 'free', last_payment_failed_at: null }) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('coach with grandfathered subscription is allowed in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'grandfathered', tier: 'free', last_payment_failed_at: null }) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('past_due within 7-day grace is allowed (enforce mode)', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({
        status: 'past_due',
        tier: 'free',
        last_payment_failed_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      }) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  // NOTE (hybrid-pricing): free endpoints no longer deny based on subscription
  // status — spec §6 says status checks only apply to Pro endpoints. The
  // following tests use a Pro-endpoint reflector where denial is expected.

  it('past_due past 7-day grace is denied on Pro endpoint in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({
        status: 'past_due',
        tier: 'pro',
        last_payment_failed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }) as any,
      makeProReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('canceled coach with tier=free on free endpoint is allowed in enforce mode (free status ignored)', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', tier: 'free', last_payment_failed_at: null }) as any,
      makeFreeReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    // Free endpoints: status=canceled does NOT deny under hybrid model.
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('canceled Pro coach on Pro endpoint is denied in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', tier: 'free', last_payment_failed_at: null }) as any,
      makeProReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('canceled is always allowed in observe mode (Pro endpoint, non-enforce)', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', tier: 'free', last_payment_failed_at: null }) as any,
      makeProReflector(),
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('paused Pro coach on Pro endpoint is denied in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'paused', tier: 'pro', last_payment_failed_at: null }) as any,
      makeProReflector(),
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('observe-mode emits PostHog telemetry for would-be denies (Pro endpoint)', async () => {
    const capture = jest.fn();
    const analytics: any = { capture };
    // Use a Pro endpoint reflector so the deny path is reached (canceled coach).
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', tier: 'free', last_payment_failed_at: null }) as any,
      makeProReflector(),
      analytics,
    );
    delete process.env.BILLING_ENFORCEMENT;
    const req = {
      user: { id: 'c', role: 'coach' },
      method: 'POST',
      route: { path: '/v1/coach/me/clients' },
    };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      'c',
      'server_billing_enforcement_observed',
      expect.objectContaining({
        currentState: 'canceled',
        reason: 'canceled',
        route: '/v1/coach/me/clients',
        method: 'POST',
      }),
    );
  });

  it('observe-mode does not capture when subscription is active', async () => {
    const capture = jest.fn();
    const analytics: any = { capture };
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'active', tier: 'free', last_payment_failed_at: null }) as any,
      makeFreeReflector(),
      analytics,
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });
});
