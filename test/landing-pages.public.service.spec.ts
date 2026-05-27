/**
 * Unit tests for LandingPagePublicService.
 *
 * Covers:
 * - SSR happy paths (published page)
 * - 404 cases (not found, draft, archived)
 * - Status filtering (only published renders)
 * - Lead submission
 * - View recording
 * - Checkout URL resolution
 */

import { LandingPagePublicService } from '../src/landing-pages/landing-pages.public.service';
import { renderNotFound } from '../src/landing-pages/landing-pages.html';

// ─── Minimal page fixture ─────────────────────────────────────────────────────

function makePublishedPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    coach_id: 'coach-1',
    slug: 'my-page',
    template: 'transformation',
    status: 'published',
    headline: 'Transform Your Life',
    subheadline: 'Work with the best',
    hero_image_url: 'https://example.com/hero.jpg',
    accent_color: '#4A90D9',
    primary_cta_type: 'checkout',
    primary_cta_label: 'Get Started',
    package_ids: ['pkg-1'],
    lead_capture_fields: ['name', 'email'],
    crm_integration_id: null,
    custom_domain: null,
    custom_domain_verified_at: null,
    published_at: new Date(),
    unpublished_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    sections: [
      {
        id: 'sec-1',
        page_id: 'page-1',
        kind: 'hero',
        order_index: 0,
        payload: {
          headline: 'Transform Your Life',
          hero_image_url: 'https://example.com/hero.jpg',
        },
      },
    ],
    coach: {
      id: 'coach-1',
      name: 'Jane Smith',
      coach_practice_type: 'fitness',
      coach_profile: {
        business_name: 'Jane Fitness Co',
        bio: 'Expert coach',
        branding_accent_color: '#4A90D9',
        branding_logo_url: null,
        invite_code: 'GP-JANE1',
      },
    },
    ...overrides,
  };
}

// ─── Stub LandingPageService ──────────────────────────────────────────────────

function makeStubLandingService(page: any | null = null) {
  return {
    findPublishedBySlug: jest.fn().mockResolvedValue(page),
    findPublishedPackages: jest.fn().mockResolvedValue(
      page?.package_ids?.length
        ? [
            {
              id: 'pkg-1',
              coach_id: 'coach-1',
              name: '12-Week Transform',
              amount_cents: 99900,
              billing_type: 'one_time',
              interval: null,
              description: 'Full program',
              is_active: true,
              share_token: 'tok_abc123def456ghi78',
            },
          ]
        : [],
    ),
  };
}

// ─── Stub Prisma ──────────────────────────────────────────────────────────────

