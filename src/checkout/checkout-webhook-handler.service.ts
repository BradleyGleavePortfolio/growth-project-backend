import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import {
  StripeConnectApiService,
  type StripeSubscriptionObject,
} from '../connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PrismaService } from '../prisma.service';
import { DunningService } from './dunning.service';
import { DunningV2Service } from './dunning-v2/dunning-v2.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';
import { PayoutRoutingService } from '../payouts-v2/payout-routing.service';
import { CoachFirstPaymentService } from '../notifications/coach-first-payment.service';

// PR-9: BillingService.handleEvent passes its outer `$transaction`'s tx
// client through `handle(event, tx)` so the entitlement update +
// PurchaseFanout drop seeding + immediate-cadence materialisation all
// commit-or-rollback together with the StripeProcessedEvent dedup row.
// Legacy callers (and the spec suite that hand-constructs the handler
// outside a tx) may still call `handle(event)` with no tx; the handler
// then falls back to the bare `this.prisma` client for the entitlement
// write and skips the fan-out's tx-only steps (drop seed). The webhook
// handler's own idempotency via StripeProcessedEvent + PurchaseFanout
// @unique is unchanged.
type WebhookTx = Prisma.TransactionClient;

// Lifecycle:
//
//   pending  -- checkout.session.completed   --> paid (one_time) / active (recurring)
//   active   -- customer.subscription.updated --> active | past_due | canceled
//   active   -- customer.subscription.deleted --> canceled
//   *        -- payment_intent.payment_failed --> payment_failed
//   pending  -- checkout.session.expired      --> expired
//
// Entitlement (`entitlement_active`) is derived and persisted on every
// transition so authorization checks are a single indexed read.
//
// All event types are no-op if no matching ClientPurchase row exists
// (the event is logged at debug level — it is normal for the platform
// Stripe account to also send events about SaaS coach subscriptions which
// CheckoutWebhookHandlerService does NOT own; BillingService handles those.
// The two handlers are kept disjoint via the metadata key `tgp_package_id`:
// if set, this handler claims the event).

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

// PR-18 B1 R3 P1 — a split-posting task the handler deferred because an
// outer $transaction (and the CoachPackage FOR UPDATE lock) was held when
// the charge succeeded. PurchaseSplitHandlerService.onChargeSucceeded() can
// synchronously call Stripe (retrievePaymentIntent to resolve the charge id
// AND transfers.attempt() which POSTs a Stripe Transfer); running it inside
// the outer tx holds the Postgres connection — and the package row lock —
// across a Stripe round-trip (the A276-P1-3 anti-pattern, made worse by B1's
// lock). When BillingService threads an outer tx, the handler resolves the
// charge id out-of-tx via prefetchForOuterTx and returns this descriptor so
// BillingService runs the split posting AFTER the outer tx commits. The
// split ledger is idempotent (composite-unique upserts) and the transfer is
// idempotency-keyed + sweeper-backed, so a rolled-back outer tx simply skips
// the post-commit run and Stripe's redelivery (or the sweeper) reconciles.
export interface DeferredSplitTask {
  purchase: ClientPurchase;
  // Charge id pre-resolved out-of-tx (null when not yet known — the split
  // handler then no-ops the transfer and the sweeper retries).
  charge_id: string | null;
  // Recurring-renewal extras (invoice.paid path).
  invoice_amount_cents?: number;
}

export interface CheckoutWebhookResult {
  claimed: boolean;
  reason?: string;
  purchase_id?: string;
  // PR-18 B1 R3 P1 — present iff split posting was deferred to post-commit
  // because the caller held an outer $transaction. BillingService runs these
  // after the outer tx commits (see runDeferredSplit below).
  deferredSplit?: DeferredSplitTask;
}

// PR-18 B1 — state that the checkout handler needs from Stripe HTTP but that
// must be resolved BEFORE BillingService opens its outer $transaction, so no
// Stripe round-trip is ever held while a DB transaction (and the CoachPackage
// FOR UPDATE lock) is open. BillingService calls `prefetchForOuterTx(event)`
// before the tx and threads the result through `handle(event, tx, prefetched)`.
export interface CheckoutWebhookPrefetch {
  // The renewed Stripe subscription for an invoice.paid/payment_succeeded
  // event, resolved out-of-tx. null when not applicable or the lookup failed
  // (the handler then falls back to its own out-of-tx retrieve only when no
  // outer tx is held).
  invoiceSubscription?: StripeSubscriptionObject | null;
  // PR-18 B1 R3 P1 — Stripe charge id for the purchase a checkout.session.
  // completed / payment_intent.succeeded event activates, resolved out-of-tx
  // BEFORE BillingService opens its outer $transaction. Keyed by
  // ClientPurchase.id. The deferred split posting (run post-commit) uses this
  // so PurchaseSplitHandlerService never has to call retrievePaymentIntent
  // while the outer tx / package row lock is held. null = not yet known
  // (rare settling race); the split handler no-ops the transfer and the
  // sweeper picks it up. undefined entry = no pre-resolution attempted.
  chargeIdByPurchaseId?: Record<string, string | null>;
}

@Injectable()
export class CheckoutWebhookHandlerService {
  private readonly logger = new Logger(CheckoutWebhookHandlerService.name);

