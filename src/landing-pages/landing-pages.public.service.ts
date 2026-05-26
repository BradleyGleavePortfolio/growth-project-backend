import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';
import { LandingPageService } from './landing-pages.service';
import { renderPublicPage, renderNotFound } from './landing-pages.html';
import type { ViewEventDto } from './dto/view-event.dto';
import type { LeadSubmitDto } from './dto/lead-submit.dto';

@Injectable()
export class LandingPagePublicService {
  private readonly logger = new Logger(LandingPagePublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly landingPageService: LandingPageService,
  ) {}

  // ─── Public page render ─────────────────────────────────────────────────

  async renderPage(
    coachSlug: string,
    pageSlug: string,
  ): Promise<{ html: string; found: boolean }> {
    const page = await this.landingPageService.findPublishedBySlug(
      coachSlug,
      pageSlug,
    );

    if (!page) {
      return { html: renderNotFound(), found: false };
    }

    // Only published pages are publicly visible
    if (page.status !== 'published') {
      return { html: renderNotFound(), found: false };
    }

    // Fetch packages referenced by the page
    const packages = await this.landingPageService.findPublishedPackages(
      page.package_ids,
    );

    const baseUrl =
      process.env.PUBLIC_APP_BASE_URL ||
      process.env.PUBLIC_INVITE_BASE_URL?.replace('/join', '') ||
      'https://app.trygrowthproject.com';

    const html = renderPublicPage(page, packages, coachSlug, baseUrl);

    return { html, found: true };
  }

  // ─── Checkout routing ────────────────────────────────────────────────────

  /**
   * Resolve checkout URL for a given tier.
   * The "Buy" button on a pricing card routes here; we validate the package
   * belongs to this page then 302 to the public storefront.
   *
   * Spec §3.2 — ZERO EXCEPTIONS: checkout always routes through TGP.
   */
  async resolveCheckoutUrl(
    coachSlug: string,
    pageSlug: string,
    tierId: string,
  ): Promise<string | null> {
    const page = await this.landingPageService.findPublishedBySlug(
      coachSlug,
      pageSlug,
    );

    if (!page || page.status !== 'published') return null;

    // Validate the tier is listed on this page
    if (!page.package_ids.includes(tierId)) return null;

    // Look up the package's share token for the storefront redirect
    const pkg = await this.prisma.coachPackage.findFirst({
      where: { id: tierId, is_active: true },
      select: { id: true, share_token: true },
    });

    if (!pkg) return null;

    // If the package has a share token, route to the public storefront.
    // Otherwise, route to the package detail page (future).
    const storefrontBase =
      process.env.STOREFRONT_BASE_URL ||
      process.env.PUBLIC_APP_BASE_URL ||
      'https://app.trygrowthproject.com';

    if (pkg.share_token) {
      return `${storefrontBase}/v1/packages/public/join/${pkg.share_token}`;
    }

    // Fallback: no share token yet → return null to signal 404
    return null;
  }

  // ─── Lead submission ──────────────────────────────────────────────────────

  async submitLead(
    coachSlug: string,
    pageSlug: string,
    dto: LeadSubmitDto,
  ): Promise<{ ok: boolean }> {
    const page = await this.landingPageService.findPublishedBySlug(
      coachSlug,
      pageSlug,
    );

    if (!page || page.status !== 'published') {
      // Return ok:false silently — don't leak page existence to spammers
      return { ok: false };
    }

    await this.prisma.coachLandingLead.create({
      data: {
        page_id: page.id,
        coach_id: page.coach_id,
        email: dto.email,
        name: dto.name ?? null,
        phone: dto.phone ?? null,
        payload: {
          email: dto.email,
          name: dto.name,
          phone: dto.phone,
          goal: dto.goal,
        } as any,
        crm_sync_status: 'pending',
        // PR #3 picks up pending leads for CRM sync
      },
    });

    return { ok: true };
  }

  // ─── View / sendBeacon ───────────────────────────────────────────────────

  async recordView(
    coachSlug: string,
    pageSlug: string,
    dto: ViewEventDto,
    rawIp: string,
    rawUa: string,
    referrer: string | undefined,
  ): Promise<void> {
    const page = await this.landingPageService.findPublishedBySlug(
      coachSlug,
      pageSlug,
    );
    if (!page || page.status !== 'published') return;

    // GDPR: hash IP + UA with a daily-rotating salt so they are non-linkable
    // across days and we store no PII.
    const salt = this.dailySalt();
    const ipHash = this.hash(rawIp + salt);
    const uaHash = this.hash(rawUa + salt);

    // Extract referrer host from full referrer URL
    let referrerHost: string | null = null;
    try {
      if (referrer) {
        referrerHost = new URL(referrer).hostname;
      }
    } catch {
      // malformed referrer — ignore
    }

    await this.prisma.coachLandingPageView.create({
      data: {
        page_id: page.id,
        ip_hash: ipHash,
        ua_hash: uaHash,
        referrer_host: referrerHost,
        utm_source: dto.utm_source ?? null,
        utm_medium: dto.utm_medium ?? null,
        utm_campaign: dto.utm_campaign ?? null,
        scroll_depth: dto.scroll_depth ?? null,
        cta_clicked: dto.cta_clicked ?? false,
        form_submitted: dto.form_submitted ?? false,
      },
    }).catch((err) => {
      // Fire-and-forget: do not let analytics writes block the response
      this.logger.warn(`view write failed: ${String(err)}`);
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private dailySalt(): string {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // In production this should use a secret key from env.
    // For now, use a deterministic daily rotation so hashes cannot be
    // correlated across days (GDPR requirement per spec §4.1).
    const secret = process.env.LANDING_VIEW_HASH_SECRET || 'landing-views-daily-salt';
    return createHash('sha256').update(`${secret}:${day}`).digest('hex').slice(0, 16);
  }

  private hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
