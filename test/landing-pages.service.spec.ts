/**
 * Unit tests for LandingPageService.
 *
 * Covers:
 * - CRUD happy paths
 * - Page count cap (max 6 non-archived)
 * - Slug deduplication per-coach
 * - Banned-host validation (create + update)
 * - Package ownership validation
 * - CRM ownership validation (stub)
 * - Analytics + leads pagination
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LandingPageService } from '../src/landing-pages/landing-pages.service';

// ─── Prisma stub ─────────────────────────────────────────────────────────────

function makePrisma() {
  const pages: any[] = [];
  const sections: any[] = [];
  const leads: any[] = [];
  const views: any[] = [];
  const packages: any[] = [];
  const crm: any[] = [];
  const profiles: any[] = [];
  const users: any[] = [];

  return {
    _pages: pages,
    _sections: sections,
    _leads: leads,
    _views: views,
    _packages: packages,
    _crm: crm,
    _profiles: profiles,
    _users: users,

    coachProfile: {
      findFirst: jest.fn(async ({ where }: any) =>
        profiles.find((p: any) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ) ?? null,
      ),
    },

    user: {
      findMany: jest.fn(async () => users),
    },

    coachLandingPage: {
      count: jest.fn(async ({ where }: any) => {
        return pages.filter((p: any) => {
          if (where.coach_id && p.coach_id !== where.coach_id) return false;
          if (where.status?.not && p.status === where.status.not) return false;
          return true;
        }).length;
      }),
      findMany: jest.fn(async ({ where, include }: any) => {
        let result = pages.filter((p: any) => {
          if (where?.coach_id && p.coach_id !== where.coach_id) return false;
          return true;
        });
        if (include?._count) {
          result = result.map((p: any) => ({
            ...p,
            _count: {
              leads: leads.filter((l: any) => l.page_id === p.id).length,
              views: views.filter((v: any) => v.page_id === p.id).length,
            },
          }));
        }
        return result;
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const p = pages.find((page: any) => {
          if (where.id && page.id !== where.id) return false;
          if (where.coach_id && page.coach_id !== where.coach_id) return false;
          if (where.slug && page.slug !== where.slug) return false;
          if (where.status && page.status !== where.status) return false;
          // CNAME Phase 4: findPublishedByCustomDomain() filters.
          if (where.custom_domain !== undefined && page.custom_domain !== where.custom_domain) {
            return false;
          }
          if (where.custom_domain_verified_at?.not === null) {
            if (page.custom_domain_verified_at == null) return false;
          }
          return true;
        });
        if (!p) return null;
        if (include?.sections) {
          return {
            ...p,
            sections: sections.filter((s: any) => s.page_id === p.id),
            coach: include?.coach
              ? {
                  id: p.coach_id,
                  name: 'Test Coach',
                  coach_practice_type: null,
                  coach_profile: profiles.find((pr: any) => pr.coach_id === p.coach_id) ?? null,
                }
              : { id: p.coach_id, name: 'Test Coach', coach_practice_type: null, profile: null },
          };
        }
        return p;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `page-${pages.length + 1}`,
          status: 'draft',
          published_at: null,
          unpublished_at: null,
          hero_image_url: null,
          accent_color: null,
          subheadline: null,
          package_ids: [],
          lead_capture_fields: [],
          crm_integration_id: null,
          custom_domain: null,
          custom_domain_verified_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        pages.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = pages.findIndex((p: any) => p.id === where.id);
        if (idx === -1) throw new Error('not found');
        Object.assign(pages[idx], data, { updated_at: new Date() });
        return { ...pages[idx] };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = pages.findIndex((p: any) => p.id === where.id);
        if (idx !== -1) pages.splice(idx, 1);
      }),
    },

    coachLandingPageSection: {
      findMany: jest.fn(async ({ where }: any) =>
        sections.filter((s: any) => s.page_id === where.page_id),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = sections.length;
        const toDelete = sections.filter((s: any) => s.page_id === where.page_id).map((s: any) => s.id);
        toDelete.forEach((id: string) => {
          const idx = sections.findIndex((s: any) => s.id === id);
          if (idx !== -1) sections.splice(idx, 1);
        });
        return { count: before - sections.length };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        const rows = data.map((d: any, i: number) => ({
          id: `sec-${sections.length + i + 1}`,
          ...d,
        }));
        sections.push(...rows);
        return { count: rows.length };
      }),
    },

    coachLandingLead: {
      count: jest.fn(async ({ where }: any) =>
        leads.filter((l: any) => l.page_id === where.page_id).length,
      ),
      findMany: jest.fn(async ({ where, take, orderBy }: any) => {
        let result = leads.filter((l: any) => {
          if (where.page_id && l.page_id !== where.page_id) return false;
          if (where.id?.lt && l.id >= where.id.lt) return false;
          return true;
        });
        if (take) result = result.slice(0, take);
        return result;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `lead-${leads.length + 1}`, ...data, created_at: new Date() };
        leads.push(row);
        return row;
      }),
    },

    coachLandingPageView: {
      findMany: jest.fn(async ({ where }: any) =>
        views.filter((v: any) => v.page_id === where.page_id),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `view-${views.length + 1}`, ...data, created_at: new Date() };
        views.push(row);
        return row;
      }),
    },

    coachPackage: {
      findMany: jest.fn(async ({ where }: any) =>
        packages.filter((p: any) => {
          if (where.id?.in && !where.id.in.includes(p.id)) return false;
          if (where.coach_id && p.coach_id !== where.coach_id) return false;
          if (where.is_active !== undefined && p.is_active !== where.is_active) return false;
          return true;
        }),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        packages.find((p: any) => {
          if (where.id && p.id !== where.id) return false;
          if (where.is_active !== undefined && p.is_active !== where.is_active) return false;
          return true;
        }) ?? null,
      ),
    },

    coachCrmIntegration: {
      findFirst: jest.fn(async ({ where }: any) =>
        crm.find((c: any) =>
          Object.entries(where).every(([k, v]) => c[k] === v),
        ) ?? null,
      ),
    },

    $transaction: jest.fn(async (fn: any) => {
      // Simple synchronous execution of the transaction callback
      // with a proxy that delegates to the same methods above
      const txProxy = {
        coachLandingPage: {
          update: jest.fn(async (args: any) => {
            const idx = pages.findIndex((p: any) => p.id === args.where.id);
            if (idx === -1) throw new Error('not found');
            Object.assign(pages[idx], args.data, { updated_at: new Date() });
            return { ...pages[idx] };
          }),
        },
        coachLandingPageSection: {
          deleteMany: jest.fn(async (args: any) => {
            const toDelete = sections.filter((s: any) => s.page_id === args.where.page_id).map((s: any) => s.id);
            toDelete.forEach((id: string) => {
              const idx = sections.findIndex((s: any) => s.id === id);
              if (idx !== -1) sections.splice(idx, 1);
            });
            return { count: toDelete.length };
          }),
          createMany: jest.fn(async (args: any) => {
            const rows = args.data.map((d: any, i: number) => ({
              id: `sec-tx-${sections.length + i + 1}`,
              ...d,
            }));
            sections.push(...rows);
            return { count: rows.length };
          }),
          findMany: jest.fn(async (args: any) =>
            sections.filter((s: any) => s.page_id === args.where.page_id),
          ),
        },
      };
      return fn(txProxy);
    }),
  };
}

// ─── Analytics stub ───────────────────────────────────────────────────────────

const analyticsStub = {
  capture: jest.fn().mockResolvedValue(undefined),
};

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeSvc(prisma: ReturnType<typeof makePrisma>) {
  return new LandingPageService(prisma as any, analyticsStub as any);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LandingPageService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: LandingPageService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = makeSvc(prisma);
    jest.clearAllMocks();
  });

  // ─── CREATE ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a draft page with auto-generated slug', async () => {
      const page = await svc.create('coach-1', {
        template: 'transformation',
        headline: 'Transform Your Body',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Get Started',
      });
      expect(page.coach_id).toBe('coach-1');
      expect(page.status).toBe('draft');
      expect(page.slug).toBe('transform-your-body');
    });

    it('rejects creation when coach has 6 non-archived pages', async () => {
      // Add 6 draft/published pages
      for (let i = 0; i < 6; i++) {
        prisma._pages.push({
          id: `page-${i}`,
          coach_id: 'coach-1',
          status: 'draft',
          slug: `page-${i}`,
        });
      }
      await expect(
        svc.create('coach-1', {
          template: 'transformation',
          headline: 'New Page',
          primary_cta_type: 'checkout',
          primary_cta_label: 'Go',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does NOT count archived pages toward the cap', async () => {
      // 5 non-archived + 1 archived = should allow creation
      for (let i = 0; i < 5; i++) {
        prisma._pages.push({ id: `page-${i}`, coach_id: 'coach-1', status: 'draft', slug: `page-${i}` });
      }
      prisma._pages.push({ id: 'page-arch', coach_id: 'coach-1', status: 'archived', slug: 'archived' });

      const page = await svc.create('coach-1', {
        template: 'transformation',
        headline: 'New Page',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
      });
      expect(page).toBeDefined();
    });

    it('deduplicates slug by appending -2', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'my-page' });
      const page = await svc.create('coach-1', {
        template: 'transformation',
        headline: 'My Page',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
      });
      expect(page.slug).toBe('my-page-2');
    });

    it('deduplicates slug by appending -3 when -2 is taken', async () => {
      prisma._pages.push(
        { id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'my-page' },
        { id: 'p2', coach_id: 'coach-1', status: 'draft', slug: 'my-page-2' },
      );
      const page = await svc.create('coach-1', {
        template: 'transformation',
        headline: 'My Page',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
      });
      expect(page.slug).toBe('my-page-3');
    });

    it('two different coaches can have the same slug', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'my-page' });
      // coach-2 creates a page with the same headline
      const page = await svc.create('coach-2', {
        template: 'transformation',
        headline: 'My Page',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
      });
      expect(page.slug).toBe('my-page');
    });

    it('rejects banned payment host in hero_image_url', async () => {
      await expect(
        svc.create('coach-1', {
          template: 'transformation',
          headline: 'Test',
          primary_cta_type: 'checkout',
          primary_cta_label: 'Go',
          hero_image_url: 'https://stripe.com/evil',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects package_ids not owned by coach', async () => {
      // No packages in DB for coach-1
      await expect(
        svc.create('coach-1', {
          template: 'transformation',
          headline: 'Test',
          primary_cta_type: 'checkout',
          primary_cta_label: 'Go',
          package_ids: ['pkg-not-mine'],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows package_ids owned by coach', async () => {
      prisma._packages.push({ id: 'pkg-1', coach_id: 'coach-1', is_active: true });
      const page = await svc.create('coach-1', {
        template: 'transformation',
        headline: 'Test',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
        package_ids: ['pkg-1'],
      });
      expect(page.package_ids).toEqual(['pkg-1']);
    });
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns page with sections', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'test' });
      prisma._sections.push({ id: 's1', page_id: 'p1', kind: 'hero', order_index: 0, payload: {} });
      const page = await svc.get('coach-1', 'p1');
      expect(page.id).toBe('p1');
      expect((page as any).sections).toHaveLength(1);
    });

    it('returns 404 for wrong coach_id (defense in depth)', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'test' });
      await expect(svc.get('coach-2', 'p1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 404 for nonexistent page', async () => {
      await expect(svc.get('coach-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── UPDATE ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates headline atomically', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'old-headline', headline: 'Old Headline' });
      const updated = await svc.update('coach-1', 'p1', { headline: 'New Headline' });
      expect(updated.headline).toBe('New Headline');
      // Slug must NOT auto-regen from new headline
      expect(updated.slug).toBe('old-headline');
    });

    it('re-slugifies only when explicit slug is provided', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'original-slug', headline: 'H' });
      const updated = await svc.update('coach-1', 'p1', { slug: 'New Slug Here' });
      expect(updated.slug).toBe('new-slug-here');
    });

    it('replaces sections atomically', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      prisma._sections.push({ id: 's-old', page_id: 'p1', kind: 'hero', order_index: 0, payload: {} });

      const result = await svc.update('coach-1', 'p1', {
        sections: [
          {
            kind: 'hero' as any,
            order_index: 0,
            payload: {
              headline: 'New Hero',
              hero_image_url: 'https://example.com/img.jpg',
            },
          },
        ],
      });

      // Old section gone, new one present
      const finalSections = prisma._sections.filter((s: any) => s.page_id === 'p1');
      expect(finalSections).toHaveLength(1);
      expect(finalSections[0].kind).toBe('hero');
    });

    it('rejects banned payment host in sections', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(
        svc.update('coach-1', 'p1', {
          sections: [
            {
              kind: 'faq' as any,
              order_index: 0,
              payload: {
                items: [{ question: 'Q', answer: 'See https://paypal.com/pay-me' }],
              },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects invalid section payload', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(
        svc.update('coach-1', 'p1', {
          sections: [
            {
              kind: 'faq' as any,
              order_index: 0,
              payload: { items: [] }, // empty items → fails Zod min(1)
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects foreign package_ids', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(
        svc.update('coach-1', 'p1', { package_ids: ['not-mine'] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 for wrong coach_id', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(svc.update('coach-2', 'p1', { headline: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── PUBLISH ─────────────────────────────────────────────────────────────

  describe('publish', () => {
    it('publishes a page with a hero section', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      prisma._sections.push({ id: 's1', page_id: 'p1', kind: 'hero', order_index: 0, payload: {} });

      const updated = await svc.publish('coach-1', 'p1');
      expect(updated.status).toBe('published');
      expect(updated.published_at).toBeTruthy();
    });

    it('rejects publishing without a hero section', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(svc.publish('coach-1', 'p1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('emits landing.published analytics event', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      prisma._sections.push({ id: 's1', page_id: 'p1', kind: 'hero', order_index: 0, payload: {} });

      await svc.publish('coach-1', 'p1');
      // Give fire-and-forget a tick to run
      await new Promise((r) => setTimeout(r, 0));
      expect(analyticsStub.capture).toHaveBeenCalledWith(
        'coach-1',
        'landing.published',
        expect.objectContaining({ page_id: 'p1' }),
      );
    });
  });

  // ─── UNPUBLISH ────────────────────────────────────────────────────────────

  describe('unpublish', () => {
    it('sets status=archived', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'published', slug: 'pg', headline: 'H' });
      const updated = await svc.unpublish('coach-1', 'p1');
      expect(updated.status).toBe('archived');
      expect(updated.unpublished_at).toBeTruthy();
    });
  });

  // ─── DELETE ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes the page', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await svc.delete('coach-1', 'p1');
      expect(prisma._pages).toHaveLength(0);
    });

    it('returns 404 for wrong coach', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'draft', slug: 'pg', headline: 'H' });
      await expect(svc.delete('coach-2', 'p1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── ANALYTICS ───────────────────────────────────────────────────────────

  describe('getAnalytics', () => {
    it('returns aggregated stats', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'published', slug: 'pg', headline: 'H' });
      prisma._views.push(
        { id: 'v1', page_id: 'p1', scroll_depth: 80, cta_clicked: true, form_submitted: false, utm_source: 'ig', utm_medium: null, utm_campaign: null, referrer_host: 'instagram.com' },
        { id: 'v2', page_id: 'p1', scroll_depth: 40, cta_clicked: false, form_submitted: true, utm_source: null, utm_medium: null, utm_campaign: null, referrer_host: null },
      );

      const stats = await svc.getAnalytics('coach-1', 'p1');
      expect(stats.total_views).toBe(2);
      expect(stats.cta_click_rate).toBe(0.5);
      expect(stats.form_submit_rate).toBe(0.5);
      expect(stats.avg_scroll_depth).toBe(60);
      expect(stats.top_referrers).toEqual([{ host: 'instagram.com', count: 1 }]);
      expect(stats.utm_breakdown.sources).toEqual({ ig: 1 });
    });
  });

  // ─── LEADS ───────────────────────────────────────────────────────────────

  describe('getLeads', () => {
    it('returns paginated leads', async () => {
      prisma._pages.push({ id: 'p1', coach_id: 'coach-1', status: 'published', slug: 'pg', headline: 'H' });
      for (let i = 0; i < 5; i++) {
        prisma._leads.push({ id: `lead-${i}`, page_id: 'p1', email: `user${i}@test.com`, created_at: new Date() });
      }
      const result = await svc.getLeads('coach-1', 'p1', { limit: 3 });
      expect(result.items.length).toBeLessThanOrEqual(4); // take limit+1
    });
  });

  // ─── findPublishedByCustomDomain (CNAME Phase 4) ─────────────────────────
  //
  // Security-critical helper that gates public renderer routing to
  // DNS-verified custom domains only. P2-2 in the PR audit — added here
  // so a future host-header wiring PR can't accidentally drop the
  // `verified_at` filter (the anti-phishing gate) without a red test.

  describe('findPublishedByCustomDomain', () => {
    it('returns the published page when the custom_domain is verified', async () => {
      prisma._pages.push({
        id: 'page-cname-ok',
        coach_id: 'coach-1',
        title: 'Verified storefront',
        slug: 'verified-storefront',
        status: 'published',
        custom_domain: 'verified.example.com',
        custom_domain_verified_at: new Date('2026-01-01T00:00:00Z'),
      });

      const page = await svc.findPublishedByCustomDomain('verified.example.com');
      expect(page).not.toBeNull();
      expect(page!.id).toBe('page-cname-ok');
      expect(page!.custom_domain).toBe('verified.example.com');
      // Renderer-shape includes are wired (sections + coach).
      expect(Array.isArray((page as any).sections)).toBe(true);
      expect((page as any).coach).toBeDefined();
    });

    it('returns null when the custom_domain is claimed but NOT verified (verified_at: null)', async () => {
      // Anti-phishing gate: a coach who CNAMEs at us without
      // DNS-verification must NEVER be served on the public renderer.
      prisma._pages.push({
        id: 'page-cname-unverified',
        coach_id: 'coach-attacker',
        title: 'Attacker page',
        slug: 'attacker-page',
        status: 'published',
        custom_domain: 'unverified.example.com',
        custom_domain_verified_at: null,
      });

      const page = await svc.findPublishedByCustomDomain('unverified.example.com');
      expect(page).toBeNull();
    });

    it('returns null when the page status is not "published" (draft/archived must not leak)', async () => {
      prisma._pages.push({
        id: 'page-cname-draft',
        coach_id: 'coach-1',
        title: 'Draft with verified CNAME',
        slug: 'draft-cname',
        status: 'draft', // <-- not published
        custom_domain: 'draft.example.com',
        custom_domain_verified_at: new Date('2026-01-01T00:00:00Z'),
      });

      const page = await svc.findPublishedByCustomDomain('draft.example.com');
      expect(page).toBeNull();
    });

    it('normalises the incoming host: lowercases, strips port, strips trailing dot', async () => {
      prisma._pages.push({
        id: 'page-cname-norm',
        coach_id: 'coach-1',
        title: 'Normalised',
        slug: 'normalised',
        status: 'published',
        custom_domain: 'norm.example.com',
        custom_domain_verified_at: new Date('2026-01-01T00:00:00Z'),
      });

      // Mixed case + port + trailing dot all resolve to the same row.
      const a = await svc.findPublishedByCustomDomain('Norm.Example.COM:443');
      const b = await svc.findPublishedByCustomDomain('norm.example.com.');
      expect(a?.id).toBe('page-cname-norm');
      expect(b?.id).toBe('page-cname-norm');
    });

    it('returns null for empty / undefined host inputs', async () => {
      expect(await svc.findPublishedByCustomDomain('')).toBeNull();
      // Host is typed `string` upstream; defensive null-handling still matters.
      expect(await svc.findPublishedByCustomDomain(undefined as any)).toBeNull();
    });
  });
});

// ─── Banned-host validation standalone ──────────────────────────────────────

describe('banned-payment-hosts', () => {
  const { checkBannedHost, findBannedHostInPayload } = require('../src/landing-pages/banned-payment-hosts');

  const BANNED = [
    'https://stripe.com/pay',
    'https://checkout.stripe.com/c/pay/xxx',
    'https://buy.stripe.com/xxx',
    'https://paypal.com/send',
    'https://paypal.me/john',
    'https://venmo.com/@john',
    'https://cash.app/$john',
    'https://cashapp.com/pay',
    'https://ko-fi.com/john',
    'https://buymeacoffee.com/john',
    'https://patreon.com/john',
    'https://gumroad.com/l/xxx',
    'https://lemonsqueezy.com/buy/xxx',
    'https://whop.com/xxx',
  ];

  it.each(BANNED)('rejects %s', (url) => {
    const result = checkBannedHost(url);
    expect(result.ok).toBe(false);
  });

  it('allows normal URLs', () => {
    const result = checkBannedHost('https://example.com/page');
    expect(result.ok).toBe(true);
  });

  it('allows null/empty', () => {
    expect(checkBannedHost(null).ok).toBe(true);
    expect(checkBannedHost('').ok).toBe(true);
    expect(checkBannedHost(undefined).ok).toBe(true);
  });

  it('finds banned host nested in payload', () => {
    const found = findBannedHostInPayload({
      items: [{ question: 'Q', answer: 'Pay at https://paypal.me/coach' }],
    });
    expect(found).toBe('paypal.me');
  });

  it('returns null for clean payload', () => {
    const found = findBannedHostInPayload({
      items: [{ question: 'Q', answer: 'Check out https://example.com' }],
    });
    expect(found).toBeNull();
  });
});
