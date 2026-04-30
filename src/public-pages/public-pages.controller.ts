import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  renderDownloadPage,
  renderSignupPage,
  sanitizeInviteCode,
  type DownloadPlatform,
} from './public-pages.html';
import { renderTrustPage } from './trust-pages.html';
import { renderHelpPage, type HelpPage } from './help-pages.html';

// Durable, server-rendered status pages used as the operator-facing
// destinations for the prod-tier env vars APP_STORE_URL, PLAY_STORE_URL,
// and PUBLIC_WEB_SIGNUP_URL until the real App Store / Play Store
// listings and the marketing signup page exist.
//
// The point of these routes is to give the operator real URLs they can
// commit to Fly secrets without inventing Apple/Google identifiers that
// don't resolve. Once the store listings are live, the operator just
// updates the secret values and the invite-landing controller starts
// pointing at the real URLs without a code change.
//
// Mounted outside the `/api` prefix (see main.ts setGlobalPrefix
// `exclude`) so that, when DNS for app.trygrowthproject.com points at
// this Fly app, the URLs resolve as bare paths under the public
// hostname:
//
//   https://app.trygrowthproject.com/download/ios
//   https://app.trygrowthproject.com/download/android
//   https://app.trygrowthproject.com/signup
//   https://app.trygrowthproject.com/signup?code=GP-A1B2C3
//   https://app.trygrowthproject.com/signup/GP-A1B2C3
@ApiTags('public-pages')
@Controller()
export class PublicPagesController {
  @Public()
  @Get('download/ios')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  iosDownload(@Res() res: Response) {
    return this.send(res, renderDownloadPage('ios'));
  }

  @Public()
  @Get('download/android')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  androidDownload(@Res() res: Response) {
    return this.send(res, renderDownloadPage('android'));
  }

  // Canonical /signup. An invite code may arrive as ?code=… (the form
  // mobile and email links use today). The path variant /signup/:code
  // exists for printed / QR-encoded invites where putting the code in the
  // path produces a shorter, friendlier URL — mirrors the /join/:code
  // and /invite/:code pattern from InviteLandingController so the public
  // surface feels consistent.
  @Public()
  @Get('signup')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  signup(@Query('code') queryCode: string | undefined, @Res() res: Response) {
    return this.sendSignup(queryCode, res);
  }

  @Public()
  @Get('signup/:code')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  signupWithCode(@Param('code') pathCode: string, @Res() res: Response) {
    return this.sendSignup(pathCode, res);
  }

  private sendSignup(rawCode: string | undefined, res: Response) {
    const code = sanitizeInviteCode(rawCode);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (code) {
      // The per-code variant should not be cached at the CDN — even though
      // the URL itself is the cache key, no-store keeps the personalised
      // copy out of any shared cache and matches the convention in
      // InviteLandingController.
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else {
      // Static page; allow a short edge cache so a viral invite link does
      // not slam the origin. 5 minutes is tight enough that operator-
      // driven copy changes propagate quickly.
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    res.status(HttpStatus.OK).send(renderSignupPage(code));
  }

  // Trust pages — durable, server-rendered policy/status surface used as
  // the public destinations expected by app store reviewers and early
  // customers. See ./trust-pages.html.ts for editorial guard rails.

  @Public()
  @Get('privacy')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  privacy(@Res() res: Response) {
    return this.sendTrust(res, renderTrustPage('privacy'));
  }

  @Public()
  @Get('terms')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  terms(@Res() res: Response) {
    return this.sendTrust(res, renderTrustPage('terms'));
  }

  @Public()
  @Get('security')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  security(@Res() res: Response) {
    return this.sendTrust(res, renderTrustPage('security'));
  }

  @Public()
  @Get('status')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  status(@Res() res: Response) {
    return this.sendTrust(res, renderTrustPage('status'));
  }

  // Help surface — durable, server-rendered self-serve coach help. Source
  // copy lives in docs/help/ and is mirrored into ./help-pages.html.ts so a
  // coach can resolve setup, first-invite, FAQ, and support-routing
  // questions without emailing the operator. Every page links to the
  // others through a shared nav so the surface reads as one section.
  @Public()
  @Get('help')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpIndex(@Res() res: Response) {
    return this.sendHelp(res, 'index');
  }

  @Public()
  @Get('help/setup')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpSetup(@Res() res: Response) {
    return this.sendHelp(res, 'setup');
  }

  @Public()
  @Get('help/first-client')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpFirstClient(@Res() res: Response) {
    return this.sendHelp(res, 'first-client');
  }

  @Public()
  @Get('help/tour')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpTour(@Res() res: Response) {
    return this.sendHelp(res, 'tour');
  }

  @Public()
  @Get('help/faq')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpFaq(@Res() res: Response) {
    return this.sendHelp(res, 'faq');
  }

  @Public()
  @Get('help/support')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpSupport(@Res() res: Response) {
    return this.sendHelp(res, 'support');
  }

  @Public()
  @Get('help/contact')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  helpContact(@Res() res: Response) {
    return this.sendHelp(res, 'contact');
  }

  private send(res: Response, html: string) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(HttpStatus.OK).send(html);
  }

  // Trust pages share the same caching posture as the static download
  // pages (5 min edge cache; copy edits propagate quickly) but live in a
  // separate helper so a future change to one surface (e.g. longer cache
  // for /privacy if the copy stabilises) does not affect the other.
  private sendTrust(res: Response, html: string) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(HttpStatus.OK).send(html);
  }

  // Help pages share the same caching posture as the trust pages — they
  // are static and edits should propagate to coaches quickly. Kept in a
  // separate helper so a future change to one surface (longer cache once
  // copy stabilises, for example) does not bleed into the other.
  private sendHelp(res: Response, page: HelpPage) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(HttpStatus.OK).send(renderHelpPage(page));
  }

  // Re-exported so callers / tests can keep the platform union narrow
  // without importing from the html module directly.
  static readonly platforms: DownloadPlatform[] = ['ios', 'android'];
}