function makeStubPrisma(shareToken: string | null = 'tok_abc123def456ghi78') {
  const leads: any[] = [];
  const views: any[] = [];
  return {
    _leads: leads,
    _views: views,
    coachPackage: {
      findFirst: jest.fn().mockResolvedValue(
        shareToken ? { id: 'pkg-1', share_token: shareToken } : null,
      ),
    },
    coachLandingLead: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `lead-${leads.length + 1}`, ...data, created_at: new Date() };
        leads.push(row);
        return row;
      }),
    },
    coachLandingPageView: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `view-${views.length + 1}`, ...data, created_at: new Date() };
        views.push(row);
        return row;
      }),
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePublicSvc(page: any | null, shareToken: string | null = 'tok_abc123def456ghi78') {
  const landingService = makeStubLandingService(page);
  const prisma = makeStubPrisma(shareToken);
  // R47: public service depends on LeadSyncQueue + LeadRateLimiterService.
  const leadSyncQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const rateLimiter = {
    checkAndIncrement: jest.fn().mockResolvedValue({
      allowed: true,
      count: 1,
      retryAfterSeconds: 86400,
    }),
  };
  const svc = new LandingPagePublicService(
    prisma as any,
    landingService as any,
    leadSyncQueue as any,
    rateLimiter as any,
  );
  return { svc, landingService, prisma, leadSyncQueue, rateLimiter };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LandingPagePublicService', () => {
  describe('renderPage', () => {
    it('renders HTML for a published page', async () => {
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page);

      const { html, found } = await svc.renderPage('GP-JANE1', 'my-page');

      expect(found).toBe(true);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('Transform Your Life');
      expect(html).toContain('Jane Fitness Co');
      // meta robots should be index,follow for published pages
      expect(html).toContain('index,follow');
      // Open Graph tags
      expect(html).toContain('og:title');
      // Schema.org JSON-LD
      expect(html).toContain('application/ld+json');
      expect(html).toContain('Person');
    });

    it('returns not-found HTML when page does not exist', async () => {
      const { svc } = makePublicSvc(null);
      const { html, found } = await svc.renderPage('ghost', 'nope');
      expect(found).toBe(false);
      expect(html).toContain('available');
    });

    it('returns not-found for draft page', async () => {
      const page = makePublishedPage({ status: 'draft' });
      const { svc } = makePublicSvc(page);
      const { found } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(found).toBe(false);
    });

    it('returns not-found for archived page', async () => {
      const page = makePublishedPage({ status: 'archived' });
      const { svc } = makePublicSvc(page);
      const { found } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(found).toBe(false);
    });

    it('includes pricing section with packages when present', async () => {
      const page = makePublishedPage({
        sections: [
          {
            id: 'sec-2',
            page_id: 'page-1',
            kind: 'pricing',
            order_index: 1,
            payload: { package_ids: ['pkg-1'] },
          },
        ],
      });
      const { svc } = makePublicSvc(page);
      const { html } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(html).toContain('12-Week Transform');
      expect(html).toContain('$999');
    });

    it('includes Cache-Control header meta via service result', async () => {
      // renderPage itself doesn't set headers — the controller does.
      // This test verifies the returned html is valid for the cache policy.
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page);
      const { found, html } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(found).toBe(true);
      expect(html.length).toBeGreaterThan(500);
    });

    it('renders testimonials section', async () => {
      const page = makePublishedPage({
        sections: [
          {
            id: 'sec-t',
            page_id: 'page-1',
            kind: 'testimonials',
            order_index: 0,
            payload: {
              items: [
                { name: 'Alice', quote: 'Changed my life', result_metric: '-32 lbs in 6 months' },
              ],
            },
          },
        ],
      });
      const { svc } = makePublicSvc(page);
      const { html } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(html).toContain('Alice');
      expect(html).toContain('-32 lbs in 6 months');
    });

    it('renders FAQ with accordion markup', async () => {
      const page = makePublishedPage({
        sections: [
          {
            id: 'sec-faq',
            page_id: 'page-1',
            kind: 'faq',
            order_index: 0,
            payload: {
              items: [{ question: 'How does it work?', answer: 'Simple.' }],
            },
          },
        ],
      });
      const { svc } = makePublicSvc(page);
      const { html } = await svc.renderPage('GP-JANE1', 'my-page');
      expect(html).toContain('<details');
      expect(html).toContain('How does it work?');
    });
  });

  describe('resolveCheckoutUrl', () => {
    it('returns storefront URL for valid tier', async () => {
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page, 'tok_abc123def456ghi78');

      const url = await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-1');
      expect(url).toContain('packages/public/join/tok_abc123def456ghi78');
    });

    it('returns null when tier is not in page.package_ids', async () => {
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page);
      const url = await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-foreign');
      expect(url).toBeNull();
    });

    it('returns null when page is not published', async () => {
      const page = makePublishedPage({ status: 'draft' });
      const { svc } = makePublicSvc(page);
      const url = await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-1');
      expect(url).toBeNull();
    });

    it('returns null when package has no share_token', async () => {
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page, null);
      const url = await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-1');
      expect(url).toBeNull();
    });

    // Audit #6 P0-5 — landing page id propagation via ?lp= query param.
    it('appends ?lp=<pageId> so storefront can credit the source page', async () => {
      const page = makePublishedPage();
      const { svc } = makePublicSvc(page, 'tok_abc123def456ghi78');
      const url = await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-1');
      expect(url).toMatch(/[?&]lp=/);
      expect(url).toContain(`lp=${encodeURIComponent(page.id)}`);
    });
  });

  describe('submitLead', () => {
    it('creates a lead with crm_sync_status=pending', async () => {
      const page = makePublishedPage();
      const { svc, prisma } = makePublicSvc(page);

      const result = await svc.submitLead('GP-JANE1', 'my-page', {
        email: 'test@example.com',
        name: 'Test User',
      });

      expect(result.ok).toBe(true);
      expect(prisma._leads).toHaveLength(1);
      expect(prisma._leads[0].crm_sync_status).toBe('pending');
      expect(prisma._leads[0].email).toBe('test@example.com');
    });

    it('returns ok:false silently for non-published page', async () => {
      const { svc, prisma } = makePublicSvc(null);
      const result = await svc.submitLead('ghost', 'nope', { email: 'x@x.com' });
      expect(result.ok).toBe(false);
      expect(prisma._leads).toHaveLength(0);
    });

    it('R47: hands off the new lead id to the sync queue', async () => {
      const page = makePublishedPage();
      const { svc, prisma, leadSyncQueue } = makePublicSvc(page);
      await svc.submitLead('GP-JANE1', 'my-page', { email: 'a@b.com' });
      expect(leadSyncQueue.enqueue).toHaveBeenCalledWith(prisma._leads[0].id);
    });

    it('R47: returns 429 when rate-limit denies the request', async () => {
      const page = makePublishedPage();
      const { svc, prisma, rateLimiter } = makePublicSvc(page);
      rateLimiter.checkAndIncrement.mockResolvedValueOnce({
        allowed: false,
        count: 101,
        retryAfterSeconds: 1234,
      });
      await expect(
        svc.submitLead('GP-JANE1', 'my-page', { email: 'a@b.com' }),
      ).rejects.toMatchObject({ status: 429 });
      expect(prisma._leads).toHaveLength(0);
    });

    it('R47: queue enqueue failure does NOT fail the visitor POST', async () => {
      const page = makePublishedPage();
      const { svc, prisma, leadSyncQueue } = makePublicSvc(page);
      leadSyncQueue.enqueue.mockRejectedValueOnce(new Error('redis down'));
      const result = await svc.submitLead('GP-JANE1', 'my-page', {
        email: 'a@b.com',
      });
      expect(result.ok).toBe(true);
      expect(prisma._leads).toHaveLength(1);
    });
  });

  describe('recordView', () => {
    it('hashes IP and UA before storing', async () => {
      const page = makePublishedPage();
      const { svc, prisma } = makePublicSvc(page);

      await svc.recordView(
        'GP-JANE1',
        'my-page',
        { scroll_depth: 75, cta_clicked: true, form_submitted: false },
        '1.2.3.4',
        'Mozilla/5.0 Test',
        'https://instagram.com',
      );

      // Give async write a tick
      await new Promise((r) => setTimeout(r, 10));

      // ip_hash and ua_hash should be hex strings (SHA-256), never raw values
      const view = prisma._views[0];
      expect(view).toBeDefined();
      expect(view.ip_hash).not.toBe('1.2.3.4');
      expect(view.ua_hash).not.toBe('Mozilla/5.0 Test');
      expect(view.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(view.scroll_depth).toBe(75);
      expect(view.cta_clicked).toBe(true);
      expect(view.referrer_host).toBe('instagram.com');
    });

    it('does not throw when page not found', async () => {
      const { svc } = makePublicSvc(null);
      await expect(
        svc.recordView('ghost', 'nope', {}, '1.2.3.4', 'UA', undefined),
      ).resolves.not.toThrow();
    });
  });
});

// ─── renderNotFound standalone ────────────────────────────────────────────────

describe('renderNotFound', () => {
  it('returns dark-mode SaaS-brand HTML', () => {
    const html = renderNotFound();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('noindex,nofollow');
    // v2 uses a typographic apostrophe in the headline (&rsquo;).
    expect(html).toMatch(/isn[&'’']/);
    // v2 dark-mode tokens — the SaaS palette replaced the cream brand.
    expect(html).toContain('#0b0b0c');
  });
});
