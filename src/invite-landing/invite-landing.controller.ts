import { Controller, Get, Headers, HttpStatus, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { InviteLandingService, landingPlatformFromUserAgent } from './invite-landing.service';

// Public, server-rendered landing for `/join/:code` and `/invite/:code`.
//
// Mounted OUTSIDE the `/api` global prefix (see main.ts setGlobalPrefix
// `exclude`) so the URLs match the mobile app's universal-link config:
//   https://app.tgp.com/join/GP-A1B2C3   →  HTML landing
//   tgp://join/GP-A1B2C3                 →  app deep link (handled in-app)
//   /api/invite/:code/preview            →  JSON preview (existing route in
//                                           InviteCodesController; unchanged)
//
// The HTML route validates the code via the same preview service the JSON
// route uses and renders a quiet-luxury success page or a generic "invite
// unavailable" page. We intentionally do NOT distinguish between not-found
// / revoked / paused / canceled in the HTML — confirming "this code existed
// once" to a stranger is a small but real privacy leak.
@ApiTags('invite-landing')
@Controller()
export class InviteLandingController {
  constructor(private landing: InviteLandingService) {}

  // ----- HTML landing pages -----------------------------------------

  @Public()
  @Get('join/:code')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async joinHtml(
    @Param('code') code: string,
    @Res() res: Response,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.renderLanding(code, res, userAgent);
  }

  // /invite/:code is the alternate canonical landing — same renderer,
  // mounted so QR codes / printed invites can use either path without a
  // redirect (a redirect would round-trip through the CDN and feel sluggish).
  @Public()
  @Get('invite/:code')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async inviteHtml(
    @Param('code') code: string,
    @Res() res: Response,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.renderLanding(code, res, userAgent);
  }

  // ----- shared renderer --------------------------------------------

  private async renderLanding(code: string, res: Response, userAgent?: string) {
    // Length-bound the param before going to the database. The DTO layer
    // doesn't run on path params, so guard here to make brute-force
    // enumeration of garbage strings cheap to reject.
    if (!code || code.length > 32 || code.length < 3) {
      this.respondInvalid(res);
      return;
    }
    const preview = await this.landing.preview(code);
    if (!preview.valid) {
      this.respondInvalid(res);
      return;
    }

    const base =
      process.env.PUBLIC_INVITE_BASE_URL || 'https://app.trygrowthproject.com/join';
    // tgp:// is the custom scheme the app registers; it opens the installed
    // app on CreateAccount with the code filled in (or stores the code for a
    // signed-in user). The universal link (base/<code>) is the URL coaches
    // share; when a visitor sees this page the OS already declined to open
    // the app for it, so it is not offered again as a button (B-LINKS-123).
    const deepLink = `tgp://join/${code}`;
    // Until the App Store listing exists, APP_STORE_URL points at the durable
    // /download/ios status page. The old unset fallback (`.../id0`) was a
    // dead App Store link; fall back to the status page on the same host.
    const appStore = process.env.APP_STORE_URL || `${publicOrigin(base)}/download/ios`;
    const playStore =
      process.env.PLAY_STORE_URL ||
      'https://play.google.com/store/apps/details?id=com.growthproject.app';
    const androidPackage =
      (process.env.ANDROID_PACKAGE_NAME ?? '').trim() || 'com.growthproject.app';

    const html = this.landing.renderValid({
      code,
      coach_name: preview.coach_name,
      business_name: preview.business_name,
      accent_color: preview.branding.accent_color,
      logo_url: preview.branding.logo_url,
      deep_link_url: deepLink,
      app_store_url: appStore,
      play_store_url: playStore,
      android_package: androidPackage,
      platform: landingPlatformFromUserAgent(userAgent),
    });

    // No-cache: the underlying CoachProfile (paused / canceled / branding)
    // can change at any moment and we never want a stale "Open in app"
    // button to point a brand-new client at a paused coach. The page is
    // small (<3 KB gz), so paying the round-trip per visit is fine.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Vary', 'User-Agent');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(HttpStatus.OK).send(html);
  }

  private respondInvalid(res: Response) {
    const webSignup =
      process.env.PUBLIC_WEB_SIGNUP_URL ||
      process.env.PUBLIC_INVITE_BASE_URL ||
      'https://app.trygrowthproject.com/join';
    const html = this.landing.renderInvalid({ web_signup_url: webSignup });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 404 is the right shape for "this resource is not currently available
    // to you" — it covers not-found, revoked, expired, and paused/canceled
    // coaches without leaking which of those it was.
    res.status(HttpStatus.NOT_FOUND).send(html);
  }
}

// Origin of the public invite host (PUBLIC_INVITE_BASE_URL without /join).
function publicOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return 'https://app.trygrowthproject.com';
  }
}
