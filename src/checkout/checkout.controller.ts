import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';
import { CheckoutService, CreateCheckoutInput } from './checkout.service';

// Client-facing: open a Stripe Checkout session for a package and read
// the list of past / current purchases.
//
// All routes are JWT-authed. Any authenticated user can open a checkout
// (mobile clients, web). The package itself enforces ownership via the
// coach_id <-> coach relationship.

@ApiTags('checkout')
@Controller('v1/checkout')
@UseGuards(JwtAuthGuard)
export class CheckoutController {
  constructor(private checkout: CheckoutService) {}

  @Post('sessions')
  async createSession(
    @Request() req: AuthedRequest,
    @Body() body: CreateCheckoutInput,
  ) {
    try {
      return await this.checkout.createCheckoutForClient(req.user.id, body);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  @Get('purchases')
  async listPurchases(@Request() req: AuthedRequest) {
    const rows = await this.checkout.listForClient(req.user.id);
    return { purchases: rows };
  }

  @Get('entitlement')
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
  async paymentMethod(@Request() req: AuthedRequest) {
    return this.checkout.getSavedPaymentMethodForClient(req.user.id);
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
  async list(@Request() req: AuthedRequest) {
    const rows = await this.checkout.listForCoach(req.user.id);
    return { purchases: rows };
  }
}
