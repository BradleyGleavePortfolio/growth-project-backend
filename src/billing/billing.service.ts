import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CheckoutWebhookHandlerService } from '../checkout/checkout-webhook-handler.service';
import { ConnectService } from '../connect/connect.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';

// BillingService is the system of record for the Stripe-mirror tables. The
// webhook controller hands it parsed Stripe event objects; this service
// applies them to CoachSubscription / Invoice / PaymentFailure rows.
//
// The mapping from a Stripe customer to our coach User is done via
// CoachProfile.stripe_customer_id. We refuse to mutate state when no coach
// can be resolved — better to log a warning than to silently overwrite the
// wrong row.

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
    private audit: AuditService,
    // ConnectService is @Optional() so the billing webhook handler still
    // boots in environments where ConnectModule was not imported (legacy
    // unit tests). When present, account.* events are forwarded to it.
    @Optional() private connect?: ConnectService,
    // CheckoutWebhookHandlerService claims checkout/session/subscription/
    // payment events that belong to a coach-package purchase. When it
    // claims an event, BillingService skips the SaaS-coach-subscription
    // handler for the same event so the two streams don't collide.
    @Optional() private checkoutWebhooks?: CheckoutWebhookHandlerService,
    // EmailService is @Optional() so legacy tests that hand-construct
    // BillingService without the email module still work. When present
    // it dispatches dunning email on invoice.payment_failed.
    @Optional() private email?: EmailService,
  ) {}

  // Idempotently process an event. Returns { processed: true } on first
  // delivery, { processed: false, alreadyProcessed: true } on duplicates so
  // the caller can return 200 either way (Stripe stops retrying after a 2xx).
  //
  // Insert-first idempotency: we claim the event id by inserting into
  // StripeProcessedEvent before running the handler. Two concurrent
  // deliveries of the same event id race on the @id unique constraint; the
  // loser hits P2002 and short-circuits as already-processed. This closes
  // the read-then-write race the previous implementation had.
  //
  // Handler errors *after* the claim are logged but the event stays
  // recorded — same poison-pill protection as the prior `finally` pattern,
  // but no longer racy.
  async handleEvent(event: StripeEvent) {
    if (!event?.id || !event?.type) {
      return { processed: false, reason: 'malformed' };
    }

    try {
      await this.prisma.stripeProcessedEvent.create({
        data: { stripe_event_id: event.id, type: event.type },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        return { processed: false, alreadyProcessed: true };
      }
      throw err;
    }

    try {
      // Phase 2-3 Connect — give the checkout handler first refusal on
      // events that may belong to a coach-package purchase. If it claims
      // the event, skip the SaaS-coach-subscription path so the two
      // streams don't both try to upsert state from the same payload.
      let claimedByCheckout = false;
      if (this.checkoutWebhooks) {
        try {
          const result = await this.checkoutWebhooks.handle(event);
          claimedByCheckout = !!result.claimed;
        } catch (err) {
          this.logger.error(
            `CheckoutWebhookHandler failed event=${event.id} type=${event.type}: ${(err as Error)?.message ?? String(err)}`,
          );
        }
      }

      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          if (!claimedByCheckout) await this.applySubscription(event);
          break;
        case 'customer.subscription.deleted':
          if (!claimedByCheckout) await this.applySubscriptionDeleted(event);
          break;
        case 'invoice.paid':
          if (!claimedByCheckout) await this.applyInvoicePaid(event);
          break;
        case 'invoice.payment_failed':
          if (!claimedByCheckout) await this.applyInvoicePaymentFailed(event);
          break;
        case 'customer.updated':
          if (!claimedByCheckout) await this.applyCustomerUpdated(event);
          break;
        // Checkout / payment events are owned entirely by
        // CheckoutWebhookHandlerService (no SaaS-coach-subscription path).
        case 'checkout.session.completed':
        case 'checkout.session.expired':
        case 'payment_intent.succeeded':
        case 'payment_intent.payment_failed':
          // Already dispatched above; nothing more to do.
          break;
        // Phase 1 Connect — Express account state mirror. Same endpoint
        // receives both test-mode and live-mode events (livemode flag is
        // ignored here intentionally — both modes process identically).
        case 'account.updated':
        case 'capability.updated':
          await this.applyConnectAccountUpdated(event);
          break;
        case 'account.application.deauthorized':
          await this.applyConnectAccountDeauthorized(event);
          break;
        default:
          this.logger.log(`Ignoring unhandled Stripe event type: ${event.type}`);
      }
    } catch (err) {
      // The event id is already recorded, so a poison-pill payload won't
      // loop through Stripe's retry queue. Surface the error in logs and
      // return — the caller still treats this as a successful delivery
      // because retrying would just hit the idempotency short-circuit.
      this.logger.error(
        `Stripe event handler failed event=${event.id} type=${event.type}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
    return { processed: true };
  }

  // Detects Prisma's unique-constraint violation (P2002). Falls back to a
  // message regex so the in-memory test stub can simulate it without
  // importing Prisma's runtime error classes.
  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    if (typeof e.message === 'string' && /unique constraint/i.test(e.message)) {
      return true;
    }
    return false;
  }

  // Resolve coach by stripe customer id via CoachProfile.
  private async resolveCoachByCustomer(customerId: string | undefined | null) {
    if (!customerId) return null;
    // CoachProfile.stripe_customer_id is not @unique on the canonical Phase 1A
    // shape (CoachSubscription owns the @unique on its own customer mirror),
    // so we use findFirst here. Order by created_at desc so that if two
    // profiles share the same customer id (duplicate Stripe customer creation
    // race) we consistently pick the most-recently created one.
    const profile = await this.prisma.coachProfile.findFirst({
      where: { stripe_customer_id: customerId },
      orderBy: { created_at: 'desc' },
    });
    return profile?.user_id ?? null;
  }

  private toDate(seconds: unknown): Date | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }

  private async applySubscription(event: StripeEvent) {
    const sub = event.data.object as {
      id?: string;
      customer?: string;
      status?: string;
      current_period_end?: number;
      trial_end?: number | null;
      cancel_at_period_end?: boolean;
      items?: { data?: Array<{ price?: { id?: string } }> };
    };
    if (!sub?.id || !sub?.customer) {
      this.logger.warn(`Subscription event ${event.id} missing id/customer`);
      return;
    }
    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const status = sub.status ?? 'incomplete';

    // Hybrid pricing (spec §9): set tier based on subscription status.
    //   active | trialing      → tier='pro' (subscribe/upgrade)
    //   canceled | incomplete_expired → tier='free' (explicit downgrade)
    //   past_due               → no tier change (guard handles 7-day grace)
    //   incomplete | unpaid    → no tier change
    //
    // IMPORTANT — no accidental Pro→free downgrade on past_due:
    //   past_due → tier stays 'pro' in the DB
    //   → SubscriptionGuard handles the 7-day grace window (spec §6)
    // This ensures a momentary payment failure does not strip Pro access.
    let tierUpdate: { tier?: string } = {};
    if (status === 'active' || status === 'trialing') {
      tierUpdate = { tier: 'pro' };
    } else if (status === 'canceled' || status === 'incomplete_expired') {
      tierUpdate = { tier: 'free' };
    }
    // past_due: no tier change — guard handles grace
    // incomplete/unpaid: no tier change
    // Keep backward-compat alias for the create/update spread below:
    const tierForActiveSubscription = tierUpdate.tier;

    // Wrap the profile lookup and subscription upsert in a transaction so that
    // concurrent customer.subscription.created + customer.subscription.updated
    // deliveries cannot interleave the read and the write, which would
    // cross-link subscription IDs to the wrong coach row.
    const coachId = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.coachProfile.findFirst({
        where: { stripe_customer_id: sub.customer },
        orderBy: { created_at: 'desc' },
      });
      if (!profile) return null;
      await (tx.coachSubscription.upsert as any)({
        where: { coach_id: profile.user_id },
        create: {
          coach_id: profile.user_id,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status,
          // Set tier per status: pro on active/trialing, free on canceled/
          // incomplete_expired, schema-default 'free' on first create otherwise.
          ...(tierForActiveSubscription !== undefined ? { tier: tierForActiveSubscription } : {}),
          current_period_end: this.toDate(sub.current_period_end),
          trial_end: this.toDate(sub.trial_end ?? null),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        },
        update: {
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status,
          // Set tier per status: active|trialing → pro, canceled|
          // incomplete_expired → free, past_due/incomplete → no change
          // (leave existing tier value unchanged in the DB).
          ...(tierForActiveSubscription !== undefined ? { tier: tierForActiveSubscription } : {}),
          current_period_end: this.toDate(sub.current_period_end),
          trial_end: this.toDate(sub.trial_end ?? null),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        },
      });
      return profile.user_id;
    });
    if (!coachId) {
      this.logger.warn(
        `Subscription ${sub.id} for unknown customer ${sub.customer}`,
      );
      return;
    }
    this.analytics.capture(coachId, Events.SUBSCRIPTION_UPDATED, {
      stripe_event_type: event.type,
      status,
      stripe_price_id: priceId,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      had_trial: !!sub.trial_end,
    });
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_UPDATED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'coach_subscription',
      targetId: sub.id,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_customer_id: sub.customer,
        stripe_price_id: priceId,
        status,
        cancel_at_period_end: !!sub.cancel_at_period_end,
      },
    });
  }

  private async applySubscriptionDeleted(event: StripeEvent) {
    const sub = event.data.object as { id?: string; customer?: string };
    const coachId = await this.resolveCoachByCustomer(sub?.customer);
    if (!coachId) return;
    // Hybrid pricing (spec §9): on subscription deleted, set tier='free'.
    // Do NOT delete the row — preserves audit trail and stripe_customer_id
    // for reactivation (spec §9: "never delete the row").
    //
    // Why tier='free' here but NOT on past_due:
    //   Deleted = coach explicitly canceled or Stripe gave up after retries.
    //   past_due = transient payment failure. The 7-day grace window in
    //   SubscriptionGuard (§6) handles past_due. The tier in DB stays 'pro'
    //   during past_due so a card update can restore access without re-checkout.
    await (this.prisma.coachSubscription.update as any)({
      where: { coach_id: coachId },
      data: { status: 'canceled', cancel_at_period_end: false, tier: 'free' },
    });
    this.analytics.capture(coachId, Events.SUBSCRIPTION_CANCELED, {});
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_CANCELED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'coach_subscription',
      targetId: sub?.id ?? null,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_customer_id: sub?.customer ?? null,
      },
    });
  }

  private async applyInvoicePaid(event: StripeEvent) {
    const inv = event.data.object as {
      id?: string;
      customer?: string;
      amount_paid?: number;
      amount_due?: number;
      currency?: string;
      hosted_invoice_url?: string;
      invoice_pdf?: string;
      period_start?: number;
      period_end?: number;
      status?: string;
      status_transitions?: { paid_at?: number };
    };
    if (!inv?.id) return;
    const coachId = await this.resolveCoachByCustomer(inv.customer);
    if (!coachId) return;
    await this.prisma.invoice.upsert({
      where: { stripe_invoice_id: inv.id },
      create: {
        coach_id: coachId,
        stripe_invoice_id: inv.id,
        stripe_customer_id: inv.customer ?? null,
        amount_paid_cents: inv.amount_paid ?? 0,
        amount_due_cents: inv.amount_due ?? 0,
        currency: inv.currency ?? 'usd',
        status: inv.status ?? 'paid',
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
        period_start: this.toDate(inv.period_start),
        period_end: this.toDate(inv.period_end),
        paid_at: this.toDate(inv.status_transitions?.paid_at) ?? new Date(),
      },
      update: {
        amount_paid_cents: inv.amount_paid ?? 0,
        status: inv.status ?? 'paid',
        paid_at: this.toDate(inv.status_transitions?.paid_at) ?? new Date(),
      },
    });
    // Clear payment failure state. If the subscription was past_due (set by
    // invoice.payment_failed), restore it to active so the guard allows
    // access immediately without waiting for a customer.subscription.updated
    // event (which Stripe may deliver slightly later).
    await this.prisma.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: { last_payment_failed_at: null, failed_payments_this_month: 0 },
    });
    // Restore status if invoice payment resolved a past_due state.
    // We only upgrade past_due → active, never touch canceled/paused/trialing.
    // The authoritative status arrives via customer.subscription.updated;
    // this is a best-effort recovery that removes the lockout immediately.
    await this.prisma.coachSubscription.updateMany({
      where: { coach_id: coachId, status: 'past_due' },
      data: { status: 'active' },
    });
    // Stripe-sourced amounts only — these are real revenue, not synthesized.
    this.analytics.capture(coachId, Events.INVOICE_PAID, {
      amount_paid_cents: inv.amount_paid ?? 0,
      currency: inv.currency ?? 'usd',
    });
    await this.audit.write({
      action: AuditAction.BILLING_INVOICE_PAID,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'invoice',
      targetId: inv.id,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_invoice_id: inv.id,
        amount_paid_cents: inv.amount_paid ?? 0,
        currency: inv.currency ?? 'usd',
      },
    });
  }

  private async applyInvoicePaymentFailed(event: StripeEvent) {
    const inv = event.data.object as {
      id?: string;
      customer?: string;
      amount_due?: number;
      last_payment_error?: { message?: string };
    };
    const coachId = await this.resolveCoachByCustomer(inv?.customer);
    if (!coachId) return;
    const now = new Date();
    await this.prisma.paymentFailure.create({
      data: {
        coach_id: coachId,
        stripe_invoice_id: inv?.id ?? null,
        stripe_event_id: event.id,
        amount_due_cents: inv?.amount_due ?? 0,
        reason: inv?.last_payment_error?.message ?? null,
        occurred_at: now,
      },
    });
    await this.prisma.coachSubscription.updateMany({
      where: { coach_id: coachId, status: { notIn: ['canceled', 'paused'] } },
      data: {
        status: 'past_due',
        last_payment_failed_at: now,
        failed_payments_this_month: { increment: 1 },
      },
    });
    this.analytics.capture(coachId, Events.INVOICE_PAYMENT_FAILED, {
      amount_due_cents: inv?.amount_due ?? 0,
    });
    await this.audit.write({
      action: AuditAction.BILLING_INVOICE_PAYMENT_FAILED,
      actorId: null,
      actorRole: 'system',
      targetUserId: coachId,
      targetType: 'invoice',
      targetId: inv?.id ?? null,
      tenantCoachId: coachId,
      metadata: {
        stripe_event_id: event.id,
        stripe_invoice_id: inv?.id ?? null,
        amount_due_cents: inv?.amount_due ?? 0,
        reason: inv?.last_payment_error?.message ?? null,
      },
    });
    // QA P1-B1. Dispatch the payment-failed dunning email so the coach
    // actually finds out their card got declined within the 7-day grace
    // window. Pre-fix the row above wrote audit + analytics but never
    // talked to EmailService, so the grace was meaningless. Idempotency
    // is keyed on the Stripe event id — webhook re-deliveries are
    // no-ops at the EmailSendLog level, and the rest of this handler
    // already short-circuits on duplicate event id at the outer claim.
    await this.dispatchPaymentFailedEmail({
      coachId,
      stripeEventId: event.id,
      amountDueCents: inv?.amount_due ?? 0,
      reason: inv?.last_payment_error?.message ?? null,
    });
  }

  private async dispatchPaymentFailedEmail(args: {
    coachId: string;
    stripeEventId: string;
    amountDueCents: number;
    reason: string | null;
  }): Promise<void> {
    if (!this.email) return; // Legacy tests / boot configs without EmailModule
    try {
      const sub = await this.prisma.coachSubscription.findUnique({
        where: { coach_id: args.coachId },
        select: { billing_email: true },
      });
      const user = await this.prisma.user.findUnique({
        where: { id: args.coachId },
        select: { email: true, name: true },
      });
      const recipient = sub?.billing_email || user?.email;
      if (!recipient) {
        this.logger.warn(
          `dispatchPaymentFailedEmail: no recipient email for coach ${args.coachId}; skipping send`,
        );
        return;
      }
      await this.email.send({
        to: recipient,
        template: EmailTemplateKey.PAYMENT_FAILED,
        idempotencyKey: `billing-payment-failed:${args.stripeEventId}`,
        data: {
          coach_name: user?.name ?? 'there',
          amount_due_cents: args.amountDueCents,
          amount_due_display: (args.amountDueCents / 100).toFixed(2),
          reason: args.reason ?? 'Your card was declined.',
        },
      });
    } catch (err) {
      // Email is best-effort — the mirror has already been updated and
      // the audit row is durable. A transient Resend outage must not
      // cause Stripe to retry the webhook and re-double-write the
      // mirror.
      this.logger.error(
        `dispatchPaymentFailedEmail failed for coach ${args.coachId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async applyCustomerUpdated(event: StripeEvent) {
    const cus = event.data.object as {
      id?: string;
      email?: string | null;
      invoice_settings?: {
        default_payment_method?:
          | string
          | { card?: { last4?: string } }
          | null;
      };
    };
    if (!cus?.id) return;
    const coachId = await this.resolveCoachByCustomer(cus.id);
    if (!coachId) return;
    const dpm = cus.invoice_settings?.default_payment_method;
    const last4 =
      dpm && typeof dpm === 'object' ? dpm.card?.last4 ?? null : null;
    await this.prisma.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: {
        billing_email: cus.email ?? null,
        ...(last4 ? { card_last4: last4 } : {}),
      },
    });
  }

  // Phase 1 Connect — refresh the mirror on every account.updated /
  // capability.updated event. The Stripe payload is the snapshot at event
  // time; we re-read via ConnectService.syncFromStripe so we always reflect
  // the freshest server state and never drift.
  private async applyConnectAccountUpdated(event: StripeEvent) {
    const obj = event.data.object as { id?: string; account?: string };
    const accountId =
      typeof obj?.id === 'string' && obj.id.startsWith('acct_')
        ? obj.id
        : typeof obj?.account === 'string'
        ? obj.account
        : null;
    if (!accountId) {
      this.logger.warn(
        `Connect event ${event.id} (${event.type}) missing account id`,
      );
      return;
    }
    if (!this.connect) {
      this.logger.warn(
        `Connect event ${event.id} (${event.type}) received but ConnectService is not wired`,
      );
      return;
    }
    await this.connect.syncFromStripe(accountId);
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_UPDATED,
      actorId: null,
      actorRole: 'system',
      targetUserId: null,
      targetType: 'connect_account',
      targetId: accountId,
      tenantCoachId: null,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_account_id: accountId,
      },
    });
  }

  private async applyConnectAccountDeauthorized(event: StripeEvent) {
    const obj = event.data.object as { id?: string; account?: string };
    const accountId =
      typeof obj?.id === 'string' && obj.id.startsWith('acct_')
        ? obj.id
        : typeof obj?.account === 'string'
        ? obj.account
        : null;
    if (!accountId) {
      this.logger.warn(
        `Connect deauthorized event ${event.id} missing account id`,
      );
      return;
    }
    if (!this.connect) {
      this.logger.warn(
        `Connect deauthorized event ${event.id} received but ConnectService is not wired`,
      );
      return;
    }
    await this.connect.markDeauthorized(accountId);
    await this.audit.write({
      action: AuditAction.BILLING_SUBSCRIPTION_CANCELED,
      actorId: null,
      actorRole: 'system',
      targetUserId: null,
      targetType: 'connect_account',
      targetId: accountId,
      tenantCoachId: null,
      metadata: {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_account_id: accountId,
      },
    });
  }

  // Read-only helpers used by /v1/coach/me/billing.

  async getCoachBilling(coachId: string) {
    const [subscription, invoices] = await Promise.all([
      this.prisma.coachSubscription.findUnique({ where: { coach_id: coachId } }),
      this.prisma.invoice.findMany({
        where: { coach_id: coachId },
        orderBy: { created_at: 'desc' },
        take: 24,
      }),
    ]);
    return {
      subscription,
      invoices,
    };
  }
}
