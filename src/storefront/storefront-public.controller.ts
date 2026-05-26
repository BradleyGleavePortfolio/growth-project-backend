import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  PipeTransform,
  Post,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
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
import { CheckoutIpRateLimiterService } from './checkout-rate-limiter.service';
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
  ) {}

  // Extract a client IP from the request, honoring Fly's
  // `fly-client-ip` then x-forwarded-for chains.  Defensive against
  // malformed/missing headers — never returns empty.
  private extractIp(req: Request): string {
    const flyIp = (req.headers['fly-client-ip'] as string | undefined)?.trim();
    if (flyIp) return flyIp;
    const xff = (req.headers['x-forwarded-for'] as string | undefined) ?? '';
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    return (req.ip ?? req.socket?.remoteAddress ?? 'unknown').toString();
  }

  // GET /api/v1/packages/public/join/:token
  // Returns coach + package metadata for the storefront SSR layer.
  // Hot path — keep cheap.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('join/:token')
  async getPublicPackage(@Param('token', new ShareTokenPipe()) token: string) {
    return this.storefront.getPublicPackageByToken(token);
  }

  // POST /api/v1/packages/public/join/:token/checkout
  // Creates (or replays) the Stripe PaymentIntent. Tighter throttle: a
  // single coach link should not see >20 checkout attempts per minute
  // from one IP unless something is wrong.
  //
  // r48 #10 + #11: long-window IP limiter (5/hour) backs up the
  // per-minute Nest throttler; on success we attach the signed
  // 7-day guest-session cookie so a returning buyer can surface
  // recent purchases without a re-confirm.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('join/:token/checkout')
  @HttpCode(HttpStatus.OK)
  async createGuestCheckout(
    @Param('token', new ShareTokenPipe()) token: string,
    @Body() body: GuestCheckoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip);
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
    const result = await this.guestCheckout.createIntent(token, body);
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
  // A276-P1-2 — apply the long-window IP rate limiter (5/hour, Redis-
  // backed) so the three recovery routes share the same hour-scale
  // budget the create-intent path uses. The limiter exposes a single
  // per-IP bucket (no per-route key); we therefore apply it uniformly
  // to all three new routes (resume, send-recovery-link, resume/:jwt)
  // — option (2) from the audit. A separate per-bucket key would have
  // been preferable for the email path but is out-of-scope for this
  // controller-level fix; an attacker who burns the 5/hr bucket on
  // resume calls also loses access to the email-send path, which is a
  // net win for abuse resistance.
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
    // A276-P1-2 — long-window IP bucket (5/hr) before doing work.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip);
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
  // A276-P1-2 — also gated by the long-window IP rate limiter (5/hr).
  // The bucket is shared with the create-intent and resume routes
  // (see resumeGuestCheckout note). EmailSendLog provides a separate
  // per-recipient 3/hr cap downstream; together they bound an
  // attacker to 5 send attempts per IP per hour regardless of how
  // many recipient addresses they try.
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
    // A276-P1-2 — long-window IP bucket (5/hr) before triggering email.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip);
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
  // A276-P1-2 — IP rate limiter (5/hr) applied before verifyToken so
  // an attacker cannot brute-force the 15-min JWT space at 30/min.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get('join/:token/checkout/resume/:jwt')
  @Redirect(undefined, HttpStatus.FOUND)
  async resumeFromMagicLink(
    @Param('token', new ShareTokenPipe()) token: string,
    @Param('jwt') jwt: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A276-P1-2 — long-window IP bucket (5/hr) before verifying token.
    const ip = this.extractIp(req);
    const rate = await this.ipLimiter.checkAndIncrement(ip);
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
    // to re-attach the abandoned checkout.
    return {
      url: `${base}/p/${encodeURIComponent(
        claims.share_token,
      )}?resume=${encodeURIComponent(claims.guest_checkout_id)}`,
      statusCode: HttpStatus.FOUND,
    };
  }
}
