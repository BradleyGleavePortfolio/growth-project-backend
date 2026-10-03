import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

/**
 * B-641-7 — retries head-coach transfer reversals still owed for succeeded
 * refunds (Stripe failed, or the process stopped between the Stripe call and
 * the local record). Every 15 minutes so a retry lands well inside Stripe's
 * 24-hour idempotency window; the refund-scoped key and the
 * transfer_reversed claim make overlapping runs on several instances safe.
 */
@Injectable()
export class RefundTransferReversalScheduler {
  private readonly logger = new Logger(RefundTransferReversalScheduler.name);

  constructor(private readonly refunds: RefundDisputeHandlerService) {}

  @Cron('*/15 * * * *', { name: 'refund-transfer-reversal-retry', timeZone: 'UTC' })
  async handleCron(): Promise<void> {
    try {
      const result = await this.refunds.retryPendingTransferReversals();
      if (result.retried > 0 || result.needs_review > 0) {
        this.logger.log(
          `refund transfer reversal retry: retried=${result.retried} reversed=${result.reversed} needs_review=${result.needs_review}`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`refund transfer reversal retry failed: ${message}`);
    }
  }
}
