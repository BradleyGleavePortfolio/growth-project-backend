/**
 * R47 $/visitor analytics tests.
 *
 * Builds a minimal LandingPageService against an in-memory Prisma stub
 * and asserts the new analytics rollup (revenue, unique visitors,
 * conversion rate, dollars-per-visitor).  Existing analytics shape
 * (cta_click_rate, top_referrers) is already covered by
 * landing-pages.service.spec.ts.
 */

import { LandingPageService } from '../src/landing-pages/landing-pages.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

function makePrisma(opts: {
  views: any[];
  leads: number;
  checkouts: any[];
}) {
  return {
    coachLandingPage: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id === 'p1' && where.coach_id === 'coach-1') {
          return { id: 'p1', coach_id: 'coach-1', slug: 'pg', headline: 'H' };
        }
        return null;
      }),
    },
    coachLandingPageView: {
      findMany: jest.fn().mockResolvedValue(opts.views),
    },
    coachLandingLead: {
      count: jest.fn().mockResolvedValue(opts.leads),
    },
    guestCheckout: {
      findMany: jest.fn().mockResolvedValue(opts.checkouts),
    },
  };
}

const analyticsStub = { capture: jest.fn() } as any;

describe('LandingPageService.getAnalytics — R47 gross-attempts rollup', () => {
  it('computes dollars_per_active_visitor_day + conversion_rate from views + checkouts', async () => {
    const views = [
      { ip_hash: 'h1', scroll_depth: 80, cta_clicked: true, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'h2', scroll_depth: 50, cta_clicked: false, form_submitted: true, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'h1', scroll_depth: 90, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
    ];
    const checkouts = [
      { status: 'paid',      package: { amount_cents: 19900 } }, // $199
      { status: 'converted', package: { amount_cents: 49900 } }, // $499
    ];
    const prisma = makePrisma({ views, leads: 5, checkouts });
    const svc = new LandingPageService(prisma as any, analyticsStub);

    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.total_views).toBe(3);
    // Audit #6 P1-4 — renamed from unique_visitors.
    expect(stats.active_visitor_days).toBe(2);
    expect(stats.checkouts_completed).toBe(2);
    // Audit #6 P1-3 — renamed from revenue_cents.
    expect(stats.gross_attempts_cents).toBe(69_800);
    // $698 / 2 distinct (visitor,day) pairs = $349.
    expect(stats.dollars_per_active_visitor_day).toBe(349);
    // 2 conversions / 2 distinct (visitor,day) = 1.0, rounded to 4dp.
    expect(stats.conversion_rate).toBe(1);
    expect(stats.period).toBe('last_30d');
  });

  it('returns dollars_per_active_visitor_day=null and conversion_rate=0 when no visitors', async () => {
    const prisma = makePrisma({ views: [], leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.active_visitor_days).toBe(0);
    expect(stats.dollars_per_active_visitor_day).toBeNull();
    expect(stats.conversion_rate).toBe(0);
    expect(stats.gross_attempts_cents).toBe(0);
  });

  it('rejects coach that does not own the page (NotFound)', async () => {
    const prisma = makePrisma({ views: [], leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    await expect(svc.getAnalytics('coach-2', 'p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rounds dollars_per_active_visitor_day to 2 decimals', async () => {
    const views = [
      { ip_hash: 'a', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'b', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'c', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
    ];
    // $100 gross-attempts / 3 distinct (visitor,day) pairs = $33.33….
    const checkouts = [{ status: 'paid', package: { amount_cents: 10000 } }];
    const prisma = makePrisma({ views, leads: 0, checkouts });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.dollars_per_active_visitor_day).toBeCloseTo(33.33, 2);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Audit #6 P1-3 — status allow-list excludes failure/pending states.
  // ────────────────────────────────────────────────────────────────────────
  it('P1-3: gross_attempts excludes non-paid/converted states by allow-list', async () => {
    // Service is responsible for issuing the right `where` clause; here we
    // assert that the prisma stub *receives* an allow-list filter and only
    // returns paid/converted rows in the rollup. We simulate that by
    // returning only paid/converted rows even though the test "database"
    // contains other states — then assert the where clause.
    const checkouts = [
      { status: 'paid',      package: { amount_cents: 10000 } },
      { status: 'converted', package: { amount_cents: 20000 } },
    ];
    const prisma = makePrisma({
      views: [{ ip_hash: 'h1', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null }],
      leads: 0,
      checkouts,
    });
    const svc = new LandingPageService(prisma as any, analyticsStub);

    const stats = await svc.getAnalytics('coach-1', 'p1');

    // Assert the prisma query enforced the allow-list, not a deny-list.
    const call = (prisma.guestCheckout.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['paid', 'converted'] });
    // refunded / disputed / failed / pending / conversion_failed_* must be
    // implicitly excluded — the filter is positive-list only.
    expect(call.where.status.notIn).toBeUndefined();

    expect(stats.gross_attempts_cents).toBe(30_000);
  });

  it('P1-3: legacy `revenue_cents` field is no longer present on the response', async () => {
    const prisma = makePrisma({ views: [], leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats: any = await svc.getAnalytics('coach-1', 'p1');
    // The field was misleading (list price, not net revenue) and is
    // replaced by `gross_attempts_cents`. Asserting absence guards
    // against accidental reintroduction.
    expect(stats.revenue_cents).toBeUndefined();
    expect(stats.dollars_per_visitor).toBeUndefined();
    expect(stats.unique_visitors).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Audit #6 P1-4 — active_visitor_days replaces unique_visitors.
  // ────────────────────────────────────────────────────────────────────────
  it('P1-4: active_visitor_days counts distinct ip_hash values (one per visitor-day)', async () => {
    // Simulates the same visitor returning across three days with
    // daily-salt-rotated hashes: three distinct ip_hash rows. The metric
    // now honestly reports 3 active visitor-days rather than pretending
    // the visitor is three different humans.
    const views = [
      { ip_hash: 'visitorA__day1', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'visitorA__day2', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'visitorA__day3', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
    ];
    const prisma = makePrisma({ views, leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.active_visitor_days).toBe(3);
    expect(stats.total_views).toBe(3);
  });
});
