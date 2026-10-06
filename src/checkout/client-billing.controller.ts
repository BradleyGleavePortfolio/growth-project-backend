import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import { THROTTLER_NAMES, THROTTLER_ROUTE_LIMITS } from '../throttler/throttler.config';
import {
  BillingQuote,
  CancelPlanResult,
  CardSetupResult,
  CardUpdateResult,
  ClientBillingService,
} from './client-billing.service';

export class CreateCardSetupDto {
  @IsUUID()
  idempotency_key!: string;
}

/** One open invoice the client approved, at the amount and currency shown. */
export class ApprovedInvoiceDto {
  @Matches(/^in_[A-Za-z0-9]+$/, { message: 'invoice_id must be a Stripe invoice id' })
  @MaxLength(255)
  invoice_id!: string;

  @IsInt()
  @Min(0)
  amount_cents!: number;

  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;
}

export class ConfirmCardUpdateDto {
  @Matches(/^seti_[A-Za-z0-9]+$/, { message: 'setup_intent_id must be a Stripe SetupIntent id' })
  @MaxLength(255)
  setup_intent_id!: string;

  /**
   * S-DUNNING-R3 (B-628-3): the exact open invoices the client approved on
   * the quote. Only these are charged, each at most at its approved amount;
   * missing means "approve nothing" (the card is saved, nothing charged).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApprovedInvoiceDto)
  approved_invoices?: ApprovedInvoiceDto[];
}

/** First failing property path, e.g. "approved_invoices.0.amount_cents". */
function firstInvalidField(errors: ValidationError[], prefix = ''): string | null {
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints && Object.keys(e.constraints).length > 0) return path;
    const nested = firstInvalidField(e.children ?? [], path);
    if (nested) return nested;
  }
  return null;
}

/**
 * B-628-10: every validation failure on these routes carries a stable
 * machine code and a specific next step (the production error envelope
 * keeps `code` and `message`).
 */
export function billingValidationError(errors: ValidationError[]): BadRequestException {
  const field = firstInvalidField(errors) ?? 'request';
  return new BadRequestException({
    code: 'INVALID_BILLING_REQUEST',
    error: 'INVALID_BILLING_REQUEST',
    message: `The app sent an incomplete billing request (${field}), so nothing was charged or changed. Close this screen, pull down to refresh, and try again. If it keeps happening, update the app.`,
  });
}

/**
 * Body pipe for these routes. The handler parameters are typed with plain
 * interfaces, so the app-wide ValidationPipe (no machine code) skips them
 * and this pipe validates against the DTO class with the coded factory.
 */
function billingBodyPipe(expectedType: new () => object): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    expectedType,
    exceptionFactory: billingValidationError,
  });
}

interface CardSetupBody {
  idempotency_key: string;
}

interface ConfirmBody {
  setup_intent_id: string;
  approved_invoices?: Array<{ invoice_id: string; amount_cents: number; currency: string }>;
}

export function invalidPlanIdError(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_PLAN_ID',
    error: 'INVALID_PLAN_ID',
    message:
      'That plan link is not valid, so nothing was changed. Pull down to refresh your plans, then try again.',
  });
}

/**
 * S-DUNNING-R2 — the client's own card and plan actions, native in the app.
 *
 *   POST /v1/checkout/payment-method/setup-intent   start an in-app card update
 *   GET  /v1/checkout/payment-method/quote          every open invoice it would pay
 *   POST /v1/checkout/payment-method/confirm        save it; (1A) pay what was approved
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
    @Body(billingBodyPipe(CreateCardSetupDto)) body: CardSetupBody,
  ): Promise<CardSetupResult> {
    return this.billing.createCardSetup(req.user.id, body.idempotency_key);
  }

  @Roles('student', 'coach', 'owner')
  @Get('payment-method/quote')
  @SkipClientEntitlement()
  async quote(@Request() req: AuthedRequest): Promise<BillingQuote> {
    return this.billing.getPaymentQuote(req.user.id);
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
    @Body(billingBodyPipe(ConfirmCardUpdateDto)) body: ConfirmBody,
  ): Promise<CardUpdateResult> {
    return this.billing.confirmCardUpdate(
      req.user.id,
      body.setup_intent_id,
      (body.approved_invoices ?? []).map((a) => ({
        invoice_id: a.invoice_id,
        amount_cents: a.amount_cents,
        currency: a.currency,
      })),
    );
  }

  @Roles('student', 'coach', 'owner')
  @Post('subscriptions/:purchaseId/cancel')
  @HttpCode(200)
  @SkipClientEntitlement()
  async cancel(
    @Request() req: AuthedRequest,
    @Param('purchaseId', new ParseUUIDPipe({ exceptionFactory: invalidPlanIdError }))
    purchaseId: string,
  ): Promise<CancelPlanResult> {
    return this.billing.cancelPlan(req.user.id, purchaseId);
  }
}
