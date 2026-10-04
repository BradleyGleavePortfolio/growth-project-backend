import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

// B-641-7 — head-coach reversals still owed after the 23-hour Stripe window
// leave automatic retry, alert once (REFUND_TRANSFER_REVERSAL_REVIEW) and are
// reconciled here (docs/runbooks/refund-transfer-reversal-review.md).
// B-674-2 (B-CM1-116): its own controller, gated by the owner's JWT alone.
// AdminPaymentOpsController also runs ServiceTokenGuard on the SAME bearer,
// so no request passed both and every owner got 401. A service token is not
// a JWT and is refused.
@ApiTags('admin-payments')
@Controller('v1/admin/payments/refund-reversals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminRefundReversalController {
  constructor(private readonly refundDispute: RefundDisputeHandlerService) {}

  @Get('review')
  @ApiOperation({ summary: 'List head-coach transfer reversals waiting for operator review' })
  async listRefundReversalsInReview(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return { refunds: await this.refundDispute.listTransferReversalsInReview(limit) };
  }

  @Post(':id/reconcile')
  @ApiOperation({
    summary:
      'Reconcile one reversal in review against Stripe: record the reversal Stripe holds, or send one new reversal when Stripe holds none',
  })
  @ApiResponse({ status: 400, description: 'RECONCILE_BODY_INVALID' })
  @ApiResponse({ status: 404, description: 'REFUND_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED | REFUND_TRANSFER_REVERSAL_NOT_IN_REVIEW | TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND | TRANSFER_REVERSAL_UNATTRIBUTED | TRANSFER_NOT_IN_STRIPE',
  })
  @ApiResponse({ status: 422, description: 'TRANSFER_REVERSAL_NOT_FOUND' })
  async reconcileRefundReversal(
    @Param('id') chargeRefundId: string,
    @Body()
    body: { stripe_transfer_reversal_id?: unknown; confirm_none_in_stripe?: unknown } = {},
  ) {
    const id = body?.stripe_transfer_reversal_id;
    const confirm = body?.confirm_none_in_stripe;
    if (
      (id !== undefined && (typeof id !== 'string' || !/^trr_[A-Za-z0-9]{1,250}$/.test(id))) ||
      (confirm !== undefined && typeof confirm !== 'boolean')
    ) {
      throw new BadRequestException({
        code: 'RECONCILE_BODY_INVALID',
        error: 'RECONCILE_BODY_INVALID',
        message:
          'stripe_transfer_reversal_id must be a Stripe reversal id (trr_...) and confirm_none_in_stripe must be true or false.',
      });
    }
    return this.refundDispute.reconcileTransferReversal(chargeRefundId, {
      stripe_transfer_reversal_id: id as string | undefined,
      confirm_none_in_stripe: confirm === true,
    });
  }
}
