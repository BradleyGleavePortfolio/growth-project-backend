import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';
import { LandingPageService } from './landing-pages.service';
import { renderPublicPage, renderNotFound } from './landing-pages.html';
import type { ViewEventDto } from './dto/view-event.dto';
import type { LeadSubmitDto } from './dto/lead-submit.dto';
import { LeadSyncQueue } from './crm/lead-sync.queue';
import { LeadRateLimiterService } from './lead-rate-limiter.service';

@Injectable()
export class LandingPagePublicService {
  private readonly logger = new Logger(LandingPagePublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly landingPageService: LandingPageService,
    private readonly leadSyncQueue: LeadSyncQueue,
    private readonly rateLimiter: LeadRateLimiterService,
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
      // R47 / Audit #6 P0-5 — propagate landing page id through to the
      // storefront so the GuestCheckout row records WHICH page sourced
      // the conversion. Without this, $/visitor analytics is structurally
      // broken (revenue rollup joins on GuestCheckout.landing_page_id).
      return `${storefrontBase}/v1/packages/public/join/${pkg.share_token}?lp=${encodeURIComponent(page.id)}`;
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

    // R47 abuse guard: 100 leads/day/page in UTC, Redis-backed counter.
    const limit = await this.rateLimiter.checkAndIncrement(page.id);
    if (!limit.allowed) {
      // 429 with Retry-After: seconds until next UTC midnight.
      throw new HttpException(
        {
          error: 'TOO_MANY_LEADS',
          message: 'Daily lead capacity reached for this page',
          retry_after_seconds: limit.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const created = await this.prisma.coachLandingLead.create({
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
      },
    });

    // R47: hand off to the CRM sync queue.  The processor scans pending
    // leads on a cron tick — `enqueue()` is a no-op today but the
    // explicit call site lets us swap in BullMQ without touching public.
    // Queue failure must NEVER fail the visitor POST.
    try {
      await this.leadSyncQueue.enqueue(created.id);
    } catch (err) {
      this.logger.warn(`lead-sync enqueue failed for ${created.id}: ${String(err)}`);
    }

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
    // Audit #6 P1-2 — no dev fallback in production. The fallback
    // constant would make every visitor hash predictable (and the
    // unique_visitors count linkable across coaches) for any operator
    // who shipped without setting the secret. env-validation also gates
    // this at boot, but we double-check at use site so a hot env
    // rotation still fails closed.
    const secret = process.env.LANDING_VIEW_HASH_SECRET;
    if (!secret || !secret.trim()) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'LANDING_VIEW_HASH_SECRET is required in production — refusing to derive a predictable visitor hash.',
        );
      }
      // Non-prod fallback keeps unit tests and local dev quiet.
      const fallback = 'landing-views-daily-salt';
      return createHash('sha256').update(`${fallback}:${day}`).digest('hex').slice(0, 16);
    }
    return createHash('sha256').update(`${secret}:${day}`).digest('hex').slice(0, 16);
  }

  private hash(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
