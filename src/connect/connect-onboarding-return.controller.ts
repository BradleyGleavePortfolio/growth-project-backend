import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';

// S-COACH (agent 111) — HTTPS landing pages for Stripe Connect Express
// onboarding. Stripe sends the coach to STRIPE_CONNECT_RETURN_URL /
// STRIPE_CONNECT_REFRESH_URL when they finish or when the single-use link
// has expired. Live-mode account links want web URLs, so the operator
// points both env values at these routes, and each one hands the coach
// straight back to the app (the in-app browser closes on the app-scheme
// redirect and the app re-reads the account from Stripe).
//
// The routes are public and stateless: no account id, token or user data is
// read or echoed, so they reveal nothing and change nothing.
export const CONNECT_APP_RETURN_URL = 'tgp://connect/onboarding/return';
export const CONNECT_APP_REFRESH_URL = 'tgp://connect/onboarding/refresh';

function landingHtml(appUrl: string, heading: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="refresh" content="0;url=${appUrl}">`,
    '<title>The Growth Project</title>',
    '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:48px 24px;color:#1a1a1a;background:#faf8f5}',
    'h1{font-size:22px;font-weight:600;margin:0 0 12px}p{font-size:16px;line-height:24px;margin:0 0 24px}',
    'a{display:inline-block;background:#1a1a1a;color:#fff;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600}</style>',
    '</head><body>',
    `<h1>${heading}</h1>`,
    `<p>${body}</p>`,
    `<a href="${appUrl}">Open The Growth Project</a>`,
    '</body></html>',
  ].join('');
}

@ApiTags('connect')
@Controller('v1/connect/onboarding')
export class ConnectOnboardingReturnController {
  @Public()
  @Get('return')
  onboardingReturn(@Res() res: Response): void {
    res.status(HttpStatus.FOUND);
    res.setHeader('Location', CONNECT_APP_RETURN_URL);
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('html')
      .send(
        landingHtml(
          CONNECT_APP_RETURN_URL,
          'Back to The Growth Project',
          'Your Stripe details are saved. Open the app to see your payout status.',
        ),
      );
  }

  @Public()
  @Get('refresh')
  onboardingRefresh(@Res() res: Response): void {
    res.status(HttpStatus.FOUND);
    res.setHeader('Location', CONNECT_APP_REFRESH_URL);
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('html')
      .send(
        landingHtml(
          CONNECT_APP_REFRESH_URL,
          'This Stripe link has expired',
          'Open the app and tap Continue with Stripe to get a fresh link. Your progress is kept.',
        ),
      );
  }
}
