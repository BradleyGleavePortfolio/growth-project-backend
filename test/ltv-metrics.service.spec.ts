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

// Persistence is a single atomic `INSERT ... ON CONFLICT DO UPDATE` executed
// through Prisma's `$queryRaw`. The two columns use DIFFERENT DB-side
// semantics, which the mock faithfully simulates:
//   - all_time_peak_rpcm  → GREATEST(persisted, incoming) — monotonic
//     high-water mark; the P1 race fix relies on this never regressing.
//   - zero_churn_streak    → EXCLUDED (incoming written as-is) — the current
//     recomputed value, which MUST be able to RESET/drop on churn (P2 fix).
// The mock:
//   - reads the "persisted" row from the same source the service reads
//     (coachLtvPeak.findUnique's resolved value) to model the pre-write state,
//   - applies GREATEST for the peak and last-write-wins for the streak,
//   - records each call's incoming values for assertions, and
//   - returns the post-write values (the RETURNING clause).
// `__rawCalls` captures the incoming (peak, streak) of every atomic upsert.
const mockPrisma: any = {
  clientPurchase: {
    findMany: jest.fn(),
  },
  // LTV-3: persisted peak/streak store (coach_ltv_peak).
  coachLtvPeak: {
    findUnique: jest.fn(),
  },
  __rawCalls: [] as Array<{ peak: number; streak: number }>,
  // Simulated persisted store, keyed by the GREATEST semantics. Seeded from
  // findUnique so a test that stubs an existing row also primes this state.
  __store: null as null | { peak: number; streak: number },
  $queryRaw: jest.fn(),
};

