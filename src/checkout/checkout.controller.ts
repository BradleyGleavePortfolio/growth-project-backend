import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';
import { CheckoutService } from './checkout.service';

// Allowed URL schemes for redirect URLs. We only accept our own deep-link
// scheme and https so Stripe cannot be tricked into redirecting to arbitrary
// origins. This is an allow-list, not a regex: the value must START with one
// of these prefixes.
const ALLOWED_URL_PREFIXES = [
  'growthproject://',
  'com.growthproject.app://',
  'https://',
] as const;

function isAllowedUrl(url: string | undefined): boolean {
  if (!url) return true; // undefined is fine — we use the env default
  return ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// Runtime-validated request body for session creation.
// class-validator decorators run at the controller boundary via ValidationPipe
// so TypeScript types alone no longer protect us at runtime.
export class CreateCheckoutDto {
  @IsUUID()
  package_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  // Only our deep-link scheme or https are valid redirect targets.
  // String form avoids the //:// comment ambiguity in TS regex literals.
  @Matches(new RegExp('^(growthproject:\/\/|com\.growthproject\.app:\/\/|https:\/\/)'), {
    message: 'success_url must start with growthproject://, com.growthproject.app://, or https://',
  })
  success_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(new RegExp('^(growthproject:\/\/|com\.growthproject\.app:\/\/|https:\/\/)'), {
    message: 'cancel_url must start with growthproject://, com.growthproject.app://, or https://',
  })
  cancel_url?: string;
}

export class CreatePaymentIntentDto {
  @IsUUID()
  package_id!: string;
}

// Client-facing: open a Stripe Checkout session for a package and read
// the list of past / current purchases.
//
// All routes are JWT-authed. Any authenticated user can open a checkout
// (mobile clients, web). The package itself enforces ownership via the
// coach_id <-> coach relationship.

@ApiTags('checkout')
@Controller('v1/checkout')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class CheckoutController {
  constructor(private checkout: CheckoutService) {}

  @Post('sessions')
  @Throttle({
    [THROTTLER_NAMES.CHECKOUT_MINT]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.CHECKOUT_MINT_PER_HOUR,
    },
  })
  async createSession(
    @Request() req: AuthedRequest,
    @Body() body: CreateCheckoutDto,
  ) {
    // Double-check URL allow-list (belt-and-suspenders; class-validator
    // Matches decorator above is the first gate).
    if (!isAllowedUrl(body.success_url) || !isAllowedUrl(body.cancel_url)) {
      throw new HttpException(
        { error: 'INVALID_URL', message: 'Redirect URLs must use the growthproject:// scheme or https://' },
        400,
      );
    }
    try {
      return await this.checkout.createCheckoutForClient(req.user.id, body);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  @Post('payment-intent')
  @Throttle({
    [THROTTLER_NAMES.CHECKOUT_MINT]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.CHECKOUT_MINT_PER_HOUR,
    },
  })
  async createPaymentIntent(
    @Request() req: AuthedRequest,
    @Body() body: CreatePaymentIntentDto,
  ) {
    try {
      return await this.checkout.createPaymentIntentForClient(req.user.id, body);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  @Get('purchases')
  @SkipClientEntitlement()
  async listPurchases(
    @Request() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    // M11 fix: use hasMore from the service (limit+1 probe) instead of
    // inferring "more pages" from result.length === limit.
    const { items, hasMore } = await this.checkout.listForClient(req.user.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    const next_cursor = hasMore ? items[items.length - 1]?.id ?? null : null;
    return { purchases: items, next_cursor };
  }

  @Get('entitlement')
  @SkipClientEntitlement()
  async checkEntitlement(
    @Request() req: AuthedRequest,
    @Query('package_id') packageId?: string,
    @Query('coach_user_id') coachUserId?: string,
  ) {
    const active = await this.checkout.hasActiveEntitlement(req.user.id, {
      packageId,
      coachUserId,
    });
    return { entitlement_active: active };
  }

  @Get('payment-method')
  @SkipClientEntitlement()
  async paymentMethod(@Request() req: AuthedRequest) {
    return this.checkout.getSavedPaymentMethodForClient(req.user.id);
  }

  /**
   * POST /v1/checkout/billing-portal
   *
   * Creates a Stripe Billing Portal session for the requesting client so
   * they can update their payment method during a dunning window.
   *
   * M10 fix: surfaces the update-card URL to past-due clients instead
   * of leaving `dunning.update_card_url` null.
   */
  @Post('billing-portal')
  @SkipClientEntitlement()
  async createBillingPortal(@Request() req: AuthedRequest) {
    try {
      return await this.checkout.createBillingPortalSession(req.user.id);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  /**
   * GET /v1/checkout/sessions/:sessionId/confirm
   *
   * Called after the client returns from the Stripe-hosted checkout page
   * (via the success deep-link). Verifies the session belongs to the
   * requesting user and returns the actual payment status from Stripe.
   *
   * M9 fix: previously the mobile client ignored the session_id entirely
   * and just polled the generic entitlement endpoint. This endpoint
   * uses the specific session id to confirm payment so webhook lag
   * doesn't cause a false "pending" state.
   */
  @Get('sessions/:sessionId/confirm')
  @SkipClientEntitlement()
  async confirmSession(
    @Param('sessionId') sessionId: string,
    @Request() req: AuthedRequest,
  ) {
    try {
      return await this.checkout.confirmSession(sessionId, req.user.id);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  private mapStripeError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof StripeConnectApiError) {
      const status =
        err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
      return new HttpException(
        {
          error: 'STRIPE_CHECKOUT_ERROR',
          message: err.message,
          stripeCode: err.stripeCode,
        },
        status,
      );
    }
    return new HttpException(
      { error: 'INTERNAL', message: (err as Error)?.message ?? 'Unknown error' },
      500,
    );
  }
}

// Coach-side: read purchases on the coach's own roster (revenue feed).
@ApiTags('checkout')
@Controller('v1/coach/purchases')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class CoachPurchasesController {
  constructor(private checkout: CheckoutService) {}

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    // M11 fix: same limit+1 probe pattern.
    const { items, hasMore } = await this.checkout.listForCoach(req.user.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    const next_cursor = hasMore ? items[items.length - 1]?.id ?? null : null;
    return { purchases: items, next_cursor };
  }
}
