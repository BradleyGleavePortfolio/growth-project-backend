import { Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  renderDigestUnsubscribePage,
  type DigestUnsubscribeState,
} from '../public-pages/public-pages.html';
import { EMAIL_UNSUBSCRIBE_PATH, UNSUBSCRIBE_KINDS, verifyUnsubscribeToken } from './digest-links';
import { NotificationsService } from './notifications.service';

/**
 * B-DIGEST-127 — one-click unsubscribe for digest emails, no sign-in.
 *
 * GET  /email/unsubscribe?t=<token>  confirm page; changes nothing, so a mail
 *                                    scanner that follows links turns nothing off.
 * POST /email/unsubscribe?t=<token>  turns the token's preference off
 *                                    (digest -> NotificationPreferences.digest_email,
 *                                    the field the digest scheduler reads). This is
 *                                    the List-Unsubscribe target (RFC 8058: the mail
 *                                    app POSTs "List-Unsubscribe=One-Click"), and the
 *                                    confirm page's button.
 * The token alone names the user (see digest-links.ts); nothing else is read.
 */
@ApiTags('public-pages')
@Controller()
export class DigestUnsubscribeController {
  private readonly logger = new Logger(DigestUnsubscribeController.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Public()
  @Get('email/unsubscribe')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  confirm(@Query('t') token: string | undefined, @Res() res: Response) {
    const check = verifyUnsubscribeToken(token);
    if (!check.ok) return this.send(res, HttpStatus.BAD_REQUEST, check.reason);
    const action = `${EMAIL_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(String(token))}`;
    return this.send(res, HttpStatus.OK, 'confirm', action);
  }

  @Public()
  @Post('email/unsubscribe')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  async unsubscribe(
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const check = verifyUnsubscribeToken(token);
    if (!check.ok) return this.send(res, HttpStatus.BAD_REQUEST, check.reason);
    const field = UNSUBSCRIBE_KINDS[check.kind];
    await this.notifications.updatePreferences(
      check.userId,
      { [field]: false },
      {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        actorRole: 'email_unsubscribe_link',
      },
    );
    this.logger.log(`email unsubscribe: user=${check.userId} kind=${check.kind}`);
    return this.send(res, HttpStatus.OK, 'done');
  }

  private send(res: Response, status: number, state: DigestUnsubscribeState, action?: string) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    // The token is in the URL: never pass it on to another site.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(status).send(renderDigestUnsubscribePage(state, action));
  }
}
