import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  PipeTransform,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import {
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
} from '../throttler/throttler.config';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { SHARE_TOKEN_REGEX } from '../share-link/share-link.service';
import {
  GuestCheckoutDto,
  GuestCheckoutResumeDto,
  SendRecoveryLinkDto,
} from './storefront.dto';
import { GuestCheckoutService } from './guest-checkout.service';
import { StorefrontService } from './storefront.service';
import { CheckoutRecoveryService } from './checkout-recovery.service';
import { ThankYouService } from './thank-you.service';
import { renderThankYouPage } from './thank-you.html';
import {
  CheckoutIpRateLimiterService,
  RATE_LIMIT_SCOPES,
} from './checkout-rate-limiter.service';
import { CheckoutCookieService } from './checkout-cookie.service';

// P1-3 / P2-1 — controller-level token shape check. A malformed token is
// rejected as 404 before the service or Prisma sees it, so brute-force
// scans against /v1/packages/public/join/:token cannot exercise the
// database. Returning the same TOKEN_NOT_FOUND shape the service uses
// keeps the public surface enumeration-resistant.
class ShareTokenPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !SHARE_TOKEN_REGEX.test(value)) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    return value;
  }
}

// H4 #7 (token enumeration) — IP-ONLY tracker for the storefront-join-ip
// throttle layer on GET join/:token.
//
// The route's `default` throttler is keyed by the COMPOSITE (token, IP)
// tracker that `UserThrottlerGuard.getTracker()` derives
// (`storefront-join:<token>:<ip>`), which gives every probed token its own
// 20/min bucket. That bounds per-(token,IP) abuse but NOT distinct-token
// enumeration from a single IP. This tracker deliberately drops the token
// from the key (`storefront-join-ip:<ip>`) so ALL of an IP's distinct-token
// join GETs consume ONE shared budget, bounding an enumeration sweep across
// the whole token space.
//
// IP extraction mirrors `UserThrottlerGuard.getTracker()` exactly
// (fly-client-ip → first x-forwarded-for hop → req.ip / socket) so the
// IP-wide bucket resolves the same client identity the rest of the throttler
// stack uses. Defensive against array-valued / missing proxy headers — never
// throws, never returns empty.
// H4 #7 (R2 P1) — throttler ISOLATION map for the GET join/:token route.
//
// NestJS Throttler evaluates EVERY globally-registered named throttler
// (`THROTTLER_LIMITS`) against EVERY request. For a route that does not opt
// out, an unrelated throttler falls back to (a) its GLOBAL baseline limit and
// (b) the guard's default `getTracker`. On this route the guard's default
// tracker is the COMPOSITE `storefront-join:<token>:<ip>` key — so unrelated
// low-ceiling named throttlers (e.g. `auth-password-reset` at 3/hour,
// `auth-signup` at 5/hour, `auth-recent-auth` at 5/min) were ALSO bucketing
// this route by (token, IP) and rejecting the 4th same-token load long before
// the intended 20/min composite ceiling could bite (R2 audit P1).
//
// This route is governed by EXACTLY two throttlers — the composite `default`
// (Layer 1) and `storefront-join-ip` (Layer 2). Every OTHER named throttler
// must be explicitly skipped so no unrelated bucket can govern legitimate
// join traffic. We derive the skip map from THROTTLER_NAMES (minus the two
// active layers) so it stays correct as new named throttlers are added —
// any future throttler is skipped here by default rather than silently
// lowering this public landing route's effective ceiling.
const STOREFRONT_JOIN_ACTIVE_THROTTLERS: ReadonlySet<string> = new Set([
  THROTTLER_NAMES.DEFAULT,
  THROTTLER_NAMES.STOREFRONT_JOIN_IP,
]);

export const STOREFRONT_JOIN_SKIP_THROTTLERS: Record<string, boolean> =
  Object.freeze(
    Object.values(THROTTLER_NAMES)
      .filter((name) => !STOREFRONT_JOIN_ACTIVE_THROTTLERS.has(name))
      .reduce<Record<string, boolean>>((acc, name) => {
        acc[name] = true;
        return acc;
      }, {}),
  );

