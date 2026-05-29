import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, CoachPackage, Prisma } from '@prisma/client';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
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
  ): Promise<CheckoutWebhookResult> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.applyCheckoutCompleted(event, tx);
      case 'checkout.session.expired':
        return this.applyCheckoutExpired(event);
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        return this.applySubscriptionUpdated(event);
      case 'customer.subscription.deleted':
        return this.applySubscriptionDeleted(event);
      case 'payment_intent.succeeded':
        return this.applyPaymentIntentSucceeded(event, tx);
      case 'payment_intent.payment_failed':
        return this.applyPaymentIntentFailed(event);
      // DUNNING-V1 — invoice.payment_succeeded mirrors invoice.paid in
      // Stripe's docs for the subscription-renewal path; some accounts
      // emit one, some the other. We route both to the same handler so
      // the dunning window resolution is robust either way.
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return this.applyInvoicePaid(event);
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
        if (this.refundDispute) return this.refundDispute.handle(event);
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

    const updated = await db.clientPurchase.update({
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
    });

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

    // Claim only if this subscription corresponds to a known package
    // purchase. SaaS coach subscriptions are tracked in CoachSubscription
    // via BillingService; this handler stays out of those.
    const purchase = await this.prisma.clientPurchase.findUnique({
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

      const pending = await this.prisma.clientPurchase.findFirst({
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
      const bound = await this.prisma.clientPurchase.updateMany({
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
      return this.applySubscriptionUpdated(event);
    }

    const pkg = await this.prisma.coachPackage.findUnique({
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

    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status,
        entitlement_active: entitlementActive,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        current_period_end: currentPeriodEnd,
        canceled_at: canceledAt,
        access_expires_at: accessExpiresAt,
      },
    });
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applySubscriptionDeleted(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const sub = event.data.object as { id?: string; canceled_at?: number | null };
    if (!sub?.id) return { claimed: false, reason: 'no_sub_id' };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: sub.id },
    });
    if (!purchase) return { claimed: false };
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'canceled',
        entitlement_active: false,
        canceled_at: this.toDate(sub.canceled_at) ?? new Date(),
      },
    });
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
  ): Promise<CheckoutWebhookResult> {
    const pi = event.data.object as {
      id?: string;
      last_payment_error?: { message?: string };
      metadata?: Record<string, string>;
    };
    if (!pi?.id) return { claimed: false };
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: { stripe_payment_intent_id: pi.id },
    });
    if (!purchase) {
      // Try metadata fallback: tgp_package_id + tgp_client_user_id may be
      // present on the failing PI for a one_time package.
      const pkgId = pi.metadata?.tgp_package_id;
      const clientId = pi.metadata?.tgp_client_user_id;
      if (!pkgId || !clientId) return { claimed: false };
      const pending = await this.prisma.clientPurchase.findFirst({
        where: {
          package_id: pkgId,
          client_user_id: clientId,
          status: 'pending',
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false };
      await this.prisma.clientPurchase.update({
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
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'payment_failed',
        entitlement_active: false,
        last_error: pi.last_payment_error?.message ?? 'payment_failed',
      },
    });
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applyInvoicePaid(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      id?: string;
      subscription?: string | null;
      amount_paid?: number;
      charge?: string | null;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.subscription) return { claimed: false };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    // Resync subscription state from Stripe so current_period_end and
    // entitlement window are fresh after a renewal.
    let updated = purchase;
    try {
      const sub = await this.stripeConnect.retrieveSubscription(inv.subscription);
      const pkg = await this.prisma.coachPackage.findUnique({
        where: { id: purchase.package_id },
      });
      const status = this.normalizeSubscriptionStatus(sub.status);
      const currentPeriodEnd = this.toDate(sub.current_period_end);
      updated = await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          status,
          entitlement_active: ['active', 'trialing', 'past_due'].includes(status),
          current_period_end: currentPeriodEnd,
          access_expires_at: this.computeAccessExpiry(
            pkg,
            purchase,
            true,
            currentPeriodEnd,
          ),
          last_error: null,
        },
      });
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
