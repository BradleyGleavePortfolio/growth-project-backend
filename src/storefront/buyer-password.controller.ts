import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { SHARE_TOKEN_REGEX } from '../share-link/share-link.service';
import { THROTTLER_NAMES } from '../throttler/throttler.config';
import { BuyerPasswordService } from './buyer-password.service';
import { STOREFRONT_JOIN_SKIP_THROTTLERS, storefrontJoinIpTracker } from './storefront-public.controller';

// WEB-BUYER-FLOW (owner #172-7 op 1) — POST
// /api/v1/packages/public/join/:token/checkout/set-password, called by the
// confirm page (/p/:token?confirmed=1) only. Body { access_token, password }.
// 200 { saved: true } | 400 PASSWORD_WEAK | 401 LINK_INVALID (bad, expired,
// used or not a confirm-link session; one answer for all) | 429 | 503
// SET_PASSWORD_UNAVAILABLE. Per IP 5/min and 10/hour. Off (the same 404 as
// an unmounted route) unless GUEST_PAY_PAGE_ENABLED is exactly "true", like
// the pages that call it.
export class SetBuyerPasswordDto {
  @IsString()
  @MaxLength(4096)
  access_token!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}

@ApiExcludeController()
@Controller('v1/packages/public')
export class BuyerPasswordController {
  constructor(
    private readonly passwords: BuyerPasswordService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipThrottle(STOREFRONT_JOIN_SKIP_THROTTLERS)
  @Throttle({
    [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 5 },
    [THROTTLER_NAMES.STOREFRONT_JOIN_IP]: {
      ttl: 3_600_000,
      limit: 10,
      getTracker: (req: Record<string, unknown>) => storefrontJoinIpTracker(req),
    },
  })
  @Post('join/:token/checkout/set-password')
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @Param('token') token: string,
    @Body() body: SetBuyerPasswordDto,
    @Req() req: Request,
  ) {
    if (this.config.get<string>('GUEST_PAY_PAGE_ENABLED') !== 'true') {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    if (typeof token !== 'string' || !SHARE_TOKEN_REGEX.test(token)) {
      throw new NotFoundException({ error: 'TOKEN_NOT_FOUND', message: 'This link is not available.' });
    }
    return this.passwords.setPassword(body.access_token, body.password);
  }
}
