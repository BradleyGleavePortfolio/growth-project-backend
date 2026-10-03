import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';
import {
  SubscriptionCheckoutService,
  type ClientPlanView,
  type SubscriptionIntentResult,
} from './subscription-checkout.service';

// B-RECUR (OR-113-1) — native subscription checkout routes.
//
// Contract choice: a SEPARATE route instead of a `mode` flag on
// /v1/checkout/payment-intent. The two contracts differ in what they return
// (subscription id, PaymentSheet mode payment|setup, plan price + interval),
// in their idempotency semantics (an existing live subscription is a coded
// 409; an open unpaid attempt is reused), and in their error set. One route
// per contract keeps each response shape fixed, and lets payment-intent
// refuse renewing plans with RECURRING_REQUIRES_SUBSCRIPTION so an older app
// build can never sell a renewing plan as one charge.
//
//   POST /v1/checkout/subscription-intent          start (or resume) an attempt
//   GET  /v1/checkout/subscriptions                the client's plans
//   GET  /v1/checkout/subscriptions/:id            one plan (status polling)
//   POST /v1/checkout/subscriptions/:id/resume     keep a plan set to cancel
//
// Cancel at period end is POST /v1/checkout/subscriptions/:id/cancel
// (ClientBillingController, #628). All routes are scoped to req.user.id;
// a foreign purchase answers 404.

export class CreateSubscriptionIntentDto {
  @IsUUID()
  package_id!: string;

  @IsUUID()
  idempotency_key!: string;

  // The renewal price the app showed. A mismatch answers 409
  // PACKAGE_PRICE_CHANGED with the current price, before any Stripe call.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  expected_amount_cents?: number;
}

export class ResumePlanDto {
  @IsUUID()
  idempotency_key!: string;
}

// A malformed plan id is answered like an unknown one: coded, plain words.
const planIdPipe = () =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({
        code: 'PURCHASE_NOT_FOUND',
        error: 'PURCHASE_NOT_FOUND',
        message: 'That plan was not found on your account. Pull down to refresh your plans.',
      }),
  });

@ApiTags('checkout')
@Controller('v1/checkout')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class SubscriptionCheckoutController {
  constructor(private readonly subscriptions: SubscriptionCheckoutService) {}

  @Roles('student', 'coach', 'owner')
  @Post('subscription-intent')
  @HttpCode(200)
  @Throttle({
    [THROTTLER_NAMES.CHECKOUT_MINT]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.CHECKOUT_MINT_PER_HOUR,
    },
  })
  async createSubscriptionIntent(
    @Request() req: AuthedRequest,
    @Body() body: CreateSubscriptionIntentDto,
  ): Promise<SubscriptionIntentResult> {
    return this.subscriptions.createSubscriptionIntent(req.user.id, body);
  }

  @Roles('student', 'coach', 'owner')
  @Get('subscriptions')
  @SkipClientEntitlement()
  async listPlans(@Request() req: AuthedRequest): Promise<{ plans: ClientPlanView[] }> {
    return { plans: await this.subscriptions.listPlans(req.user.id) };
  }

  @Roles('student', 'coach', 'owner')
  @Get('subscriptions/:purchaseId')
  @SkipClientEntitlement()
  async getPlan(
    @Request() req: AuthedRequest,
    @Param('purchaseId', planIdPipe()) purchaseId: string,
  ): Promise<ClientPlanView> {
    return this.subscriptions.getPlan(req.user.id, purchaseId);
  }

  @Roles('student', 'coach', 'owner')
  @Post('subscriptions/:purchaseId/resume')
  @HttpCode(200)
  @SkipClientEntitlement()
  async resumePlan(
    @Request() req: AuthedRequest,
    @Param('purchaseId', planIdPipe()) purchaseId: string,
    @Body() body: ResumePlanDto,
  ): Promise<ClientPlanView> {
    return this.subscriptions.resumePlan(req.user.id, purchaseId, body.idempotency_key);
  }
}
