import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { CoachClientPaymentsService } from './coach-client-payments.service';
import { CoachPaymentActionsFeatureGuard } from './coach-payment-actions.feature';

/** Every POST carries a fresh UUID per tap; a retry of the same tap reuses it. */
export class CoachPaymentActionDto {
  @IsUUID()
  idempotency_key!: string;
}

export class CoachRefundDto extends CoachPaymentActionDto {
  /** Integer minor units; omit to refund everything left on the payment. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount_cents?: number;

  /** A `payments[].charge_id` from the list; omit for the newest payment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  charge_id?: string;

  @IsOptional()
  @IsIn(['requested_by_customer', 'duplicate'])
  reason?: 'requested_by_customer' | 'duplicate';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// CF-COACH-PAY-BE-128: coach payments for one client. 404 while
// FEATURE_COACH_PAYMENT_ACTIONS is off; active sub-coaches get 403
// sub_coach_billing_blocked (their head coach acts for them).
@ApiTags('coach-payments')
@Controller('v1/coach/clients/:clientId/payments')
@UseGuards(CoachPaymentActionsFeatureGuard, JwtAuthGuard, CoachOrOwnerGuard, NoActiveSubCoachGuard)
export class CoachClientPaymentsController {
  constructor(private readonly payments: CoachClientPaymentsService) {}

  @Roles('coach', 'owner')
  @Get()
  list(@Request() req: AuthedRequest, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.payments.list(req.user, clientId);
  }

  @Roles('coach', 'owner')
  @Post(':purchaseId/refund')
  @HttpCode(200)
  refund(
    @Request() req: AuthedRequest,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: CoachRefundDto,
  ) {
    return this.payments.refund(req.user, clientId, purchaseId, body);
  }

  @Roles('coach', 'owner')
  @Post(':purchaseId/pause')
  @HttpCode(200)
  pause(
    @Request() req: AuthedRequest,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: CoachPaymentActionDto,
  ) {
    return this.payments.pause(req.user, clientId, purchaseId, body.idempotency_key);
  }

  @Roles('coach', 'owner')
  @Post(':purchaseId/resume')
  @HttpCode(200)
  resume(
    @Request() req: AuthedRequest,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: CoachPaymentActionDto,
  ) {
    return this.payments.resume(req.user, clientId, purchaseId, body.idempotency_key);
  }

  @Roles('coach', 'owner')
  @Post(':purchaseId/cancel')
  @HttpCode(200)
  cancel(
    @Request() req: AuthedRequest,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: CoachPaymentActionDto,
  ) {
    return this.payments.cancel(req.user, clientId, purchaseId, body.idempotency_key);
  }
}
