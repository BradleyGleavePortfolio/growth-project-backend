/**
 * test/billing/subscription-webhook.tier.spec.ts
 *
 * Tests for tier transitions on customer.subscription.updated webhook events
 * (spec §9 — canceled/incomplete_expired → tier='free'; past_due → no change;
 * active → tier='pro').
 */

import { BillingService } from '../../src/billing/billing.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStripeEvent(
  type: string,
  status: string,
  customer = 'cus_test',
  subId = 'sub_test',
) {
  return {
    id: `evt_${type}_${status}`,
    type,
    data: {
      object: {
        id: subId,
        customer,
        status,
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        trial_end: null,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_test' } }] },
      },
    },
  };
}

/**
 * Build a minimal BillingService with mocked Prisma.
 * @param upsertCapture - jest.fn() to capture upsert calls (subscription events)
 * @param currentTier   - current tier in the DB (for the profile/coach lookup)
 */
function makeSvc(
  upsertCapture: jest.Mock,
  currentTier = 'pro',
  options: { updateManyCapture?: jest.Mock } = {},
) {
  const coachId = 'coach-tier-test-1';
  const prisma: any = {
    stripeProcessedEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
    coachProfile: {
      findFirst: jest.fn().mockResolvedValue({
        user_id: coachId,
        stripe_customer_id: 'cus_test',
      }),
    },
    coachSubscription: {
      upsert: upsertCapture,
      updateMany: options.updateManyCapture ?? jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue({ tier: currentTier, status: 'active' }),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };

  const analytics: any = { capture: jest.fn() };
  const audit: any = { write: jest.fn().mockResolvedValue(undefined) };

  return {
    svc: new BillingService(prisma, analytics, audit),
    prisma,
    coachId,
  };
}

/**
 * Build a service for subscription.deleted tests (uses updateMany, not upsert).
 */
function makeDeletedSvc(updateManyCapture: jest.Mock, profileResult: any | null = null) {
  const coachId = 'coach-deleted-test-1';
  const prisma: any = {
    stripeProcessedEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
    coachProfile: {
      findFirst: jest.fn().mockResolvedValue(
        profileResult ?? { user_id: coachId, stripe_customer_id: 'cus_del' },
      ),
    },
    coachSubscription: {
      upsert: jest.fn(),
      updateMany: updateManyCapture,
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };

  const analytics: any = { capture: jest.fn() };
  const audit: any = { write: jest.fn().mockResolvedValue(undefined) };

  return { svc: new BillingService(prisma, analytics, audit), prisma, coachId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BillingService — webhook tier transitions (spec §9)', () => {
  it('customer.subscription.updated with status="canceled" → tier set to "free"', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const { svc } = makeSvc(upsert, 'pro');

    await svc.handleEvent(
      makeStripeEvent('customer.subscription.updated', 'canceled') as any,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ tier: 'free' });
    expect(call.create).toMatchObject({ tier: 'free' });
  });

  it('customer.subscription.updated with status="incomplete_expired" → tier set to "free"', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const { svc } = makeSvc(upsert, 'pro');

    await svc.handleEvent(
      makeStripeEvent('customer.subscription.updated', 'incomplete_expired') as any,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ tier: 'free' });
    expect(call.create).toMatchObject({ tier: 'free' });
  });

  it('customer.subscription.updated with status="past_due" → tier NOT in update payload (no change)', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const { svc } = makeSvc(upsert, 'pro');

    await svc.handleEvent(
      makeStripeEvent('customer.subscription.updated', 'past_due') as any,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    // tier must NOT appear in the update payload — DB value stays unchanged
    expect(call.update).not.toHaveProperty('tier');
  });

  it('customer.subscription.updated with status="active" → tier set to "pro"', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const { svc } = makeSvc(upsert, 'free');

    await svc.handleEvent(
      makeStripeEvent('customer.subscription.updated', 'active') as any,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ tier: 'pro' });
    expect(call.create).toMatchObject({ tier: 'pro' });
  });
});

describe('BillingService — subscription.deleted uses updateMany (spec should-fix #1)', () => {
  it('subscription.deleted for existing coach → updateMany called with tier=free, status=canceled', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { svc } = makeDeletedSvc(updateMany);

    await svc.handleEvent({
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_gone', customer: 'cus_del' } },
    } as any);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({ status: 'canceled', tier: 'free' });
  });

  it('subscription.deleted for non-existent coach_id → no throw, no-op (updateMany count=0)', async () => {
    // Simulate: coach profile found but no subscription row → updateMany returns count=0
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { svc } = makeDeletedSvc(updateMany);

    // Should not throw even when count=0
    await expect(
      svc.handleEvent({
        id: 'evt_del_noop',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_missing', customer: 'cus_del' } },
      } as any),
    ).resolves.toEqual({ processed: true });

    // updateMany was still called (not update, which would throw P2025)
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
