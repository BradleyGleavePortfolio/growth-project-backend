import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SubscriptionGuard } from '../src/billing/subscription.guard';

function ctxFor(user: any): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

function makePrismaWithSub(sub: any | null) {
  return {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
    },
  };
}

describe('SubscriptionGuard', () => {
  const ORIGINAL_ENV = process.env.BILLING_ENFORCEMENT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = ORIGINAL_ENV;
  });

  it('owner bypasses every check', async () => {
    const guard = new SubscriptionGuard(makePrismaWithSub(null) as any);
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'o', role: 'owner' })),
    ).resolves.toBe(true);
  });

  it('rejects students even without enforcement (defense in depth)', async () => {
    const guard = new SubscriptionGuard(makePrismaWithSub(null) as any);
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 's', role: 'student' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('coach with no mirror row is allowed during rollout', async () => {
    const guard = new SubscriptionGuard(makePrismaWithSub(null) as any);
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('coach with active subscription is allowed', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'active', last_payment_failed_at: null }) as any,
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('coach with trialing subscription is allowed', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'trialing', last_payment_failed_at: null }) as any,
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
        last_payment_failed_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      }) as any,
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('past_due past 7-day grace is denied in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({
        status: 'past_due',
        last_payment_failed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }) as any,
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('canceled is denied in enforce mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', last_payment_failed_at: null }) as any,
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('canceled is allowed in observe (non-enforce) mode', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', last_payment_failed_at: null }) as any,
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
  });

  it('paused mirrors canceled in enforce mode (denied)', async () => {
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'paused', last_payment_failed_at: null }) as any,
    );
    process.env.BILLING_ENFORCEMENT = 'enforce';
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('observe-mode emits PostHog telemetry for would-be denies', async () => {
    const capture = jest.fn();
    const analytics: any = { capture };
    const guard = new SubscriptionGuard(
      makePrismaWithSub({ status: 'canceled', last_payment_failed_at: null }) as any,
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
    };
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      'c',
      'server_billing_enforcement_observed',
      expect.objectContaining({
        status: 'canceled',
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
      makePrismaWithSub({ status: 'active', last_payment_failed_at: null }) as any,
      analytics,
    );
    delete process.env.BILLING_ENFORCEMENT;
    await expect(
      guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
    ).resolves.toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });
});
