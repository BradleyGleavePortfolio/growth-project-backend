import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Redirect,
  Request as NestRequest,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request as ExpressRequest, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { LandingPagePublicService } from './landing-pages.public.service';
import { LeadSubmitDto } from './dto/lead-submit.dto';
import { ViewEventDto } from './dto/view-event.dto';

// TODO PR #4 (custom domain Pro+): Add host header check here.
// When a request arrives at a custom domain (e.g. coaching.example.com),
// look up the CoachLandingPage by custom_domain and rewrite coachSlug/pageSlug
// to the matching page before delegating to LandingPagePublicService.
// See spec §6 and CustomDomainService (to be added in PR #4).

/**
 * Public landing page routes — mounted OUTSIDE the /api global prefix.
 * See main.ts: app.setGlobalPrefix('api', { exclude: ['p/*'] }).
 *
 * All routes are @Public() — no JWT required.
 *
 * Throttle limits:
 *   - View (sendBeacon): 30/min/IP (spec §5.4)
 *   - Lead submit:       3/min/IP  (spec §5.4 — Redis-backed per-page/IP)
 *   - Checkout redirect: 60/min/IP (generous — it's just a 302)
 *
 * The UserThrottlerGuard falls back to IP-based bucketing for @Public()
 * routes (no user identity), which is exactly what we want here.
 */
@ApiTags('landing-pages-public')
@Controller()
export class LandingPagePublicController {
  constructor(private readonly publicService: LandingPagePublicService) {}

  // ─── GET /p/:coachSlug/:pageSlug — SSR HTML ───────────────────────────────

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get('p/:coachSlug/:pageSlug')
  async renderPage(
    @Param('coachSlug') coachSlug: string,
    @Param('pageSlug') pageSlug: string,
    @Res() res: Response,
  ) {
    // Basic length guard before hitting the DB
    if (
      !coachSlug || coachSlug.length > 80 ||
      !pageSlug || pageSlug.length > 80
    ) {
      return this.send404(res);
    }

    const { html, found } = await this.publicService.renderPage(coachSlug, pageSlug);

    if (!found) {
      return this.send404(res);
    }

    // Cache-Control: 60s freshness + 300s stale-while-revalidate.
    // Published pages are cached at CDN for 60s; pausing/unpublishing has a
    // small lag (same SWR pattern as other public pages — spec §3.3).
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(HttpStatus.OK).send(html);
  }

  // ─── GET /p/:coachSlug/:pageSlug/checkout — Checkout routing ─────────────

  /**
   * Routes to the TGP storefront for the selected pricing tier.
   * Query: ?tier=<package_id>
   *
   * Spec §3.2 — ZERO EXCEPTIONS: all checkout routes through TGP GuestCheckout.
   * No external payment provider links permitted.
   *
   * Returns 302 to /v1/packages/public/join/:token on success.
   * Returns 404 if page not found, not published, or tier not in page.package_ids.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('p/:coachSlug/:pageSlug/checkout')
  async checkout(
    @Param('coachSlug') coachSlug: string,
    @Param('pageSlug') pageSlug: string,
    @Query('tier') tierId: string,
    @Res() res: Response,
  ) {
    if (!tierId || !tierId.trim()) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'missing_tier',
        message: 'Query parameter ?tier=<package_id> is required',
      });
    }

    const checkoutUrl = await this.publicService.resolveCheckoutUrl(
      coachSlug,
      pageSlug,
      tierId,
    );

    if (!checkoutUrl) {
      return res.status(HttpStatus.NOT_FOUND).json({
        error: 'checkout_unavailable',
        message: 'The selected package is not available for checkout on this page',
      });
    }

    res.redirect(HttpStatus.FOUND, checkoutUrl);
  }

  // ─── POST /p/:coachSlug/:pageSlug/leads — Lead form submit ───────────────

  /**
   * Lead form submission.
   * Throttled: 3/min/IP per page (UserThrottlerGuard falls back to IP).
   * 100/day/page is enforced by a Redis counter in the service layer.
   * Returns 200 {ok:true} or 429 on throttle.
   * Writes CoachLandingLead with crm_sync_status='pending' (PR #3 picks it up).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('p/:coachSlug/:pageSlug/leads')
  @HttpCode(HttpStatus.OK)
  async submitLead(
    @Param('coachSlug') coachSlug: string,
    @Param('pageSlug') pageSlug: string,
    @Body() dto: LeadSubmitDto,
  ) {
    const result = await this.publicService.submitLead(coachSlug, pageSlug, dto);
    if (!result.ok) {
      // Page not found or not published — return 200 silently to avoid
      // leaking page existence to form spammers
      return { ok: false };
    }
    return { ok: true };
  }

  // ─── POST /p/:coachSlug/:pageSlug/view — sendBeacon analytics ────────────

  /**
   * sendBeacon analytics event.
   * Throttled: 30/min/IP.
   * Accepts: {scroll_depth, cta_clicked, form_submitted, utm_source, utm_medium, utm_campaign}.
   * Writes CoachLandingPageView with hashed IP/UA.
   * Always returns 200 (fire-and-forget from client).
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('p/:coachSlug/:pageSlug/view')
  @HttpCode(HttpStatus.OK)
  async recordView(
    @Param('coachSlug') coachSlug: string,
    @Param('pageSlug') pageSlug: string,
    @Body() dto: ViewEventDto,
    @NestRequest() req: ExpressRequest,
  ) {
    const rawIp = this.extractIp(req);
    const rawUa = (req.headers['user-agent'] as string) || '';
    const referrer = (req.headers['referer'] || req.headers['referrer']) as string | undefined;

    // Fire-and-forget: do not await — sendBeacon must get 200 immediately
    this.publicService
      .recordView(coachSlug, pageSlug, dto, rawIp, rawUa, referrer)
      .catch(() => {/* swallow analytics errors */});

    return { ok: true };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private send404(res: Response): void {
    const { renderNotFound } = require('./landing-pages.html');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(HttpStatus.NOT_FOUND).send(renderNotFound());
  }

  private extractIp(req: ExpressRequest): string {
    const flyIp = req.headers['fly-client-ip'] as string | undefined;
    if (flyIp?.trim()) return flyIp.trim();
    const xff = req.headers['x-forwarded-for'] as string | undefined;
    if (xff) return xff.split(',')[0]?.trim() || '';
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
