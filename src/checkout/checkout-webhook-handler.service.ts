import { Injectable, Logger } from '@nestjs/common';
import type { ClientPurchase, CoachPackage } from '@prisma/client';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';

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
  ) {}

  // Returns claimed=true iff the event was for a Connect package purchase
  // (identified by `metadata.tgp_package_id` or by a matching
  // stripe_checkout_session_id / stripe_subscription_id on a ClientPurchase
  // row). The caller (BillingService) inspects claimed and skips the
  // SaaS-coach-subscription handler when this returns claimed=true.
  async handle(event: StripeEvent): Promise<CheckoutWebhookResult> {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.applyCheckoutCompleted(event);
      case 'checkout.session.expired':
        return this.applyCheckoutExpired(event);
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        return this.applySubscriptionUpdated(event);
      case 'customer.subscription.deleted':
        return this.applySubscriptionDeleted(event);
      case 'payment_intent.payment_failed':
        return this.applyPaymentIntentFailed(event);
      case 'invoice.paid':
        return this.applyInvoicePaid(event);
      case 'invoice.payment_failed':
        return this.applyInvoicePaymentFailed(event);
      case 'customer.updated':
        return this.applyCustomerUpdated(event);
      default:
        return { claimed: false };
    }
  }

  private async applyCheckoutCompleted(
    event: StripeEvent,
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

    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_checkout_session_id: session.id },
    });
    if (!purchase) {
      // Not one of ours.
      return { claimed: false, reason: 'no_matching_purchase' };
    }

    const pkg = await this.prisma.coachPackage.findUnique({
      where: { id: purchase.package_id },
    });

    const isRecurring = session.mode === 'subscription' || !!session.subscription;
    const newStatus = isRecurring ? 'active' : 'paid';

    const accessExpiresAt = this.computeAccessExpiry(pkg, purchase, isRecurring, null);

    await this.prisma.clientPurchase.update({
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
      // Heuristic 2: metadata may carry tgp_package_id if the subscription
      // was minted by our checkout but the webhook arrived before the
      // checkout.session.completed event populated the FK. Look it up by
      // metadata then.
      const pkgIdFromMeta = sub.metadata?.tgp_package_id;
      if (!pkgIdFromMeta) return { claimed: false };
      // Stash the subscription id on the matching pending purchase if any.
      const pending = await this.prisma.clientPurchase.findFirst({
        where: {
          package_id: pkgIdFromMeta,
          status: 'pending',
          stripe_subscription_id: null,
        },
        orderBy: { created_at: 'desc' },
      });
      if (!pending) return { claimed: false };
      await this.prisma.clientPurchase.update({
        where: { id: pending.id },
        data: { stripe_subscription_id: sub.id },
      });
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
      subscription?: string | null;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.subscription) return { claimed: false };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    // Resync subscription state from Stripe so current_period_end and
    // entitlement window are fresh after a renewal.
    try {
      const sub = await this.stripeConnect.retrieveSubscription(inv.subscription);
      const pkg = await this.prisma.coachPackage.findUnique({
        where: { id: purchase.package_id },
      });
      const status = this.normalizeSubscriptionStatus(sub.status);
      const currentPeriodEnd = this.toDate(sub.current_period_end);
      await this.prisma.clientPurchase.update({
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
    return { claimed: true, purchase_id: purchase.id };
  }

  private async applyInvoicePaymentFailed(
    event: StripeEvent,
  ): Promise<CheckoutWebhookResult> {
    const inv = event.data.object as {
      subscription?: string | null;
      last_payment_error?: { message?: string };
    };
    if (!inv?.subscription) return { claimed: false };
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { stripe_subscription_id: inv.subscription },
    });
    if (!purchase) return { claimed: false };
    await this.prisma.clientPurchase.update({
      where: { id: purchase.id },
      data: {
        status: 'past_due',
        // Entitlement is retained during past_due — same as SaaS billing —
        // until Stripe ultimately cancels the subscription, which fires
        // customer.subscription.deleted.
        last_error: inv.last_payment_error?.message ?? 'invoice_payment_failed',
      },
    });
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
