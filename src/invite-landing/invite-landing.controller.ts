import { Controller, Get, HttpStatus, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { InviteLandingService } from './invite-landing.service';

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
@Controller()
export class InviteLandingController {
  constructor(private landing: InviteLandingService) {}

  // ----- HTML landing pages -----------------------------------------

  @Public()
  @Get('join/:code')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async joinHtml(@Param('code') code: string, @Res() res: Response) {
    return this.renderLanding(code, res);
  }

  // /invite/:code is the alternate canonical landing — same renderer,
  // mounted so QR codes / printed invites can use either path without a
  // redirect (a redirect would round-trip through the CDN and feel sluggish).
  @Public()
  @Get('invite/:code')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async inviteHtml(@Param('code') code: string, @Res() res: Response) {
    return this.renderLanding(code, res);
  }

  // ----- shared renderer --------------------------------------------

  private async renderLanding(code: string, res: Response) {
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
      process.env.PUBLIC_INVITE_BASE_URL || 'https://app.tgp.com/join';
    const webSignup = process.env.PUBLIC_WEB_SIGNUP_URL || `${base}/${code}`;
    // tgp:// is the custom scheme registered by the mobile app for cold-start
    // deep linking; the universal link works when the app is installed AND
    // when it isn't (the OS hands it to Safari/Chrome which lands here, on
    // this same page — recursion is fine because the user can then use the
    // store buttons). Keep both: tgp:// is the immediate-open path; the
    // https URL is the share-friendly canonical form.
    const universalLink = `${base}/${code}`;
    const deepLink = `tgp://join/${code}`;
    const appStore =
      process.env.APP_STORE_URL ||
      'https://apps.apple.com/app/the-growth-project/id0';
    const playStore =
      process.env.PLAY_STORE_URL ||
      'https://play.google.com/store/apps/details?id=com.tgp.app';

    const html = this.landing.renderValid({
      code,
      coach_name: preview.coach_name,
      business_name: preview.business_name,
      accent_color: preview.branding.accent_color,
      logo_url: preview.branding.logo_url,
      deep_link_url: deepLink,
      universal_link_url: universalLink,
      web_signup_url: webSignup,
      app_store_url: appStore,
      play_store_url: playStore,
    });

    // No-cache: the underlying CoachProfile (paused / canceled / branding)
    // can change at any moment and we never want a stale "Open in app"
    // button to point a brand-new client at a paused coach. The page is
    // small (<3 KB gz), so paying the round-trip per visit is fine.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(HttpStatus.OK).send(html);
  }

  private respondInvalid(res: Response) {
    const webSignup =
      process.env.PUBLIC_WEB_SIGNUP_URL ||
      process.env.PUBLIC_INVITE_BASE_URL ||
      'https://app.tgp.com/join';
    const html = this.landing.renderInvalid({ web_signup_url: webSignup });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 404 is the right shape for "this resource is not currently available
    // to you" — it covers not-found, revoked, expired, and paused/canceled
    // coaches without leaking which of those it was.
    res.status(HttpStatus.NOT_FOUND).send(html);
  }
}
