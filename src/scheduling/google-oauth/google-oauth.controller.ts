import * as crypto from 'crypto';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { GoogleOAuthService } from './google-oauth.service';

// GoogleOAuthController — minimal two-endpoint flow.
//
//   GET /scheduling/auth/google/initiate
//       Authed (user must be logged in). Mints a state nonce binding
//       the OAuth handshake to the caller's user id, returns a 302
//       redirect to Google's consent screen. The mobile client opens
//       this in an in-app browser.
//
//   GET /scheduling/auth/google/callback
//       Public (Google posts here without a TGP JWT). Verifies the
//       state nonce, exchanges the code for tokens, persists the
//       CalendarConnection row, then issues a 302 back to the mobile
//       app's deep-link return URL.
//
// State nonce format: `${userId}:${base64url(randomBytes(16))}`.
// The randomBytes half is a CSRF guard; we recompute and compare in
// the callback against an in-process Map. A production deployment
// will swap the in-process Map for a Redis SET with a short TTL —
// flagged inline.

const STATE_NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const _stateNonces = new Map<string, { userId: string; expiresAt: number }>();

@ApiTags('scheduling')
@Controller('scheduling/auth/google')
export class GoogleOAuthController {
  constructor(private readonly oauth: GoogleOAuthService) {}

  @Get('initiate')
  @UseGuards(JwtAuthGuard)
  initiate(@Req() req: AuthedRequest, @Res() res: Response): void {
    if (!GoogleOAuthService.isFeatureFlagOn()) {
      throw new NotFoundException();
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const stateKey = `${req.user.id}:${nonce}`;
    _stateNonces.set(stateKey, {
      userId: req.user.id,
      expiresAt: Date.now() + STATE_NONCE_TTL_MS,
    });
    const url = this.oauth.buildAuthorizeUrl({
      userId: req.user.id,
      state: stateKey,
    });
    res.redirect(302, url);
  }

  // PUBLIC — Google posts the callback without our JWT. CSRF is
  // mitigated by the signed `state` nonce.
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!GoogleOAuthService.isFeatureFlagOn()) {
      throw new NotFoundException();
    }
    if (error) {
      // User declined consent — bounce back to the app with the reason.
      res.redirect(
        302,
        this.appReturnUrl({ status: 'error', detail: error.slice(0, 64) }),
      );
      return;
    }
    if (!code || !state) {
      throw new BadRequestException({
        error: 'Missing code or state',
        code: 'GOOGLE_OAUTH_CALLBACK_MALFORMED',
      });
    }
    const entry = _stateNonces.get(state);
    _stateNonces.delete(state); // single-use
    if (!entry) {
      throw new BadRequestException({
        error: 'state nonce not recognised',
        code: 'GOOGLE_OAUTH_STATE_INVALID',
      });
    }
    if (entry.expiresAt < Date.now()) {
      throw new BadRequestException({
        error: 'state nonce expired',
        code: 'GOOGLE_OAUTH_STATE_EXPIRED',
      });
    }

    const tokens = await this.oauth.exchangeCode({
      code,
      userId: entry.userId,
    });
    const googleAccountEmail = this.parseEmailFromIdToken(tokens.id_token);
    if (googleAccountEmail) {
      await this.oauth.persistConnection({
        userId: entry.userId,
        googleAccountEmail,
        scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
      });
    }

    res.redirect(302, this.appReturnUrl({ status: 'ok' }));
  }

  private appReturnUrl(payload: {
    status: 'ok' | 'error';
    detail?: string;
  }): string {
    const base = process.env.APP_URL?.trim() || 'https://app.thegrowthproject.app';
    const u = new URL(`${base.replace(/\/+$/, '')}/settings/integrations`);
    u.searchParams.set('google_oauth', payload.status);
    if (payload.detail) u.searchParams.set('detail', payload.detail);
    return u.toString();
  }

  private parseEmailFromIdToken(idToken: string | undefined): string | null {
    if (!idToken) return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as { email?: string };
      return typeof payload.email === 'string' ? payload.email : null;
    } catch {
      return null;
    }
  }
}
