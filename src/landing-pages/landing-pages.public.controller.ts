import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
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

// B3 (PR-18) — custom-domain Host-header routing.
//
// When a request arrives on a VERIFIED custom domain (e.g.
// coaching.example.com) we resolve it to the coach's published page via
// `findPublishedByCustomDomain` and reuse the existing slug-keyed
// render/checkout/lead/view paths — no `/p/:coachSlug/:pageSlug` needed.
// Canonical app/API hosts are ignored so normal `/p/...` routing is
// unchanged. See `resolvePageAddress` below for the full security model.

// ─── Custom-domain host model (B3) ──────────────────────────────────────
//
// THREAT MODEL: Express here has NO `trust proxy` configured and Fly's
// edge forwards arbitrary client headers verbatim (same precondition the
// storefront webview interstitial documents). Therefore we DO NOT trust
// `X-Forwarded-Host` for routing — a forged value could otherwise be used
// to probe / hijack another coach's verified domain. We read the `Host`
// header only. The resolved host is never reflected into a redirect or
// into HTML; it is used ONLY as a DB lookup key, and a row is returned
// ONLY when `custom_domain_verified_at` is set (the service enforces it).
//
// Canonical first-party hosts must NEVER take the custom-domain branch,
// otherwise `/p/:coachSlug/:pageSlug` on app.trygrowthproject.com could be
// shadowed. We ignore an explicit allow-list of canonical hosts plus any
// host whose registrable apex is one of our brand domains (covers staging
// / preview subdomains we add later without a code change).
const CANONICAL_HOST_SUFFIXES: ReadonlyArray<string> = [
  'trygrowthproject.com',
  'joingrowthproject.com',
];
const CANONICAL_HOST_EXACT: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
]);

/**
 * Normalize a raw `Host` header value into a bare lowercase hostname, or
 * return `null` if it cannot be safely used as a custom-domain lookup key.
 *
 * Rules (mirrors `CustomDomainService.normaliseDomain` so a host can only
 * match a domain that was stored through the same normalization):
 *  - trim whitespace, lowercase (DNS is case-insensitive);
 *  - REJECT comma chains — a single `Host` header must carry exactly one
 *    host. A comma means header injection / a forged proxy chain, so we
 *    refuse rather than silently taking the first value;
 *  - strip a single `:port` suffix;
 *  - strip a single trailing dot (FQDN root);
 *  - REJECT empty, over-length (>253), or values containing a path,
 *    scheme, whitespace, or `@`.
 */
function normalizeHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Reject comma chains outright — one Host = one value.
  if (trimmed.includes(',')) return null;
  // No scheme, path, query, userinfo, or internal whitespace allowed.
  if (/[\s/@?#\\]/.test(trimmed) || trimmed.includes('://')) return null;
  // Strip a single :port suffix (IPv6 literals are bracketed and would
  // never be in our verified-domain table, so the naive split is safe).
  const noPort = trimmed.split(':')[0];
  if (!noPort) return null;
  // Strip a single trailing dot.
  const host = noPort.replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  return host;
}

/** True if `host` is one of our canonical first-party hosts. */
function isCanonicalHost(host: string): boolean {
  if (CANONICAL_HOST_EXACT.has(host)) return true;
  return CANONICAL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

// Low-cardinality routing-decision labels for the Host dispatcher. These are
// the ONLY values emitted to telemetry so the metric/log series stays bounded
// (no raw, attacker-controllable Host string is ever logged at the decision
// site — see `logDispatch` below).
type DispatchOutcome =
  | 'custom_domain_match'
  | 'canonical_host_skip'
  | 'invalid_host_reject'
  | 'unknown_host_404';

/**
 * Public landing page routes — mounted OUTSIDE the /api global prefix.
 * See main.ts: app.setGlobalPrefix('api', { exclude: [...] }) excludes both
 * the `p/:coachSlug/:pageSlug[...]` slug routes and the bare custom-domain
 * apex routes (GET '', GET 'checkout', POST 'leads', POST 'view').
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
  // Decacorn-quality observability: a security-sensitive per-request Host
  // dispatcher must emit a sampled, structured decision signal so we can
  // alert on a spike in `invalid_host_reject` (probing) or a drop in
  // `custom_domain_match` (a verification / DNS regression). Logged at debug
  // with a bounded label set; see `logDispatch`.
  private readonly logger = new Logger(LandingPagePublicController.name);

  constructor(private readonly publicService: LandingPagePublicService) {}

  /**
   * Emit one bounded, structured routing-decision log for the Host
   * dispatcher. The `outcome` is one of four fixed labels (low cardinality),
   * and we deliberately do NOT log the raw Host header — only a coarse,
   * non-reflective descriptor:
   *  - `custom_domain_match` logs the normalized host (already a verified,
   *    DB-backed domain at this point, so it is not attacker-injected free
   *    text and is safe/useful for ops);
   *  - all other outcomes log only the host length, so a flood of garbage
   *    Host values cannot blow up log cardinality or smuggle log-injection
   *    payloads.
   */
  private logDispatch(
    outcome: DispatchOutcome,
    host: string | null,
  ): void {
    if (outcome === 'custom_domain_match') {
      this.logger.debug(
        `host-dispatch outcome=${outcome} host=${host ?? ''}`,
      );
      return;
    }
    this.logger.debug(
      `host-dispatch outcome=${outcome} host_len=${host ? host.length : 0}`,
    );
  }

  // ─── Custom-domain routes (B3) ────────────────────────────────────────────
  //
  // These bare-path routes serve a VERIFIED custom domain's published page
  // directly at its apex (`/`, `/checkout`, `/leads`, `/view`). They are
  // gated on the Host resolving to a verified custom domain; if it does
  // not (canonical host, unknown/unverified domain, malformed Host) they
  // 404 with `no-store` and do NOT fall through to `/p/...`.
  //
  // ROUTING: these four paths are EXCLUDED from the global `/api` prefix in
  // main.ts (setGlobalPrefix exclude list: GET '', GET 'checkout',
  // POST 'leads', POST 'view') so they resolve at the bare host apex
  // (`/`, `/checkout`, `/leads`, `/view`) — exactly the URL shape a verified
  // custom domain hits. Canonical-host traffic on these same bare paths
  // resolves to no verified custom domain and returns the no-store 404,
  // leaving `/p/...` untouched. No `/api/...` route is shadowed because no
  // other controller declares a bare `/`, `checkout`, `leads`, or `view`.

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get()
  async renderCustomDomainRoot(
    @NestRequest() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const addr = await this.resolvePageAddress(req, {});
    if (addr.source !== 'customDomain') {
      return this.send404(res);
    }
    return this.renderResolved(addr.coachSlug, addr.pageSlug, res);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('checkout')
  async checkoutCustomDomain(
    @Query('tier') tierId: string,
    @NestRequest() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const addr = await this.resolvePageAddress(req, {});
    if (addr.source !== 'customDomain') {
      return this.send404(res);
    }
    return this.doCheckout(addr.coachSlug, addr.pageSlug, tierId, res);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('leads')
  @HttpCode(HttpStatus.OK)
  async submitLeadCustomDomain(
    @Body() dto: LeadSubmitDto,
    @NestRequest() req: ExpressRequest,
  ) {
    const addr = await this.resolvePageAddress(req, {});
    if (addr.source !== 'customDomain') {
      // Same silent shape as the slug route — never leak page existence.
      return { ok: false };
    }
    const result = await this.publicService.submitLead(
      addr.coachSlug,
      addr.pageSlug,
      dto,
    );
    return { ok: result.ok };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Post('view')
  @HttpCode(HttpStatus.OK)
  async recordViewCustomDomain(
    @Body() dto: ViewEventDto,
    @NestRequest() req: ExpressRequest,
  ) {
    const addr = await this.resolvePageAddress(req, {});
    if (addr.source !== 'customDomain') {
      // Fire-and-forget shape — always 200, but do nothing for non-domains.
      return { ok: true };
    }
    const rawIp = this.extractIp(req);
    const rawUa = (req.headers['user-agent'] as string) || '';
    const referrer = (req.headers['referer'] || req.headers['referrer']) as
      | string
      | undefined;
    this.publicService
      .recordView(addr.coachSlug, addr.pageSlug, dto, rawIp, rawUa, referrer)
      .catch(() => {/* swallow analytics errors */});
    return { ok: true };
  }

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

    return this.renderResolved(coachSlug, pageSlug, res);
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
    return this.doCheckout(coachSlug, pageSlug, tierId, res);
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

  /**
   * B3 — resolve a request to the page it should serve.
   *
   *  - If explicit `/p/:coachSlug/:pageSlug` params are present, ALWAYS use
   *    them (`source:'path'`). This keeps the canonical route
   *    backwards-compatible and means the custom-domain branch can never
   *    hijack a `/p/...` request, even on a custom domain.
   *  - Otherwise read the `Host` header (never `X-Forwarded-Host` — see the
   *    threat-model note at the top of this file), normalize it, ignore
   *    canonical first-party hosts, and look it up against verified custom
   *    domains. A match yields `source:'customDomain'` with the page's own
   *    `coachSlug`/`pageSlug`; anything else yields `source:'path'` with
   *    empty slugs, which the bare routes treat as a no-store 404.
   *
   * The resolved host is NEVER reflected into a redirect or HTML; it is
   * only ever used as a DB lookup key behind `custom_domain_verified_at`.
   */
  private async resolvePageAddress(
    req: ExpressRequest,
    params: { coachSlug?: string; pageSlug?: string },
  ): Promise<{ coachSlug: string; pageSlug: string; source: 'path' | 'customDomain' }> {
    // Explicit path params win unconditionally.
    if (params.coachSlug && params.pageSlug) {
      return {
        coachSlug: params.coachSlug,
        pageSlug: params.pageSlug,
        source: 'path',
      };
    }

    // Deliberately read ONLY the Host header. Express has no `trust proxy`
    // here, so X-Forwarded-Host is attacker-controlled and must not steer
    // routing.
    const rawHostHeader = req.headers['host'];
    const rawHost = Array.isArray(rawHostHeader) ? rawHostHeader[0] : rawHostHeader;
    const host = normalizeHost(rawHost);
    if (!host) {
      // Absent / malformed / rejected Host (comma chain, scheme, path,
      // userinfo, over-length, etc.). A spike here is a probing signal.
      this.logDispatch('invalid_host_reject', rawHost ?? null);
      return { coachSlug: '', pageSlug: '', source: 'path' };
    }
    if (isCanonicalHost(host)) {
      // First-party host — short-circuit before any DB lookup so normal
      // `/p/...` traffic is never routed through the custom-domain branch.
      this.logDispatch('canonical_host_skip', host);
      return { coachSlug: '', pageSlug: '', source: 'path' };
    }

    const addr = await this.publicService.resolveCustomDomainAddress(host);
    if (!addr) {
      // Well-formed, non-canonical host that matched no verified/published
      // custom domain → the bare HTML routes turn this into a no-store 404.
      this.logDispatch('unknown_host_404', host);
      return { coachSlug: '', pageSlug: '', source: 'path' };
    }
    this.logDispatch('custom_domain_match', host);
    return { coachSlug: addr.coachSlug, pageSlug: addr.pageSlug, source: 'customDomain' };
  }

  /** Shared SSR render path for both `/p/...` and custom-domain roots. */
  private async renderResolved(
    coachSlug: string,
    pageSlug: string,
    res: Response,
  ): Promise<void> {
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

  /** Shared checkout path for both `/p/...` and custom-domain checkout. */
  private async doCheckout(
    coachSlug: string,
    pageSlug: string,
    tierId: string,
    res: Response,
  ): Promise<void> {
    if (!tierId || !tierId.trim()) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'missing_tier',
        message: 'Query parameter ?tier=<package_id> is required',
      });
      return;
    }

    const checkoutUrl = await this.publicService.resolveCheckoutUrl(
      coachSlug,
      pageSlug,
      tierId,
    );

    if (!checkoutUrl) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: 'checkout_unavailable',
        message: 'The selected package is not available for checkout on this page',
      });
      return;
    }

    res.redirect(HttpStatus.FOUND, checkoutUrl);
  }

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
