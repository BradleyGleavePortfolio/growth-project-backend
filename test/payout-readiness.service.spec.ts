import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';

// In-memory stand-in for the bits of PrismaService PayoutReadinessService
// touches. Mirrors the style of test/payment-ops.controller.spec.ts.
function makePrismaStub() {
  const accounts: any[] = [];
  const snapshots: any[] = [];
  return {
    _accounts: accounts,
    _snapshots: snapshots,
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.coach_user_id) {
          return accounts.find((a) => a.coach_user_id === where.coach_user_id) ?? null;
        }
        if (where.stripe_account_id) {
          return accounts.find((a) => a.stripe_account_id === where.stripe_account_id) ?? null;
        }
        return null;
      }),
    },
    payoutSnapshot: {
      findUnique: jest.fn(async ({ where }: any) =>
        snapshots.find((s) => s.coach_user_id === where.coach_user_id) ?? null,
      ),
      findMany: jest.fn(async ({ where = {}, take = 25 }: any) => {
        let rows = snapshots.slice();
        if (where.OR) {
          rows = rows.filter((s) =>
            where.OR.some((c: any) =>
              c.stale_after === null
                ? s.stale_after === null
                : c.stale_after?.lte && s.stale_after && s.stale_after <= c.stale_after.lte,
            ),
          );
        }
        return rows.slice(0, take);
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = snapshots.find((s) => s.coach_user_id === where.coach_user_id);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: 'snap-' + (snapshots.length + 1), ...create };
        snapshots.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = snapshots.find((s) => s.coach_user_id === where.coach_user_id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

function makeStripeStub(overrides: Record<string, any> = {}) {
  return {
    retrieveAccount: jest.fn(async () => ({
      id: 'acct_x',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
    })),
    retrieveBalance: jest.fn(async () => ({
      available: [{ amount: 12_345, currency: 'usd' }],
      pending: [{ amount: 6_000, currency: 'usd' }],
      connect_reserved: [{ amount: 1_000, currency: 'usd' }],
    })),
    listPayouts: jest.fn(async ({ status }: any = {}) => {
      if (status === 'in_transit') {
        return { data: [{ amount: 2_000, currency: 'usd', id: 'po_t' }] };
      }
      return {
        data: [
          {
            id: 'po_last',
            amount: 5_000,
            status: 'paid',
            arrival_date: 1_700_000_000,
            currency: 'usd',
            failure_message: null,
          },
        ],
      };
    }),
    ...overrides,
  };
}

describe('PayoutReadinessService', () => {
  it('returns no_account when the coach has no ConnectAccount', async () => {
    const prisma = makePrismaStub();
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const view = await svc.getForCoach('coach-1');
    expect(view.readiness_status).toBe('no_account');
    expect(view.available_cents).toBe(0);
  });

  it('refreshes from Stripe and persists a ready snapshot', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_x',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      deauthorized_at: null,
    });
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const view = await svc.getForCoach('coach-1');
    expect(view.readiness_status).toBe('ready');
    expect(view.available_cents).toBe(12_345);
    expect(view.pending_cents).toBe(6_000);
    expect(view.in_transit_cents).toBe(2_000);
    expect(view.reserved_cents).toBe(1_000);
    expect(view.last_payout.stripe_id).toBe('po_last');
    expect(prisma._snapshots).toHaveLength(1);
    expect(prisma._snapshots[0].readiness_status).toBe('ready');
  });

  it('marks needs_action when Stripe reports currently_due requirements', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-2',
      stripe_account_id: 'acct_y',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      deauthorized_at: null,
    });
    const stripe = makeStripeStub({
      retrieveAccount: jest.fn(async () => ({
        id: 'acct_y',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: {
          currently_due: ['individual.id_number'],
          past_due: [],
          disabled_reason: 'requirements.past_due',
        },
      })),
    });
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const view = await svc.getForCoach('coach-2');
    expect(view.readiness_status).toBe('needs_action');
    expect(view.disabled_reason).toBe('requirements.past_due');
  });

  it('returns the cached snapshot on a follow-up call within TTL', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-3',
      stripe_account_id: 'acct_z',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      deauthorized_at: null,
    });
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    await svc.getForCoach('coach-3');
    expect(stripe.retrieveAccount).toHaveBeenCalledTimes(1);
    await svc.getForCoach('coach-3');
    expect(stripe.retrieveAccount).toHaveBeenCalledTimes(1); // still cached
  });

  it('forceRefresh=true re-polls Stripe even with fresh cache', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-3',
      stripe_account_id: 'acct_z',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      deauthorized_at: null,
    });
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    await svc.getForCoach('coach-3');
    await svc.getForCoach('coach-3', { forceRefresh: true });
    expect(stripe.retrieveAccount).toHaveBeenCalledTimes(2);
  });

  it('returns cached snapshot with stale=true when Stripe is unreachable', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-4',
      stripe_account_id: 'acct_w',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      deauthorized_at: null,
    });
    prisma._snapshots.push({
      id: 'snap-pre',
      coach_user_id: 'coach-4',
      stripe_account_id: 'acct_w',
      readiness_status: 'ready',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      available_cents: 100,
      pending_cents: 0,
      in_transit_cents: 0,
      reserved_cents: 0,
      currency: 'usd',
      requirements_due: null,
      disabled_reason: null,
      last_payout_stripe_id: null,
      last_payout_amount_cents: null,
      last_payout_status: null,
      last_payout_arrival_at: null,
      last_payout_failure_message: null,
      next_payout_at: null,
      refreshed_at: new Date(Date.now() - 60 * 60 * 1000),
      stale_after: new Date(Date.now() - 30 * 60 * 1000),
    });
    const stripe = makeStripeStub({
      retrieveAccount: jest.fn(async () => {
        throw new Error('stripe down');
      }),
    });
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const view = await svc.getForCoach('coach-4');
    expect(view.stale).toBe(true);
    expect(view.available_cents).toBe(100);
  });

  it('returns deauthorized status when the account was disconnected', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-5',
      stripe_account_id: 'acct_d',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      deauthorized_at: new Date(),
    });
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const view = await svc.getForCoach('coach-5');
    expect(view.readiness_status).toBe('deauthorized');
  });

  it('recordPayoutEvent updates last_payout_* fields', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      coach_user_id: 'coach-6',
      stripe_account_id: 'acct_p',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      deauthorized_at: null,
    });
    const stripe = makeStripeStub();
    const svc = new PayoutReadinessService(prisma as any, stripe as any);
    const result = await svc.recordPayoutEvent({
      stripe_account_id: 'acct_p',
      payout_id: 'po_new',
      amount_cents: 7_500,
      status: 'paid',
      arrival_at: new Date(),
      failure_message: null,
    });
    expect(result?.last_payout_stripe_id).toBe('po_new');
    expect(result?.last_payout_amount_cents).toBe(7_500);
  });
});