export function storefrontJoinIpTracker(
  req: Record<string, unknown>,
): string {
  const headers = (req?.headers ?? {}) as Record<string, unknown>;
  const pickFirst = (h: unknown): string => {
    if (Array.isArray(h)) {
      const last = h[h.length - 1];
      return typeof last === 'string' ? last : '';
    }
    return typeof h === 'string' ? h : '';
  };
  const flyIp = pickFirst(headers['fly-client-ip']).trim();
  if (flyIp.length > 0) return `storefront-join-ip:${flyIp}`;
  const fwdIp = pickFirst(headers['x-forwarded-for']).split(',')[0]?.trim();
  if (fwdIp && fwdIp.length > 0) return `storefront-join-ip:${fwdIp}`;
  const socket = (req?.socket ?? {}) as Record<string, unknown>;
  const connection = (req?.connection ?? {}) as Record<string, unknown>;
  const ip =
    (typeof req?.ip === 'string' && req.ip) ||
    (typeof socket.remoteAddress === 'string' && socket.remoteAddress) ||
    (typeof connection.remoteAddress === 'string' &&
      connection.remoteAddress) ||
    'unknown';
  return `storefront-join-ip:${ip}`;
}

// All routes are @Public() — the storefront serves anonymous traffic.
// Security comes from:
//   • opaque random share_token (collision-resistant, not enumerable)
//   • UUID v4 idempotency_key (validated by DTO)
//   • Stripe webhook signature verification (separate controller)
//   • Throttle decorators sized for "person on Instagram tapping a link"
@ApiTags('storefront-public')
@Controller('v1/packages/public')
export class StorefrontPublicController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly guestCheckout: GuestCheckoutService,
    private readonly recovery: CheckoutRecoveryService,
    private readonly config: ConfigService,
    private readonly ipLimiter: CheckoutIpRateLimiterService,
    private readonly cookies: CheckoutCookieService,
    private readonly thankYou: ThankYouService,
  ) {}

  // Extract a client IP from the request, honoring Fly's
  // `fly-client-ip` then x-forwarded-for chains.  Defensive against
  // malformed/missing headers — never returns empty.
  //
  // A276-F4-P2-G — Node's `IncomingHttpHeaders` types proxy headers
  // as `string | string[] | undefined`. Express normally coalesces
  // multi-set headers into a comma-joined string, but raw Node http2
  // and a hostile (or simply over-eager) upstream can deliver an
  // ACTUAL array — at which point calling `.trim()` / `.split()` on
  // the array would throw, the limiter would never increment, and
  // every request from that source would silently bypass the bucket.
  // We normalize array → last element first (the array tail is the
  // hop closest to our edge, mirroring how the comma-joined string
  // would be ordered) and only then split on `,` to pick the
  // originating client per RFC 7239. Matches the pattern already in
  // `auth.controller.ts` and `admin.controller.ts`.
  private extractIp(req: Request): string {
    const flyIp = this.firstHeaderValue(req.headers['fly-client-ip'])?.trim();
    if (flyIp) return flyIp;
    const xffJoined = this.firstHeaderValue(req.headers['x-forwarded-for']);
    if (xffJoined) {
      const first = xffJoined.split(',')[0]?.trim();
      if (first) return first;
    }
    return (req.ip ?? req.socket?.remoteAddress ?? 'unknown').toString();
  }

  // A276-F4-P2-G — collapse a proxy header value into a single string.
  //   • array → last element (closest hop to our edge per RFC 7239,
  //     matching how Express would have joined comma-separated)
  //   • string → as-is
  //   • undefined / empty array → undefined
  // Never throws; the caller can rely on `?.trim()` on the result.
  private firstHeaderValue(
    header: string | string[] | undefined,
  ): string | undefined {
    if (Array.isArray(header)) {
      if (header.length === 0) return undefined;
      const last = header[header.length - 1];
      return typeof last === 'string' ? last : undefined;
    }
    return typeof header === 'string' ? header : undefined;
  }

  // GET /api/v1/packages/public/join/:token
  // Returns coach + package metadata for the storefront SSR layer.
  // Hot path — keep cheap.
  //
  // #7 (token enumeration) — TWO coordinated throttle layers protect this
  // route. Both apply to every GET join/:token request (NestJS evaluates all
  // configured named throttlers per request; the request passes only if it
  // is under BOTH ceilings):
  //
  //  LAYER 1 — `default` throttler, COMPOSITE (token, IP) key at 20/min.
  //    The Nest @Throttle `default` bucket on every `/v1/packages/public/
  //    join/*` route is keyed by the composite tracker that
  //    `UserThrottlerGuard.getTracker()` derives
  //    (`storefront-join:<token>:<ip>` — see src/throttler/user-throttler.
  //    guard.ts). This matches the companion POST `join/:token/checkout`
  //    EXACTLY (same tracker, same `{ ttl: 60_000, limit: 20 }`) and keeps
  //    per-(token, IP) fairness: a real buyer reloading their ONE valid link
  //    stays far under 20/min and is isolated from traffic to other tokens.
  //
  //  LAYER 2 — `storefront-join-ip` throttler, IP-ONLY key at 120/min.
  //    Layer 1 alone does NOT bound distinct-token PROBING from one IP:
  //    each guessed token gets its OWN 20/min composite bucket, so a single
  //    IP could enumerate many tokens at 20 attempts EACH (the P1 finding).
  //    This second layer drops the token from the key
  //    (`storefront-join-ip:<ip>`, via storefrontJoinIpTracker) so ALL of an
  //    IP's distinct-token join GETs share ONE 120/min budget — bounding an
  //    enumeration sweep across the whole token space. 120/min is generous
  //    enough for legitimate shared-NAT/CGNAT traffic (≈6 distinct real
  //    buyers behind one IP can each reach their token's 20/min ceiling
  //    before this bites) while making bulk token enumeration impractical.
  //
  // The two layers are coordinated: Layer 1 protects each individual link
  // from per-(token, IP) hammering; Layer 2 caps the aggregate distinct-token
  // attempts per source IP. Valid single-token traffic is unaffected by
  // either; only the abuse paths are tightened.
  //
  // R2 P1 (throttler ISOLATION) — @SkipThrottle disables every OTHER named
  // throttler on this route. Without it, NestJS would also run unrelated
  // low-ceiling throttlers (auth-password-reset 3/hr, auth-signup 5/hr,
  // auth-recent-auth 5/min, …) here; because the guard's default tracker on
  // this route is the composite `storefront-join:<token>:<ip>` key, those
  // unrelated buckets would key by (token, IP) and reject the 4th same-token
  // load — far below the intended 20/min composite ceiling. Skipping them
  // guarantees this route is governed by EXACTLY the two layers above (no
  // shared bucket exhaustion from another module's named throttler).
  @Public()
  @SkipThrottle(STOREFRONT_JOIN_SKIP_THROTTLERS)
  @Throttle({
    [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 20 },
    [THROTTLER_NAMES.STOREFRONT_JOIN_IP]: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN,
      getTracker: (req: Record<string, unknown>) =>
        storefrontJoinIpTracker(req),
    },
  })
  @Get('join/:token')
  async getPublicPackage(@Param('token', new ShareTokenPipe()) token: string) {
    return this.storefront.getPublicPackageByToken(token);
  }

  // POST /api/v1/packages/public/join/:token/checkout
  // Creates (or replays) the Stripe PaymentIntent. Tighter throttle: a
  // single coach link should not see >20 checkout attempts per minute
  // from one IP unless something is wrong.
  //
  // r48 #10 + #11: long-window IP limiter backs up the per-minute
  // Nest throttler; on success we attach the signed 7-day guest-
  // session cookie so a returning buyer can surface recent purchases
  // without a re-confirm.
  //
  // A276-F4-P1-B — per-route bucket scope `create-intent` at 10/hr.
  // See `resumeGuestCheckout` below for the design rationale; the
  // ceiling on this route is set above the 5/hr default because the
  // bucket is no longer shared with three sibling routes — a real
  // buyer who reloads the page, hits a flaky 3DS, and retries can
  // safely consume up to 10 mint attempts before getting locked out
  // of *only this route*.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('join/:token/checkout')
  @HttpCode(HttpStatus.OK)
  async createGuestCheckout(
    @Param('token', new ShareTokenPipe()) token: string,
    @Body() body: GuestCheckoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    // R47 / Audit #6 P0-5 — landing page id propagation. The landing-page
    // checkout redirect appends `?lp=<pageId>`. We accept it as a query
    // param (rather than baking it into the body DTO) so existing direct
    // storefront integrations continue to work without modification.
    // Service-side, the id is validated against (a) the coach who owns
    // the share_token's package and (b) the page lists that package.
    @Query('lp') lp?: string,
  ) {
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip, {
      scope: RATE_LIMIT_SCOPES.CreateIntent,
      maxAttempts: 10,
    });
    if (!rate.allowed) {
      // 429 with Retry-After header (seconds until next bucket).
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new HttpException(
        {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many checkout attempts. Please try again later.',
          retry_after_seconds: rate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const result = await this.guestCheckout.createIntent(token, body, lp);
    // r48 #11 — attach the 7-day signed cookie.  Best-effort:
    // a write failure does NOT roll back the checkout (the response
    // body still carries everything the storefront needs).
    await this.cookies.setSessionCookie(res, {
      email: body.guest_email,
      guest_checkout_id: result.guest_checkout_id,
    });
    return result;
  }

  // r48 #4 — POST /v1/packages/public/join/:token/checkout/resume
  //
  // Called by the storefront on network reconnect to pick up an in-
  // flight checkout without re-confirming the form. Returns either the
  // existing GuestCheckout row's resumable details, or 404 when nothing
  // recoverable exists (or when the resume window has expired).
  //
  // A276-P1-2 / A276-F4-P1-B — long-window IP rate limiter with a
  // PER-ROUTE bucket scope.
  //
  // The previous revision shared a single 5/hr bucket across four
  // recovery routes. A real buyer behind CGNAT (university/corporate
  // WiFi, mobile carrier) doing normal retries could exhaust the
  // shared bucket in one checkout session and earn a 60-minute 429
  // on every endpoint, including the redirect they were about to
  // click — a conversion-killing failure mode on a money path.
  //
  // Per-route buckets restore the abuse-resistance property (each
  // bucket is still per-IP, hour-windowed, Redis-backed) while
  // ensuring a buyer who burns one route's budget can still complete
  // checkout via the others. The cost asymmetry between routes
  // justifies different ceilings:
  //   • /create-intent   — 10/hr (Stripe API call, but no email)
  //   • /resume          —  5/hr (redirect-only; matches prior bound)
  //   • /send-recovery-link — 3/hr (only cost-amplifying route;
  //     bounded ≤ the EmailSendLog per-recipient 3/hr cap so the
  //     IP-level limit cannot exceed the per-recipient one)
  //   • /resume/:jwt     — 10/hr (verify-only, no cost, looser to
  //     accommodate users clicking the same email link twice)
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('join/:token/checkout/resume')
  @HttpCode(HttpStatus.OK)
  async resumeGuestCheckout(
    @Param('token', new ShareTokenPipe()) token: string,
    @Body() body: GuestCheckoutResumeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A276-F4-P1-B — per-route bucket: scope=resume, 5/hr.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip, {
      scope: RATE_LIMIT_SCOPES.Resume,
      maxAttempts: 5,
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new HttpException(
        {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many checkout attempts. Please try again later.',
          retry_after_seconds: rate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const result = await this.recovery.resumeFromCredentials(
      token,
      body.guest_email,
    );
    if (!result) {
      // Same enumeration-resistant 404 shape the rest of the public
      // surface uses.
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }
    return result;
  }

  // r48 #5 — POST /v1/packages/public/join/:token/checkout/send-recovery-link
  //
  // Mints a 15-min recovery JWT and emails it to the guest. Returns
  // { sent: true } regardless of whether a matching checkout exists
  // (enumeration resistance). Tighter throttle than the create path
  // because this triggers an outbound email.
  //
  // A276-P1-2 / A276-F4-P1-B — dedicated per-route IP bucket at 3/hr.
  // This is the only cost-amplifying route in the recovery flow, so
  // its ceiling is the tightest of the four. The IP-level limit is
  // deliberately bounded at 3/hr to match (not exceed) the
  // EmailSendLog per-recipient 3/hr cap downstream, so an attacker
  // cycling recipient addresses still cannot pump more than 3 emails
  // per source IP per hour regardless of how many addresses they
  // try. The bucket is no longer shared with /resume or
  // /resume/:jwt, so a real buyer who burns this budget can still
  // complete checkout via the other routes.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  @Post('join/:token/checkout/send-recovery-link')
  @HttpCode(HttpStatus.OK)
  async sendRecoveryLink(
    @Param('token', new ShareTokenPipe()) token: string,
    @Body() body: SendRecoveryLinkDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A276-F4-P1-B — per-route bucket: scope=send-recovery-link, 3/hr.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip, {
      scope: RATE_LIMIT_SCOPES.SendRecoveryLink,
      maxAttempts: 3,
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new HttpException(
        {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many checkout attempts. Please try again later.',
          retry_after_seconds: rate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.recovery.sendRecoveryLink(token, body.guest_email);
  }

  // r48 #5 — GET /v1/packages/public/join/:token/checkout/resume/:jwt
  //
  // Verifies the magic-link JWT and 302s the visitor back to the SSR
  // checkout page with the guest_checkout_id pre-attached. We do the
  // verification + cross-check in the service so the route stays a
  // thin redirect.
  //
  // A276-P1-2 / A276-F4-P1-B — IP rate limiter on its own per-route
  // bucket (scope=resume-jwt) at 10/hr. The route is verify-only
  // (no Stripe call, no email, no DB write beyond the single-use
  // claim), so the ceiling is set looser than the cost-amplifying
  // /send-recovery-link route. A real user who clicks the recovery
  // email twice (mobile preview + actual tap) must not be locked
  // out; 10/hr accommodates that while still bounding brute-force
  // attempts against the 15-min JWT space well below 30/min.
  // A276-P1-3 (controller half) — `Referrer-Policy: no-referrer` is
  // set on the redirect response so the destination origin never
  // sees the prior `…/resume/<jwt>` URL via the Referer header.
  // (The single-use enforcement of the JWT itself lives in
  // checkout-recovery.service.ts and is handled in a companion
  // commit.)
  //
  // Note: @Redirect is replaced with explicit res.redirect so we can
  // set headers on the same response. The 302 status is preserved.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get('join/:token/checkout/resume/:jwt')
  async resumeFromMagicLink(
    @Param('token', new ShareTokenPipe()) token: string,
    @Param('jwt') jwt: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // A276-F4-P1-B — per-route bucket: scope=resume-jwt, 10/hr.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip, {
      scope: RATE_LIMIT_SCOPES.ResumeJwt,
      maxAttempts: 10,
    });
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      throw new HttpException(
        {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many checkout attempts. Please try again later.',
          retry_after_seconds: rate.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const claims = await this.recovery.verifyToken(token, jwt);
    const base = (
      this.config.get<string>('STOREFRONT_BASE_URL') ??
      'https://joingrowthproject.com'
    ).replace(/\/+$/, '');
    // SSR layer accepts ?resume=<guest_checkout_id> on the join page
    // to re-attach the abandoned checkout. The destination URL
    // intentionally does NOT carry the JWT in any query param — the
    // share_token and guest_checkout_id are the only values forwarded
    // (audit A276-P1-3).
    const url = `${base}/p/${encodeURIComponent(
      claims.share_token,
    )}?resume=${encodeURIComponent(claims.guest_checkout_id)}`;
    // A276-P1-3 (controller half) — prevent Referer leakage of the
    // 15-min recovery JWT to the storefront origin.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(HttpStatus.FOUND, url);
  }

  // PR-15A — SSR thank-you / return page. Stripe's hosted checkout
  // success_url redirects buyers here with `?session_id={CHECKOUT_SESSION_ID}`
  // (the standard storefront return template). The page reaches parity
  // with the in-app PurchaseUnpackScreen: receipt summary + "unlocked
  // now" + "coming up" + recurring next-charge.
  //
  // Auth model: the Stripe checkout session id is the entry credential.
  // ThankYouService 404s on (a) unknown session, (b) not-yet-entitled
  // purchase. No JWT required (this IS the post-purchase return for
  // guest buyers who don't have an account yet). Page is
  // `noindex,nofollow` and references the just-converted buyer's drops
  // ONLY — never any other purchase's data.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('thank-you')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'private, no-store')
  async thankYouPage(@Query('session_id') sessionId: string): Promise<string> {
    // Empty/missing session_id surfaces as a 404 from the service
    // rather than rendering a blank page.
    const vm = await this.thankYou.buildViewModel(sessionId ?? '');
    return renderThankYouPage(vm);
  }
}
