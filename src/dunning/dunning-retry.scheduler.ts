import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { DunningCase } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StripeApiError, StripeApiService } from '../billing/stripe-api.service';
import { DunningService } from './dunning.service';
import { DunningNotifier } from './dunning.notifier';

// r50 Dunning v1 — retry worker.
//
// The spec calls for a BullMQ queue `dunning-retry`, but the repo does
// not ship BullMQ. Instead we use the same @nestjs/schedule + DB pattern
// as GuestCheckoutReconciliationService: the DunningCase row IS the
// queue, and (state, retry_N_at) is the schedule. Tick every minute,
// drain everything that's due.
//
// Cancellation: a recovered case (invoice.payment_succeeded landed
// first) transitions to 'recovered' inside the same webhook
// transaction. The next tick re-reads `findDueRetries` and the
// recovered case no longer matches the filter (state was retry_N_scheduled,
// is now recovered). The pending retry timestamp is left in place for
// audit but never fires.
//
// Cadence is owned by DunningService.openOrReopenCase + recordRetryFailure;
// this worker only translates "case is due" into a Stripe API call and a
// state transition.
const DUNNING_RETRY_DISABLED_ENV = 'CRM_DUNNING_RETRY_DISABLED';
const BATCH_SIZE = 25;

@Injectable()
export class DunningRetryScheduler {
  private readonly logger = new Logger(DunningRetryScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dunning: DunningService,
    private readonly stripe: StripeApiService,
    private readonly notifier: DunningNotifier,
  ) {}

  // EVERY_MINUTE matches the cadence used elsewhere in the codebase
  // (GuestCheckoutReconciliationService). The 1-day / 3-day / 7-day
  // gaps mean per-tick batches are small; a higher cadence buys
  // nothing.
  @Cron(CronExpression.EVERY_MINUTE, { name: 'dunning-retry' })
  async run(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env[DUNNING_RETRY_DISABLED_ENV] === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`DunningRetry: processed ${processed} cases`);
      }
    } catch (err) {
      this.logger.error(
        `DunningRetry tick failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * Exposed for tests + admin "drain queue" tooling. Returns the number
   * of cases processed (success + failure both count).
   */
  async runOnce(now: Date = new Date()): Promise<number> {
    const due = await this.dunning.findDueRetries(now, BATCH_SIZE);
    let count = 0;
    for (const c of due) {
      try {
        await this.processOne(c);
        count += 1;
      } catch (err) {
        this.logger.error(
          `DunningRetry case ${c.id} crashed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return count;
  }

  private retryNumberFor(c: DunningCase): 1 | 2 | 3 {
    if (c.state === 'retry_1_scheduled') return 1;
    if (c.state === 'retry_2_scheduled') return 2;
    return 3;
  }

  private async processOne(c: DunningCase): Promise<void> {
    if (!c.stripe_invoice_id) {
      // The case opened without an invoice id (rare — Stripe usually
      // includes it on payment_failed). Skip and let the next webhook
      // attempt populate it.
      this.logger.warn(
        `DunningRetry: case ${c.id} has no stripe_invoice_id; skipping`,
      );
      return;
    }
    const n = this.retryNumberFor(c);

    // Notify BEFORE we hit Stripe — the coach should learn about the
    // upcoming retry slot first. Idempotency key on the notifier
    // collapses duplicates from a redelivered tick.
    await this.notifier.retryScheduled(c, n);

    // Ask Stripe to retry collection. We don't catch decline errors as
    // exceptions — Stripe returns 402 with a typed StripeApiError, and
    // any non-paid status is treated as a failed retry.
    let paid = false;
    let lastError: string | null = null;
    try {
      const result = await this.stripe.payInvoice({
        invoiceId: c.stripe_invoice_id,
        // Idempotency key includes the retry number so each scheduled
        // slot has its own Stripe attempt id. A redelivered tick within
        // the same slot collapses; a separate slot (e.g. retry_2 after
        // retry_1 failed) gets a fresh attempt.
        idempotencyKey: `dunning-retry:${c.id}:${n}`,
      });
      paid = result.paid === true || result.status === 'paid';
    } catch (err) {
      // 402 (card declined) is the expected failure path. Everything
      // else (network, 5xx, configuration_missing) is also treated as a
      // failure so the worker advances the state. A later tick will
      // re-try only if state stays in retry_N_scheduled, which only
      // happens for the final attempt OR if recordRetryFailure throws.
      if (err instanceof StripeApiError) {
        lastError = `${err.stripeCode ?? 'unknown'} (${err.httpStatus})`;
      } else {
        lastError = err instanceof Error ? err.message : 'unknown';
      }
      this.logger.warn(
        `DunningRetry: payInvoice failed for case ${c.id} retry ${n}: ${lastError}`,
      );
    }

    if (paid) {
      // Stripe will ALSO fire invoice.payment_succeeded which closes the
      // case via BillingService.applyInvoicePaid → DunningService.recordRecovery.
      // We still call recordRecovery here so the in-app banner updates
      // immediately rather than waiting for the webhook round trip.
      await this.dunning.recordRecovery(c.stripe_subscription_id);
      return;
    }

    // Failure path: advance retry_N → retry_(N+1) (or → churned on n=3).
    // recordRetryFailure persists the new state + schedules the next
    // retry_N_at if applicable, and fires the churned notification
    // when it goes terminal.
    await this.dunning.recordRetryFailure(c.id, n);
  }
}