  constructor(
    private prisma: PrismaService,
    private stripeConnect: StripeConnectApiService,
    // Phase 4-5 — split & dunning. @Optional() so legacy bootstrap tests
    // that don't wire these still construct the handler.
    @Optional() private splits?: PurchaseSplitHandlerService,
    @Optional() private dunning?: DunningService,
    // Phase 6 — refund / dispute / payout event handling. Optional so the
    // legacy unit-test wiring still constructs the handler without these.
    @Optional() private refundDispute?: RefundDisputeHandlerService,
    // PR-4 — fan-out seam fired when entitlement_active flips true.
    // @Optional() so legacy unit tests that hand-construct this service
    // without the full Nest container still work; in production wiring
    // (CheckoutModule imports PackagesModule) it is always present.
    @Optional() private fanout?: PurchaseFanoutService,
    // Bank-Account Payouts v2 (spec §2.5) — @Optional() additive routing seam.
    // On payout.* events the router resolves the coach's effective
    // PayoutMethod.kind and reports the bookkeeping tier (card vs bank). It
    // NEVER moves money (Stripe already did) and NO-OPs while
    // FEATURE_BANK_PAYOUTS_V2 is off, so v1 Express payout bookkeeping
    // (RefundDisputeHandlerService.onPayoutEvent) is entirely unchanged.
    @Optional() private payoutRouting?: PayoutRoutingService,
    // B3 Smart Dunning v2 — @Optional() additive seam. Every call below is
    // gated internally by FEATURE_DUNNING_V2 (default OFF), so this never
    // alters v1 behaviour: while the flag is off the v2 methods return
    // immediately without reading or writing state. No v1 dunning logic is
    // modified — these are pure additions after the existing v1 calls.
    @Optional() private dunningV2?: DunningV2Service,
    // Roman P4 (Option C) — @Optional() additive seam. The first-payment
    // notification primitive. Every call below is gated on
    // FEATURE_ROMAN_FIRST_PAYMENT (default OFF), so while the flag is off this
    // never reads or writes state. @Optional() so legacy unit-test wiring that
    // hand-constructs the handler without the full container still works.
    @Optional() private coachFirstPaymentService?: CoachFirstPaymentService,
  ) {}

  /**
   * Roman P4 (Option C) — record + emit the coach's first-ever payment
   * notification, gated on FEATURE_ROMAN_FIRST_PAYMENT (default OFF). Called
   * from BOTH entitlement-activation callsites (checkout.session.completed and
   * payment_intent.succeeded) AFTER the purchase status flips, on the SAME
   * outer `tx` so the ledger row commits-or-rolls-back with the purchase
   * (50-Failures #44). All inputs come from the SERVER-TRUSTED, just-persisted
   * ClientPurchase row — never the Stripe webhook body (50-Failures #5 IDOR).
   * Exactly-once is enforced downstream by CoachFirstPaymentNotification's
   * coachId @unique. No-op when the flag is off, the service is unwired, or no
   * outer tx is held (the emit MUST share the purchase transaction).
   */
  private async maybeEmitFirstPayment(
    purchase: ClientPurchase,
    tx: WebhookTx | undefined,
  ): Promise<void> {
    if (process.env.FEATURE_ROMAN_FIRST_PAYMENT !== 'true') return;
    if (!this.coachFirstPaymentService || !tx) return;
    await this.coachFirstPaymentService.tryEmitFirstPayment(tx, {
      coachId: purchase.coach_user_id,
      amount: purchase.amount_cents,
      currency: purchase.currency,
      clientId: purchase.client_user_id,
    });
  }

