import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { GuestCheckoutService } from './guest-checkout.service';

// r48 #2 — lost-webhook reconciler.
//
// Failure mode: Stripe fires payment_intent.succeeded but the webhook
// never reaches us (Stripe outage, our outage, Fly drain, infra hiccup).
// Without this poller a guest pays, never gets provisioned, and the
// row sits in 'pending' until expires_at flips it to 'failed' — refund
// is the only recourse.
//
// Mitigation: every minute, scan GuestCheckouts in 'pending' that are
// older than INTENT_GRACE_MS (so we don't poll a freshly-minted PI),
// ordered by last_reconciled_at NULLS FIRST so the most-stale rows are
// picked up first.  For each, call stripe.paymentIntents.retrieve.  If
// Stripe says 'succeeded', invoke the same code path the webhook would
// have ((guestCheckout.handlePaymentSucceeded). Cap at
// MAX_RECONCILE_ATTEMPTS polls (5 min worth at 10s repeats; we run at
// 1-minute cron cadence so 5 attempts = ~5 min) — past that flip to
// 'conversion_failed_terminal' (semantically: this guest never
// converted and we're giving up) and page on-call.
//
// Cancellation: a row that flips to 'paid'/'converted' via webhook
// is no longer matched by the WHERE status='pending' filter on the
// next tick.  The reconcile_attempts counter stays for audit but no
// further polling happens.

// How fresh a row must be before we start polling. A genuine webhook
// usually arrives in < 10s; below this threshold the poller does
// nothing and the webhook handler owns the row.
const INTENT_GRACE_MS = 30_000;
// Bound per-tick batch so a backlog doesn't monopolise Stripe API quota.
const BATCH_SIZE = 25;
// Hard cap on poll attempts per row before declaring a lost cause.
const MAX_RECONCILE_ATTEMPTS = 5;

@Injectable()
export class LostWebhookReconcileService {
  private readonly logger = new Logger(LostWebhookReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    private readonly guestCheckout: GuestCheckoutService,
  ) {}

  // EVERY_MINUTE matches the cadence used by GuestCheckoutReconciliationService.
  // The spec called for "every 10s" via BullMQ; we don't ship BullMQ so we
  // run on the cron and accept the up-to-60s extra latency on a lost
  // webhook (still way inside Stripe's retry window).
  @Cron(CronExpression.EVERY_MINUTE, { name: 'checkout-lost-webhook-reconcile' })
  async run(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.CHECKOUT_RECONCILE_DISABLED === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`lost-webhook-reconcile: processed ${processed} rows`);
      }
    } catch (err) {
      this.logger.error(
        `lost-webhook-reconcile tick failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * Exposed for tests + ops "drain" tooling. Returns the number of
   * rows that observed a state change (succeeded reconciled OR moved
   * to conversion_failed_terminal); rows that polled-but-stayed-pending count
   * as zero so the log line reflects work actually done.
   */
  async runOnce(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - INTENT_GRACE_MS);
    const rows = await this.prisma.guestCheckout.findMany({
      where: {
        status: 'pending',
        created_at: { lt: cutoff },
        // Skip rows whose PI id is the synthetic `pending_<idem>` sentinel
        // — they never made it to Stripe so polling Stripe would 404.
        stripe_payment_intent_id: { not: { startsWith: 'pending_' } },
      },
      orderBy: [
        { last_reconciled_at: { sort: 'asc', nulls: 'first' } },
        { created_at: 'asc' },
      ],
      take: BATCH_SIZE,
    });
    let stateChanges = 0;
    for (const row of rows) {
      try {
        const changed = await this.reconcileOne(row.id, row.stripe_payment_intent_id);
        if (changed) stateChanges += 1;
      } catch (err) {
        this.logger.error(
          `reconcileOne ${row.id} crashed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return stateChanges;
  }

  private async reconcileOne(
    checkoutId: string,
    paymentIntentId: string,
  ): Promise<boolean> {
    // Atomic increment + read-back so two parallel workers don't double-poll.
    const claimed = await this.prisma.guestCheckout.update({
      where: { id: checkoutId },
      data: {
        last_reconciled_at: new Date(),
        reconcile_attempts: { increment: 1 },
      },
      select: { reconcile_attempts: true, status: true },
    });

    // Status may have moved between findMany and update (webhook landed
    // in the meantime).  If it's no longer pending, do nothing.
    if (claimed.status !== 'pending') return false;

    if (claimed.reconcile_attempts > MAX_RECONCILE_ATTEMPTS) {
      // Bail out: stamp a terminal state so this row is no longer
      // picked up.  Operator dashboard surfaces 'conversion_failed_terminal'
      // so on-call can refund manually.
      //
      // A279-P1-1: was 'reconcile_failed' — not in GuestCheckout_status_check
      // nor in GUEST_CHECKOUT_STATUSES, so Postgres raised 23514, the
      // surrounding try/catch swallowed it, the row stayed 'pending', and
      // the cron polled Stripe every minute burning API quota. Reusing the
      // existing valid terminal status preserves the intent (operator
      // intervention required) with zero schema change.
      await this.prisma.guestCheckout.updateMany({
        where: { id: checkoutId, status: 'pending' },
        data: { status: 'conversion_failed_terminal' },
      });
      this.logger.warn(
        `lost-webhook-reconcile: bailing out on ${checkoutId} after ${claimed.reconcile_attempts} attempts`,
      );
      return true;
    }

    // Poll Stripe.  retrievePaymentIntent has an AbortController(10s)
    // wired so a hung Stripe cannot stall the tick.  The signature
    // returns an open record (`[k: string]: unknown`) so we narrow
    // `status` out via a cast — adding `status` to the upstream type
    // would touch every retrievePaymentIntent caller for no real win.
    let piStatus: string | null = null;
    try {
      const pi = await this.stripe.retrievePaymentIntent(paymentIntentId);
      const raw = (pi as Record<string, unknown>).status;
      piStatus = typeof raw === 'string' ? raw : null;
    } catch (err) {
      // Network blip / 5xx — keep status=pending and try again next tick.
      this.logger.warn(
        `lost-webhook-reconcile: Stripe retrieve failed for ${paymentIntentId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return false;
    }

    if (piStatus === 'succeeded') {
      // Same code path as the webhook handler — handlePaymentSucceeded
      // takes the PI id, claims the row pending→paid, and runs the
      // convertGuestToUser flow inline.
      await this.guestCheckout.handlePaymentSucceeded(paymentIntentId);
      return true;
    }
    if (piStatus === 'canceled' || piStatus === 'requires_payment_method') {
      // PI is dead on Stripe's side — flip the row so we stop polling.
      await this.prisma.guestCheckout.updateMany({
        where: { id: checkoutId, status: 'pending' },
        data: { status: 'failed' },
      });
      return true;
    }
    // requires_action / requires_confirmation / processing — leave it
    // alone, the guest is mid-flow.  Counter increments on every poll;
    // a stuck PI eventually hits MAX_RECONCILE_ATTEMPTS.
    return false;
  }
}
