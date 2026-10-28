import { Controller, Get, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';
import { StorefrontService } from './storefront.service';
import { payDoneUrl } from './storefront-links';
import { PAY_DONE_REFRESH_SECONDS, readPayDone } from './pay-done';
import { renderPayDonePage } from './pay-done.html';
import { STOREFRONT_JOIN_SKIP_THROTTLERS, storefrontJoinIpTracker } from './storefront-public.controller';
import {
  APP_STORE_URL_DEFAULT,
  PAY_PAGE_COPY,
  renderConfirmedPage,
  renderPayPage,
  renderPayPageState,
} from './pay-page.html';

// Same shape the guest checkout accepts for `?lp=` (landing page id).
const LANDING_PAGE_ID = /^[a-z0-9]{20,40}$/i;

/** Route-level CSP: scripts only by nonce (plus Stripe.js), Stripe frames and API only. */
export function payPageHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://js.stripe.com https://*.js.stripe.com`,
      `style-src 'nonce-${nonce}'`,
      'img-src https: data:',
      'frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com',
      "connect-src 'self' https://api.stripe.com",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'private, no-store',
    // Wallet popups (Google Pay) need their opener; helmet's default is same-origin.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  };
}

// GC-1 — GET /p/:token, outside the /api prefix (#GC-DOMAIN
// app.trygrowthproject.com/p/<code>). Off unless GUEST_PAY_PAGE_ENABLED is
// exactly "true": then it answers the same 404 as an unmounted route.
// Throttled like GET /api/v1/packages/public/join/:token, sharing its
// IP-wide bucket so the page is no cheaper to probe than the JSON route.
@ApiExcludeController()
@Controller('p')
export class PayPageController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
  ) {}

  @Public()
  @SkipThrottle(STOREFRONT_JOIN_SKIP_THROTTLERS)
  @Throttle({
    [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 20 },
    [THROTTLER_NAMES.STOREFRONT_JOIN_IP]: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN,
      getTracker: (req: Record<string, unknown>) => storefrontJoinIpTracker(req),
    },
  })
  @Get(':token')
  async payPage(
    @Param('token') token: string,
    @Query('lp') lp: unknown,
    @Query('confirmed') confirmed: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (this.config.get<string>('GUEST_PAY_PAGE_ENABLED') !== 'true') {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    const nonce = randomBytes(16).toString('base64');
    // GUEST-ELIGIBILITY (owner #170-2) — the new buyer's confirm link lands
    // here: app download + login email. No package lookup (the link must
    // still work if the coach later stops selling it).
    if (confirmed === '1') {
      const store = this.config.get<string>('APP_STORE_URL') ?? APP_STORE_URL_DEFAULT;
      res.status(200).set(payPageHeaders(nonce)).type('html').send(renderConfirmedPage(nonce, store));
      return;
    }
    let status = 200;
    let html: string;
    try {
      const { data, onBehalfOf } = await this.storefront.loadPublicPackage(token);
      const landing = typeof lp === 'string' && LANDING_PAGE_ID.test(lp) ? lp : null;
      const returnUrl = payDoneUrl(this.config.get<string>('STOREFRONT_BASE_URL'), token, landing);
      html = renderPayPage(data, { token, lp: landing, onBehalfOf, nonce, returnUrl });
    } catch (err) {
      // Only the share-link 404s become a page; anything else (503 with no
      // publishable key) keeps the API's JSON error.
      if (!(err instanceof NotFoundException)) throw err;
      const body = err.getResponse();
      const notReady = typeof body === 'object' && 'error' in body && body.error === 'PACKAGE_UNAVAILABLE';
      status = 404;
      html = renderPayPageState(notReady ? PAY_PAGE_COPY.notReady : PAY_PAGE_COPY.notOffered, nonce);
    }
    res.status(status).set(payPageHeaders(nonce)).type('html').send(html);
  }

  // GC-2 — Stripe's return_url for every buyer (card or wallet): the result
  // of the payment, read from Stripe (pay-done.ts). Same switch, throttles and
  // headers as GET /p/:token. Read-only, so reloading or opening it twice is
  // safe. Registered before LandingPagesModule's p/:coachSlug/:pageSlug
  // (StorefrontModule comes first in AppModule), so /p/<token>/done lands here.
  @Public()
  @SkipThrottle(STOREFRONT_JOIN_SKIP_THROTTLERS)
  @Throttle({
    [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 20 },
    [THROTTLER_NAMES.STOREFRONT_JOIN_IP]: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.STOREFRONT_JOIN_IP_PER_MIN,
      getTracker: (req: Record<string, unknown>) => storefrontJoinIpTracker(req),
    },
  })
  @Get(':token/done')
  async payDone(
    @Param('token') token: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (this.config.get<string>('GUEST_PAY_PAGE_ENABLED') !== 'true') {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    const nonce = randomBytes(16).toString('base64');
    const { view, refresh } = await readPayDone(
      { db: this.prisma, stripe: this.stripe, storefrontBase: this.config.get<string>('STOREFRONT_BASE_URL') },
      token,
      query,
    );
    const status = view.kind === 'unknown' ? 404 : view.kind === 'unavailable' ? 503 : 200;
    const store = this.config.get<string>('APP_STORE_URL') ?? APP_STORE_URL_DEFAULT;
    res.status(status).set(payPageHeaders(nonce));
    if (refresh) res.set('Refresh', `${PAY_DONE_REFRESH_SECONDS}; url=${refresh}`);
    res.type('html').send(renderPayDonePage(view, nonce, store));
  }
}
