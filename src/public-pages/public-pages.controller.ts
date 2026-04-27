import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  renderDownloadPage,
  renderSignupPage,
  type DownloadPlatform,
} from './public-pages.html';

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

  @Public()
  @Get('signup')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  signup(@Res() res: Response) {
    return this.send(res, renderSignupPage());
  }

  private send(res: Response, html: string) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The page contents change only on deploy; allow a short edge cache
    // so a viral invite link does not slam the origin. 5 minutes is
    // tight enough that operator-driven content changes (e.g. flipping
    // wording when the App Store listing goes live) propagate quickly.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(HttpStatus.OK).send(html);
  }

  // Re-exported so callers / tests can keep the platform union narrow
  // without importing from the html module directly.
  static readonly platforms: DownloadPlatform[] = ['ios', 'android'];
}
