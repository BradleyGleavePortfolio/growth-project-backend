// Phase 8 — CoachConnectService coverage.
//
// 1. getStatus — no account returns configured:false + empty arrays
//    (no fake fields).
// 2. getStatus — onboarded account returns the right boolean fan-out.
// 3. listPackages — recurring + one_time hydration with active_subscribers.
// 4. listPayouts — empty array when no account; Stripe-driven mapping
//    when configured; cached PayoutSnapshot fallback when Stripe is off.
// 5. createOnboardingLink — wraps ConnectService + returns ISO expires_at.
// 6. getMetrics — wires ledger earnings into the mobile contract shape
//    (no fabricated churn or revenue).

import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';

interface MockPrisma {
  connectAccount: { findUnique: jest.Mock };
  payoutSnapshot: { findUnique: jest.Mock };
  coachPackage: { findMany: jest.Mock };
  clientPurchase: {
    groupBy: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    count: jest.Mock;
  };
  teamSubCoachAssignment: { findMany: jest.Mock };
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  return {
    connectAccount: { findUnique: jest.fn(async () => null) },
    payoutSnapshot: { findUnique: jest.fn(async () => null) },
    coachPackage: { findMany: jest.fn(async () => []) },
    clientPurchase: {
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    user: {
      findUnique: jest.fn(async () => ({ email: 'c@example.com' })),
      count: jest.fn(async () => 0),
    },
    teamSubCoachAssignment: { findMany: jest.fn(async () => []) },
    ...overrides,
  };
}

function buildAnalytics() {
  const earnings = {
    coach_user_id: 'coach-1',
    window: { from: new Date(), to: new Date() },
    as_seller: {
      gross_cents: 0,
      posted_cents: 0,
      pending_cents: 0,
      reversed_cents: 0,
      refunds_cents: 0,
      purchases_count: 0,
    },
    as_head_coach: {
      gross_cents: 0,
      posted_cents: 0,
      pending_cents: 0,
      reversed_cents: 0,
      sub_coaches_count: 0,
    },
    last_payout: null,
    balance: null,
  };
  return {
    getCoachEarnings: jest.fn(async () => earnings),
  };
}

describe('CoachConnectService.getStatus', () => {
  it('returns a typed not_configured envelope when no ConnectAccount row exists', async () => {
    const prisma = buildPrisma();
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const status = await svc.getStatus('coach-1');
    expect(status).toEqual({
      configured: false,
      charges_enabled: false,
      payouts_enabled: false,
      account_id: null,
      last_onboarded_at: null,
      requirements_due: [],
    });
  });

  it('returns charges/payouts flags from the mirror row', async () => {
    const prisma = buildPrisma({
      connectAccount: {
        findUnique: jest.fn(async () => ({
          stripe_account_id: 'acct_test',
          charges_enabled: true,
          payouts_enabled: true,
          updated_at: new Date('2026-04-01T00:00:00Z'),
          requirements_due: { currently_due: ['individual.id_number'] },
        })),
      },
    });
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const status = await svc.getStatus('coach-1');
    expect(status.configured).toBe(true);
    expect(status.account_id).toBe('acct_test');
    expect(status.requirements_due).toEqual(['individual.id_number']);
  });
});

describe('CoachConnectService.listPackages', () => {
  it('hydrates active_subscribers from entitlement_active purchases', async () => {
    const prisma = buildPrisma({
      coachPackage: {
        findMany: jest.fn(async () => [
          {
            id: 'pkg-1',
            name: 'Monthly',
            description: 'Recurring monthly',
            billing_type: 'recurring',
            interval: 'month',
            amount_cents: 19900,
            currency: 'usd',
            is_active: true,
            archived_at: null,
            created_at: new Date(),
          },
          {
            id: 'pkg-2',
            name: 'One-off',
            description: null,
            billing_type: 'one_time',
            interval: null,
            amount_cents: 9900,
            currency: 'usd',
            is_active: true,
            archived_at: null,
            created_at: new Date(),
          },
        ]),
      },
      clientPurchase: {
        ...buildPrisma().clientPurchase,
        groupBy: jest.fn(async () => [{ package_id: 'pkg-1', _count: { _all: 4 } }]),
      },
    });
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const out = await svc.listPackages('coach-1');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'pkg-1',
      type: 'recurring',
      price: 199,
      active_subscribers: 4,
      interval: 'month',
    });
    expect(out[1]).toMatchObject({
      id: 'pkg-2',
      type: 'one_time',
      active_subscribers: 0,
      interval: null,
    });
  });
});

