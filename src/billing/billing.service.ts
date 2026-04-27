import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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

  constructor(private prisma: PrismaService) {}

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
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.applySubscription(event);
          break;
        case 'customer.subscription.deleted':
          await this.applySubscriptionDeleted(event);
          break;
        case 'invoice.paid':
          await this.applyInvoicePaid(event);
          break;
        case 'invoice.payment_failed':
          await this.applyInvoicePaymentFailed(event);
          break;
        case 'customer.updated':
          await this.applyCustomerUpdated(event);
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
    // so we use findFirst here.
    const profile = await this.prisma.coachProfile.findFirst({
      where: { stripe_customer_id: customerId },
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
    const coachId = await this.resolveCoachByCustomer(sub.customer);
    if (!coachId) {
      this.logger.warn(
        `Subscription ${sub.id} for unknown customer ${sub.customer}`,
      );
      return;
    }
    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const status = sub.status ?? 'incomplete';
    await this.prisma.coachSubscription.upsert({
      where: { coach_id: coachId },
      create: {
        coach_id: coachId,
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        stripe_price_id: priceId,
        status,
        current_period_end: this.toDate(sub.current_period_end),
        trial_end: this.toDate(sub.trial_end ?? null),
        cancel_at_period_end: !!sub.cancel_at_period_end,
      },
      update: {
        stripe_customer_id: sub.customer,
        stripe_subscription_id: sub.id,
        stripe_price_id: priceId,
        status,
        current_period_end: this.toDate(sub.current_period_end),
        trial_end: this.toDate(sub.trial_end ?? null),
        cancel_at_period_end: !!sub.cancel_at_period_end,
      },
    });
  }

  private async applySubscriptionDeleted(event: StripeEvent) {
    const sub = event.data.object as { id?: string; customer?: string };
    const coachId = await this.resolveCoachByCustomer(sub?.customer);
    if (!coachId) return;
    await this.prisma.coachSubscription.update({
      where: { coach_id: coachId },
      data: { status: 'canceled', cancel_at_period_end: false },
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
    // Clear last_payment_failed_at — we have a fresh paid invoice.
    await this.prisma.coachSubscription.updateMany({
      where: { coach_id: coachId },
      data: { last_payment_failed_at: null, failed_payments_this_month: 0 },
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
      where: { coach_id: coachId },
      data: {
        last_payment_failed_at: now,
        failed_payments_this_month: { increment: 1 },
      },
    });
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
