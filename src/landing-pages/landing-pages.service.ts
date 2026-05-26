import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type {
  CoachLandingPage,
  CoachLandingPageSection,
  LandingPageStatus,
} from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { checkBannedHost, findBannedHostInPayload } from './banned-payment-hosts';
import { validateSectionPayload } from './section-schemas';
import type { CreateLandingPageDto } from './dto/create-landing-page.dto';
import type { UpdateLandingPageDto } from './dto/update-landing-page.dto';
import type { LeadsQueryDto } from './dto/leads-query.dto';

/** Maximum published+draft pages per coach (spec §3.1). */
const MAX_PAGES = 6;

/** Maximum characters in a generated slug. */
const SLUG_MAX = 64;

// ─── Slug helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a free-form string to a URL-safe lowercase slug.
 * Strips diacritics, collapses whitespace, replaces non-alphanum with `-`.
 */
function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

/**
 * Deduplicate a slug within a coach's page list.
 * Strategy: try `base`, then `base-2`, `base-3`, … up to 99.
 * The `existingSlug` param allows the current page to keep its own slug on PATCH.
 */
async function uniqueSlugForCoach(
  prisma: PrismaService,
  coachId: string,
  base: string,
  excludePageId?: string,
): Promise<string> {
  const candidate = base.slice(0, SLUG_MAX);
  const existing = await prisma.coachLandingPage.findMany({
    where: { coach_id: coachId },
    select: { slug: true, id: true },
  });
  const taken = new Set(
    existing
      .filter((p) => p.id !== excludePageId)
      .map((p) => p.slug),
  );
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; i <= 99; i++) {
    const suffix = `-${i}`;
    const attempt = candidate.slice(0, SLUG_MAX - suffix.length) + suffix;
    if (!taken.has(attempt)) return attempt;
  }
  // Fallback: timestamp suffix (extremely unlikely to reach here)
  return `${candidate.slice(0, SLUG_MAX - 10)}-${Date.now().toString(36)}`;
}

// ─── URL/payload validation helpers ──────────────────────────────────────────

/** Throw 400 if any URL in `payload` is on the banned-payment-host list. */
function assertNoBannedHost(url: string | null | undefined, context: string): void {
  const result = checkBannedHost(url);
  if (!result.ok) {
    throw new BadRequestException({
      error: 'external_payment_host_forbidden',
      host: result.host,
      context,
    });
  }
}

