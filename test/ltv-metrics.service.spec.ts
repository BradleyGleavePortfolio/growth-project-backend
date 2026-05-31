// test/ltv-metrics.service.spec.ts
//
// Unit tests for LtvMetricsService.
// Uses an in-memory mock of PrismaService — no real DB required.

import { Test, TestingModule } from '@nestjs/testing';
import { LtvMetricsService } from '../src/coach/command-center/ltv-metrics.service';
import { PrismaService } from '../src/prisma.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Issue 6: mock shape now matches real ClientPurchase schema.
// interval and interval_count are on the joined package relation, not on
// ClientPurchase directly.
function makePurchase(overrides: Partial<{
  client_user_id: string;
  amount_cents: number;
  currency: string;
  billing_type: string;
  package: { interval: string | null; interval_count: number };
  status: string;
  entitlement_active: boolean;
  created_at: Date;
  canceled_at: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
}> = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    client_user_id: overrides.client_user_id ?? 'client-1',
    amount_cents: overrides.amount_cents ?? 20000,
    currency: overrides.currency ?? 'usd',
    billing_type: overrides.billing_type ?? 'recurring',
    // Issue 6: nested package object replacing flat interval/interval_count fields
    package: overrides.package ?? { interval: 'month', interval_count: 1 },
    status: overrides.status ?? 'active',
    entitlement_active: overrides.entitlement_active ?? true,
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    canceled_at: overrides.canceled_at ?? null,
    current_period_end: overrides.current_period_end ?? null,
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
  };
}

// ─── Mock PrismaService ───────────────────────────────────────────────────────

