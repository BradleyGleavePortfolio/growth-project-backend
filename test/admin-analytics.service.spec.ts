import { AdminAnalyticsService } from '../src/checkout/admin-analytics.service';

function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const refunds: any[] = [];
  const disputes: any[] = [];
  const accounts: any[] = [];
  const snapshots: any[] = [];
  return {
    _purchases: purchases,
    _splits: splits,
    _refunds: refunds,
    _disputes: disputes,
    _accounts: accounts,
    _snapshots: snapshots,
    clientPurchase: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        purchases.filter((p) => matchWhere(p, where)),
      ),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        splits.filter((s) => matchWhere(s, where)),
      ),
    },
    chargeRefund: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        refunds.filter((r) => matchWhere(r, where)),
      ),
    },
    chargeDispute: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        disputes.filter((d) => matchWhere(d, where)),
      ),
    },
    connectAccount: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        accounts.filter((a) => matchWhere(a, where)),
      ),
    },
    payoutSnapshot: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        snapshots.filter((s) => matchWhere(s, where)),
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        snapshots.find((s) => s.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
  };
}

function matchWhere(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: any) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if (v.gte && row[k] < v.gte) return false;
      if (v.lte && row[k] > v.lte) return false;
      if (v.in && Array.isArray(v.in)) return v.in.includes(row[k]);
      if (v.not !== undefined) return row[k] !== v.not;
      return true;
    }
    return row[k] === v;
  });
}

describe('AdminAnalyticsService', () => {
  it('getEnterpriseRollup sums GMV, platform fee, head-coach split, seller gross', async () => {
    const prisma = makePrismaStub();
    const now = new Date();
    const earlier = new Date(now.getTime() - 1_000);
    prisma._purchases.push(
      {
        id: 'p1',
        amount_cents: 10_000,
        coach_user_id: 'c1',
        status: 'paid',
        created_at: earlier,
      },
      {
        id: 'p2',
        amount_cents: 5_000,
        coach_user_id: 'c2',
        status: 'active',
        created_at: earlier,
      },
    );
    prisma._splits.push(
      {
        kind: 'application_fee',
        amount_cents: 200,
        reversed_cents: 0,
        payee_user_id: null,
        posted_at: earlier,
        purchase_id: 'p1',
        status: 'posted',
      },
      {
        kind: 'destination',
        amount_cents: 9_800,
        reversed_cents: 0,
        payee_user_id: 'c1',
        posted_at: earlier,
        purchase_id: 'p1',
        status: 'posted',
      },
      {
        kind: 'destination',
        amount_cents: 4_900,
        reversed_cents: 0,
        payee_user_id: 'c2',
        posted_at: earlier,
        purchase_id: 'p2',
        status: 'posted',
      },
      {
        kind: 'application_fee',
        amount_cents: 100,
        reversed_cents: 0,
        payee_user_id: null,
        posted_at: earlier,
        purchase_id: 'p2',
        status: 'posted',
      },
      {
        kind: 'head_coach_split',
        amount_cents: 250,
        reversed_cents: 0,
        payee_user_id: 'hc1',
        posted_at: earlier,
        purchase_id: 'p2',
        status: 'posted',
      },
    );
    prisma._accounts.push(
      { coach_user_id: 'c1', charges_enabled: true, deauthorized_at: null },
      { coach_user_id: 'c2', charges_enabled: true, deauthorized_at: null },
    );
    prisma._snapshots.push(
      { coach_user_id: 'c1', readiness_status: 'ready' },
    );

    const svc = new AdminAnalyticsService(prisma as any);
    const rollup = await svc.getEnterpriseRollup({});
    expect(rollup.gmv_cents).toBe(15_000);
    expect(rollup.platform_fee_cents).toBe(300);
    expect(rollup.head_coach_split_cents).toBe(250);
    expect(rollup.seller_gross_cents).toBe(14_700);
    expect(rollup.purchases_count).toBe(2);
    expect(rollup.active_coaches).toBe(2);
    expect(rollup.payouts_ready_coaches).toBe(1);
  });

  it('getEnterpriseRollup groups by coach when requested', async () => {
    const prisma = makePrismaStub();
    const now = new Date();
    prisma._purchases.push(
      { id: 'p1', amount_cents: 10_000, coach_user_id: 'c1', status: 'paid', created_at: now },
      { id: 'p2', amount_cents: 20_000, coach_user_id: 'c2', status: 'paid', created_at: now },
    );
    const svc = new AdminAnalyticsService(prisma as any);
    const rollup = await svc.getEnterpriseRollup({ groupBy: 'coach' });
    const c1 = rollup.groups.find((g) => g.key === 'c1');
    const c2 = rollup.groups.find((g) => g.key === 'c2');
    expect(c1?.gmv_cents).toBe(10_000);
    expect(c2?.gmv_cents).toBe(20_000);
    // c2 has higher GMV → sorts first when groupBy=coach.
    expect(rollup.groups[0].key).toBe('c2');
  });

  it('getEnterpriseRollup includes refund + dispute totals', async () => {
    const prisma = makePrismaStub();
    const now = new Date();
    prisma._refunds.push({
      amount_cents: 1_000,
      status: 'succeeded',
      created_at: now,
      purchase_id: 'p1',
    });
    prisma._disputes.push(
      { amount_cents: 2_000, status: 'needs_response', closed_at: null, created_at: now },
      { amount_cents: 3_000, status: 'lost', closed_at: now, created_at: now },
    );
    const svc = new AdminAnalyticsService(prisma as any);
    const rollup = await svc.getEnterpriseRollup({});
    expect(rollup.refunds_cents).toBe(1_000);
    expect(rollup.refund_count).toBe(1);
    expect(rollup.disputes_open).toBe(1);
    expect(rollup.disputes_lost_cents).toBe(3_000);
  });

  it('getCoachEarnings sums seller + head-coach buckets by status', async () => {
    const prisma = makePrismaStub();
    const now = new Date();
    prisma._splits.push(
      {
        payee_user_id: 'me',
        kind: 'destination',
        amount_cents: 5_000,
        reversed_cents: 0,
        status: 'posted',
        created_at: now,
      },
      {
        payee_user_id: 'me',
        kind: 'destination',
        amount_cents: 3_000,
        reversed_cents: 0,
        status: 'pending',
        created_at: now,
      },
      {
        payee_user_id: 'me',
        kind: 'head_coach_split',
        amount_cents: 500,
        reversed_cents: 0,
        status: 'posted',
        purchase_id: 'p1',
        created_at: now,
      },
    );
    prisma._purchases.push({
      id: 'p1',
      coach_user_id: 'sub-coach-a',
      amount_cents: 10_000,
      created_at: now,
    });
    prisma._snapshots.push({
      coach_user_id: 'me',
      last_payout_stripe_id: 'po_x',
      last_payout_amount_cents: 1_234,
      last_payout_status: 'paid',
      last_payout_arrival_at: now,
      available_cents: 250,
      pending_cents: 100,
    });
    const svc = new AdminAnalyticsService(prisma as any);
    const view = await svc.getCoachEarnings('me', {});
    expect(view.as_seller.posted_cents).toBe(5_000);
    expect(view.as_seller.pending_cents).toBe(3_000);
    expect(view.as_head_coach.posted_cents).toBe(500);
    expect(view.as_head_coach.sub_coaches_count).toBe(1);
    expect(view.last_payout.stripe_id).toBe('po_x');
    expect(view.available_cents).toBe(250);
  });
});
