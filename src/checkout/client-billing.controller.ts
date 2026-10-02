import {
  Body,
  Controller,
  HttpCode,
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
import { IsUUID, Matches, MaxLength } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';
import {
  CancelPlanResult,
  CardSetupResult,
  CardUpdateResult,
  ClientBillingService,
} from './client-billing.service';

export class CreateCardSetupDto {
  @IsUUID()
  idempotency_key!: string;
}

export class ConfirmCardUpdateDto {
  @Matches(/^seti_[A-Za-z0-9]+$/, { message: 'setup_intent_id must be a Stripe SetupIntent id' })
  @MaxLength(255)
  setup_intent_id!: string;
}

/**
 * S-DUNNING-R2 — the client's own card and plan actions, native in the app.
 *
 *   POST /v1/checkout/payment-method/setup-intent   start an in-app card update
 *   POST /v1/checkout/payment-method/confirm        save it; (1A) pay what is owed
 *   POST /v1/checkout/subscriptions/:id/cancel      2A in dunning, option A otherwise
 *
 * All three sit under the `checkout` head, which the Day-10 lockout guard
 * allows, and skip the client entitlement gate: a locked or past-due client
 * must be able to fix their card or end their plan. Scoped to req.user.id;
 * a foreign purchase or SetupIntent answers 404. Not flag-gated: the routes
 * only act when the client asks, and are correct with or without dunning v2.
 */
@ApiTags('checkout')
@Controller('v1/checkout')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class ClientBillingController {
  constructor(private readonly billing: ClientBillingService) {}

  @Roles('student', 'coach', 'owner')
  @Post('payment-method/setup-intent')
  @HttpCode(200)
  @SkipClientEntitlement()
  @Throttle({
    [THROTTLER_NAMES.CHECKOUT_MINT]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.CHECKOUT_MINT_PER_HOUR,
    },
  })
  async createSetupIntent(
    @Request() req: AuthedRequest,
    @Body() body: CreateCardSetupDto,
  ): Promise<CardSetupResult> {
    return this.billing.createCardSetup(req.user.id, body.idempotency_key);
  }

  @Roles('student', 'coach', 'owner')
  @Post('payment-method/confirm')
  @HttpCode(200)
  @SkipClientEntitlement()
  @Throttle({
    [THROTTLER_NAMES.CHECKOUT_MINT]: {
      ttl: 3_600_000,
      limit: THROTTLER_ROUTE_LIMITS.CHECKOUT_MINT_PER_HOUR,
    },
  })
  async confirm(
    @Request() req: AuthedRequest,
    @Body() body: ConfirmCardUpdateDto,
  ): Promise<CardUpdateResult> {
    return this.billing.confirmCardUpdate(req.user.id, body.setup_intent_id);
  }

  @Roles('student', 'coach', 'owner')
  @Post('subscriptions/:purchaseId/cancel')
  @HttpCode(200)
  @SkipClientEntitlement()
  async cancel(
    @Request() req: AuthedRequest,
    @Param('purchaseId', new ParseUUIDPipe()) purchaseId: string,
  ): Promise<CancelPlanResult> {
    return this.billing.cancelPlan(req.user.id, purchaseId);
  }
}
