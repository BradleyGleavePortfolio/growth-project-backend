import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { GetAppService, Platform } from './get-app.service';

// Public, server-rendered "Get the app" interstitial.
//
// Mounted OUTSIDE the `/api` global prefix (see main.ts setGlobalPrefix
// `exclude`) so the URLs are short, share-friendly, and usable as
// APP_STORE_URL / PLAY_STORE_URL in Fly secrets before real App Store /
// Play Store listings exist:
//
//   https://api.thegrowthproject.app/get-app          → generic interstitial
//   https://api.thegrowthproject.app/get-app/ios      → iOS-specific copy
//   https://api.thegrowthproject.app/get-app/android  → Android-specific copy
//
// The ?code=<invite> query is optional and forwarded to PUBLIC_WEB_SIGNUP_URL
// so a coach's QR code printed before the app ships still attaches the
// student to the right coach when they sign up on the web.
@Controller()
export class GetAppController {
  constructor(private getApp: GetAppService) {}

  @Public()
  @Get('get-app')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async generic(@Query('code') code: string | undefined, @Res() res: Response) {
    return this.respond('unknown', code, res);
  }

  @Public()
  @Get('get-app/ios')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async ios(@Query('code') code: string | undefined, @Res() res: Response) {
    return this.respond('ios', code, res);
  }

  @Public()
  @Get('get-app/android')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async android(@Query('code') code: string | undefined, @Res() res: Response) {
    return this.respond('android', code, res);
  }

  private respond(platform: Platform, rawCode: string | undefined, res: Response) {
    // Length-bound the code before forwarding so a malformed query string
    // can't be reflected unbounded into the rendered HTML. The render path
    // escapes everything, but bounding here keeps the surface small.
    const code =
      typeof rawCode === 'string' && rawCode.length >= 3 && rawCode.length <= 32
        ? rawCode
        : null;

    const webSignup =
      process.env.PUBLIC_WEB_SIGNUP_URL ||
      process.env.PUBLIC_INVITE_BASE_URL ||
      'https://app.tgp.com/join';

    const html = this.getApp.render({
      platform,
      webSignupUrl: webSignup,
      inviteCode: code,
    });

    // No-store: the copy can change at any time (e.g. once real listings
    // ship and we replace this interstitial with a 302 to the live store
    // URL). Page is small (<3 KB gz) so per-visit fetch is fine.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(HttpStatus.OK).send(html);
  }
}
