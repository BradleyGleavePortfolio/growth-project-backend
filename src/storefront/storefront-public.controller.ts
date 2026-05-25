import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { GuestCheckoutDto } from './storefront.dto';
import { GuestCheckoutService } from './guest-checkout.service';
import { StorefrontService } from './storefront.service';

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
  ) {}

  // GET /api/v1/packages/public/join/:token
  // Returns coach + package metadata for the storefront SSR layer.
  // Hot path — keep cheap.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('join/:token')
  async getPublicPackage(@Param('token') token: string) {
    return this.storefront.getPublicPackageByToken(token);
  }

  // POST /api/v1/packages/public/join/:token/checkout
  // Creates (or replays) the Stripe PaymentIntent. Tighter throttle: a
  // single coach link should not see >20 checkout attempts per minute
  // from one IP unless something is wrong.
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('join/:token/checkout')
  @HttpCode(HttpStatus.OK)
  async createGuestCheckout(
    @Param('token') token: string,
    @Body() body: GuestCheckoutDto,
  ) {
    return this.guestCheckout.createIntent(token, body);
  }
}