// Extract the bound parameter values out of a Prisma.sql tagged-template object.
// Prisma.sql exposes `.values` (the interpolated params, in order). Our query
// binds: [coach_id, incomingPeakCents, incomingStreak].
function parseRawValues(sql: any): { peak: number; streak: number } {
  const values: any[] = sql?.values ?? [];
  // values[0] = coach_id, values[1] = peak cents, values[2] = streak
  return { peak: Number(values[1]), streak: Number(values[2]) };
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

    // Simulate the atomic GREATEST upsert. The "persisted" baseline is taken
    // from whatever findUnique was stubbed to return for this test (the
    // pre-write row), then GREATEST is applied per column. The result is the
    // post-write state (mirrors the RETURNING clause).
    mockPrisma.$queryRaw.mockImplementation(async (sql: any) => {
      const incoming = parseRawValues(sql);
      mockPrisma.__rawCalls.push(incoming);
      const existing = mockPrisma.coachLtvPeak.findUnique.mock.results.length
        ? await mockPrisma.coachLtvPeak.findUnique.mock.results[
            mockPrisma.coachLtvPeak.findUnique.mock.results.length - 1
          ].value
        : null;
      const baseline = mockPrisma.__store ?? {
        peak: existing ? Number(existing.all_time_peak_rpcm) : 0,
        streak: existing ? Number(existing.zero_churn_streak) : 0,
      };
      const after = {
        // Peak: monotonic high-water mark (DB-side GREATEST).
        peak: Math.max(baseline.peak, incoming.peak),
        // Streak: current recomputed value written as-is (DB-side EXCLUDED).
        // Reset-capable — a lower incoming streak overwrites the stored value.
        streak: incoming.streak,
      };
      mockPrisma.__store = after;
      return [
        {
          all_time_peak_rpcm: after.peak,
          zero_churn_streak: after.streak,
        },
      ];
    });
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

    it('does NOT write when peak cannot advance AND the recomputed streak equals the stored streak', async () => {
      // The streak is now a reset-capable current value, so a write is skipped
      // only when the peak cannot advance AND the recomputed streak already
      // equals what is stored. Seed the stored streak to exactly the value the
      // recompute will produce for this roster so no write is needed.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      // First call (no persisted row) computes & persists the current streak.
      const first = await service.getMetrics('coach-1');
      const computedStreak = first.zero_churn_streak_months;

      // Now seed a persisted row whose streak already equals the recompute and
      // whose peak dominates the current RPCM — nothing to advance or change.
      jest.clearAllMocks();
      mockPrisma.__store = null;
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 30000, // $300 > current $200 → peak won't advance
        zero_churn_streak: computedStreak, // equals the recompute → no change
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.all_time_peak_rpcm_cents).toBe(30000);
      expect(result.zero_churn_streak_months).toBe(computedStreak);
      // Neither peak advanced nor streak changed → no atomic upsert performed.
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
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
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
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
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
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
      // max($100, $250)=$250 and clobbered A's $300. With the atomic GREATEST
      // upsert, the DB compares against the CURRENT stored $300, so the result
      // stays $300.
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 25000, status: 'active' }),
      ]);
      const resultStaleLow = await service.getMetrics('coach-1');

      // The persisted peak is NEVER regressed by the racing stale-low writer.
      expect(resultStaleLow.all_time_peak_rpcm_cents).toBe(30000);
      // And the simulated store confirms monotonicity end-to-end.
      expect(mockPrisma.__store?.peak).toBe(30000);
      // The lower writer still hands the DB its own (lower) candidate — the
      // monotonic guarantee is enforced by GREATEST, not by the app skipping it.
      const lastCall = mockPrisma.__rawCalls[mockPrisma.__rawCalls.length - 1];
      expect(lastCall.peak).toBe(25000);
    });

    it('the persistence write uses an atomic upsert: GREATEST for the peak, EXCLUDED (as-is) for the streak', async () => {
      // Guard test: assert the service drives persistence through the raw
      // atomic upsert path (the concurrency-safe mechanism). The peak column
      // must use GREATEST (monotonic); the streak column must write the
      // incoming value as-is (EXCLUDED) so it can reset — NOT GREATEST.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 5000,
        zero_churn_streak: 0,
      });
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, status: 'active' }),
      ]);
      await service.getMetrics('coach-1');
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sqlArg = mockPrisma.$queryRaw.mock.calls[0][0];
      const sqlText: string = (sqlArg?.strings ?? []).join(' ');
      // Single ON CONFLICT upsert touching both columns.
      expect(sqlText).toMatch(/ON CONFLICT/i);
      expect(sqlText).toMatch(/all_time_peak_rpcm/);
      expect(sqlText).toMatch(/zero_churn_streak/);
      // Peak is monotonic via GREATEST.
      expect(sqlText).toMatch(/GREATEST/i);
      // Streak is written as-is from EXCLUDED (reset-capable), and is NOT
      // wrapped in a GREATEST(... zero_churn_streak ...) expression.
      expect(sqlText).toMatch(/EXCLUDED/i);
      expect(sqlText).not.toMatch(/GREATEST\s*\([^)]*zero_churn_streak/i);
    });
  });

  describe('LTV-3 P2: zero_churn_streak stores the CURRENT recomputed value (reset-capable)', () => {
    it('RESETS the persisted/returned streak to the LOWER current value when churn happened (no GREATEST pin)', async () => {
      // P2 regression: the prior fix used GREATEST for the streak, which
      // permanently PINNED it to its old high — a legitimate reset (a client
      // churned) could never persist. Here a high streak (8) was previously
      // stored, but a recent churn means the CURRENT recomputed streak is 0.
      // The persisted/returned streak must drop to the current value, not stay
      // pinned at 8.
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 0,
        zero_churn_streak: 8, // historically high streak
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

      // The current recomputed streak is 0 (churn last month) and must be
      // written/returned as-is — GREATEST would have pinned it at 8.
      expect(result.zero_churn_streak_months).toBe(0);
      // The atomic upsert ran (streak changed from 8 → 0) and handed the DB the
      // current value, NOT a max against the stored 8.
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.__rawCalls[0].streak).toBe(0);
      // The simulated store reflects the reset (last-write-wins, not GREATEST).
      expect(mockPrisma.__store?.streak).toBe(0);
    });

    it('persists the current streak when the recompute exceeds the stored value', async () => {
      mockPrisma.coachLtvPeak.findUnique.mockResolvedValue({
        coach_id: 'coach-1',
        all_time_peak_rpcm: 0,
        zero_churn_streak: 1,
      });
      // Old client, no cancellations → computed streak grows large.
      const longAgo = new Date('2020-01-01');
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: longAgo, canceled_at: null }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.zero_churn_streak_months).toBeGreaterThan(1);
      // Atomic upsert called to persist the current streak; the incoming streak
      // equals the recomputed value (written as-is via EXCLUDED).
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockPrisma.__rawCalls[0].streak).toBe(result.zero_churn_streak_months);
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

      // Peak stays monotonic at $300; streak reflects the current reset to 0.
      expect(resultStaleLow.all_time_peak_rpcm_cents).toBe(30000);
      expect(mockPrisma.__store?.peak).toBe(30000);
      expect(resultStaleLow.zero_churn_streak_months).toBe(0);
      expect(mockPrisma.__store?.streak).toBe(0);
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
