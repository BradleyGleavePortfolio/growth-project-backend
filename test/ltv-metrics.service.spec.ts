// test/ltv-metrics.service.spec.ts
//
// Unit tests for LtvMetricsService.
// Uses an in-memory mock of PrismaService — no real DB required.

import { Test, TestingModule } from '@nestjs/testing';
import { LtvMetricsService } from '../src/coach/command-center/ltv-metrics.service';
import { PrismaService } from '../src/prisma.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePurchase(overrides: Partial<{
  client_user_id: string;
  amount_cents: number;
  currency: string;
  billing_type: string;
  interval: string | null;
  interval_count: number | null;
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
    interval: overrides.interval ?? 'month',
    interval_count: overrides.interval_count ?? 1,
    status: overrides.status ?? 'active',
    entitlement_active: overrides.entitlement_active ?? true,
    created_at: overrides.created_at ?? new Date('2026-01-01'),
    canceled_at: overrides.canceled_at ?? null,
    current_period_end: overrides.current_period_end ?? null,
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
  };
}

// ─── Mock PrismaService ───────────────────────────────────────────────────────

const mockPrisma = {
  clientPurchase: {
    findMany: jest.fn(),
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LtvMetricsService', () => {
  let service: LtvMetricsService;

  beforeEach(async () => {
    jest.clearAllMocks();
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
    });
  });

  describe('mrr_cents', () => {
    it('sums recurring active purchases correctly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 20000, billing_type: 'recurring', interval: 'month', interval_count: 1, status: 'active' }),
        makePurchase({ client_user_id: 'c2', amount_cents: 15000, billing_type: 'recurring', interval: 'month', interval_count: 1, status: 'active' }),
        // One-time — excluded from MRR
        makePurchase({ client_user_id: 'c3', amount_cents: 50000, billing_type: 'one_time', status: 'paid', entitlement_active: true }),
      ]);
      const result = await service.getMetrics('coach-1');

      expect(result.mrr_cents).toBe(35000); // 200 + 150
      expect(result.active_client_count).toBe(3); // all 3 have entitlement
    });

    it('normalises yearly recurring to monthly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 240000, billing_type: 'recurring', interval: 'year', interval_count: 1, status: 'active' }),
      ]);
      const result = await service.getMetrics('coach-1');
      expect(result.mrr_cents).toBe(20000); // $2400/yr → $200/mo
    });

    it('normalises 3-month recurring correctly', async () => {
      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        makePurchase({ client_user_id: 'c1', amount_cents: 60000, billing_type: 'recurring', interval: 'month', interval_count: 3, status: 'active' }),
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
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const midMonth = new Date(now.getFullYear(), now.getMonth(), 10);
      const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);

      mockPrisma.clientPurchase.findMany.mockResolvedValue([
        // Active at start of month, still active
        makePurchase({ client_user_id: 'c1', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        makePurchase({ client_user_id: 'c2', status: 'active', created_at: twoMonthsAgo, canceled_at: null }),
        // Active at start of month, canceled mid-month
        makePurchase({ client_user_id: 'c3', status: 'canceled', entitlement_active: false, created_at: twoMonthsAgo, canceled_at: midMonth }),
      ]);
      const result = await service.getMetrics('coach-1');
      // 3 active at start, 1 canceled → 33.3%
      expect(result.churn_rate_pct).toBe(33.3);
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
