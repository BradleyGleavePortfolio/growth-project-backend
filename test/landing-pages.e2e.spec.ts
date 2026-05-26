/**
 * E2E lifecycle test for the landing pages feature (in-memory Prisma stubs).
 *
 * Full lifecycle:
 *   create draft → patch sections → publish → public GET → lead submit → leads list
 *
 * Uses the same in-memory stub pattern as landing-pages.service.spec.ts.
 * Does NOT boot a real HTTP server or DB.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { LandingPageService } from '../src/landing-pages/landing-pages.service';
import { LandingPagePublicService } from '../src/landing-pages/landing-pages.public.service';

// ─── Full Prisma stub (shared between both services) ─────────────────────────

function makePrisma() {
  const pages: any[] = [];
  const sections: any[] = [];
  const leads: any[] = [];
  const views: any[] = [];
  const packages: any[] = [
    {
      id: 'pkg-lifecycle',
      coach_id: 'coach-lifecycle',
      name: 'Signature Program',
      amount_cents: 49900,
      billing_type: 'one_time',
      interval: null,
      description: 'The full experience',
      is_active: true,
      share_token: 'tok_lifecycle12345678901',
    },
  ];
  const profiles: any[] = [
    {
      id: 'prof-1',
      user_id: 'coach-lifecycle',
      invite_code: 'GP-LIFECYCLE',
      business_name: 'Lifecycle Coaching',
      bio: 'Transform',
      branding_accent_color: '#4A90D9',
      branding_logo_url: null,
    },
  ];

  const sectionOps = {
    findMany: jest.fn(async ({ where }: any) =>
      sections.filter((s: any) => s.page_id === where.page_id),
    ),
    deleteMany: jest.fn(async ({ where }: any) => {
      const before = sections.length;
      const ids = sections.filter((s: any) => s.page_id === where.page_id).map((s: any) => s.id);
      ids.forEach((id: string) => {
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
  };

  return {
    _pages: pages,
    _sections: sections,
    _leads: leads,
    _views: views,
    _packages: packages,
    _profiles: profiles,

    coachProfile: {
      findFirst: jest.fn(async ({ where }: any) =>
        profiles.find((p: any) => p.invite_code === where.invite_code) ?? null,
      ),
    },

    user: {
      findMany: jest.fn(async () => []),
    },

    coachLandingPage: {
      count: jest.fn(async ({ where }: any) =>
        pages.filter((p: any) => {
          if (where.coach_id && p.coach_id !== where.coach_id) return false;
          if (where.status?.not && p.status === where.status.not) return false;
          return true;
        }).length,
      ),
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
          return true;
        });
        if (!p) return null;
        const coach = {
          id: p.coach_id,
          name: 'Lifecycle Coach',
          coach_practice_type: null,
          coach_profile: profiles.find((pr: any) => pr.user_id === p.coach_id) ?? null,
        };
        if (include?.sections) {
          return {
            ...p,
            sections: sections.filter((s: any) => s.page_id === p.id),
            coach,
          };
        }
        return { ...p, coach };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `page-lc-${pages.length + 1}`,
          status: 'draft',
          published_at: null,
          unpublished_at: null,
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

    coachLandingPageSection: sectionOps,

    coachLandingLead: {
      count: jest.fn(async ({ where }: any) =>
        leads.filter((l: any) => l.page_id === where.page_id).length,
      ),
      findMany: jest.fn(async ({ where, take }: any) => {
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
      findFirst: jest.fn().mockResolvedValue(null),
    },

    $transaction: jest.fn(async (fn: any) => {
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
            const ids = sections.filter((s: any) => s.page_id === args.where.page_id).map((s: any) => s.id);
            ids.forEach((id: string) => {
              const idx = sections.findIndex((s: any) => s.id === id);
              if (idx !== -1) sections.splice(idx, 1);
            });
            return { count: ids.length };
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

// ─── Lifecycle test ───────────────────────────────────────────────────────────

describe('Landing Pages — full lifecycle', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let coachSvc: LandingPageService;
  let publicSvc: LandingPagePublicService;
  const COACH_ID = 'coach-lifecycle';
  const COACH_SLUG = 'GP-LIFECYCLE';

  beforeEach(() => {
    prisma = makePrisma();
    const analytics = { capture: jest.fn().mockResolvedValue(undefined) };
    coachSvc = new LandingPageService(prisma as any, analytics as any);
    publicSvc = new LandingPagePublicService(prisma as any, coachSvc);
    jest.clearAllMocks();
  });

  it('complete lifecycle: create → patch sections → publish → public GET → lead → leads list', async () => {
    // 1. Create draft
    const page = await coachSvc.create(COACH_ID, {
      template: 'transformation',
      headline: 'Lifecycle Test Page',
      primary_cta_type: 'checkout',
      primary_cta_label: 'Book Now',
      package_ids: ['pkg-lifecycle'],
    });
    expect(page.status).toBe('draft');
    expect(page.slug).toBe('lifecycle-test-page');

    // 2. Patch with sections
    await coachSvc.update(COACH_ID, page.id, {
      headline: 'Updated Lifecycle Page',
      sections: [
        {
          kind: 'hero' as any,
          order_index: 0,
          payload: {
            headline: 'Updated Lifecycle Page',
            hero_image_url: 'https://example.com/hero.jpg',
          },
        },
        {
          kind: 'testimonials' as any,
          order_index: 1,
          payload: {
            items: [
              { name: 'Alice', quote: 'Life changing', result_metric: '-30 lbs' },
            ],
          },
        },
      ],
    });

    // Verify sections were saved
    const withSections = await coachSvc.get(COACH_ID, page.id);
    expect((withSections as any).sections).toHaveLength(2);

    // 3. Publish
    const published = await coachSvc.publish(COACH_ID, page.id);
    expect(published.status).toBe('published');
    expect(published.published_at).toBeTruthy();

    // 4. Public GET — renders HTML
    const { html, found } = await publicSvc.renderPage(COACH_SLUG, page.slug);
    expect(found).toBe(true);
    expect(html).toContain('Updated Lifecycle Page');
    expect(html).toContain('Alice');
    expect(html).toContain('<!doctype html>');

    // 5. Lead submit
    const leadResult = await publicSvc.submitLead(COACH_SLUG, page.slug, {
      email: 'prospect@test.com',
      name: 'Test Prospect',
    });
    expect(leadResult.ok).toBe(true);
    expect(prisma._leads).toHaveLength(1);
    expect(prisma._leads[0].crm_sync_status).toBe('pending');

    // 6. Leads list via coach service
    const leadsResult = await coachSvc.getLeads(COACH_ID, page.id, { limit: 10 });
    expect(leadsResult.items).toHaveLength(1);
    expect(leadsResult.items[0].email).toBe('prospect@test.com');

    // 7. Unpublish → public 404
    await coachSvc.unpublish(COACH_ID, page.id);
    const { found: foundAfterUnpublish } = await publicSvc.renderPage(COACH_SLUG, page.slug);
    expect(foundAfterUnpublish).toBe(false);
  });

  it('page count cap: cannot create 7th non-archived page', async () => {
    // Add 6 draft pages directly
    for (let i = 0; i < 6; i++) {
      prisma._pages.push({
        id: `cap-${i}`,
        coach_id: COACH_ID,
        status: 'draft',
        slug: `cap-${i}`,
        headline: `Page ${i}`,
      });
    }

    await expect(
      coachSvc.create(COACH_ID, {
        template: 'transformation',
        headline: 'Seventh Page',
        primary_cta_type: 'checkout',
        primary_cta_label: 'Go',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('publishes a second page when one is archived (cap allows it)', async () => {
    // 5 active + 1 archived
    for (let i = 0; i < 5; i++) {
      prisma._pages.push({ id: `act-${i}`, coach_id: COACH_ID, status: 'draft', slug: `act-${i}`, headline: `P${i}` });
    }
    prisma._pages.push({ id: 'arc-1', coach_id: COACH_ID, status: 'archived', slug: 'archived' });

    const newPage = await coachSvc.create(COACH_ID, {
      template: 'offer',
      headline: 'New Offer Page',
      primary_cta_type: 'lead_form',
      primary_cta_label: 'Sign Up',
    });
    expect(newPage).toBeDefined();
    expect(newPage.slug).toBe('new-offer-page');
  });

  it('invalid section payload rejects on update', async () => {
    const page = await coachSvc.create(COACH_ID, {
      template: 'authority',
      headline: 'Validation Test',
      primary_cta_type: 'lead_form',
      primary_cta_label: 'Apply',
    });

    await expect(
      coachSvc.update(COACH_ID, page.id, {
        sections: [
          {
            kind: 'lead_form' as any,
            order_index: 0,
            payload: {
              // Missing email in fields — should fail LeadFormPayloadSchema
              fields: ['name', 'phone'],
              cta_label: 'Submit',
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