function assertNoBannedHostInPayload(payload: unknown, context: string): void {
  const found = findBannedHostInPayload(payload);
  if (found) {
    throw new BadRequestException({
      error: 'external_payment_host_forbidden',
      host: found,
      context,
    });
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class LandingPageService {
  private readonly logger = new Logger(LandingPageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ─── LIST ──────────────────────────────────────────────────────────────────

  /**
   * List all pages for a coach (max 6) with summary stats.
   * Defense-in-depth: always filters by coach_id even though RLS would catch it.
   */
  async list(coachId: string) {
    const pages = await this.prisma.coachLandingPage.findMany({
      where: { coach_id: coachId },
      include: {
        _count: {
          select: {
            leads: true,
            views: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      template: p.template,
      status: p.status,
      headline: p.headline,
      subheadline: p.subheadline,
      hero_image_url: p.hero_image_url,
      accent_color: p.accent_color,
      primary_cta_type: p.primary_cta_type,
      primary_cta_label: p.primary_cta_label,
      published_at: p.published_at,
      created_at: p.created_at,
      updated_at: p.updated_at,
      _count: p._count,
    }));
  }

  // ─── CREATE ────────────────────────────────────────────────────────────────

  async create(coachId: string, dto: CreateLandingPageDto): Promise<CoachLandingPage> {
    // Spec §9 — page count cap: drafts + published count, not just published.
    const active = await this.prisma.coachLandingPage.count({
      where: { coach_id: coachId, status: { not: 'archived' } },
    });
    if (active >= MAX_PAGES) {
      throw new ConflictException({ error: 'max_pages_reached' });
    }

    // Banned-host validation on any URL fields
    assertNoBannedHost(dto.hero_image_url, 'hero_image_url');

    // Validate package ownership if provided
    if (dto.package_ids?.length) {
      await this.assertPackageOwnership(coachId, dto.package_ids);
    }

    // Validate CRM integration if provided
    if (dto.crm_integration_id) {
      await this.assertCrmOwnership(coachId, dto.crm_integration_id);
    }

    // Generate slug from headline
    const base = slugify(dto.headline);
    const slug = await uniqueSlugForCoach(this.prisma, coachId, base);

    return this.prisma.coachLandingPage.create({
      data: {
        coach_id: coachId,
        slug,
        template: dto.template,
        headline: dto.headline,
        subheadline: dto.subheadline ?? null,
        hero_image_url: dto.hero_image_url ?? null,
        accent_color: dto.accent_color ?? null,
        primary_cta_type: dto.primary_cta_type,
        primary_cta_label: dto.primary_cta_label,
        package_ids: dto.package_ids ?? [],
        lead_capture_fields: dto.lead_capture_fields ?? [],
        crm_integration_id: dto.crm_integration_id ?? null,
      },
    });
  }

  // ─── GET ───────────────────────────────────────────────────────────────────

  async get(coachId: string, pageId: string) {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
      include: {
        sections: { orderBy: { order_index: 'asc' } },
      },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });
    return page;
  }

  // ─── UPDATE ────────────────────────────────────────────────────────────────

  async update(
    coachId: string,
    pageId: string,
    dto: UpdateLandingPageDto,
  ): Promise<CoachLandingPage & { sections: CoachLandingPageSection[] }> {
    const existing = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
    });
    if (!existing) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    // Banned-host validation
    assertNoBannedHost(dto.hero_image_url, 'hero_image_url');

    // Package ownership check
    if (dto.package_ids?.length) {
      await this.assertPackageOwnership(coachId, dto.package_ids);
    }

    // CRM integration ownership check (spec CRM stub — validate FK but no sync logic)
    if (dto.crm_integration_id !== undefined) {
      if (dto.crm_integration_id !== null) {
        await this.assertCrmOwnership(coachId, dto.crm_integration_id);
      }
    }

    // Slug handling — ONLY re-slug if coach explicitly provides a new slug
    let slug = existing.slug;
    if (dto.slug !== undefined && dto.slug.trim() !== '') {
      const base = slugify(dto.slug.trim());
      slug = await uniqueSlugForCoach(this.prisma, coachId, base, pageId);
    }

    // Section validation
    if (dto.sections !== undefined) {
      for (const sec of dto.sections) {
        assertNoBannedHostInPayload(sec.payload, `section[${sec.kind}]`);
        const validation = validateSectionPayload(sec.kind, sec.payload);
        if (!validation.ok) {
          throw new BadRequestException({
            error: 'invalid_section_payload',
            kind: sec.kind,
            message: validation.message,
          });
        }
      }
    }

    // Single atomic write — wrap everything in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.coachLandingPage.update({
        where: { id: pageId },
        data: {
          ...(dto.headline !== undefined && { headline: dto.headline }),
          ...(dto.subheadline !== undefined && { subheadline: dto.subheadline }),
          ...(dto.hero_image_url !== undefined && { hero_image_url: dto.hero_image_url }),
          ...(dto.accent_color !== undefined && { accent_color: dto.accent_color }),
          ...(dto.primary_cta_type !== undefined && { primary_cta_type: dto.primary_cta_type }),
          ...(dto.primary_cta_label !== undefined && { primary_cta_label: dto.primary_cta_label }),
          ...(dto.package_ids !== undefined && { package_ids: dto.package_ids }),
          ...(dto.lead_capture_fields !== undefined && { lead_capture_fields: dto.lead_capture_fields }),
          ...(dto.crm_integration_id !== undefined && { crm_integration_id: dto.crm_integration_id }),
          slug,
        },
      });

      // Replace sections atomically if provided
      if (dto.sections !== undefined) {
        // Delete all existing sections for this page
        await tx.coachLandingPageSection.deleteMany({ where: { page_id: pageId } });

        // Insert new sections
        if (dto.sections.length > 0) {
          await tx.coachLandingPageSection.createMany({
            data: dto.sections.map((s) => ({
              page_id: pageId,
              kind: s.kind,
              order_index: s.order_index,
              payload: s.payload as any,
            })),
          });
        }
      }

      const sections = await tx.coachLandingPageSection.findMany({
        where: { page_id: pageId },
        orderBy: { order_index: 'asc' },
      });

      return { ...updated, sections };
    });

    return result;
  }

  // ─── PUBLISH ───────────────────────────────────────────────────────────────

  async publish(coachId: string, pageId: string): Promise<CoachLandingPage> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
      include: { sections: true },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    // Basic publish validation — must have a hero section
    const hasHero = page.sections.some((s) => s.kind === 'hero');
    if (!hasHero) {
      throw new BadRequestException({
        error: 'publish_validation_failed',
        message: 'Page must have a hero section before publishing',
      });
    }

    const updated = await this.prisma.coachLandingPage.update({
      where: { id: pageId },
      data: {
        status: 'published',
        published_at: new Date(),
        unpublished_at: null,
      },
    });

    // Emit landing.published analytics event (fire-and-forget)
    // analytics.capture is synchronous + never throws (see analytics.service.ts)
    this.analytics.capture(coachId, 'landing.published', {
      page_id: pageId,
      slug: page.slug,
      template: page.template,
    });

    return updated;
  }

  // ─── UNPUBLISH ─────────────────────────────────────────────────────────────

  async unpublish(coachId: string, pageId: string): Promise<CoachLandingPage> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    return this.prisma.coachLandingPage.update({
      where: { id: pageId },
      data: {
        status: 'archived',
        unpublished_at: new Date(),
      },
    });
  }

  // ─── DELETE ────────────────────────────────────────────────────────────────

  async delete(coachId: string, pageId: string): Promise<void> {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    // Hard delete — cascades to sections, leads, views via FK onDelete: Cascade
    await this.prisma.coachLandingPage.delete({ where: { id: pageId } });
  }

  // ─── ANALYTICS ────────────────────────────────────────────────────────────

  async getAnalytics(coachId: string, pageId: string) {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    const [views, leads, revenueAgg] = await Promise.all([
      this.prisma.coachLandingPageView.findMany({
        where: { page_id: pageId },
        select: {
          scroll_depth: true,
          cta_clicked: true,
          form_submitted: true,
          referrer_host: true,
          utm_source: true,
          utm_medium: true,
          utm_campaign: true,
        },
      }),
      this.prisma.coachLandingLead.count({ where: { page_id: pageId } }),
      // $/visitor: sum GuestCheckout amounts where page_id matches
      // GuestCheckout links to CoachLandingPage via metadata (PR #3 wires CRM)
      // For now, query via the page's package_ids cross-reference
      Promise.resolve(null as null),
    ]);

    const totalViews = views.length;
    const ctaClicks = views.filter((v) => v.cta_clicked).length;
    const formSubmits = views.filter((v) => v.form_submitted).length;
    const scrollDepths = views
      .map((v) => v.scroll_depth)
      .filter((d): d is number => d !== null);
    const avgScrollDepth =
      scrollDepths.length > 0
        ? Math.round(scrollDepths.reduce((a, b) => a + b, 0) / scrollDepths.length)
        : null;

    // UTM breakdown
    const utmBreakdown = views.reduce(
      (acc, v) => {
        if (v.utm_source) {
          acc.sources[v.utm_source] = (acc.sources[v.utm_source] || 0) + 1;
        }
        if (v.utm_medium) {
          acc.mediums[v.utm_medium] = (acc.mediums[v.utm_medium] || 0) + 1;
        }
        if (v.utm_campaign) {
          acc.campaigns[v.utm_campaign] = (acc.campaigns[v.utm_campaign] || 0) + 1;
        }
        return acc;
      },
      {
        sources: {} as Record<string, number>,
        mediums: {} as Record<string, number>,
        campaigns: {} as Record<string, number>,
      },
    );

    // Top referrers
    const referrerCounts: Record<string, number> = {};
    for (const v of views) {
      if (v.referrer_host) {
        referrerCounts[v.referrer_host] = (referrerCounts[v.referrer_host] || 0) + 1;
      }
    }
    const topReferrers = Object.entries(referrerCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([host, count]) => ({ host, count }));

    return {
      page_id: pageId,
      total_views: totalViews,
      total_leads: leads,
      avg_scroll_depth: avgScrollDepth,
      cta_click_rate: totalViews > 0 ? ctaClicks / totalViews : 0,
      form_submit_rate: totalViews > 0 ? formSubmits / totalViews : 0,
      // $/visitor: calculated from GuestCheckout data; PR #3 wires full CRM
      // TODO PR #3: join GuestCheckout WHERE page_id = pageId to compute revenue
      dollars_per_visitor: null,
      top_referrers: topReferrers,
      utm_breakdown: utmBreakdown,
    };
  }

  // ─── LEADS ────────────────────────────────────────────────────────────────

  async getLeads(coachId: string, pageId: string, query: LeadsQueryDto) {
    const page = await this.prisma.coachLandingPage.findFirst({
      where: { id: pageId, coach_id: coachId },
    });
    if (!page) throw new NotFoundException({ error: 'PAGE_NOT_FOUND' });

    const limit = query.limit ?? 50;
    const leads = await this.prisma.coachLandingLead.findMany({
      where: {
        page_id: pageId,
        ...(query.cursor && { id: { lt: query.cursor } }),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        payload: true,
        crm_sync_status: true,
        crm_synced_at: true,
        crm_error: true,
        created_at: true,
      },
    });

    const hasMore = leads.length > limit;
    const items = hasMore ? leads.slice(0, limit) : leads;
    const nextCursor = hasMore ? items[items.length - 1]?.id : null;

    return { items, next_cursor: nextCursor, has_more: hasMore };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Validate every package_id belongs to the coach (spec §2 Hard Requirement #2). */
  private async assertPackageOwnership(
    coachId: string,
    packageIds: string[],
  ): Promise<void> {
    if (!packageIds.length) return;
    const owned = await this.prisma.coachPackage.findMany({
      where: { id: { in: packageIds }, coach_id: coachId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((p) => p.id));
    const foreign = packageIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new ForbiddenException({
        error: 'package_not_owned',
        package_ids: foreign,
      });
    }
  }

  /**
   * Validate CRM integration belongs to coach.
   * Spec CRM stub — actual CRM logic is PR #3.
   */
  private async assertCrmOwnership(
    coachId: string,
    crmIntegrationId: string,
  ): Promise<void> {
    const crm = await this.prisma.coachCrmIntegration.findFirst({
      where: { id: crmIntegrationId, coach_id: coachId },
      select: { id: true },
    });
    if (!crm) {
      throw new ForbiddenException({
        error: 'crm_integration_not_owned',
        crm_integration_id: crmIntegrationId,
      });
    }
  }

  // ─── Public lookup (used by public service) ───────────────────────────────

  async findPublishedBySlug(coachSlug: string, pageSlug: string) {
    // Resolve coach by their invite_code (used as coach slug in URLs)
    // or by user.name slugified. We use the CoachProfile.invite_code field
    // as the canonical "coach slug" for URL routing since it's already unique.
    // If no match by invite_code, fall back to slugified user name.
    const coach = await this.prisma.coachProfile.findFirst({
      where: { invite_code: coachSlug },
      select: { user_id: true },
    });

    let coachId: string | null = null;
    if (coach) {
      coachId = coach.user_id;
    } else {
      // Fallback: match by slugified name
      const users = await this.prisma.user.findMany({
        where: { role: 'coach' },
        select: { id: true, name: true },
      });
      const matched = users.find((u) => slugify(u.name) === coachSlug);
      if (matched) coachId = matched.id;
    }

    if (!coachId) return null;

    const page = await this.prisma.coachLandingPage.findFirst({
      where: { coach_id: coachId, slug: pageSlug, status: 'published' },
      include: {
        sections: { orderBy: { order_index: 'asc' } },
        coach: {
          select: {
            id: true,
            name: true,
            coach_practice_type: true,
            coach_profile: {
              select: {
                business_name: true,
                bio: true,
                branding_accent_color: true,
                branding_logo_url: true,
                invite_code: true,
              },
            },
          },
        },
      },
    });

    return page;
  }

  async findPublishedPackages(packageIds: string[]) {
    if (!packageIds.length) return [];
    return this.prisma.coachPackage.findMany({
      where: { id: { in: packageIds }, is_active: true },
      orderBy: { amount_cents: 'asc' },
    });
  }
}
