import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import {
  StripeConnectApiService,
  type StripeSubscriptionObject,
} from '../connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PrismaService } from '../prisma.service';
import { DunningService } from './dunning.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

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

export interface CheckoutWebhookResult {
  claimed: boolean;
  reason?: string;
  purchase_id?: string;
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
  ) {}

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
        return this.applyCheckoutCompleted(event, tx);
      case 'checkout.session.expired':
        return this.applyCheckoutExpired(event);
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        return this.applySubscriptionUpdated(event, tx);
      case 'customer.subscription.deleted':
        return this.applySubscriptionDeleted(event, tx);
      case 'payment_intent.succeeded':
        return this.applyPaymentIntentSucceeded(event, tx);
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
        if (this.refundDispute) return this.refundDispute.handle(event, tx);
        return { claimed: false };
      default:
        return { claimed: false };
    }
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

  private async applyCheckoutCompleted(
    event: StripeEvent,
    tx?: WebhookTx,
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

    // Phase 4 — materialize ledger + queue head-coach transfer now that
    // the charge has actually succeeded.
    //
    // PR-9 boundary: splits intentionally runs against `this.prisma`
    // (NOT the outer tx) because TransferOrchestratorService issues
    // synchronous Stripe HTTP calls to mint the head-coach Transfer —
    // exactly the A276-P1-3 anti-pattern that we explicitly keep out
    // of the outer $transaction (holding the Postgres connection
    // through a Stripe round-trip saturates the pool). The split
    // ledger itself is idempotent via composite-unique upserts +
    // sweep-on-retry, and its rows FK to the ClientPurchase row that
    // ALREADY exists in `pending` state (this handler only flips
    // `entitlement_active`, it doesn't create the purchase), so a
    // rolled-back outer tx leaves ledger rows that collapse onto
    // themselves on Stripe's retry rather than orphaning.
    if (this.splits) {
      try {
        await this.splits.onChargeSucceeded({ purchase: updated });
      } catch (err) {
        this.logger.warn(
          `Split posting failed for purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }

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
    return { claimed: true, purchase_id: purchase.id };
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

    // See applyCheckoutCompleted for the splits boundary rationale.
    if (this.splits) {
      try {
        await this.splits.onChargeSucceeded({ purchase: updated });
      } catch (err) {
        this.logger.warn(
          `Split posting failed for purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }

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

    return { claimed: true, purchase_id: purchase.id };
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
    if (this.splits) {
      try {
        await this.splits.onChargeSucceeded({
          purchase: updated,
          invoice_amount_cents: inv.amount_paid ?? undefined,
          invoice_charge_id: inv.charge ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `Split posting on renewal failed for purchase=${updated.id}: ${(err as Error).message}`,
        );
      }
    }
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
    return { claimed: true, purchase_id: purchase.id };
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
      await client.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "CoachPackage" WHERE id = ${packageId} FOR UPDATE`;
      return activate(client);
    };
    if (tx) {
      // Already inside the caller's outer $transaction — lock on it.
      return runLocked(tx);
    }
    // No outer tx — open our own so the row lock is held across the write.
    return this.prisma.$transaction((innerTx) =>
      runLocked(innerTx as unknown as WebhookTx),
    );
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