describe('CoachConnectService.listPayouts', () => {
  it('returns [] when the coach has no ConnectAccount', async () => {
    const prisma = buildPrisma();
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true, listPayouts: jest.fn() } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const out = await svc.listPayouts('coach-1', 5);
    expect(out).toEqual([]);
  });

  it('maps Stripe payouts into the mobile contract shape', async () => {
    const prisma = buildPrisma({
      connectAccount: {
        findUnique: jest.fn(async () => ({
          stripe_account_id: 'acct_test',
          default_currency: 'usd',
        })),
      },
    });
    const stripe = {
      isConfigured: () => true,
      listPayouts: jest.fn(async () => ({
        data: [
          {
            id: 'po_1',
            amount: 12000,
            currency: 'usd',
            status: 'paid',
            arrival_date: 1_700_000_000,
            created: 1_699_900_000,
            description: 'Auto payout',
            failure_message: null,
          },
        ],
        has_more: false,
      })),
    };
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      stripe as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const out = await svc.listPayouts('coach-1', 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'po_1',
      amount: 120,
      currency: 'usd',
      status: 'paid',
      description: 'Auto payout',
    });
  });

  it('falls back to the cached PayoutSnapshot when Stripe is off', async () => {
    const prisma = buildPrisma({
      connectAccount: {
        findUnique: jest.fn(async () => ({
          stripe_account_id: 'acct_test',
          default_currency: 'usd',
        })),
      },
      payoutSnapshot: {
        findUnique: jest.fn(async () => ({
          last_payout_stripe_id: 'po_cached',
          last_payout_amount_cents: 8800,
          last_payout_status: 'paid',
          last_payout_arrival_at: new Date('2026-04-15T00:00:00Z'),
          last_payout_failure_message: null,
          currency: 'usd',
        })),
      },
    });
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => false } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const out = await svc.listPayouts('coach-1');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('po_cached');
    expect(out[0].amount).toBe(88);
  });
});

describe('CoachConnectService.createOnboardingLink', () => {
  it('refuses when Stripe Connect is not configured (503)', async () => {
    const prisma = buildPrisma();
    const svc = new CoachConnectService(
      prisma as never,
      { createAccountForCoach: jest.fn(), createOnboardingLink: jest.fn() } as never,
      { isConfigured: () => false } as never,
      { ready: false, reason: 'STRIPE_SECRET_KEY unset' } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    await expect(svc.createOnboardingLink('coach-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('returns an ISO-formatted expires_at on the happy path', async () => {
    const prisma = buildPrisma({
      connectAccount: {
        findUnique: jest.fn(async () => ({ stripe_account_id: 'acct_test' })),
      },
    });
    const connect = {
      createAccountForCoach: jest.fn(),
      createOnboardingLink: jest.fn(async () => ({
        url: 'https://stripe.example/onboard',
        expires_at: 1_700_000_000,
      })),
    };
    const svc = new CoachConnectService(
      prisma as never,
      connect as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const out = await svc.createOnboardingLink('coach-1');
    expect(out.url).toMatch(/stripe.example/);
    expect(out.expires_at).toMatch(/T/);
  });
});

describe('CoachConnectService.getMetrics', () => {
  it('returns honest zeros when there is no purchase history', async () => {
    const prisma = buildPrisma({
      user: {
        findUnique: jest.fn(async () => null),
        count: jest.fn(async () => 0),
      },
    });
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      buildAnalytics() as never,
    );
    const m = await svc.getMetrics('coach-1');
    expect(m.revenue_30d).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.sub_coach_revenue_30d).toBe(0);
    expect(m.active_clients).toBe(0);
    expect(m.clients_added_30d).toBe(0);
    expect(m.currency).toBe('usd');
  });

  it('reflects ledger earnings + recurring MRR on the happy path', async () => {
    const earnings = {
      as_seller: {
        gross_cents: 50_000,
        posted_cents: 50_000,
        pending_cents: 0,
        reversed_cents: 0,
        refunds_cents: 5_000,
        purchases_count: 4,
      },
      as_head_coach: {
        gross_cents: 10_000,
        posted_cents: 10_000,
        pending_cents: 0,
        reversed_cents: 0,
        sub_coaches_count: 2,
      },
    };
    const analytics = { getCoachEarnings: jest.fn(async () => earnings) };
    const prisma = buildPrisma({
      clientPurchase: {
        ...buildPrisma().clientPurchase,
        findMany: jest.fn(async () => [
          { amount_cents: 19900, package: { interval: 'month' } },
          { amount_cents: 1_999_00, package: { interval: 'year' } },
        ]),
        count: jest.fn(async () => 1),
      },
      user: {
        findUnique: jest.fn(),
        count: jest.fn(async () => 12),
      },
    });
    const svc = new CoachConnectService(
      prisma as never,
      {} as never,
      { isConfigured: () => true } as never,
      { ready: true, reason: null } as never,
      { refresh: jest.fn() } as never,
      analytics as never,
    );
    const m = await svc.getMetrics('coach-1');
    expect(m.revenue_30d).toBe(500);
    expect(m.net_30d).toBe(450);
    expect(m.sub_coach_revenue_30d).toBe(100);
    // 199/mo + 1999/12 mo = 199 + 166.5833 ≈ 365.58
    expect(m.mrr).toBeGreaterThan(360);
    expect(m.mrr).toBeLessThan(370);
    expect(m.active_clients).toBe(12);
  });
});
