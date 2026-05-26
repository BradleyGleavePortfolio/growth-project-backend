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

describe('LandingPageService.getAnalytics — R47 revenue rollup', () => {
  it('computes dollars_per_visitor + conversion_rate from views + checkouts', async () => {
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
    expect(stats.unique_visitors).toBe(2);
    expect(stats.checkouts_completed).toBe(2);
    expect(stats.revenue_cents).toBe(69_800);
    // $698 / 2 unique = $349 per visitor.
    expect(stats.dollars_per_visitor).toBe(349);
    // 2 conversions / 2 unique = 1.0, rounded to 4dp.
    expect(stats.conversion_rate).toBe(1);
    expect(stats.period).toBe('last_30d');
  });

  it('returns dollars_per_visitor=null and conversion_rate=0 when no visitors', async () => {
    const prisma = makePrisma({ views: [], leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.unique_visitors).toBe(0);
    expect(stats.dollars_per_visitor).toBeNull();
    expect(stats.conversion_rate).toBe(0);
    expect(stats.revenue_cents).toBe(0);
  });

  it('rejects coach that does not own the page (NotFound)', async () => {
    const prisma = makePrisma({ views: [], leads: 0, checkouts: [] });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    await expect(svc.getAnalytics('coach-2', 'p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rounds dollars_per_visitor to 2 decimals', async () => {
    const views = [
      { ip_hash: 'a', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'b', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
      { ip_hash: 'c', scroll_depth: null, cta_clicked: false, form_submitted: false, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null },
    ];
    // $100 revenue / 3 unique visitors = $33.3333… → rounded to $33.33.
    const checkouts = [{ status: 'paid', package: { amount_cents: 10000 } }];
    const prisma = makePrisma({ views, leads: 0, checkouts });
    const svc = new LandingPageService(prisma as any, analyticsStub);
    const stats = await svc.getAnalytics('coach-1', 'p1');
    expect(stats.dollars_per_visitor).toBeCloseTo(33.33, 2);
  });
});