  // Returns claimed=true iff the event was for a Connect package purchase
  // (identified by `metadata.tgp_package_id` or by a matching
  // stripe_checkout_session_id / stripe_subscription_id on a ClientPurchase
  // row). The caller (BillingService) inspects claimed and skips the
  // SaaS-coach-subscription handler when this returns claimed=true.
  async handle(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.applyCheckoutCompleted(event, tx, prefetched);
      case 'checkout.session.expired':
        return this.applyCheckoutExpired(event);
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        return this.applySubscriptionUpdated(event, tx);
      case 'customer.subscription.deleted':
        return this.applySubscriptionDeleted(event, tx);
      case 'payment_intent.succeeded':
        return this.applyPaymentIntentSucceeded(event, tx, prefetched);
      case 'payment_intent.payment_failed':
        return this.applyPaymentIntentFailed(event, tx);
      // DUNNING-V1 — invoice.payment_succeeded mirrors invoice.paid in
      // Stripe's docs for the subscription-renewal path; some accounts
      // emit one, some the other. We route both to the same handler so
      // the dunning window resolution is robust either way.
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return this.applyInvoicePaid(event, tx, prefetched);
      case 'invoice.payment_failed':
        return this.applyInvoicePaymentFailed(event);
      case 'customer.updated':
        return this.applyCustomerUpdated(event);
      // Phase 6 — refund / dispute / transfer / payout events. Delegated
      // to the RefundDisputeHandlerService.
      case 'charge.refunded':
      case 'charge.refund.updated':
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'transfer.reversed':
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled':
        // PR-16 — pass the outer tx so cancelPendingForPurchase can run
        // INSIDE the refund / dispute revocation $transaction (entitlement
        // revoke + drop cancel commit-or-rollback together).
        //
        // B3 v2 (§6) — additive late-reversal seam. For dispute-created /
        // refunded events we additionally probe whether this reverses a
        // PREVIOUSLY-CLEARED dunning payment and, if so, open a compressed
        // cycle. No-op while FEATURE_DUNNING_V2 is off; fire-and-forget so it
        // never alters the v1 refund/dispute result. The v2 service applies
        // the one-active-cycle-per-state guard (§6.4) so a dispute→refund
        // pair never double-opens.
        if (
          this.dunningV2 &&
          (event.type === 'charge.dispute.created' ||
            event.type === 'charge.refunded')
        ) {
          this.fireLateReversalProbe(event);
        }
        // Bank-Account Payouts v2 (spec §2.5) — additive routing branch on the
        // payout.* events. Fire-and-forget bookkeeping classification only;
        // no-op while FEATURE_BANK_PAYOUTS_V2 is off. Never alters the v1
        // refund/dispute/payout result below.
        if (
          this.payoutRouting &&
          (event.type === 'payout.paid' ||
            event.type === 'payout.failed' ||
            event.type === 'payout.canceled')
        ) {
          this.firePayoutRouting(event);
        }
        if (this.refundDispute) return this.refundDispute.handle(event, tx);
        return { claimed: false };
      default:
        return { claimed: false };
    }
  }

  /**
   * B3 v2 (§6) — fire-and-forget late-reversal probe. Extracts the charge /
   * PI id + reversal timestamp from the Stripe event and hands them to the v2
   * service, which applies the "previously cleared" + one-active-cycle guards.
   * Never throws into the webhook path; no-op while FEATURE_DUNNING_V2 is off.
   */
  private fireLateReversalProbe(event: StripeEvent): void {
    if (!this.dunningV2) return;
    const obj = event.data.object as {
      id?: string;
      charge?: string | null;
      payment_intent?: string | null;
      created?: number | null;
    };
    // For charge.refunded the object IS the charge; for dispute.created the
    // object is the dispute carrying a `charge` ref.
    const chargeId =
      event.type === 'charge.refunded' ? (obj.id ?? null) : (obj.charge ?? null);
    const reversedAt =
      typeof obj.created === 'number'
        ? new Date(obj.created * 1000)
        : new Date();
    void this.dunningV2
      .detectAndHandleLateReversal({
        chargeId,
        paymentIntentId: obj.payment_intent ?? null,
        reversedChargeAt: reversedAt,
      })
      .catch((err) =>
        this.logger.warn(
          `dunningV2.detectAndHandleLateReversal failed: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * Bank-Account Payouts v2 (spec §2.5) — fire-and-forget payout routing.
   * Extracts the connected-account id + payout id from the Stripe payout event
   * and hands them to the router, which resolves the coach's effective
   * PayoutMethod.kind and the bookkeeping fee tier. The router NEVER moves
   * money (Stripe already did) and no-ops while FEATURE_BANK_PAYOUTS_V2 is off.
   * Never throws into the webhook path.
   */
  private firePayoutRouting(event: StripeEvent): void {
    if (!this.payoutRouting) return;
    const obj = event.data.object as {
      id?: string;
      account?: string | null;
    };
    void this.payoutRouting
      .routePayoutWebhook({
        connectedAccountId: obj.account ?? null,
        payoutId: obj.id ?? '',
        eventType: event.type,
      })
      .catch((err) =>
        this.logger.warn(
          `payoutRouting.routePayoutWebhook failed: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * PR-9 — fire-and-forget drop alerts captured during the most recent
   * fan-out for the given purchase. Called by BillingService AFTER the
   * outer $transaction commits. Failure-isolated by the fanout service
   * (never throws). No-op when no alerts are pending.
   */
  flushDripAlerts(purchaseId: string): void {
    this.fanout?.flushAlerts(purchaseId);
  }

  /**
   * PR-9 — discard alerts staged for a purchase whose outer tx rolled
   * back. Called by BillingService in the catch block so a Stripe
   * retry doesn't double-alert when the next attempt commits.
   */
  discardPendingDripAlerts(purchaseId: string): void {
    this.fanout?.discardPendingAlerts(purchaseId);
  }

  /**
   * PR-18 B1 — resolve any Stripe HTTP state the handler will need INSIDE
   * BillingService's outer $transaction, run BEFORE that transaction opens.
   *
   * The invoice-renewal path (`invoice.paid` / `invoice.payment_succeeded`)
   * resyncs the subscription via `stripeConnect.retrieveSubscription`. Doing
   * that inside the outer tx would hold the Postgres connection across a
   * Stripe round-trip (the A276-P1-3 anti-pattern) AND across the
   * CoachPackage FOR UPDATE lock the activation takes. BillingService calls
   * this before opening its tx and threads the result through
   * `handle(event, tx, prefetched)`, mirroring `preResolveReceiptUrl`.
   *
   * Best-effort: a Stripe blip returns `invoiceSubscription: null` and the
   * handler degrades cleanly (the renewal simply isn't resynced on this
   * delivery). Never throws — a failure here must not roll back the dedup row.
   */
  async prefetchForOuterTx(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    // PR-18 B1 R3 P1 — checkout.session.completed / payment_intent.succeeded
    // activate a one-time (or first-invoice) purchase and then post the
    // head-coach split. That split posting resolves the parent Stripe charge
    // id via stripe.retrievePaymentIntent and may immediately attempt the
    // transfer (stripe.createTransfer) — both Stripe HTTP. To keep those out
    // of BillingService's outer $transaction (and out from under the
    // CoachPackage FOR UPDATE lock the activation takes), we resolve the
    // charge id HERE, before the tx opens. The handler then defers the whole
    // split posting to post-commit using this pre-resolved id, so the in-tx
    // path performs zero Stripe HTTP.
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded'
    ) {
      return this.prefetchChargeIdForActivation(event);
    }
    if (
      event.type !== 'invoice.paid' &&
      event.type !== 'invoice.payment_succeeded'
    ) {
      return {};
    }
    const inv = event.data.object as { subscription?: string | null };
    if (!inv?.subscription) return {};
    // Only pre-resolve when this invoice maps to a package purchase we own;
    // otherwise the SaaS-coach-subscription path (BillingService) handles it
    // and we avoid a needless Stripe call.
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
      select: { id: true },
    });
    if (!purchase) return {};
    try {
      const invoiceSubscription = await this.stripeConnect.retrieveSubscription(
        inv.subscription,
      );
      return { invoiceSubscription };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: retrieveSubscription failed for sub=${inv.subscription}: ${(err as Error).message}`,
      );
      return { invoiceSubscription: null };
    }
  }

  /**
   * PR-18 B1 R3 P1 — resolve, out-of-tx, the Stripe charge id for the pending
   * purchase that a checkout.session.completed / payment_intent.succeeded
   * event will activate, so the post-commit split posting needs no Stripe HTTP
   * inside the outer $transaction. Best-effort and never throws — a null entry
   * means the split handler will no-op the transfer and the sweeper retries.
   */
  private async prefetchChargeIdForActivation(
    event: StripeEvent,
  ): Promise<CheckoutWebhookPrefetch> {
    const obj = event.data.object as {
      id?: string;
      payment_intent?: string | null;
      latest_charge?: string | { id?: string } | null;
      charges?: { data?: Array<{ id?: string }> };
    };
    try {
      let purchaseId: string | null = null;
      let paymentIntentId: string | null = null;
      // Charge id may already be on the event payload (PI events carry
      // latest_charge); prefer it to avoid a needless Stripe round-trip.
      let chargeId: string | null =
        (typeof obj.latest_charge === 'string' ? obj.latest_charge : null) ??
        (obj.latest_charge && typeof obj.latest_charge === 'object'
          ? obj.latest_charge.id ?? null
          : null) ??
        obj.charges?.data?.[0]?.id ??
        null;

      if (event.type === 'checkout.session.completed') {
        if (!obj.id) return {};
        const purchase = await this.prisma.clientPurchase.findUnique({
          where: { stripe_checkout_session_id: obj.id },
          select: { id: true, stripe_payment_intent_id: true },
        });
        if (!purchase) return {};
        purchaseId = purchase.id;
        paymentIntentId =
          obj.payment_intent ?? purchase.stripe_payment_intent_id ?? null;
      } else {
        // payment_intent.succeeded
        if (!obj.id) return {};
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: obj.id, status: 'pending' },
          select: { id: true },
        });
        if (!purchase) return {};
        purchaseId = purchase.id;
        paymentIntentId = obj.id;
      }

      // Resolve the charge id from the PaymentIntent when the event payload
      // didn't already carry it. This is the ONLY Stripe HTTP in the path and
      // it runs BEFORE the outer tx opens.
      if (!chargeId && paymentIntentId) {
        const pi = await this.stripeConnect.retrievePaymentIntent(
          paymentIntentId,
        );
        chargeId =
          (typeof pi.latest_charge === 'string' ? pi.latest_charge : null) ??
          pi.charges?.data?.[0]?.id ??
          null;
      }
      return { chargeIdByPurchaseId: { [purchaseId]: chargeId } };
    } catch (err) {
      this.logger.warn(
        `prefetchForOuterTx: charge-id pre-resolution failed for ${event.type} ${obj.id ?? 'unknown'}: ${(err as Error).message}`,
      );
      return {};
    }
  }

  private async applyCheckoutCompleted(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const session = event.data.object as {
      id?: string;
      payment_intent?: string | null;
      subscription?: string | null;
      customer?: string | null;
      metadata?: Record<string, string>;
      mode?: string;
      status?: string;
    };
    if (!session?.id) return { claimed: false, reason: 'no_session_id' };

    // Use the outer tx for the read so we see uncommitted state from the
    // same transaction (e.g. a row inserted by a prior handler step) and
    // so any racing event delivery serialises on the row's tx lock.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_checkout_session_id: session.id },
    });
    if (!purchase) {
      // Not one of ours.
      return { claimed: false, reason: 'no_matching_purchase' };
    }

    const pkg = await db.coachPackage.findUnique({
      where: { id: purchase.package_id },
    });

    const isRecurring = session.mode === 'subscription' || !!session.subscription;
    const newStatus = isRecurring ? 'active' : 'paid';

    const accessExpiresAt = this.computeAccessExpiry(pkg, purchase, isRecurring, null);

    // B1 pricing-lock serialization (PR-18). Before flipping this purchase
    // to entitlement_active=true, take the SAME CoachPackage row lock that
    // PackagesService.update() takes (`SELECT id ... FOR UPDATE`). The
    // pricing-lock transaction counts active recurring buyers under that
    // row lock; if a recurring activation could commit WITHOUT touching the
    // package row, the count could miss it and a price edit could slip past
    // the guard. Taking the package-row lock here forces the two operations
    // to serialize on the package row: whichever transaction acquires the
    // lock first runs to completion, and the other blocks until commit and
    // then observes the committed state (the activation sees the price
    // edit, or the price edit's count sees the now-active buyer and locks).
    // No deadlock: every path acquires the SAME single row lock and never a
    // second one, so there is no lock-ordering cycle.
    const updated = await this.activateUnderPackageLock(
      tx,
      purchase.package_id,
      (client) =>
        client.clientPurchase.update({
          where: { id: purchase.id },
          data: {
            status: newStatus,
            entitlement_active: true,
            stripe_payment_intent_id: session.payment_intent ?? null,
            stripe_subscription_id: session.subscription ?? null,
            stripe_customer_id: session.customer ?? purchase.stripe_customer_id,
            access_expires_at: accessExpiresAt,
            last_error: null,
          },
        }),
    );

    // Roman P4 (Option C) — first-payment notification. Runs AFTER the status
    // flip to a successful terminal status, on the SAME outer tx so the
    // exactly-once ledger row commits-or-rolls-back with this purchase
    // (50-Failures #44). Gated on FEATURE_ROMAN_FIRST_PAYMENT (default OFF).
    await this.maybeEmitFirstPayment(updated, tx);

    // Phase 4 — materialize ledger + post head-coach transfer now that
    // the charge has actually succeeded.
    //
    // PR-18 B1 R3 P1: PurchaseSplitHandlerService.onChargeSucceeded() can
    // synchronously call Stripe (retrievePaymentIntent to resolve the charge
    // id AND transfers.attempt() which POSTs a Transfer). When BillingService
    // holds an outer $transaction (it took the CoachPackage FOR UPDATE lock
    // via activateUnderPackageLock above), running that Stripe HTTP inline
    // would hold the Postgres connection — and the package row lock — across
    // the round-trip (the A276-P1-3 anti-pattern, made worse by B1's lock).
    // So when a tx is held we DEFER the split posting to post-commit and
    // return a descriptor; BillingService runs it after the tx commits, using
    // the charge id we pre-resolved out-of-tx in prefetchForOuterTx. When no
    // outer tx is held (legacy/test path) we run it inline against
    // `this.prisma` exactly as before — that path never holds a tx so it is
    // already free of the in-tx-HTTP hazard.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched);

    // PR-9 — fan-out (drop seed + immediate inline materialisation) INSIDE
    // the outer tx so entitlement + content commit-or-rollback together.
    // A resolver failure here re-throws and rolls the whole event back;
    // Stripe retries; the StripeProcessedEvent dedup + PurchaseFanout
    // @unique + ScheduledDrop @@unique + per-resolver uniques (PR-7)
    // make the retry safe.
    //
    // Legacy callers (test wiring without a real $transaction) still
    // get an idempotent PurchaseFanout row via the @unique guard but
    // skip the drop seed.
    if (this.fanout && tx) {
      await this.fanout.onPurchaseEntitled(
        updated,
        {
          entrypoint: 'in_app_hosted',
          coachId: updated.coach_user_id,
          clientId: updated.client_user_id,
          purchaseTime: new Date(),
        },
        tx,
      );
    } else if (this.fanout) {
      // No outer tx (legacy/test path) — record the idempotency row only.
      try {
        await this.fanout.onPurchaseEntitled(
          updated,
          {
            entrypoint: 'in_app_hosted',
            coachId: updated.coach_user_id,
            clientId: updated.client_user_id,
          },
          this.prisma as unknown as WebhookTx,
        );
      } catch (err) {
        this.logger.warn(
          `Fanout seam failed for purchase=${updated.id} (no-tx legacy path): ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  /**
   * PR-18 B1 R3 P1 — run the head-coach split posting for a just-activated
   * purchase, or DEFER it to post-commit when an outer $transaction is held.
   *
   * onChargeSucceeded resolves the parent Stripe charge id (retrievePaymentIntent)
   * and may immediately post the head-coach Transfer (createTransfer) — both
   * Stripe HTTP. Doing that while the caller's outer tx (and the CoachPackage
   * FOR UPDATE lock) is open holds the Postgres connection across a Stripe
   * round-trip. So:
   *   - tx held  → return a DeferredSplitTask carrying the pre-resolved charge
   *     id; BillingService.runDeferredSplit runs the posting AFTER commit.
   *   - no tx    → run inline against this.prisma exactly as before (legacy /
   *     sweeper / unit-test path; no lock held, so safe).
   * Returns the descriptor when deferred, otherwise undefined.
   */
  private async runOrDeferSplit(
    purchase: ClientPurchase,
    tx: WebhookTx | undefined,
    prefetched: CheckoutWebhookPrefetch | undefined,
    extra?: { invoice_amount_cents?: number; invoice_charge_id?: string | null },
  ): Promise<DeferredSplitTask | undefined> {
    if (!this.splits) return undefined;
    // Pre-resolved (out-of-tx) charge id for this purchase, when available.
    const preChargeId =
      extra?.invoice_charge_id ??
      prefetched?.chargeIdByPurchaseId?.[purchase.id] ??
      null;
    if (tx) {
      // Defer: do NOT touch Stripe while the outer tx / package lock is held.
      return {
        purchase,
        charge_id: preChargeId,
        invoice_amount_cents: extra?.invoice_amount_cents,
      };
    }
    // No outer tx — safe to post inline (legacy/sweeper/test path).
    try {
      await this.splits.onChargeSucceeded({
        purchase,
        invoice_amount_cents: extra?.invoice_amount_cents,
        invoice_charge_id: preChargeId ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Split posting failed for purchase=${purchase.id}: ${(err as Error).message}`,
      );
    }
    return undefined;
  }

  /**
   * PR-18 B1 R3 P1 — execute a split posting that applyCheckoutCompleted /
   * applyPaymentIntentSucceeded / applyInvoicePaid deferred because the caller
   * held an outer $transaction. Called by BillingService AFTER that tx commits
   * (so the package row lock is released and no DB tx is open across the Stripe
   * round-trip). The pre-resolved charge id is threaded as invoice_charge_id so
   * onChargeSucceeded does NOT re-issue retrievePaymentIntent. Failure-isolated:
   * the split ledger is idempotent and the transfer is idempotency-keyed +
   * sweeper-backed, so a thrown error here is logged, not propagated (money
   * must never depend on a post-commit best-effort hook).
   */
  async runDeferredSplit(task: DeferredSplitTask): Promise<void> {
    if (!this.splits) return;
    try {
      await this.splits.onChargeSucceeded({
        purchase: task.purchase,
        invoice_amount_cents: task.invoice_amount_cents,
        invoice_charge_id: task.charge_id ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Deferred split posting failed for purchase=${task.purchase.id}: ${(err as Error).message}`,
      );
    }
  }

  private async applyCheckoutExpired(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const session = event.data.object as { id?: string };
    if (!session?.id) return { claimed: false, reason: 'no_session_id' };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_checkout_session_id: session.id },
    });
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    if (purchase.status !== 'pending') {
      // Don't override a paid/active row with expired.
      return { claimed: true, purchase_id: purchase.id, reason: 'already_progressed' };
    }
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: { status: 'expired', entitlement_active: false },
    });
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applySubscriptionUpdated(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const sub = event.data.object as {
      id?: string;
      status?: string;
      customer?: string | { id?: string };
      current_period_end?: number;
      cancel_at_period_end?: boolean;
      canceled_at?: number | null;
      metadata?: Record<string, string>;
    };
    if (!sub?.id) return { claimed: false, reason: 'no_sub_id' };

    // PR-18 B1 — use the caller's outer tx for reads/writes when provided so
    // the entitlement activation (and its CoachPackage row lock) commit-or-
    // rollback together with the StripeProcessedEvent dedup row instead of
    // committing independently via a nested $transaction.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    // Claim only if this subscription corresponds to a known package
    // purchase. SaaS coach subscriptions are tracked in CoachSubscription
    // via BillingService; this handler stays out of those.
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: sub.id },
    });
    if (!purchase) {
      // Heuristic 2: metadata may carry binding fields if the subscription
      // was minted by our checkout but the webhook arrived before the
      // checkout.session.completed event populated the FK.
      // Require all binding identifiers from metadata before claiming.
      // Matching only on package_id risks cross-binding two clients who bought
      // the same package in a short window.
      const pkgIdFromMeta = sub.metadata?.tgp_package_id;
      const clientIdFromMeta = sub.metadata?.tgp_client_user_id;
      const coachIdFromMeta = sub.metadata?.tgp_coach_user_id;
      const customerIdFromMeta =
        typeof sub.customer === 'string' ? sub.customer : (sub as any).customer?.id;

      if (!pkgIdFromMeta || !clientIdFromMeta || !coachIdFromMeta || !customerIdFromMeta) {
        this.logger.warn(
          `applySubscriptionUpdated: missing binding metadata on sub ${sub.id} — skipping fallback`,
        );
        return { claimed: false, reason: 'missing_binding_metadata' };
      }

      const pending = await db.clientPurchase.findFirst({
        where: {
          package_id: pkgIdFromMeta,
          client_user_id: clientIdFromMeta,
          coach_user_id: coachIdFromMeta,
          stripe_customer_id: customerIdFromMeta,
          status: 'pending',
          stripe_subscription_id: null,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false, reason: 'no_pending_purchase_for_metadata' };

      // Use updateMany with the same where clause to guard against races —
      // only one concurrent call can win the stripe_subscription_id: null check.
      const bound = await db.clientPurchase.updateMany({
        where: {
          id: pending.id,
          stripe_subscription_id: null,
        },
        data: { stripe_subscription_id: sub.id },
      });
      if (bound.count === 0) {
        // Another event already claimed this row.
        this.logger.warn(
          `applySubscriptionUpdated: race-lost binding for purchase ${pending.id}`,
        );
        return { claimed: false, reason: 'race_lost' };
      }
      return this.applySubscriptionUpdated(event, tx);
    }

    const pkg = await db.coachPackage.findUnique({
      where: { id: purchase.package_id },
    });

    const status = this.normalizeSubscriptionStatus(sub.status);
    const entitlementActive = ['active', 'trialing', 'past_due'].includes(status);
    const currentPeriodEnd = this.toDate(sub.current_period_end);
    const canceledAt = this.toDate(sub.canceled_at);

    const accessExpiresAt = this.computeAccessExpiry(
      pkg,
      purchase,
      true,
      currentPeriodEnd,
    );

    // B1 pricing-lock serialization (PR-18). This path can flip
    // entitlement_active=true for a recurring purchase (active/trialing/
    // past_due), so it must serialize against PackagesService.update()'s
    // CoachPackage row lock. We take the same `SELECT id ... FOR UPDATE`
    // before the update. See applyCheckoutCompleted for the full argument.
    // When BillingService threads its outer tx through handle(event, tx) the
    // lock + activation run on that tx (no nested $transaction); otherwise
    // the helper opens its own short $transaction.
    await this.activateUnderPackageLock(tx, purchase.package_id, (client) =>
      client.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          status,
          entitlement_active: entitlementActive,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          current_period_end: currentPeriodEnd,
          canceled_at: canceledAt,
          access_expires_at: accessExpiresAt,
        },
      }),
    );
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applySubscriptionDeleted(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const sub = event.data.object as { id?: string; canceled_at?: number | null };
    if (!sub?.id) return { claimed: false, reason: 'no_sub_id' };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: sub.id },
    });
    if (!purchase) return { claimed: false };
    // Capture pre-revocation entitlement so we know whether this purchase
    // was actually serving content — only entitled purchases have drops
    // worth canceling (cancelPendingForPurchase is still safe for
    // never-entitled purchases — its WHERE clause returns count=0 — but
    // skipping the call avoids noise in the logs).
    const wasEntitled = !!purchase.entitlement_active;
    await db.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'canceled',
        entitlement_active: false,
        canceled_at: this.toDate(sub.canceled_at) ?? new Date(),
      },
    });
    // PR-16 — cancel any not-yet-fired drops for this purchase. Runs in
    // the SAME outer $transaction as the entitlement flip (when caller
    // provides a tx) so revoke + cancel commit-or-rollback together.
    if (this.fanout && wasEntitled) {
      await this.fanout.cancelPendingForPurchase(
        purchase.id,
        'subscription_canceled',
        (tx ?? (this.prisma as unknown as WebhookTx)),
      );
    }
    // DUNNING-V1 — explicitly terminate the dunning window so no further
    // cadence reminders fire after Stripe (or the customer) cancels.
    if (this.dunning) {
      try {
        await this.dunning.terminate(purchase.id, 'subscription_deleted');
      } catch (err) {
        this.logger.warn(
          `dunning.terminate failed purchase=${purchase.id}: ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  // B3: PaymentSheet flow path. CheckoutSession-completed already covers the
  // hosted-checkout case, but PaymentIntent (created via
  // /v1/checkout/payment-intent for the in-app PaymentSheet) never gets a
  // checkout.session.completed event — only payment_intent.succeeded. Without
  // this case the matching ClientPurchase row stays in `pending` forever.
  private async applyPaymentIntentSucceeded(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false, reason: 'no_pi_id' };

    const db: WebhookTx | PrismaService = tx ?? this.prisma;

    // Only claim if a pending purchase row references this payment intent.
    // PaymentSheet flow creates a pending ClientPurchase with the PI id set
    // by checkout.service.ts createPaymentIntentForClient().
    const purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id, status: 'pending' },
    });
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };

    const updated = await db.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'paid',
        entitlement_active: true,
        last_error: null,
      },
    });

    // Roman P4 (Option C) — first-payment notification on the PaymentSheet
    // (payment_intent.succeeded) path too. Same in-tx, server-trusted,
    // feature-flagged contract as the checkout.session.completed callsite.
    await this.maybeEmitFirstPayment(updated, tx);

    // PR-18 B1 R3 P1 — defer the split posting to post-commit when an outer
    // tx is held (see runOrDeferSplit / runDeferredSplit + applyCheckoutCompleted
    // for the boundary rationale); run inline only on the no-tx legacy path.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched);

    // PR-9 — fan-out INSIDE the outer tx (when provided). Resolver
    // failure on an immediate drop rethrows and rolls back entitlement
    // + drops together; Stripe retries idempotently.
    if (this.fanout && tx) {
      await this.fanout.onPurchaseEntitled(
        updated,
        {
          entrypoint: 'in_app_ps',
          coachId: updated.coach_user_id,
          clientId: updated.client_user_id,
          purchaseTime: new Date(),
        },
        tx,
      );
    } else if (this.fanout) {
      try {
        await this.fanout.onPurchaseEntitled(
          updated,
          {
            entrypoint: 'in_app_ps',
            coachId: updated.coach_user_id,
            clientId: updated.client_user_id,
          },
          this.prisma as unknown as WebhookTx,
        );
      } catch (err) {
        this.logger.warn(
          `Fanout seam failed for purchase=${updated.id} (no-tx legacy path): ${(err as Error).message}`,
        );
      }
    }

    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  private async applyPaymentIntentFailed(
    event: StripeEvent,
    tx?: WebhookTx,
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      last_payment_error?: { message?: string };
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false };
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id },
    });
    if (!purchase) {
      // Try metadata fallback: tgp_package_id + tgp_client_user_id may be
      // present on the failing PI for a one_time package.
      const pkgId = pi.metadata?.tgp_package_id;
      const clientId = pi.metadata?.tgp_client_user_id;
      if (!pkgId || !clientId) return { claimed: false };
      const pending = await db.clientPurchase.findFirst({
        where: {
          package_id: pkgId,
          client_user_id: clientId,
          status: 'pending',
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false };
      // Never-entitled pending purchase — flip to payment_failed only.
      // Per PR-16 brief: PI-failed for a never-entitled purchase must NOT
      // cancel drops (none exist anyway; fanout was never run). Skip the
      // cancel call to keep the log line out of the never-entitled path.
      await db.clientPurchase.update({
        where: { id: pending.id },
        data: {
          status: 'payment_failed',
          entitlement_active: false,
          last_error: pi.last_payment_error?.message ?? 'payment_failed',
          stripe_payment_intent_id: pi.id,
        },
      });
      return { claimed: true, purchase_id: pending.id };
    }
    // Capture pre-flip entitlement: only entitled purchases have drops
    // worth canceling. A first-attempt PaymentSheet failure on a still-
    // pending purchase never minted drops; a later recurring-charge
    // failure on an already-entitled purchase did. Either way the cancel
    // call is idempotent — but skipping when wasEntitled=false matches
    // the brief's "PI-failed-never-entitled does not cancel" semantic
    // and keeps the log clean.
    const wasEntitled = !!purchase.entitlement_active;
    await db.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'payment_failed',
        entitlement_active: false,
        last_error: pi.last_payment_error?.message ?? 'payment_failed',
      },
    });
    if (this.fanout && wasEntitled) {
      await this.fanout.cancelPendingForPurchase(
        purchase.id,
        'payment_failed',
        (tx ?? (this.prisma as unknown as WebhookTx)),
      );
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applyInvoicePaid(
    event: StripeEvent,
    tx?: WebhookTx,
    prefetched?: CheckoutWebhookPrefetch,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      id?: string;
      subscription?: string | null;
      amount_paid?: number;
      charge?: string | null;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.subscription) return { claimed: false };
    // PR-18 B1 — read/write on the caller's outer tx when provided so the
    // renewal entitlement activation (and its CoachPackage row lock) commit
    // with the StripeProcessedEvent dedup row instead of via a nested
    // $transaction.
    const db: WebhookTx | PrismaService = tx ?? this.prisma;
    const purchase = await db.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    // Resync subscription state from Stripe so current_period_end and
    // entitlement window are fresh after a renewal.
    let updated = purchase;
    try {
      // PR-18 B1 — NEVER perform Stripe HTTP while a DB transaction is held.
      // When BillingService threads its outer tx, it ALSO pre-resolves the
      // subscription via `prefetchForOuterTx(event)` BEFORE opening the tx
      // and passes it here, so the round-trip already happened out-of-tx.
      // When there is no outer tx (legacy/test resync path), it is safe to
      // retrieve here because activateUnderPackageLock opens its own short
      // tx AFTER this call. If an outer tx is held but no prefetch was
      // supplied, we must not block the connection on Stripe — skip the
      // resync (degraded but correct: entitlement/window simply isn't
      // refreshed on this delivery; a later event or the reconciler will).
      let sub = prefetched?.invoiceSubscription ?? null;
      if (!sub) {
        if (tx) {
          this.logger.warn(
            `invoice.paid resync skipped for sub=${inv.subscription}: outer tx held without a prefetched subscription (no Stripe HTTP in tx)`,
          );
          return { claimed: true, purchase_id: purchase.id };
        }
        sub = await this.stripeConnect.retrieveSubscription(inv.subscription);
      }
      const pkg = await db.coachPackage.findUnique({
        where: { id: purchase.package_id },
      });
      const status = this.normalizeSubscriptionStatus(sub.status);
      const currentPeriodEnd = this.toDate(sub.current_period_end);
      updated = await this.activateUnderPackageLock(
        tx,
        purchase.package_id,
        (client) =>
          client.clientPurchase.update({
            where: { id: purchase.id },
            data: {
              status,
              entitlement_active: ['active', 'trialing', 'past_due'].includes(
                status,
              ),
              current_period_end: currentPeriodEnd,
              access_expires_at: this.computeAccessExpiry(
                pkg,
                purchase,
                true,
                currentPeriodEnd,
              ),
              last_error: null,
            },
          }),
      );
    } catch (err) {
      this.logger.warn(
        `invoice.paid resync failed for sub=${inv.subscription}: ${(err as Error).message}`,
      );
    }
    // Phase 4 — per-renewal split: each invoice.paid mints (or
    // re-collapses-onto) the head-coach Transfer for that invoice.
    //
    // PR-18 B1 R3 P1: the invoice event already carries the charge id
    // (`inv.charge`) so no retrievePaymentIntent is needed, but
    // onChargeSucceeded still calls transfers.attempt() (createTransfer =
    // Stripe HTTP). When an outer tx is held we defer the posting to
    // post-commit, threading inv.charge as the pre-resolved charge id; with
    // no outer tx we run it inline as before.
    const deferredSplit = await this.runOrDeferSplit(updated, tx, prefetched, {
      invoice_amount_cents: inv.amount_paid ?? undefined,
      invoice_charge_id: inv.charge ?? null,
    });
    // Phase 5 — clear any active dunning window.
    if (this.dunning) {
      try {
        await this.dunning.recordResolution(updated.id);
      } catch (err) {
        this.logger.warn(
          `dunning.recordResolution failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    // B3 v2 (§5) — immediate-clear additions (restore entitlement, lift Day-10
    // lockout, dismiss blockers, revoke recovery tokens). No-op when the flag
    // is off; runs AFTER the v1 recordResolution so v1 behaviour is unchanged.
    if (this.dunningV2) {
      try {
        await this.dunningV2.applyImmediateClear(updated.id, 'retry');
      } catch (err) {
        this.logger.warn(
          `dunningV2.applyImmediateClear failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id, deferredSplit };
  }

  private async applyInvoicePaymentFailed(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      id?: string;
      subscription?: string | null;
      amount_due?: number | null;
      attempt_count?: number | null;
      last_payment_error?: { message?: string };
    };
    if (!inv?.subscription) return { claimed: false };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    const updated = await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'past_due',
        // Entitlement is retained during past_due — same as SaaS billing —
        // until Stripe ultimately cancels the subscription, which fires
        // customer.subscription.deleted.
        last_error: inv.last_payment_error?.message ?? 'invoice_payment_failed',
      },
    });
    // Phase 5 — open or extend the dunning window and queue a reminder.
    if (this.dunning) {
      try {
        await this.dunning.recordFailure({
          purchase: updated,
          stripe_invoice_id: inv.id ?? null,
          amount_due_cents: typeof inv.amount_due === 'number' ? inv.amount_due : null,
          attempt_number:
            typeof inv.attempt_count === 'number' ? inv.attempt_count : null,
          reason: inv.last_payment_error?.message ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `dunning.recordFailure failed purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applyCustomerUpdated(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const cus = event.data.object as {
      id?: string;
      invoice_settings?: {
        default_payment_method?:
          | string
          | { id?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } }
          | null;
      };
    };
    if (!cus?.id) return { claimed: false };
    const customer = await this.prisma.connectCustomer.findUnique({
      where: { stripe_customer_id: cus.id },
    });
    if (!customer) return { claimed: false };

    const dpm = cus.invoice_settings?.default_payment_method;
    let pmId: string | null = null;
    let brand: string | null = null;
    let last4: string | null = null;
    let expMonth: number | null = null;
    let expYear: number | null = null;
    if (typeof dpm === 'string') {
      pmId = dpm;
      // Stripe didn't expand — pull the card details.
      try {
        const pm = await this.stripeConnect.retrievePaymentMethod(dpm);
        brand = pm.card?.brand ?? null;
        last4 = pm.card?.last4 ?? null;
        expMonth = pm.card?.exp_month ?? null;
        expYear = pm.card?.exp_year ?? null;
      } catch (err) {
        this.logger.warn(
          `customer.updated: failed to retrieve payment method ${dpm}: ${(err as Error).message}`,
        );
      }
    } else if (dpm && typeof dpm === 'object') {
      pmId = dpm.id ?? null;
      brand = dpm.card?.brand ?? null;
      last4 = dpm.card?.last4 ?? null;
      expMonth = dpm.card?.exp_month ?? null;
      expYear = dpm.card?.exp_year ?? null;
    }

    await this.prisma.connectCustomer.update({
      where: { stripe_customer_id: cus.id },
      data: {
        default_payment_method_id: pmId,
        default_card_brand: brand,
        default_card_last4: last4,
        default_card_exp_month: expMonth,
        default_card_exp_year: expYear,
      },
    });
    return { claimed: true };
  }

  /**
   * B1 pricing-lock serialization (PR-18).
   *
   * Runs `activate` (a ClientPurchase entitlement-activation write) AFTER
   * taking a `SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR
   * UPDATE` row lock on the package, inside the SAME transaction that
   * performs the activation. This is the exact lock that
   * PackagesService.update() takes before it counts active recurring
   * buyers and writes a price edit.
   *
   * Serialization argument (what locks what, in what order, no deadlock):
   *   - Both the pricing-edit tx and the activation tx acquire ONE lock:
   *     the `CoachPackage` row identified by `packageId`. Neither acquires
   *     a second lock while holding the first, so there is no
   *     lock-ordering cycle and therefore no deadlock.
   *   - Whichever tx acquires the row lock first runs to completion; the
   *     other blocks on the row lock until the first commits, then proceeds
   *     against the now-committed state:
   *       * If the activation commits first, the pricing edit's count
   *         (taken under the same row lock) sees the newly active recurring
   *         buyer and throws PACKAGE_PRICING_LOCKED.
   *       * If the pricing edit commits first, this activation observes the
   *         already-edited package row when it proceeds (the price change
   *         is fully committed before the buyer becomes active).
   *   - The guard can therefore NEVER miss an entitlement activation that
   *     commits before the price update commits.
   *
   * When the caller already holds an outer `$transaction` (BillingService
   * threads its tx through `handle(event, tx)`), the lock + activation run
   * on that same tx. When there is no outer tx (the subscription/invoice
   * resync paths call `this.prisma` directly), we open our own short
   * `$transaction` so the FOR UPDATE lock is held across the activating
   * write. No Stripe HTTP is performed inside this transaction.
   */
  private async activateUnderPackageLock<T>(
    tx: WebhookTx | undefined,
    packageId: string,
    activate: (client: WebhookTx) => Promise<T>,
  ): Promise<T> {
    const runLocked = async (client: WebhookTx): Promise<T> => {
      // Legacy/test wiring may pass a minimal client stub without $queryRaw.
      // Production prisma always provides it, so the FOR UPDATE row lock is
      // unchanged there; in the stub case we skip the raw lock and just run
      // the activation write (same defensive pattern as the no-$transaction
      // fallback below).
      if (
        typeof (client as { $queryRaw?: unknown }).$queryRaw === 'function'
      ) {
        await client.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR UPDATE`;
      }
      return activate(client);
    };
    if (tx) {
      // Already inside the caller's outer $transaction — lock on it.
      return runLocked(tx);
    }
    // No outer tx — open our own so the row lock is held across the write.
    // Legacy/test wiring may hand-construct this service with a minimal
    // prisma stub that lacks `$transaction` (the same defensive pattern the
    // fanout no-tx path uses). In that case run the lock + activate directly
    // on `this.prisma`: production always provides `$transaction`, so the
    // FOR UPDATE serialization is unchanged there.
    if (
      typeof (this.prisma as { $transaction?: unknown }).$transaction ===
      'function'
    ) {
      return this.prisma.$transaction((innerTx) =>
        runLocked(innerTx as unknown as WebhookTx),
      );
    }
    return runLocked(this.prisma as unknown as WebhookTx);
  }

  // Compute access_expires_at given the package + purchase context.
  //
  // - Recurring: mirrors current_period_end. Once Stripe stops renewing
  //   (status=canceled), the row keeps current_period_end as a tombstone.
  // - One_time + duration_periods != null: created_at + duration_periods
  //   weeks. (Weeks is the unit because programs are typically advertised
  //   in week counts; if we ever need other units the package can carry an
  //   explicit duration_unit.)
  // - One_time + duration_periods == null: returns null (lifetime access).
  private computeAccessExpiry(
    pkg: CoachPackage | null,
    purchase: ClientPurchase,
    isRecurring: boolean,
    currentPeriodEnd: Date | null,
  ): Date | null {
    if (isRecurring) {
      // Pad recurring access by 1 day so a late renewal webhook doesn't
      // briefly drop entitlement between current_period_end and the new
      // current_period_end. Stripe's grace is typically minutes; 24h is a
      // safe cap.
      if (currentPeriodEnd) {
        return new Date(currentPeriodEnd.getTime() + 24 * 3600 * 1000);
      }
      return null;
    }
    if (!pkg || !pkg.duration_periods) return null;
    const startedAt = purchase.created_at;
    return new Date(
      startedAt.getTime() + pkg.duration_periods * 7 * 24 * 3600 * 1000,
    );
  }

  private normalizeSubscriptionStatus(status: string | undefined): string {
    // Stripe statuses: active | past_due | unpaid | canceled | incomplete |
    // incomplete_expired | trialing | paused
    if (!status) return 'pending';
    return status;
  }

  private toDate(seconds: number | null | undefined): Date | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }
}