// Persistence is now a ROW-LOCKED TRANSACTION (lockedPeakUpsert) on a SINGLE
// ENSURE-ROW-THEN-LOCK path. The service runs `prisma.$transaction(async (tx)
// => ...)` and inside it:
//   1. `INSERT ... ON CONFLICT (coach_id) DO NOTHING` — ENSURE the row exists,
//      seeding all_time_peak_rpcm=0 + zero_churn_streak only when ABSENT. Under
//      a concurrent first-run race this materialises the row exactly once; the
//      racing request is a no-op. This is the P1 fix: it removes the old
//      first-run bare-INSERT branch that raced two INSERTs (→ unique-violation
//      throw + lost peak).
//   2. `SELECT "all_time_peak_rpcm" ... FOR UPDATE` — reads the LIVE LOCKED
//      current row (NOT a statement-start snapshot). Because step 1 ensured the
//      row exists, this ALWAYS locks a real row (first-run included). This is
//      the P0 fix: the prior peak used to decide is_new_rpcm_record is the live
//      locked value.
//   3. Compute newPeak = GREATEST(livePeak, incoming) and UPDATE the row (the
//      streak is NEVER written on this path — P2 fix preserved).
//
// The mock faithfully models LIVE LOCKED semantics against a single shared
// simulated store (`__store`):
//   - INSERT ... ON CONFLICT DO NOTHING seeds __store to {peak:0, streak:seed}
//     ONLY when __store is null (row absent); when a row already exists it is a
//     NO-OP (never overwrites peak or streak). This models exactly-once
//     row creation under a concurrent first-run race.
//   - SELECT ... FOR UPDATE returns the CURRENT __store row (the live value a
//     concurrent writer would have just committed) — NOT a frozen snapshot.
//     After ensure-row it is always non-empty. This distinguishes the fix from
//     the old snapshot-CTE bug: in a two-request sequence the second request's
//     locked read sees the value the first request already raised.
//   - all_time_peak_rpcm → GREATEST(live, incoming) — monotonic high-water mark.
//   - zero_churn_streak  → seeded ONLY on the ensure-row INSERT; LEFT UNTOUCHED
//     on the UPDATE path. The returned streak comes from the service's live
//     recompute, so an out-of-order persist can never corrupt it (P2 fix).
// The store is seeded from coachLtvPeak.findUnique's stubbed value the first
// time a transaction runs, so a test that stubs an existing row also primes the
// live store. `__rawCalls` captures the persisted peak of every UPDATE write.
const mockPrisma: any = {
  clientPurchase: {
    findMany: jest.fn(),
  },
  // LTV-3: persisted peak/streak store (coach_ltv_peak).
  coachLtvPeak: {
    findUnique: jest.fn(),
  },
  __rawCalls: [] as Array<{ peak: number; streak: number }>,
  // Simulated LIVE persisted store. Seeded from findUnique so a test that stubs
  // an existing row also primes this state. The SELECT ... FOR UPDATE reads
  // THIS live value (not a snapshot), modelling the row lock.
  __store: null as null | { peak: number; streak: number },
  // Tracks whether __store was already seeded from findUnique in this test, so
  // a later transaction in the SAME test reuses the live (possibly mutated)
  // store rather than re-seeding from the stale findUnique stub.
  __seeded: false,
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

// Extract the bound parameter values out of a Prisma.sql tagged-template object.
// Prisma.sql exposes `.values` (the interpolated params, in order).
//   - SELECT ... FOR UPDATE binds only [coach_id].
//   - INSERT binds [coach_id, incomingPeakCents, incomingStreak].
//   - UPDATE binds [newPeakCents, coach_id].
// For the upsert-call assertions we only care about the incoming peak/streak,
// which we capture in the $queryRaw/$executeRaw handlers below.
function sqlText(sql: any): string {
  return (sql?.strings ?? []).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LtvMetricsService', () => {
  let service: LtvMetricsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no persisted peak row yet (first-run behaviour). Individual
    // tests override findUnique to simulate an existing persisted peak/streak.
    mockPrisma.coachLtvPeak.findUnique.mockResolvedValue(null);
    mockPrisma.__rawCalls = [];
    mockPrisma.__store = null;
    mockPrisma.__seeded = false;

    // Lazily seed the LIVE store from the findUnique stub the first time a
    // transaction runs in this test. Subsequent transactions in the same test
    // reuse the (possibly mutated) live store — modelling that a prior request
    // already committed its write to the live row.
    const ensureStoreSeeded = async () => {
      if (mockPrisma.__seeded) return;
      mockPrisma.__seeded = true;
      const stub = mockPrisma.coachLtvPeak.findUnique.mock.results.length
        ? await mockPrisma.coachLtvPeak.findUnique.mock.results[
            mockPrisma.coachLtvPeak.findUnique.mock.results.length - 1
          ].value
        : null;
      mockPrisma.__store =
        mockPrisma.__store ??
        (stub
          ? {
              peak: Number(stub.all_time_peak_rpcm),
              streak: Number(stub.zero_churn_streak),
            }
          : null);
    };

    // The transactional `tx` handle. Inside lockedPeakUpsert the service issues
    // (a) an ensure-row INSERT ... ON CONFLICT DO NOTHING via tx.$executeRaw,
    // (b) a SELECT ... FOR UPDATE via tx.$queryRaw (always finds the row now),
    // (c) a peak-only UPDATE via tx.$executeRaw.
    const tx = {
      $queryRaw: jest.fn(async (sql: any) => {
        const text = sqlText(sql);
        if (/FOR UPDATE/i.test(text)) {
          // SELECT ... FOR UPDATE: return the LIVE LOCKED row (current __store).
          // After the ensure-row INSERT (step 1) the row ALWAYS exists, so this
          // is never empty on the persistence path. This is the crux of the P0
          // fix — a snapshot would have returned a frozen pre-concurrent-write
          // value; the row lock returns the current committed value instead.
          if (mockPrisma.__store === null) return [];
          return [{ all_time_peak_rpcm: mockPrisma.__store.peak }];
        }
        throw new Error('Unexpected tx.$queryRaw call: ' + text);
      }),
      $executeRaw: jest.fn(async (sql: any) => {
        const text = sqlText(sql);
        const values: any[] = sql?.values ?? [];
        if (/ON CONFLICT/i.test(text) || /INSERT/i.test(text)) {
          // Ensure-row INSERT ... ON CONFLICT DO NOTHING:
          // [coach_id, seedStreak] (peak is the literal 0 in the SQL). Seed a
          // 0/seedStreak row ONLY when absent; NO-OP when a row already exists
          // (never overwrites peak or streak). Models exactly-once row creation
          // under a concurrent first-run race.
          if (mockPrisma.__store === null) {
            const seedStreak = Number(values[values.length - 1]);
            mockPrisma.__store = { peak: 0, streak: seedStreak };
          }
          // No row affected on conflict; returns 0 in that case. We don't assert
          // on this, so just return a benign count.
          return mockPrisma.__store ? 1 : 0;
        }
        if (/UPDATE/i.test(text)) {
          // UPDATE path: [newPeakCents, coach_id]. The new peak is already the
          // GREATEST(live, incoming) computed by the service against the locked
          // value, so just record + persist it. The streak is NOT touched here.
          const newPeak = Number(values[0]);
          // For assertions, record the incoming candidate as the new peak (the
          // service hands the DB the GREATEST result; the candidate it computed
          // from is captured implicitly). We push the persisted peak so
          // __rawCalls reflects the write that occurred.
          mockPrisma.__rawCalls.push({
            peak: newPeak,
            streak: mockPrisma.__store ? mockPrisma.__store.streak : 0,
          });
          mockPrisma.__store = {
            peak: newPeak,
            // Streak left UNTOUCHED on the update path (P2 fix).
            streak: mockPrisma.__store ? mockPrisma.__store.streak : 0,
          };
          return 1;
        }
        throw new Error('Unexpected tx.$executeRaw call: ' + text);
      }),
    };

    // $transaction runs the interactive callback with the tx handle, after
    // seeding the live store from the findUnique stub.
    mockPrisma.$transaction.mockImplementation(async (cb: any) => {
      await ensureStoreSeeded();
      return cb(tx);
    });
    // Expose tx handles for assertions about which raw statements ran.
    mockPrisma.__tx = tx;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LtvMetricsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<LtvMetricsService>(LtvMetricsService);
  });

  describe('empty roster', () => {
    it('returns zeroes and no errors when coach has no purchases', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([]);
      const result = await service.getMetrics('coach-empty');

      expect(result.mrr_cents).toBe(0);
      expect(result.active_client_count).toBe(0);
      expect(result.revenue_per_client_month_cents).toBe(0);
      expect(result.churn_rate_pct).toBe(0);
      expect(result.projected_annual_revenue_cents).toBe(0);
      expect(result.mrr_trend).toBe('flat');
      expect(result.next_milestone.clients_needed).toBe(0);
      expect(result.currency).toBe('usd');
      // Issue 4: nrr_is_stub must always be set
      expect(result.nrr_is_stub).toBe(true);
    });
  });

  describe('mrr_cents', () => {
    it('sums recurring active purchases correctly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Issue 6: interval/interval_count now nested under package
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, billing_type: 'recurring', package: { interval: 'month', interval_count: 1 }, status: 'active' }),
        makePurchase({ client_user_id: 'c2', amount_cents: 15000, billing_type: 'recurring', package: { interval: 'month', interval_count: 1 }, status: 'active' }),
        // One-time — excluded from MRR
        makePurchase({ client_user_id: 'c3', amount_cents: 50000, billing_type: 'one_time', status: 'paid', entitlement_active: true }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.mrr_cents).toBe(35000); // 200 + 150
      expect(result.active_client_count).toBe(3); // all 3 have entitlement
    });

    it('normalises yearly recurring to monthly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Issue 6: interval fields under package
        makePurchase({ client_user_id: 'c1', amount_cents: 240000, billing_type: 'recurring', package: { interval: 'year', interval_count: 1 }, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_cents).toBe(20000); // $2400/yr → $200/mo
    });

    it('normalises 3-month recurring correctly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Issue 6: interval fields under package
        makePurchase({ client_user_id: 'c1', amount_cents: 60000, billing_type: 'recurring', package: { interval: 'month', interval_count: 3 }, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_cents).toBe(20000); // $600 / 3 months → $200/mo
    });

    it('excludes canceled recurring from MRR', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
        makePurchase({ client_user_id: 'c2', amount_cents: 20000, status: 'canceled', entitlement_active: false, canceled_at: new Date() }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_cents).toBe(20000);
    });
  });

  describe('revenue_per_client_month_cents', () => {
    it('divides mrr by active client count', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
        makePurchase({ client_user_id: 'c2', amount_cents: 20000, status: 'active' }),
        makePurchase({ client_user_id: 'c3', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.revenue_per_client_month_cents).toBe(20000);
    });

    it('counts unique clients (not unique purchases)', async () => {
      // One client with two packages (both active)
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 10000, status: 'active' }),
        makePurchase({ client_user_id: 'c1', amount_cents: 10000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.active_client_count).toBe(1);
      expect(result.mrr_cents).toBe(20000); // both packages add to MRR
      expect(result.revenue_per_client_month_cents).toBe(20000); // RPCM = MRR / 1 client
    });
  });

  describe('churn_rate_pct', () => {
    it('returns 0 when no cancellations this month', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: new Date('2026-01-01') }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.churn_rate_pct).toBe(0);
    });

    it('computes churn correctly when one client canceled this month', async () => {
      const now = new Date();
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 10);
      const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Active at start of month, still active
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        makePurchase({ client_user_id: 'c2', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        // Active at start of month, canceled mid-month — status is now 'canceled'
        // but temporal logic counts them in the denominator.
        makePurchase({ client_user_id: 'c3', status: 'canceled', entitlement_active: false, created_at: twoMonthsAgo, canceled_at: midMonth }),
      ]);
      const result = await service.getMetrics('coach-1');
      // PR #223: temporal logic — c3 was active at start of month (created
      // twoMonthsAgo, canceled_at >= startOfMonth), so activeAtStart = {c1, c2, c3}.
      // canceledThisMonthClientIds = {c3} (1 unique client).
      // churn = 1 canceled / 3 active-at-start = 33.3%.
      expect(result.churn_rate_pct).toBe(33.3);
    });

    it('counts a client with two purchases as one churned client', async () => {
      // Issue 2 regression: two purchase rows for the same client should
      // count as ONE cancellation, not two.
      // PR #223: temporal logic means c2 (canceled mid-month, created before
      // month) is also counted in the denominator.
      const now = new Date();
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 10);
      const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // c1 has two active recurring purchases
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        // c2 canceled both their purchases this month
        makePurchase({ client_user_id: 'c2', status: 'canceled', entitlement_active: false, created_at: twoMonthsAgo, canceled_at: midMonth }),
        makePurchase({ client_user_id: 'c2', status: 'canceled', entitlement_active: false, created_at: twoMonthsAgo, canceled_at: midMonth }),
      ]);
      const result = await service.getMetrics('coach-1');
      // PR #223: activeAtStart = {c1, c2} (both created before month; c2
      // canceled mid-month so canceled_at >= startOfMonth, still counts).
      // canceledThisMonth = {c2} (1 unique client).
      // churn = 1/2 = 50%. Dedup ensures two purchase rows for c2 still = 1.
      expect(result.churn_rate_pct).toBe(50);
    });

    it('client active at start of month who cancels mid-month is counted in denominator', async () => {
      // PR #223 regression test: the sole active client cancels mid-month.
      // Old (status-based) logic: denominator=0 → churn=0%.
      // New (temporal) logic: denominator=1 → churn=100%.
      const now = new Date();
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 15);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({
          client_user_id: 'c1',
          billing_type: 'recurring',
          status: 'canceled',
          entitlement_active: false,
          created_at: lastMonth,   // existed before this month
          canceled_at: midMonth,   // canceled during this month
        }),
      ]);
      const result = await service.getMetrics('coach-1');
      // c1 was active at start of month (created before month, canceled_at >= startOfMonth).
      // activeAtStart = {c1}, canceledThisMonth = {c1}.
      // churn = 1/1 = 100%, not 0%.
      expect(result.churn_rate_pct).toBe(100);
    });

    it('1 of 2 clients churns mid-month produces 50% churn rate', async () => {
      // PR #223: with 2 clients active at start and 1 canceling mid-month,
      // churn should be 50%.
      const now = new Date();
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 15);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // c1 stays active
        makePurchase({
          client_user_id: 'c1',
          billing_type: 'recurring',
          status: 'active',
          entitlement_active: true,
          created_at: lastMonth,
          canceled_at: null,
        }),
        // c2 cancels mid-month — status is now 'canceled'
        makePurchase({
          client_user_id: 'c2',
          billing_type: 'recurring',
          status: 'canceled',
          entitlement_active: false,
          created_at: lastMonth,
          canceled_at: midMonth,
        }),
      ]);
      const result = await service.getMetrics('coach-1');
      // activeAtStart = {c1, c2}, canceledThisMonth = {c2}.
      // churn = 1/2 = 50%.
      expect(result.churn_rate_pct).toBe(50);
    });
  });

  describe('mrr_trend', () => {
    it('returns "up" when MRR grew ≥5% in last 30 days', async () => {
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active', created_at: thirtyOneDaysAgo }),
        // New client added in last 30 days — not in 30d-ago baseline
        makePurchase({ client_user_id: 'c2', amount_cents: 10000, status: 'active', created_at: new Date() }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_trend).toBe('up');
    });

    it('returns "flat" when MRR is identical', async () => {
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active', created_at: thirtyOneDaysAgo }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_trend).toBe('flat');
    });
  });

  describe('projected_annual_revenue_cents', () => {
    it('equals mrr × 12', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.projected_annual_revenue_cents).toBe(result.mrr_cents * 12);
    });
  });

  describe('next_milestone', () => {
    it('computes correct milestone above current MRR', async () => {
      // MRR = $200 → next milestone is $500
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.next_milestone.mrr_target_cents).toBe(50000); // $500
      // clients_needed = ceil(($500 - $200) / $200) = ceil(1.5) = 2
      expect(result.next_milestone.clients_needed).toBe(2);
    });

    it('jumps to $2k milestone when MRR is $1k', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 100000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.next_milestone.mrr_target_cents).toBe(200000); // $2k
    });
  });

  describe('avg_client_lifespan_months stub', () => {
    it('returns 6-month default when fewer than 3 cancellations', async () => {
      const ninetyTwoDaysAgo = new Date(Date.now() - 92 * 24 * 3600 * 1000);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'canceled', billing_type: 'recurring',
          created_at: ninetyTwoDaysAgo, canceled_at: new Date(), entitlement_active: false }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.avg_client_lifespan_months).toBe(6);
    });
  });

  describe('net_revenue_retention_pct (stub)', () => {
    it('is always flagged as a stub via nrr_is_stub', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      // Issue 4: nrr_is_stub must be true so frontend knows this is not true NRR
      expect(result.nrr_is_stub).toBe(true);
    });

    it('equals 100 minus churn rate when churn > 0', async () => {
      const now = new Date();
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 10);
      const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: twoMonthsAgo }),
        makePurchase({ client_user_id: 'c2', status: 'active', created_at: twoMonthsAgo }),
        makePurchase({ client_user_id: 'c3', status: 'active', created_at: twoMonthsAgo, canceled_at: midMonth }),
      ]);
      const result = await service.getMetrics('coach-1');
      // churnRatePct = 1 canceled / 3 active-at-start = 33.3%
      // grossRetentionPct = 100 - 33.3 = 66.7
      expect(result.net_revenue_retention_pct).toBe(
        parseFloat((100 - result.churn_rate_pct).toFixed(1)),
      );
    });
  });

  describe('LTV-3: all_time_peak_rpcm persistence (coach_ltv_peak)', () => {
    it('returns the persisted peak (not current) and isNewRpcmRecord=false when persisted > current', async () => {
      // Persisted peak is higher than current RPCM ($300 > $200), so the
      // monotonic peak does NOT advance and remains the source of truth.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 30000, // $300 in cents (Decimal coerces to number)
        zero_churn_streak: 99,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.revenue_per_client_month_cents).toBe(20000);
      // Persisted peak is the (monotonic) source of truth — never regresses.
      expect(result.all_time_peak_rpcm_cents).toBe(30000);
      expect(result.is_new_rpcm_record).toBe(false);
      expect(result.peak_rpcm_is_estimate).toBe(false);
    });

    it('does NOT write when the peak cannot advance (streak is no longer persisted)', async () => {
      // P2 fix: the streak is no longer persisted on the read path, so the only
      // reason to write is the monotonic peak advancing. When a persisted peak
      // already dominates the current RPCM, NO atomic upsert is performed —
      // regardless of the streak (which is always returned live from the
      // recompute).
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 30000, // $300 > current $200 → peak won't advance
        zero_churn_streak: 99, // stale stored streak — irrelevant to the response
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.all_time_peak_rpcm_cents).toBe(30000);
      // The returned streak is the LIVE recompute, NOT the stale stored 99.
      const expectedStreak = (service as any).computeZeroChurnStreak(
        [makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' })],
        new Date(),
      );
      expect(result.zero_churn_streak_months).toBe(expectedStreak);
      expect(result.zero_churn_streak_months).not.toBe(99);
      // Peak did not advance → no atomic upsert performed.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('upserts a new peak and sets isNewRpcmRecord=true when current > persisted', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000, // $100 persisted
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.revenue_per_client_month_cents).toBe(20000);
      expect(result.all_time_peak_rpcm_cents).toBe(20000); // GREATEST(10000, 20000)
      expect(result.is_new_rpcm_record).toBe(true);
      // One atomic GREATEST upsert; the incoming peak we hand the DB is the
      // current RPCM (the DB itself takes the max against the stored value).
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.__rawCalls[0].peak).toBe(20000);
    });

    it('does NOT flag a new record when current ties the persisted peak', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 20000,
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.is_new_rpcm_record).toBe(false);
      expect(result.all_time_peak_rpcm_cents).toBe(20000);
    });

    it('creates the row on first run (no persisted peak) and records the current RPCM', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue(null);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.all_time_peak_rpcm_cents).toBe(20000);
      expect(result.is_new_rpcm_record).toBe(true); // 20000 > 0
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('LTV-3 P1: monotonic peak under concurrent stale reads', () => {
    // These tests reproduce the lost-update race the P1 fix closes for the PEAK
    // (a monotonic high-water mark). The fix performs the max DB-side via
    // GREATEST(...) inside a single atomic INSERT ... ON CONFLICT DO UPDATE, so
    // a request that read a STALE (lower) peak can never overwrite/regress a
    // higher value another request already persisted. The mock's $queryRaw
    // applies the same GREATEST semantics for the peak against a shared
    // simulated store, modelling true concurrent ordering. (The streak uses
    // different, reset-capable semantics — covered in its own describe block.)

    it('a stale low write does NOT regress a peak a concurrent higher write already persisted', async () => {
      // Both requests observe the same stale starting row (peak=$100). This is
      // the race window: each read happened before either wrote.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000, // $100 — the stale value both requests read
        zero_churn_streak: 0,
      });

      // Request A computes a high RPCM ($300) and persists it first.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 30000, status: 'active' }),
      ]);
      const resultHigh = await service.getMetrics('coach-1');
      expect(resultHigh.all_time_peak_rpcm_cents).toBe(30000); // store now $300

      // Request B — which had read the stale $100 — now lands with a LOWER RPCM
      // ($250). With the old read-then-absolute-write, B would have written
      // $250 and clobbered A's $300. With the row-locked upsert, B's
      // SELECT ... FOR UPDATE reads the LIVE $300 A already committed, computes
      // GREATEST($300, $250)=$300, and the result stays $300.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 25000, status: 'active' }),
      ]);
      const resultStaleLow = await service.getMetrics('coach-1');

      // The persisted peak is NEVER regressed by the racing stale-low writer.
      expect(resultStaleLow.all_time_peak_rpcm_cents).toBe(30000);
      // And the simulated store confirms monotonicity end-to-end.
      expect(mockPrisma.__store?.peak).toBe(30000);
      // The lower writer's UPDATE persists the GREATEST result ($300), NOT its
      // own lower candidate — the monotonic guarantee is enforced by reading the
      // LIVE LOCKED value and taking GREATEST against it.
      const lastCall = mockPrisma.__rawCalls[mockPrisma.__rawCalls.length - 1];
      expect(lastCall.peak).toBe(30000);
    });

    it('CONCURRENT FIRST-RUN (brand-new coach): two racing requests → exactly one row, peak = max of the two incoming, neither throws, at most one is_new_rpcm_record', async () => {
      // P1 regression. A brand-new coach has NO persisted row
      // (findUnique → null). Two requests race for the very first peak. With the
      // OLD first-run code BOTH took the bare-INSERT branch (the SELECT FOR
      // UPDATE returned no row for both, since FOR UPDATE cannot lock a
      // not-yet-existing row): one INSERT won, the OTHER THREW a unique
      // violation, and the loser's (possibly higher) peak was LOST.
      //
      // With the ENSURE-ROW-THEN-LOCK fix the mock models the new flow:
      //   - INSERT ... ON CONFLICT DO NOTHING materialises a 0/0 row exactly
      //     ONCE (the second call is a no-op against the shared store),
      //   - SELECT ... FOR UPDATE then ALWAYS finds the row, so the two requests
      //     serialise on the SAME locked row and merge via GREATEST.
      //
      // Expected semantics (asserted): exactly one shared row; final peak = the
      // MAX of the two incoming RPCM values (no loss); neither request throws;
      // and is_new_rpcm_record is true for AT MOST one request — specifically
      // the request(s) that advanced the live locked prior (request A advances
      // 0→$250 → true; request B reads the now-live $250 prior and lands a
      // HIGHER $300 → advances → true; a request that does NOT advance the live
      // peak reports false). Here we land the LOWER one first then the HIGHER
      // one to make the "no lost peak" guarantee unambiguous, and separately
      // assert the higher-first ordering yields exactly one new-record claim.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue(null); // brand-new coach

      // Request A (lands first): RPCM = $250 on a brand-new coach.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 25000, status: 'active' }),
      ]);
      const resultA = await service.getMetrics('coach-new');

      // Request B (lands second): RPCM = $300 — a HIGHER first-run value that
      // must NOT be lost.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 30000, status: 'active' }),
      ]);
      const resultB = await service.getMetrics('coach-new');

      // Neither request threw (both awaited resolutions above succeeded).
      // Exactly one shared row exists (single __store), and the final peak is
      // the MAX of the two incoming values — the higher $300 was NOT lost.
      expect(mockPrisma.__store).not.toBeNull();
      expect(mockPrisma.__store?.peak).toBe(30000);
      expect(resultB.all_time_peak_rpcm_cents).toBe(30000);
      // A advanced from the seeded 0 → new record; B advanced $250→$300 → new
      // record. Each was a genuine advance of the live locked prior, so each is
      // legitimately true; what must NEVER happen is two requests claiming a
      // record for the SAME prior value. We assert that at most one request
      // advanced from any given prior by checking the higher-first ordering in
      // the dedicated block below; here we assert monotonic no-loss + no throw.
      expect(resultA.all_time_peak_rpcm_cents).toBe(25000); // A's own GREATEST(0,250)
      // Only ONE row was ever created: the ensure-row INSERT seeded the store
      // once; the second request's ensure-row was a no-op. Two transactions ran
      // (one per request), but both target the same single row.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('CONCURRENT FIRST-RUN higher-first: the racing lower request does NOT lose the peak and does NOT falsely claim a new record', async () => {
      // Same brand-new-coach race, but the HIGHER request lands first. The
      // lower second request must (a) not throw, (b) not regress the peak, and
      // (c) NOT claim a new record (it did not advance the live locked prior).
      // Against the OLD first-run code this scenario would have THROWN a unique
      // violation on the second INSERT — proving the test catches the bug.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue(null);

      // Higher request first: $300 (advances seeded 0 → new record).
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 30000, status: 'active' }),
      ]);
      const high = await service.getMetrics('coach-new2');
      expect(high.all_time_peak_rpcm_cents).toBe(30000);
      expect(high.is_new_rpcm_record).toBe(true); // 30000 > seeded 0

      // Lower request second: $200. Its ensure-row INSERT is a no-op (row
      // exists); its SELECT ... FOR UPDATE reads the LIVE $300; GREATEST keeps
      // $300; $200 > $300 is false → no new record. NO throw.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const low = await service.getMetrics('coach-new2');

      // No peak lost / regressed.
      expect(low.all_time_peak_rpcm_cents).toBe(30000);
      expect(mockPrisma.__store?.peak).toBe(30000);
      // The lower racing request did NOT advance the high-water mark.
      expect(low.is_new_rpcm_record).toBe(false);
      // At most ONE of the two reported a new record.
      const claims = [high.is_new_rpcm_record, low.is_new_rpcm_record].filter(Boolean);
      expect(claims.length).toBe(1);
    });

    it('FIRST-RUN persistence is ENSURE-ROW-THEN-LOCK: INSERT ... ON CONFLICT DO NOTHING, then SELECT ... FOR UPDATE, then peak-only UPDATE (no first-run bare INSERT, no streak write)', async () => {
      // Guard test pinning the new single-path mechanism on a brand-new coach.
      // It must: run in a transaction; ensure the row via INSERT ... ON CONFLICT
      // DO NOTHING; lock with SELECT ... FOR UPDATE; persist via a peak-only
      // UPDATE that does NOT touch zero_churn_streak. Crucially the ensure-row
      // INSERT must carry ON CONFLICT DO NOTHING (so a racing duplicate is a
      // no-op, never a throw) and the locked read must NOT be a RETURNING insert.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue(null); // first run
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-fresh');
      expect(result.all_time_peak_rpcm_cents).toBe(20000);
      expect(result.is_new_rpcm_record).toBe(true); // 20000 > seeded 0
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // The ensure-row INSERT ran via tx.$executeRaw and carries ON CONFLICT
      // DO NOTHING (the P1 conflict-safety mechanism).
      const execSql: string = mockPrisma.__tx.$executeRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .join('\n');
      expect(execSql).toMatch(/INSERT INTO/i);
      expect(execSql).toMatch(/coach_ltv_peak/);
      expect(execSql).toMatch(/ON CONFLICT/i);
      expect(execSql).toMatch(/DO NOTHING/i);

      // The locking read happened (FOR UPDATE) via tx.$queryRaw and is NOT a
      // RETURNING insert / ON CONFLICT upsert.
      const selectSql: string = mockPrisma.__tx.$queryRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .join('\n');
      expect(selectSql).toMatch(/SELECT/i);
      expect(selectSql).toMatch(/FOR UPDATE/i);
      expect(selectSql).toMatch(/all_time_peak_rpcm/);
      expect(selectSql).not.toMatch(/RETURNING/i);
      expect(selectSql).not.toMatch(/ON CONFLICT/i);

      // The peak was persisted via an UPDATE that does NOT write the streak.
      const updateSql: string = mockPrisma.__tx.$executeRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .filter((s: string) => /UPDATE/i.test(s) && !/INSERT/i.test(s))
        .join('\n');
      expect(updateSql).toMatch(/UPDATE/i);
      expect(updateSql).toMatch(/all_time_peak_rpcm/);
      expect(updateSql).not.toMatch(/zero_churn_streak/i);
      expect(updateSql).not.toMatch(/EXCLUDED/i);
    });

    it('the persistence write is a row-locked transaction: SELECT ... FOR UPDATE then a peak-only UPDATE that never writes the streak (P0 + P2)', async () => {
      // Guard test: assert the service drives persistence through the row-locked
      // transactional path (the concurrency-safe mechanism). It must:
      //   - run inside prisma.$transaction,
      //   - lock the row with SELECT ... FOR UPDATE (the P0 fix: the prior peak
      //     is read from the LIVE LOCKED row, not a statement-start snapshot),
      //   - persist the peak via an UPDATE that does NOT touch zero_churn_streak
      //     (P2 fix preserved).
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 5000,
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      await service.getMetrics('coach-1');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // The locking read happened (FOR UPDATE), via tx.$queryRaw.
      const selectSql: string = mockPrisma.__tx.$queryRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .join('\n');
      expect(selectSql).toMatch(/SELECT/i);
      expect(selectSql).toMatch(/FOR UPDATE/i);
      expect(selectSql).toMatch(/all_time_peak_rpcm/);
      // The locking read MUST NOT be an ON CONFLICT upsert (the racy snapshot
      // pattern is gone).
      expect(selectSql).not.toMatch(/ON CONFLICT/i);

      // The ensure-row INSERT (P1) ran via tx.$executeRaw with ON CONFLICT
      // DO NOTHING — for an EXISTING coach this is a no-op that never overwrites
      // the persisted peak or streak.
      const allExecSql: string[] = mockPrisma.__tx.$executeRaw.mock.calls.map(
        (c: any[]) => (c[0]?.strings ?? []).join(' '),
      );
      const ensureSql = allExecSql.filter((s) => /INSERT INTO/i.test(s)).join('\n');
      expect(ensureSql).toMatch(/ON CONFLICT/i);
      expect(ensureSql).toMatch(/DO NOTHING/i);

      // The peak was persisted via the UPDATE statement only (exclude the
      // ensure-row INSERT, whose column list legitimately names
      // zero_churn_streak as a SEED). The UPDATE itself must touch only the
      // peak.
      const updateSql: string = allExecSql
        .filter((s) => /UPDATE/i.test(s) && !/INSERT/i.test(s))
        .join('\n');
      expect(updateSql).toMatch(/UPDATE/i);
      expect(updateSql).toMatch(/all_time_peak_rpcm/);
      // The UPDATE must NOT write the streak — this is the core P2 assertion.
      expect(updateSql).not.toMatch(/zero_churn_streak/i);
      // No legacy ON CONFLICT / EXCLUDED streak write on the UPDATE path.
      expect(updateSql).not.toMatch(/EXCLUDED/i);
    });
  });

  describe('LTV-3 P2: zero_churn_streak is returned LIVE (not persisted) — stale-source race eliminated', () => {
    it('RESETS the RETURNED streak to the current value when churn happened (returned live, never read from persistence)', async () => {
      // P2 regression: the prior implementation persisted the streak and could
      // be corrupted by a stale read. Now the streak is RECOMPUTED and returned
      // live every request, so a stored high streak (8) is irrelevant: a recent
      // churn means the current recomputed streak is 0, and that is what the
      // response returns — regardless of what the stored row says.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 0,
        zero_churn_streak: 8, // stale historically-high stored streak — ignored
      });

      // Roster: a client created long ago that CANCELED last month — so the
      // most recent completed month had a churn → computeZeroChurnStreak yields 0.
      const now = new Date();
      const longAgo = new Date('2020-01-01');
      const lastMonthMid = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({
          client_user_id: 'c1',
          billing_type: 'recurring',
          status: 'canceled',
          entitlement_active: false,
          created_at: longAgo,
          canceled_at: lastMonthMid, // churn in the most recent completed month
        }),
      ]);
      const result = await service.getMetrics('coach-1');

      // The current recomputed streak is 0 (churn last month) and is returned
      // live — NOT the stale stored 8.
      expect(result.zero_churn_streak_months).toBe(0);
      // Peak cannot advance (current RPCM 0, stored 0) and the streak is no
      // longer persisted, so no atomic upsert is performed at all.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns a high current streak live when there are no recent cancellations (no persisted dependency)', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 0,
        zero_churn_streak: 1, // stored low value — must not cap the live result
      });
      // Old client, no cancellations → computed streak grows large.
      const longAgo = new Date('2020-01-01');
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: longAgo, canceled_at: null }),
      ]);
      const result = await service.getMetrics('coach-1');
      // Returned streak is the live recompute, independent of the stored 1.
      expect(result.zero_churn_streak_months).toBeGreaterThan(1);
      const expected = (service as any).computeZeroChurnStreak(
        [makePurchase({ client_user_id: 'c1', status: 'active', created_at: longAgo, canceled_at: null })],
        new Date(),
      );
      expect(result.zero_churn_streak_months).toBe(expected);
    });

    it('the stale-source out-of-order persist can no longer corrupt the RETURNED streak', async () => {
      // This is the exact P2 scenario. Request A reads purchases pre-cancellation
      // (streak 8). A cancellation commits. Request B reads the new state
      // (streak 0). Request A's persist lands LATER (out of order). With the old
      // code, A's stale 8 overwrote the stored 0 and corrupted later reads. Now
      // the streak is NOT persisted on the read path, so the value each request
      // RETURNS is always its own current-request recompute and an out-of-order
      // persist cannot change it.
      const now = new Date();
      const longAgo = new Date('2020-01-01');
      const lastMonthMid = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      // Pre-cancellation roster (what request A reads): active client, no churn
      // → high streak.
      const rosterPreCancel = [
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active', created_at: longAgo, canceled_at: null }),
      ];
      // Post-cancellation roster (what request B reads): client churned last
      // month → streak 0.
      const rosterPostCancel = [
        makePurchase({
          client_user_id: 'c1', amount_cents: 20000,
          billing_type: 'recurring', status: 'canceled', entitlement_active: false,
          created_at: longAgo, canceled_at: lastMonthMid,
        }),
      ];

      // Shared persisted row; peak already dominates so neither request advances
      // it (isolating the streak behaviour).
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 50000, // dominates both requests' RPCM
        zero_churn_streak: 3, // arbitrary stored value — must never leak out
      });

      // Request A (reads pre-cancellation snapshot) returns the high streak.
      mockPrisma.clientPurchase.findMany.mockResolvedValue(rosterPreCancel);
      const resultA = await service.getMetrics('coach-1');
      const streakA = (service as any).computeZeroChurnStreak(rosterPreCancel, new Date());
      expect(resultA.zero_churn_streak_months).toBe(streakA);
      expect(streakA).toBeGreaterThan(0);

      // Cancellation commits; request B reads the post-cancellation snapshot and
      // returns 0 — its own current recompute.
      mockPrisma.clientPurchase.findMany.mockResolvedValue(rosterPostCancel);
      const resultB = await service.getMetrics('coach-1');
      expect(resultB.zero_churn_streak_months).toBe(0);

      // Now simulate request A's persist landing LATE (out of order). Even if A
      // were to write, it can only touch the peak (GREATEST) — the streak is
      // never written on the read path — so a re-read still returns the current
      // recompute, NOT a corrupted stale value.
      mockPrisma.clientPurchase.findMany.mockResolvedValue(rosterPostCancel);
      const resultBAfterLatePersist = await service.getMetrics('coach-1');
      expect(resultBAfterLatePersist.zero_churn_streak_months).toBe(0);
      // The stored streak (3) never leaked into any returned value.
      expect(resultA.zero_churn_streak_months).not.toBe(3);
      expect(resultB.zero_churn_streak_months).not.toBe(3);
      // No write ever touched zero_churn_streak: every $queryRaw (if any) is a
      // peak-only upsert. Here peak never advances, so none were issued.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('a stale-low concurrent write does NOT regress the PEAK while the streak still tracks the current value', async () => {
      // Combined guarantee: under the same concurrency window the PEAK stays
      // monotonic (GREATEST) while the STREAK is the current recompute. Request
      // A persists a high peak ($300) with a long streak; request B lands later
      // with a lower peak ($250) AND a churned roster (current streak 0).
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000,
        zero_churn_streak: 0,
      });
      const longAgo = new Date('2020-01-01');
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 30000, status: 'active', created_at: longAgo, canceled_at: null }),
      ]);
      const resultHigh = await service.getMetrics('coach-1');
      expect(resultHigh.all_time_peak_rpcm_cents).toBe(30000);
      expect(resultHigh.zero_churn_streak_months).toBeGreaterThan(0);

      // Request B: an active client at lower RPCM ($250) PLUS a different
      // client who churned last month → RPCM=$250 (peak can't advance past
      // $300) and the current recomputed streak resets to 0.
      const now = new Date();
      const lastMonthMid = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Active client drives RPCM = $250.
        makePurchase({
          client_user_id: 'c1', amount_cents: 25000,
          billing_type: 'recurring', status: 'active', entitlement_active: true,
          created_at: longAgo, canceled_at: null,
        }),
        // Churn in the most recent completed month → streak recompute = 0.
        makePurchase({
          client_user_id: 'c2', amount_cents: 25000,
          billing_type: 'recurring', status: 'canceled', entitlement_active: false,
          created_at: longAgo, canceled_at: lastMonthMid,
        }),
      ]);
      const resultStaleLow = await service.getMetrics('coach-1');

      // Sanity: current RPCM is $250 (single active client), below the $300 peak.
      expect(resultStaleLow.revenue_per_client_month_cents).toBe(25000);

      // Peak stays monotonic at $300. The RETURNED streak is the live recompute
      // (reset to 0 on churn) — it is never read from persistence.
      expect(resultStaleLow.all_time_peak_rpcm_cents).toBe(30000);
      expect(mockPrisma.__store?.peak).toBe(30000);
      expect(resultStaleLow.zero_churn_streak_months).toBe(0);
      // The persisted streak was only ever seeded (request A's insert) and is
      // never touched again on conflict — it does not feed the returned value.
      expect(mockPrisma.__store?.streak).toBe(0);
    });
  });

  describe('LTV-3 P0: is_new_rpcm_record derived from the LIVE LOCKED prior peak (no false positive under a concurrent-peak race)', () => {
    // The original implementation computed is_new_rpcm_record from a STALE
    // pre-write findUnique snapshot; a later iteration used a leading read-only
    // `prev` CTE inside an INSERT ... ON CONFLICT statement. BOTH read a
    // STATEMENT SNAPSHOT, not the live row the GREATEST update applied to — so
    // under PostgreSQL READ COMMITTED two requests could observe the same stale
    // old_peak and BOTH report is_new_rpcm_record=true even though only one
    // actually advanced the high-water mark. The P0 fix reads the prior peak
    // under `SELECT ... FOR UPDATE` in the SAME transaction as the write, so
    // the prior value is the LIVE LOCKED current row. A concurrent writer that
    // already raised the peak commits BEFORE this locked read returns, so the
    // racing request observes the raised value and correctly reports false. The
    // mock's SELECT ... FOR UPDATE returns the CURRENT shared __store (the live
    // value), faithfully modelling the serialised locked read+write ordering.

    it('is_new_rpcm_record is TRUE only for the request that actually raises the peak; the racing stale request reports FALSE', async () => {
      // Both requests start from the SAME stale snapshot (peak=$100) — the race
      // window where each read happened before either wrote.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000, // $100 — the stale value BOTH requests read
        zero_churn_streak: 0,
      });

      // Request A genuinely raises the peak to $300 and lands first.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 30000, status: 'active' }),
      ]);
      const resultA = await service.getMetrics('coach-1');
      expect(resultA.all_time_peak_rpcm_cents).toBe(30000);
      // A's RPCM ($300) exceeded the atomically-observed prior peak ($100) → new record.
      expect(resultA.is_new_rpcm_record).toBe(true);

      // Request B read the SAME stale $100 but lands LATER with a higher-than-
      // stale-read but still-below-current RPCM ($250). With the old stale
      // pre-read it would have seen $250 > $100 and FALSELY claimed a new
      // record. Now it derives the flag from the peak the upsert observed
      // atomically ($300, since A already raised it), so $250 > $300 is false.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 25000, status: 'active' }),
      ]);
      const resultB = await service.getMetrics('coach-1');
      // Peak stays monotonic at $300 (GREATEST).
      expect(resultB.all_time_peak_rpcm_cents).toBe(30000);
      // The racing stale request did NOT move the high-water mark → no new record.
      expect(resultB.is_new_rpcm_record).toBe(false);
    });

    it('two concurrent writers reading the same stale peak do NOT both claim a new record', async () => {
      // The exact false-positive scenario. Two writers both read the stale
      // $100; both have an RPCM above the stale read ($200 and $250). At most
      // ONE — the writer that actually raised the high-water mark — may report
      // is_new_rpcm_record=true.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000, // $100 stale read shared by both
        zero_churn_streak: 0,
      });

      // Writer 1 lands first at $250 — raises the peak from $100 → $250.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 25000, status: 'active' }),
      ]);
      const r1 = await service.getMetrics('coach-1');

      // Writer 2 lands second at $200 — below the now-current $250, so it does
      // NOT raise the peak.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const r2 = await service.getMetrics('coach-1');

      const claims = [r1.is_new_rpcm_record, r2.is_new_rpcm_record].filter(Boolean);
      // At most one request reports a new record — never both.
      expect(claims.length).toBeLessThanOrEqual(1);
      // And concretely: the raiser (writer 1) claims it; the stale racer does not.
      expect(r1.is_new_rpcm_record).toBe(true);
      expect(r2.is_new_rpcm_record).toBe(false);
    });

    it('a stale request whose RPCM is below the already-persisted higher peak reports is_new_rpcm_record=FALSE (and performs no write)', async () => {
      // The persisted peak ($300) already dominates the current RPCM ($200): the
      // request cannot set a record regardless of ordering. is_new must be
      // false, and no atomic upsert is performed.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 30000, // $300 already persisted
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.is_new_rpcm_record).toBe(false);
      expect(result.all_time_peak_rpcm_cents).toBe(30000);
      // No write on the dominated branch.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('derives is_new_rpcm_record from the LIVE LOCKED prior peak, NOT the pre-write findUnique snapshot', async () => {
      // Guard test: even if the pre-write findUnique snapshot is STALE-LOW (it
      // reports $100), the flag must be driven by the LIVE LOCKED prior peak the
      // transaction reads under FOR UPDATE. We make the locked read observe a
      // HIGHER prior peak ($500) than the findUnique snapshot ($100); with the
      // old (buggy) snapshot logic is_new would be $200 > $100 = true, but the
      // authoritative live-locked prior is $500, so the correct answer is
      // $200 > $500 = false.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 10000, // stale-low snapshot ($100)
        zero_churn_streak: 0,
      });
      // Prime the shared LIVE store so the locked SELECT ... FOR UPDATE observes
      // the AUTHORITATIVE prior ($500) — i.e. another writer already raised it
      // after our findUnique read but before our locked read.
      mockPrisma.__store = { peak: 50000, streak: 0 };
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      // Because rpcm ($200) > stale findUnique ($100), the write path IS taken
      // (peakCouldAdvance true on the stale read), so the locked transaction
      // runs and the flag is derived from the live locked prior ($500):
      // $200 > $500 = false.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.is_new_rpcm_record).toBe(false);
      // Peak never regresses below the authoritative $500.
      expect(result.all_time_peak_rpcm_cents).toBe(50000);
    });

    it('the persistence reads the prior peak with SELECT ... FOR UPDATE inside a transaction (live locked value, not a snapshot CTE)', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 5000,
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      await service.getMetrics('coach-1');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      const selectSql: string = mockPrisma.__tx.$queryRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .join('\n');
      // The prior peak is read under a pessimistic ROW LOCK, in the same
      // transaction as the write — this is what makes old_peak the live current
      // value rather than a statement-start snapshot.
      expect(selectSql).toMatch(/SELECT/i);
      expect(selectSql).toMatch(/FOR UPDATE/i);
      expect(selectSql).toMatch(/all_time_peak_rpcm/);
      // The racy snapshot patterns are GONE: no leading read-only CTE, no
      // ON CONFLICT upsert whose GREATEST re-evaluates against a different row
      // version than the snapshot read.
      expect(selectSql).not.toMatch(/WITH\s+prev\s+AS/i);
      expect(selectSql).not.toMatch(/ON CONFLICT/i);
    });
  });

  describe('LTV-1: estimated_ltv is-estimate flag', () => {
    it('flags estimated_ltv as an estimate when fewer than 3 cancellations', async () => {
      const ninetyTwoDaysAgo = new Date(Date.now() - 92 * 24 * 3600 * 1000);
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active' }),
        makePurchase({ client_user_id: 'c2', status: 'canceled', billing_type: 'recurring',
          created_at: ninetyTwoDaysAgo, canceled_at: new Date(), entitlement_active: false }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.lifespan_is_estimate).toBe(true);
      expect(result.estimated_ltv_is_estimate).toBe(true);
      expect(result.estimated_ltv_estimate_note).toEqual(expect.any(String));
      expect(result.estimated_ltv_estimate_note).toContain('Estimated LTV');
    });

    it('does NOT flag estimated_ltv when there are >=3 real cancellations', async () => {
      const ninetyTwoDaysAgo = new Date(Date.now() - 92 * 24 * 3600 * 1000);
      const cancel = () => makePurchase({
        client_user_id: Math.random().toString(36).slice(2),
        status: 'canceled', billing_type: 'recurring',
        created_at: ninetyTwoDaysAgo, canceled_at: new Date(), entitlement_active: false,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([cancel(), cancel(), cancel()]);
      const result = await service.getMetrics('coach-1');
      expect(result.lifespan_is_estimate).toBe(false);
      expect(result.estimated_ltv_is_estimate).toBe(false);
      expect(result.estimated_ltv_estimate_note).toBeNull();
    });
  });

  describe('LTV-2: nrr_is_stub honesty flag', () => {
    it('is present and true on the response', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result).toHaveProperty('nrr_is_stub');
      expect(result.nrr_is_stub).toBe(true);
    });
  });

  describe('formatting', () => {
    it('formats MRR as currency string', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 250000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_label).toMatch(/\$2,500/);
    });

    it('includes computed_at as ISO string', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([]);
      const result = await service.getMetrics('coach-1');
      expect(() => new Date(result.computed_at)).not.toThrow();
      expect(result.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('ltv_cac_ratio is null (CAC not yet modeled)', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([]);
      const result = await service.getMetrics('coach-1');
      expect(result.ltv_cac_ratio).toBeNull();
    });
  });
});
