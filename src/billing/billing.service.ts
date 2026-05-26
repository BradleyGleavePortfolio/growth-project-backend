import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoachTier, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AuditAction, AuditService } from '../audit/audit.service';
import { CheckoutWebhookHandlerService } from '../checkout/checkout-webhook-handler.service';
import { ConnectService } from '../connect/connect.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
// R43 Storefront Phase 1 — guest checkout webhook routing. Optional so
// the billing module still boots in environments that have not imported
// StorefrontModule (legacy tests, half-built deploys).
import { GUEST_CHECKOUT_METADATA_KEY, GuestCheckoutService } from '../storefront/guest-checkout.service';

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
    // R43 — Optional so the billing module still boots when
    // StorefrontModule is not imported (e.g. minimal test wiring).
    @Optional() private guestCheckout?: GuestCheckoutService,
  ) {}

  // Idempotently process an event. Returns { processed: true } on first
  // delivery, { processed: false, alreadyProcessed: true } on duplicates.
  //
  // Audit #4 P1-1 — transactional integrity: the dedup-row insert and ALL
  // domain writes for this delivery run inside a single Prisma
  // `$transaction`. If any handler throws, the transaction rolls back —
  // the dedup row is undone, the domain writes are undone, and we
  // re-throw. The webhook controller then returns non-2xx and Stripe
  // retries the same event id until the transaction commits. We never
  // acknowledge an event whose side effects failed to commit.
  //
  // External handlers (CheckoutWebhookHandlerService, GuestCheckoutService)
  // run inside the same try/catch — if they throw we propagate. They
  // currently manage their own internal transactions; their writes
  // commit when they return success. The dedup row commits last on
  // success, so a partial external-handler failure cannot leave the
  // dedup row claimed.
  async handleEvent(event: StripeEvent) {
    if (!event?.id || !event?.type) {
      return { processed: false, reason: 'malformed' };
    }

    // Fast-path duplicate check OUTSIDE any transaction so concurrent
    // deliveries of the same event don't both open a transaction that
    // will race on the unique index. The authoritative dedup is still
    // the unique-index INSERT inside the transaction below.
    const existing = await this.prisma.stripeProcessedEvent.findUnique({
      where: { stripe_event_id: event.id },
      select: { stripe_event_id: true, handler_completed_at: true },
    });
    if (existing) {
      return { processed: false, alreadyProcessed: true };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Insert the dedup row INSIDE the transaction. A concurrent
        // delivery that started before this transaction commits will
        // either (a) see the row in its own findUnique fast-path above
        // and short-circuit, or (b) lose the unique-constraint race
        // here and we translate that to an alreadyProcessed return.
        await tx.stripeProcessedEvent.create({
          data: { stripe_event_id: event.id, type: event.type },
        });

        // Phase 2-3 Connect — give the checkout handler first refusal
        // on events that may belong to a coach-package purchase. If it
        // throws we propagate so the outer transaction rolls back and
        // Stripe retries. The checkout handler manages its own writes
        // via this.prisma; until its API is refactored to accept a
        // TransactionClient those writes are not inside this tx, but
        // any failure still surfaces here so we never ack a failed
        // side effect.
        let claimedByCheckout = false;
        if (this.checkoutWebhooks) {
          const result = await this.checkoutWebhooks.handle(event);
          claimedByCheckout = !!result.claimed;
        }

        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            if (!claimedByCheckout) await this.applySubscription(event, tx);
            break;
          case 'customer.subscription.deleted':
            if (!claimedByCheckout) await this.applySubscriptionDeleted(event, tx);
            break;
          case 'invoice.paid':
            if (!claimedByCheckout) await this.applyInvoicePaid(event, tx);
            break;
          case 'invoice.payment_failed':
            if (!claimedByCheckout) await this.applyInvoicePaymentFailed(event, tx);
            break;
          case 'customer.updated':
            if (!claimedByCheckout) await this.applyCustomerUpdated(event, tx);
            break;
          case 'checkout.session.completed':
          case 'checkout.session.expired':
            // Already dispatched to checkoutWebhooks above.
            break;
          case 'payment_intent.succeeded': {
            const pi = event.data.object as {
              id?: string;
              metadata?: Record<string, string>;
            };
            if (
              this.guestCheckout &&
              pi?.id &&
              pi.metadata?.[GUEST_CHECKOUT_METADATA_KEY]
            ) {
              await this.guestCheckout.handlePaymentSucceeded(pi.id);
            }
            break;
          }
          case 'payment_intent.payment_failed': {
            const pi = event.data.object as {
              id?: string;
              metadata?: Record<string, string>;
            };
            if (
              this.guestCheckout &&
              pi?.id &&
              pi.metadata?.[GUEST_CHECKOUT_METADATA_KEY]
            ) {
              await this.guestCheckout.handlePaymentFailed(pi.id);
            }
            break;
          }
          // r48 #1 — log requires_action but don't treat as failure.
          // Stripe Elements drives the 3DS challenge on the client; the
          // payment ultimately resolves to succeeded or payment_failed.
          case 'payment_intent.requires_action': {
            const pi = event.data.object as { id?: string };
            this.logger.log(
              `payment_intent.requires_action received for ${pi?.id ?? 'unknown'} — 3DS in progress on client`,
            );
            break;
          }
          // r48 #13 — refund webhook.  CheckoutWebhookHandlerService
          // (above) claims this event when it maps to a ClientPurchase;
          // if it didn't claim, fall back to the GuestCheckout path so
          // a guest refund flips status='refunded' + refunded_at and
          // surfaces to the coach via the existing notifications path.
          case 'charge.refunded': {
            if (claimedByCheckout) break;
            if (!this.guestCheckout) break;
            const charge = event.data.object as {
              payment_intent?: string;
              amount?: number;
              amount_refunded?: number;
            };
            if (!charge.payment_intent) break;
            await this.guestCheckout.handleChargeRefunded(
              charge.payment_intent,
              typeof charge.amount === 'number' ? charge.amount : 0,
              typeof charge.amount_refunded === 'number'
                ? charge.amount_refunded
                : 0,
            );
            break;
          }
          // r48 #13 — dispute opened.  Same fall-through semantics as
          // charge.refunded above.
          case 'charge.dispute.created': {
            if (claimedByCheckout) break;
            if (!this.guestCheckout) break;
            const dispute = event.data.object as {
              payment_intent?: string;
              reason?: string;
            };
            if (!dispute.payment_intent) break;
            await this.guestCheckout.handleDisputeOpened(
              dispute.payment_intent,
              dispute.reason ?? null,
            );
            break;
          }
          case 'account.updated':
          case 'capability.updated':
            await this.applyConnectAccountUpdated(event, tx);
            break;
          case 'account.application.deauthorized':
            await this.applyConnectAccountDeauthorized(event, tx);
            break;
          default:
            this.logger.log(`Ignoring unhandled Stripe event type: ${event.type}`);
        }

        // Mark handler-complete in the SAME transaction so the row is
        // never visible with handler_completed_at = NULL on commit.
        await tx.stripeProcessedEvent.updateMany({
          where: {
            stripe_event_id: event.id,
            handler_completed_at: null,
          },
          data: { handler_completed_at: new Date() },
        });
      });
    } catch (err) {
      // If the failure is a unique-constraint violation, a concurrent
      // delivery beat us to the insert; treat as duplicate.
      if (this.isUniqueViolation(err)) {
        return { processed: false, alreadyProcessed: true };
      }
      // Any other error: roll back (already done by Prisma) and re-throw
      // so the controller returns non-2xx. Stripe will retry the same
      // event id and the next attempt will commit cleanly once the
      // transient cause clears.
      this.logger.error(
        `Stripe event handler failed event=${event.id} type=${event.type}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      throw err;
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

  // Resolve coach by stripe customer id via CoachProfile. Accepts a
  // Prisma TransactionClient so the lookup participates in the outer
  // webhook transaction — same connection, same isolation level, no
  // read-after-write skew.
  private async resolveCoachByCustomer(
    customerId: string | undefined | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!customerId) return null;
    // CoachProfile.stripe_customer_id is not @unique on the canonical Phase 1A
    // shape (CoachSubscription owns the @unique on its own customer mirror),
    // so we use findFirst here. Order by created_at desc so that if two
    // profiles share the same customer id (duplicate Stripe customer creation
    // race) we consistently pick the most-recently created one.
    const profile = await db.coachProfile.findFirst({
      where: { stripe_customer_id: customerId },
      orderBy: { created_at: 'desc' },
    });
    return profile?.user_id ?? null;
  }

  private toDate(seconds: unknown): Date | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  }

  private async applySubscription(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
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
    let tierUpdate: { tier?: CoachTier } = {};
    if (status === 'active' || status === 'trialing') {
      tierUpdate = { tier: CoachTier.pro };
    } else if (status === 'canceled' || status === 'incomplete_expired') {
      tierUpdate = { tier: CoachTier.free };
    }
    // past_due: no tier change — guard handles grace
    // incomplete/unpaid: no tier change
    // Keep backward-compat alias for the create/update spread below:
    const tierForActiveSubscription = tierUpdate.tier;

    // Profile lookup + subscription upsert run inside the outer webhook
    // transaction (passed in as `tx`). Concurrent created+updated
    // deliveries cannot interleave the read and the write, which would
    // cross-link subscription IDs to the wrong coach row.
    const profile = await tx.coachProfile.findFirst({
      where: { stripe_customer_id: sub.customer },
      orderBy: { created_at: 'desc' },
    });
    const coachId = profile?.user_id ?? null;
    if (coachId) {
      await tx.coachSubscription.upsert({
        where: { coach_id: coachId },
        create: {
          coach_id: coachId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          status,
          // Set tier per status: pro on active/trialing, free on canceled/
          // incomplete_expired, schema-default 'free' on first create otherwise.
          ...(tierForActiveSubscription !== undefined
            ? { tier: tierForActiveSubscription }
            : {}),
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
          ...(tierForActiveSubscription !== undefined
            ? { tier: tierForActiveSubscription }
            : {}),
          current_period_end: this.toDate(sub.current_period_end),
          trial_end: this.toDate(sub.trial_end ?? null),
          cancel_at_period_end: !!sub.cancel_at_period_end,
        },
      });
    }
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

  private async applySubscriptionDeleted(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const sub = event.data.object as { id?: string; customer?: string };
    const coachId = await this.resolveCoachByCustomer(sub?.customer, tx);
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
    //
    // Use updateMany (not update) so that an out-of-order delete event for a
    // coach with no subscription row is a graceful no-op rather than a P2025
    // throw. updateMany with 0 matching rows silently does nothing.
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: {
        status: 'canceled',
        cancel_at_period_end: false,
        tier: CoachTier.free,
        updated_at: new Date(),
      },
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

  private async applyInvoicePaid(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
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
    const coachId = await this.resolveCoachByCustomer(inv.customer, tx);
    if (!coachId) return;
    await tx.invoice.upsert({
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
    await tx.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: { last_payment_failed_at: null, failed_payments_this_month: 0 },
    });
    // Restore status if invoice payment resolved a past_due state.
    // We only upgrade past_due → active, never touch canceled/paused/trialing.
    // The authoritative status arrives via customer.subscription.updated;
    // this is a best-effort recovery that removes the lockout immediately.
    await tx.coachSubscription.updateMany({
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

  private async applyInvoicePaymentFailed(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
    const inv = event.data.object as {
      id?: string;
      customer?: string;
      amount_due?: number;
      last_payment_error?: { message?: string };
    };
    const coachId = await this.resolveCoachByCustomer(inv?.customer, tx);
    if (!coachId) return;
    const now = new Date();
    await tx.paymentFailure.create({
      data: {
        coach_id: coachId,
        stripe_invoice_id: inv?.id ?? null,
        stripe_event_id: event.id,
        amount_due_cents: inv?.amount_due ?? 0,
        reason: inv?.last_payment_error?.message ?? null,
        occurred_at: now,
      },
    });
    await tx.coachSubscription.updateMany({
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

  private async applyCustomerUpdated(
    event: StripeEvent,
    tx: Prisma.TransactionClient,
  ) {
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
    const coachId = await this.resolveCoachByCustomer(cus.id, tx);
    if (!coachId) return;
    const dpm = cus.invoice_settings?.default_payment_method;
    const last4 =
      dpm && typeof dpm === 'object' ? dpm.card?.last4 ?? null : null;
    await tx.coachSubscription.updateMany({
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
  // Connect account events are forwarded to ConnectService, which manages
  // its own writes. The `tx` parameter is accepted for symmetry with other
  // handlers and so future refactors can wire ConnectService into the same
  // transaction without changing the call sites here.
  private async applyConnectAccountUpdated(
    event: StripeEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tx: Prisma.TransactionClient,
  ) {
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

  private async applyConnectAccountDeauthorized(
    event: StripeEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tx: Prisma.TransactionClient,
  ) {
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
