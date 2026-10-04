import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { LedgerWriteConflictError } from '../connect/fees/split-ledger.service';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';
import {
  REFUND_TRANSFER_REVERSAL_RUNBOOK,
  RefundDisputeHandlerService,
} from './refund-dispute-handler.service';

// B-674-4 (B-CM1-116): a failed sweep reports a closed code and a closed error
// class only. The exception object, its name, message, code or any provider
// or database text never reaches a log line or Sentry.
export const REFUND_TRANSFER_SWEEP_FAILED_CODE = 'REFUND_TRANSFER_REVERSAL_SWEEP_FAILED';
export type RefundTransferSweepErrorClass =
  'ledger_write_conflict' | 'database' | 'stripe' | 'unknown';

export function refundTransferSweepErrorClass(err: unknown): RefundTransferSweepErrorClass {
  if (err instanceof LedgerWriteConflictError) return 'ledger_write_conflict';
  if (err instanceof StripeConnectApiError) return 'stripe';
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientValidationError
  ) {
    return 'database';
  }
  return 'unknown';
}

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
      const errorClass = refundTransferSweepErrorClass(err);
      this.logger.error(
        `refund transfer reversal retry failed code=${REFUND_TRANSFER_SWEEP_FAILED_CODE} error_class=${errorClass}`,
      );
      // The next run (15 minutes) retries the same rows; the alert tells the
      // operator the sweep itself is failing, with the runbook to follow.
      Sentry.captureMessage('refund transfer reversal retry sweep failed', {
        level: 'error',
        fingerprint: ['refund-transfer-reversal-sweep-failed', errorClass],
        tags: { code: REFUND_TRANSFER_SWEEP_FAILED_CODE, error_class: errorClass },
        extra: { runbook: REFUND_TRANSFER_REVERSAL_RUNBOOK },
      });
    }
  }
}
