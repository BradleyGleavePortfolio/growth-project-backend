import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientPurchase, DunningState } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeInvoiceObject,
} from '../connect/stripe-connect-api.service';
import { NotificationKind } from '../notifications/notification-kind';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PrismaService } from '../prisma.service';
import { DunningService } from './dunning.service';
import { isDunningV2Enabled } from './dunning-v2/dunning-v2.feature';
import { DunningV2Service } from './dunning-v2/dunning-v2.service';

/**
 * S-DUNNING-R2 — the client's own billing actions, native in the app
 * (OR-110-2: no browser-hosted Stripe portal in the client journey).
 *
 *   1. createCardSetup:  SetupIntent + ephemeral key for the in-app
 *      PaymentSheet (setup mode) on the client's PLATFORM Stripe Customer
 *      (destination-charge model: Customer, subscription and invoices live on
 *      the platform; funds reach the coach via the subscription's
 *      transfer_data).
 *   2. confirmCardUpdate: after the sheet saves the card, make it the default
 *      for the Customer AND every live subscription, then (owner ruling 1A)
 *      pay each open invoice of a subscription in dunning right away with the
 *      new card. Access returns on success; a decline is reported truthfully.
 *   3. cancelPlan: owner ruling 2A in dunning (void the unpaid invoice, end
 *      the subscription and access now, no further collection); owner 13:43
 *      option A outside dunning (cancel at period end, access through the
 *      paid period, no refund).
 *
 * WHO CHARGES: Stripe's retry schedule (Days 1/3/7) and, since 1A, exactly
 * one more caller: this service's on-session `invoices.pay` when the client
 * saves a new card. Both confirm the invoice's single PaymentIntent, so an
 * invoice is paid at most once (no double charge). A paid invoice cannot be
 * voided and a voided invoice cannot be paid; the DunningState billing-action
 * lease additionally keeps our own pay and void from interleaving.
 *
 * MONEY: every amount is integer minor units (cents) as Stripe returns them.
 * Nothing is ever computed in floating point.
 */

/** Lease length; longer than the worst case of the Stripe calls it guards. */
const BILLING_ACTION_LEASE_MS = 120_000;

/** Purchase statuses that mean "Stripe is still trying to collect". */
const DELINQUENT_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

/** Subscription-backed purchases whose card default must follow the client. */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

export type CardUpdateOutcome =
  | 'paid' // every open invoice in dunning is now paid; access is back
  | 'saved' // the card is saved; nothing was owed
  | 'requires_action' // the bank wants the client to confirm (3DS) in the app
  | 'declined' // the card is saved but the bank declined the payment
  | 'processing'; // Stripe accepted the payment; it has not settled yet

export interface SavedCard {
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

export interface CardSetupResult {
  setup_intent_id: string;
  setup_intent_client_secret: string;
  ephemeral_key: string;
  customer_id: string;
  publishable_key: string;
  merchant_display_name: string;
}

export interface CardUpdateResult {
  outcome: CardUpdateOutcome;
  card: SavedCard | null;
  /** Integer minor units paid by this request (0 when nothing was charged). */
  amount_paid_cents: number;
  /** Integer minor units still open after this request. */
  amount_due_cents: number;
  currency: string | null;
  access_restored: boolean;
  /** Present only for `requires_action`: hand to the SDK's handleNextAction. */
  payment_intent_client_secret: string | null;
  /** Issuer decline reason for `declined` (e.g. insufficient_funds). */
  decline_code: string | null;
  message: string;
}

export type CancelOutcome = 'ended' | 'scheduled' | 'already_ended';

export interface CancelPlanResult {
  outcome: CancelOutcome;
  purchase_id: string;
  /** ISO instant access ends (now for `ended`, period end for `scheduled`). */
  access_ends_at: string | null;
  voided_invoice_count: number;
  /** Integer minor units forgiven by voiding (never collected). */
  voided_amount_cents: number;
  currency: string | null;
  message: string;
}

interface InvoicePayOutcome {
  kind: 'paid' | 'requires_action' | 'declined' | 'processing';
  amountPaidCents: number;
  clientSecret?: string | null;
  declineCode?: string | null;
}

@Injectable()
export class ClientBillingService {
  private readonly logger = new Logger(ClientBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
    @Optional() private readonly dunning?: DunningService,
    @Optional() private readonly dunningV2?: DunningV2Service,
    @Optional() private readonly fanout?: PurchaseFanoutService,
  ) {}

  // ── 1. SetupIntent for the native PaymentSheet ────────────────────────────

  async createCardSetup(clientUserId: string, idempotencyKey: string): Promise<CardSetupResult> {
    const customer = await this.requireCustomer(clientUserId);
    const key = `tgp-card-setup-${clientUserId}-${idempotencyKey}`;
    try {
      const [setupIntent, ephemeralKey] = await Promise.all([
        this.stripe.createSetupIntent({
          customer: customer.stripe_customer_id,
          metadata: {
            tgp_client_user_id: clientUserId,
            tgp_purpose: 'client_card_update',
          },
          idempotencyKey: key,
        }),
        this.stripe.createEphemeralKey(customer.stripe_customer_id, `${key}-ephkey`),
      ]);
      if (!setupIntent.client_secret) {
        throw new StripeConnectApiError('SetupIntent has no client_secret', 502, null, null);
      }
      return {
        setup_intent_id: setupIntent.id,
        setup_intent_client_secret: setupIntent.client_secret,
        ephemeral_key: ephemeralKey.secret,
        customer_id: customer.stripe_customer_id,
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
        merchant_display_name: 'The Growth Project',
      };
    } catch (err) {
      throw this.stripeFailure(err, 'card_setup');
    }
  }

  // ── 2. Card saved -> set defaults -> (1A) pay the open invoice now ───────

  async confirmCardUpdate(clientUserId: string, setupIntentId: string): Promise<CardUpdateResult> {
    const customer = await this.requireCustomer(clientUserId);

    let paymentMethodId: string;
    try {
      const si = await this.stripe.retrieveSetupIntent(setupIntentId);
      const owner = si.metadata?.tgp_client_user_id;
      // Never confirm a SetupIntent minted for another client (or outside
      // this flow); answer as if it did not exist.
      if (si.customer !== customer.stripe_customer_id || owner !== clientUserId) {
        throw new NotFoundException({
          code: 'SETUP_INTENT_NOT_FOUND',
          error: 'SETUP_INTENT_NOT_FOUND',
          message: 'That card update was not found for your account. Start the card update again.',
        });
      }
      if (si.status !== 'succeeded') {
        throw new ConflictException({
          code: 'SETUP_INTENT_NOT_CONFIRMED',
          error: 'SETUP_INTENT_NOT_CONFIRMED',
          message:
            'Your new card was not saved yet, so nothing was charged. Add the card again to finish.',
          setup_intent_status: si.status,
        });
      }
      const pm = si.payment_method;
      paymentMethodId = typeof pm === 'string' ? pm : (pm?.id ?? '');
      if (!paymentMethodId) {
        throw new ConflictException({
          code: 'SETUP_INTENT_NOT_CONFIRMED',
          error: 'SETUP_INTENT_NOT_CONFIRMED',
          message:
            'Your new card was not saved yet, so nothing was charged. Add the card again to finish.',
          setup_intent_status: si.status,
        });
      }
    } catch (err) {
      throw this.stripeFailure(err, 'card_confirm');
    }

    const purchases = await this.prisma.clientPurchase.findMany({
      where: {
        client_user_id: clientUserId,
        billing_type: 'recurring',
        stripe_subscription_id: { not: null },
        status: { in: LIVE_SUBSCRIPTION_STATUSES },
      },
      include: { dunning: true },
      orderBy: { created_at: 'asc' },
      take: 20,
    });

    // Defaults first: Stripe retries (and every future renewal) charge the
    // subscription's default before the customer's, so both must move to the
    // new card. Idempotent per SetupIntent, so a retried confirm is a no-op.
    try {
      await this.stripe.setCustomerDefaultPaymentMethod({
        customerId: customer.stripe_customer_id,
        paymentMethodId,
        idempotencyKey: `tgp-card-default-cus-${setupIntentId}`,
      });
      for (const p of purchases) {
        await this.stripe.setSubscriptionDefaultPaymentMethod({
          subscriptionId: p.stripe_subscription_id as string,
          paymentMethodId,
          idempotencyKey: `tgp-card-default-sub-${p.stripe_subscription_id}-${setupIntentId}`,
        });
      }
    } catch (err) {
      throw this.stripeFailure(err, 'card_default');
    }
    const card = await this.mirrorCard(customer.id, paymentMethodId);

    const delinquent = purchases.filter(
      (p) => DELINQUENT_STATUSES.has(p.status) || p.dunning?.status === 'active',
    );
    let paidCents = 0;
    let currency: string | null = delinquent[0]?.currency ?? null;
    let restored = false;
    for (const purchase of delinquent) {
      const res = await this.payOpenInvoices(purchase, paymentMethodId, setupIntentId);
      paidCents += res.amountPaidCents;
      currency = res.currency ?? currency;
      if (res.kind === 'requires_action') {
        return this.cardResult('requires_action', card, paidCents, res.amountDueCents, currency, restored, {
          clientSecret: res.clientSecret ?? null,
        });
      }
      if (res.kind === 'declined') {
        return this.cardResult('declined', card, paidCents, res.amountDueCents, currency, restored, {
          declineCode: res.declineCode ?? null,
        });
      }
      if (res.kind === 'processing') {
        return this.cardResult('processing', card, paidCents, res.amountDueCents, currency, restored);
      }
      if (res.kind === 'paid') {
        await this.restoreAfterPayment(purchase, true);
        restored = true;
      } else if (await this.restoreAfterPayment(purchase, false)) {
        // Nothing open any more but the cycle is still on our side: the
        // client finished a bank confirmation (3DS) for the invoice, or a
        // Stripe retry paid it. Stripe's subscription says paid, so restore.
        restored = true;
      }
    }
    if (paidCents > 0 || restored) {
      return this.cardResult('paid', card, paidCents, 0, currency, true);
    }
    return this.cardResult('saved', card, 0, 0, currency, false);
  }

  /**
   * Pay every open invoice of one subscription, oldest first, under the
   * billing-action lease. Stops at the first invoice that needs the client
   * (3DS), is declined, or is still processing.
   */
  private async payOpenInvoices(
    purchase: ClientPurchase & { dunning: DunningState | null },
    paymentMethodId: string,
    setupIntentId: string,
  ): Promise<{
    kind: 'paid' | 'nothing_due' | 'requires_action' | 'declined' | 'processing';
    amountPaidCents: number;
    amountDueCents: number;
    currency: string | null;
    clientSecret?: string | null;
    declineCode?: string | null;
  }> {
    const lease = await this.claimLease(purchase.dunning, 'paying');
    try {
      let invoices: StripeInvoiceObject[];
      try {
        invoices = await this.stripe.listOpenInvoices(purchase.stripe_subscription_id as string);
      } catch (err) {
        throw this.stripeFailure(err, 'invoice_list');
      }
      invoices.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      let paid = 0;
      let currency: string | null = invoices[0]?.currency ?? purchase.currency ?? null;
      for (let i = 0; i < invoices.length; i += 1) {
        const inv = invoices[i];
        const out = await this.payOne(inv, paymentMethodId, setupIntentId);
        paid += out.amountPaidCents;
        currency = inv.currency ?? currency;
        if (out.kind !== 'paid') {
          const due = invoices
            .slice(i)
            .reduce((sum, x) => sum + this.dueCents(x), 0);
          return { ...out, amountPaidCents: paid, amountDueCents: due, currency };
        }
      }
      this.logEvent('dunning.card_update_paid', {
        purchase_id: purchase.id,
        invoices_paid: invoices.length,
        amount_paid_cents: paid,
      });
      return {
        kind: invoices.length > 0 ? 'paid' : 'nothing_due',
        amountPaidCents: paid,
        amountDueCents: 0,
        currency,
      };
    } finally {
      await this.releaseLease(lease);
    }
  }

  private async payOne(
    inv: StripeInvoiceObject,
    paymentMethodId: string,
    setupIntentId: string,
  ): Promise<InvoicePayOutcome> {
    try {
      const res = await this.stripe.payInvoice({
        invoiceId: inv.id,
        paymentMethodId,
        idempotencyKey: `tgp-1a-pay-${inv.id}-${setupIntentId}`,
      });
      if (res.status === 'paid') {
        return { kind: 'paid', amountPaidCents: res.amount_paid ?? this.dueCents(inv) };
      }
      return { kind: 'processing', amountPaidCents: 0 };
    } catch (err) {
      if (!(err instanceof StripeConnectApiError)) {
        // Lost response: the payment may or may not have landed. Re-read.
        const fresh = await this.safeRetrieveInvoice(inv.id);
        if (fresh?.status === 'paid') {
          return { kind: 'paid', amountPaidCents: fresh.amount_paid ?? this.dueCents(inv) };
        }
        throw this.stripeFailure(err, 'invoice_pay');
      }
      if (err.stripeCode === 'invoice_payment_intent_requires_action') {
        const fresh = await this.safeRetrieveInvoice(inv.id);
        const pi = fresh?.payment_intent;
        const secret = pi && typeof pi === 'object' ? (pi.client_secret ?? null) : null;
        if (!secret) throw this.stripeFailure(err, 'invoice_pay');
        return { kind: 'requires_action', amountPaidCents: 0, clientSecret: secret };
      }
      // A concurrent Stripe retry (or a second device) may have settled the
      // invoice first. Stripe is the truth: re-read before reporting.
      const fresh = await this.safeRetrieveInvoice(inv.id);
      if (fresh?.status === 'paid') {
        return { kind: 'paid', amountPaidCents: 0 };
      }
      if (err.stripeType === 'card_error' || err.httpStatus === 402) {
        return {
          kind: 'declined',
          amountPaidCents: 0,
          declineCode: err.declineCode ?? err.stripeCode ?? null,
        };
      }
      throw this.stripeFailure(err, 'invoice_pay');
    }
  }

  /**
   * Restore access now instead of waiting for the webhook (which re-runs the
   * same idempotent steps). `knownPaid`: Stripe just answered `paid` to our
   * invoices.pay. Otherwise access returns only when Stripe's subscription is
   * active again (never on a guess). Status and period come from Stripe.
   * Returns whether access was restored.
   */
  private async restoreAfterPayment(purchase: ClientPurchase, knownPaid: boolean): Promise<boolean> {
    let subPaid = false;
    try {
      const sub = await this.stripe.retrieveSubscription(purchase.stripe_subscription_id as string);
      const status = String(sub.status);
      if (status === 'active' || status === 'trialing') {
        subPaid = true;
        const periodEnd =
          typeof sub.current_period_end === 'number'
            ? new Date(sub.current_period_end * 1000)
            : purchase.current_period_end;
        await this.prisma.clientPurchase.updateMany({
          where: { id: purchase.id, status: { in: [...DELINQUENT_STATUSES] } },
          data: {
            status,
            entitlement_active: true,
            current_period_end: periodEnd,
            access_expires_at: periodEnd,
          },
        });
      }
    } catch (err) {
      // The invoice.paid webhook performs the same resync; never fail the
      // client's paid response on this read.
      this.logger.warn(
        `card update: post-pay resync deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
      );
    }
    if (!knownPaid && !subPaid) return false;
    if (this.dunningV2) {
      try {
        await this.dunningV2.applyImmediateClear(purchase.id, 'card_update');
      } catch (err) {
        this.logger.warn(
          `card update: v2 clear deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
        );
      }
    }
    if (this.dunning) {
      try {
        await this.dunning.recordResolution(purchase.id);
      } catch (err) {
        this.logger.warn(
          `card update: v1 resolution deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
        );
      }
    }
    return true;
  }

  // ── 3. Cancel: 2A in dunning, option A otherwise ──────────────────────────

  async cancelPlan(clientUserId: string, purchaseId: string): Promise<CancelPlanResult> {
    const purchase = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, client_user_id: clientUserId },
      include: { dunning: true },
    });
    if (!purchase) {
      throw new NotFoundException({
        code: 'PURCHASE_NOT_FOUND',
        error: 'PURCHASE_NOT_FOUND',
        message: 'That plan was not found on your account. Pull down to refresh your plans.',
      });
    }
    if (purchase.billing_type !== 'recurring' || !purchase.stripe_subscription_id) {
      throw new ConflictException({
        code: 'NOT_A_SUBSCRIPTION',
        error: 'NOT_A_SUBSCRIPTION',
        message:
          'This plan is not a subscription, so there is nothing to cancel. Message your coach if you want to change it.',
      });
    }
    if (purchase.status === 'canceled' || purchase.dunning?.client_canceled_at) {
      if (purchase.dunning?.client_canceled_at && purchase.status !== 'canceled') {
        // A previous 2A request voided the invoice but did not finish the
        // Stripe cancel: finish it now.
        return this.finishDunningCancel(purchase, 0, 0);
      }
      return {
        outcome: 'already_ended',
        purchase_id: purchase.id,
        access_ends_at: (purchase.canceled_at ?? purchase.access_expires_at)?.toISOString() ?? null,
        voided_invoice_count: 0,
        voided_amount_cents: 0,
        currency: purchase.currency,
        message: 'This plan has already ended. Nothing more will be charged for it.',
      };
    }
    const inDunning =
      purchase.dunning?.status === 'active' || DELINQUENT_STATUSES.has(purchase.status);
    if (!inDunning) return this.cancelAtPeriodEnd(purchase);
    return this.cancelInDunning(purchase);
  }

  /** Owner 13:43 option A: access through the paid period, no refund. */
  private async cancelAtPeriodEnd(purchase: ClientPurchase): Promise<CancelPlanResult> {
    let periodEnd = purchase.current_period_end ?? purchase.access_expires_at;
    if (!purchase.cancel_at_period_end) {
      try {
        const sub = await this.stripe.setCancelAtPeriodEnd({
          subscriptionId: purchase.stripe_subscription_id as string,
          idempotencyKey: `tgp-cancel-ape-${purchase.stripe_subscription_id}`,
        });
        if (typeof sub.current_period_end === 'number') {
          periodEnd = new Date(sub.current_period_end * 1000);
        }
      } catch (err) {
        throw this.stripeFailure(err, 'cancel');
      }
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: { cancel_at_period_end: true, ...(periodEnd ? { current_period_end: periodEnd } : {}) },
      });
      this.logEvent('billing.client_cancel_scheduled', {
        purchase_id: purchase.id,
        access_ends_at: periodEnd?.toISOString() ?? null,
      });
    }
    return {
      outcome: 'scheduled',
      purchase_id: purchase.id,
      access_ends_at: periodEnd?.toISOString() ?? null,
      voided_invoice_count: 0,
      voided_amount_cents: 0,
      currency: purchase.currency,
      message: periodEnd
        ? `Your plan is canceled. You keep access until ${periodEnd.toISOString().slice(0, 10)}, the end of the period you paid for, and you will not be charged again.`
        : 'Your plan is canceled. You keep access until the end of the period you paid for, and you will not be charged again.',
    };
  }

  /**
   * Owner 2A: void every open invoice of the subscription (it can never be
   * collected after that), then end the subscription and access now.
   *
   * Void BEFORE cancel, on purpose: Stripe refuses to void a paid invoice, so
   * if a Stripe retry paid it a moment earlier the client is no longer in
   * dunning and we fall back to option A (they keep the period they just
   * paid for) instead of ending a plan they paid for. Once void, the invoice
   * cannot be paid, so no later retry can charge it.
   */
  private async cancelInDunning(
    purchase: ClientPurchase & { dunning: DunningState | null },
  ): Promise<CancelPlanResult> {
    const lease = await this.claimLease(purchase.dunning, 'canceling');
    let voidedCount = 0;
    let voidedCents = 0;
    let paidMeanwhile = false;
    try {
      let invoices: StripeInvoiceObject[];
      try {
        invoices = await this.stripe.listOpenInvoices(purchase.stripe_subscription_id as string);
      } catch (err) {
        throw this.stripeFailure(err, 'invoice_list');
      }
      for (const inv of invoices) {
        try {
          await this.stripe.voidInvoice({
            invoiceId: inv.id,
            idempotencyKey: `tgp-2a-void-${inv.id}`,
          });
          voidedCount += 1;
          voidedCents += this.dueCents(inv);
        } catch (err) {
          const fresh = await this.safeRetrieveInvoice(inv.id);
          if (fresh?.status === 'void') {
            voidedCount += 1;
            voidedCents += this.dueCents(inv);
            continue;
          }
          if (fresh?.status === 'paid') {
            paidMeanwhile = true;
            continue;
          }
          throw this.stripeFailure(err, 'invoice_void');
        }
      }
      if (paidMeanwhile) {
        this.logEvent('billing.client_cancel_paid_meanwhile', {
          purchase_id: purchase.id,
          voided_invoice_count: voidedCount,
        });
      } else if (purchase.dunning) {
        // Record the 2A intent before the Stripe cancel so a failure after
        // the void is finished by the next request or the reconciler.
        await this.prisma.dunningState.update({
          where: { id: purchase.dunning.id },
          data: { client_canceled_at: new Date() },
        });
      }
    } finally {
      await this.releaseLease(lease);
    }
    if (paidMeanwhile) {
      const fresh = await this.prisma.clientPurchase.findUnique({ where: { id: purchase.id } });
      return this.cancelAtPeriodEnd(fresh ?? purchase);
    }
    return this.finishDunningCancel(purchase, voidedCount, voidedCents);
  }

  /**
   * End the subscription now (no proration, no final invoice, so no refund
   * and no new charge) and end access locally. Idempotent: a subscription
   * Stripe already canceled counts as done. Also used by the reconciler.
   */
  async finishDunningCancel(
    purchase: ClientPurchase,
    voidedCount: number,
    voidedCents: number,
  ): Promise<CancelPlanResult> {
    try {
      await this.stripe.cancelSubscription(purchase.stripe_subscription_id as string);
    } catch (err) {
      let canceled = false;
      try {
        const sub = await this.stripe.retrieveSubscription(purchase.stripe_subscription_id as string);
        canceled = String(sub.status) === 'canceled';
      } catch {
        canceled = false;
      }
      if (!canceled) {
        this.logEvent('billing.client_cancel_incomplete', { purchase_id: purchase.id });
        throw new ServiceUnavailableException({
          code: 'CANCEL_INCOMPLETE',
          error: 'CANCEL_INCOMPLETE',
          message:
            voidedCount > 0
              ? 'Your unpaid invoice is canceled, so you will not be charged for it, but your plan did not finish ending. Tap End plan again in a minute.'
              : 'Your plan did not finish ending, and nothing was charged. Tap End plan again in a minute.',
          stripe_code: err instanceof StripeConnectApiError ? err.stripeCode : null,
        });
      }
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'canceled',
          entitlement_active: false,
          cancel_at_period_end: false,
          canceled_at: now,
          access_expires_at: now,
        },
      });
      const state = await tx.dunningState.findUnique({ where: { purchase_id: purchase.id } });
      if (state) {
        await tx.dunningState.update({
          where: { id: state.id },
          data: {
            status: 'abandoned',
            abandoned_at: state.abandoned_at ?? now,
            client_canceled_at: state.client_canceled_at ?? now,
            locked_out_at: null,
            next_attempt_at: null,
            cancel_scheduled_at: null,
            billing_action: null,
            billing_action_until: null,
          },
        });
        await tx.dunningAttempt.updateMany({
          where: { dunning_state_id: state.id, status: 'pending' },
          data: { status: 'cancelled' },
        });
        const attempts = await tx.dunningAttempt.findMany({
          where: { dunning_state_id: state.id },
          select: { id: true },
        });
        if (attempts.length > 0) {
          await tx.paymentRecoveryToken.updateMany({
            where: { dunning_attempt_id: { in: attempts.map((a) => a.id) }, used_at: null },
            data: { used_at: now },
          });
        }
      }
      // The payment notices are moot once the plan has ended.
      await tx.notification.updateMany({
        where: {
          user_id: purchase.client_user_id,
          kind: NotificationKind.DUNNING_BLOCKER,
          read_at: null,
        },
        data: { read_at: now },
      });
      if (this.fanout) {
        await this.fanout.cancelPendingForPurchase(purchase.id, 'subscription_canceled', tx);
      }
    });
    this.logEvent('billing.client_cancel_in_dunning', {
      purchase_id: purchase.id,
      voided_invoice_count: voidedCount,
      voided_amount_cents: voidedCents,
    });
    return {
      outcome: 'ended',
      purchase_id: purchase.id,
      access_ends_at: now.toISOString(),
      voided_invoice_count: voidedCount,
      voided_amount_cents: voidedCents,
      currency: purchase.currency,
      message:
        voidedCount > 0
          ? 'Your plan has ended. The unpaid invoice is canceled, so you will not be charged for it. Your data stays in your account until you delete it.'
          : 'Your plan has ended, and you will not be charged again. Your data stays in your account until you delete it.',
    };
  }

  /**
   * Hourly reconciler (ClientBillingReconciler):
   *   a. finish any 2A cancel whose Stripe cancel did not complete (always on:
   *      only rows written by the in-app cancel carry client_canceled_at);
   *   b. under FEATURE_DUNNING_V2, apply 2A to an active cycle whose
   *      subscription was set to cancel at period end outside the app (e.g.
   *      a Stripe-hosted page), so every cancel in dunning ends the same way.
   */
  async reconcile(now: Date = new Date()): Promise<{ finished: number; applied: number; failed: number }> {
    let finished = 0;
    let applied = 0;
    let failed = 0;
    const settle = new Date(now.getTime() - 5 * 60_000);
    const pending = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        client_canceled_at: { not: null, lte: settle },
      },
      include: { purchase: true },
      take: 100,
    });
    for (const row of pending) {
      try {
        await this.finishDunningCancel(row.purchase, 0, 0);
        finished += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(`reconcile: finish cancel failed purchase=${row.purchase_id}: ${(err as Error).message}`);
      }
    }
    if (isDunningV2Enabled()) {
      const outOfBand = await this.prisma.dunningState.findMany({
        where: {
          status: 'active',
          client_canceled_at: null,
          purchase: { cancel_at_period_end: true, status: { in: [...DELINQUENT_STATUSES] } },
        },
        include: { purchase: true },
        take: 100,
      });
      for (const row of outOfBand) {
        const { purchase, ...state } = row;
        try {
          await this.cancelInDunning({ ...purchase, dunning: state });
          applied += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(`reconcile: 2A failed purchase=${row.purchase_id}: ${(err as Error).message}`);
        }
      }
    }
    return { finished, applied, failed };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireCustomer(clientUserId: string) {
    const customer = await this.prisma.connectCustomer.findUnique({
      where: { client_user_id: clientUserId },
    });
    if (!customer) {
      throw new NotFoundException({
        code: 'CUSTOMER_NOT_FOUND',
        error: 'CUSTOMER_NOT_FOUND',
        message:
          'There is no card on file for your account yet. Message your coach to set up your plan.',
      });
    }
    return customer;
  }

  /**
   * CAS lease on the DunningState: free when null or expired. A purchase
   * with no dunning row has nothing to serialize (no pay/void race of ours).
   */
  private async claimLease(
    state: DunningState | null | undefined,
    action: 'paying' | 'canceling',
  ): Promise<{ stateId: string; token: string } | null> {
    if (!state) return null;
    const now = new Date();
    const token = `${action}:${randomUUID()}`;
    const res = await this.prisma.dunningState.updateMany({
      where: {
        id: state.id,
        OR: [{ billing_action: null }, { billing_action_until: { lte: now } }],
      },
      data: {
        billing_action: token,
        billing_action_until: new Date(now.getTime() + BILLING_ACTION_LEASE_MS),
      },
    });
    if (res.count !== 1) {
      throw new ConflictException({
        code: 'BILLING_ACTION_IN_PROGRESS',
        error: 'BILLING_ACTION_IN_PROGRESS',
        message:
          'Another change to this plan is still being processed. Wait a few seconds, then pull down to see the result.',
      });
    }
    return { stateId: state.id, token };
  }

  private async releaseLease(lease: { stateId: string; token: string } | null): Promise<void> {
    if (!lease) return;
    try {
      await this.prisma.dunningState.updateMany({
        where: { id: lease.stateId, billing_action: lease.token },
        data: { billing_action: null, billing_action_until: null },
      });
    } catch (err) {
      // An unreleased lease expires on its own after BILLING_ACTION_LEASE_MS.
      this.logger.warn(`billing lease release failed state=${lease.stateId}: ${(err as Error).message}`);
    }
  }

  private async mirrorCard(customerRowId: string, paymentMethodId: string): Promise<SavedCard | null> {
    try {
      const pm = await this.stripe.retrievePaymentMethod(paymentMethodId);
      const card: SavedCard = {
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        exp_month: pm.card?.exp_month ?? null,
        exp_year: pm.card?.exp_year ?? null,
      };
      await this.prisma.connectCustomer.update({
        where: { id: customerRowId },
        data: {
          default_payment_method_id: paymentMethodId,
          default_card_brand: card.brand,
          default_card_last4: card.last4,
          default_card_exp_month: card.exp_month,
          default_card_exp_year: card.exp_year,
        },
      });
      return card;
    } catch (err) {
      // customer.updated mirrors the same fields; the card is saved either way.
      this.logger.warn(`card mirror deferred to webhook: ${(err as Error).message}`);
      return null;
    }
  }

  private async safeRetrieveInvoice(invoiceId: string): Promise<StripeInvoiceObject | null> {
    try {
      return await this.stripe.retrieveInvoice(invoiceId);
    } catch {
      return null;
    }
  }

  private dueCents(inv: StripeInvoiceObject): number {
    const v = inv.amount_remaining ?? inv.amount_due ?? 0;
    return Number.isInteger(v) && v > 0 ? v : 0;
  }

  private cardResult(
    outcome: CardUpdateOutcome,
    card: SavedCard | null,
    paidCents: number,
    dueCents: number,
    currency: string | null,
    restored: boolean,
    extra: { clientSecret?: string | null; declineCode?: string | null } = {},
  ): CardUpdateResult {
    const ending = card?.last4 ? ` ending ${card.last4}` : '';
    const messages: Record<CardUpdateOutcome, string> = {
      paid: `Your card${ending} is saved and your payment went through. Your plan is active again.`,
      saved: `Your card${ending} is saved. Your next payment will use it.`,
      requires_action: `Your card${ending} is saved. Your bank wants you to confirm this payment.`,
      declined: `Your card${ending} is saved, but your bank declined the payment, so nothing was charged. Try a different card, or call your bank and try again.`,
      processing: `Your card${ending} is saved and your payment is processing. Your plan updates as soon as it clears.`,
    };
    return {
      outcome,
      card,
      amount_paid_cents: paidCents,
      amount_due_cents: dueCents,
      currency,
      access_restored: restored,
      payment_intent_client_secret: extra.clientSecret ?? null,
      decline_code: extra.declineCode ?? null,
      message: messages[outcome],
    };
  }

  /** Map a Stripe/transport failure to a specific, actionable error. */
  private stripeFailure(err: unknown, step: string): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof StripeConnectApiError) {
      this.logger.warn(
        `client billing ${step}: Stripe ${err.httpStatus} ${err.stripeCode ?? ''} ${err.message}`,
      );
      const unavailable = err.httpStatus >= 500 || err.httpStatus === 429;
      return new HttpException(
        {
          code: unavailable ? 'STRIPE_UNAVAILABLE' : 'STRIPE_REQUEST_FAILED',
          error: unavailable ? 'STRIPE_UNAVAILABLE' : 'STRIPE_REQUEST_FAILED',
          message: unavailable
            ? this.unavailableMessage(step)
            : 'Our payment provider could not complete this change, so nothing was charged. Try again, or contact support with the reference below.',
          stripe_code: err.stripeCode,
          step,
        },
        unavailable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY,
      );
    }
    const message = (err as Error)?.message ?? '';
    if (err instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(message)) {
      // Transport failure before Stripe answered (DNS, reset, TLS).
      this.logger.warn(`client billing ${step}: Stripe unreachable: ${message}`);
      return new ServiceUnavailableException({
        code: 'STRIPE_UNAVAILABLE',
        error: 'STRIPE_UNAVAILABLE',
        message: this.unavailableMessage(step),
        step,
      });
    }
    if (/STRIPE_SECRET_KEY/i.test(message)) {
      return new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        error: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Card payments are not available right now. Contact support with the reference below.',
        step,
      });
    }
    this.logger.error(`client billing ${step}: unexpected ${message}`);
    return new HttpException(
      {
        code: 'BILLING_ACTION_FAILED',
        error: 'BILLING_ACTION_FAILED',
        message: 'This change did not complete. Contact support with the reference below.',
        step,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Truthful copy when Stripe did not answer: a lost response on a payment
   * or a cancel may still have taken effect, so never claim "nothing
   * changed" there. Repeating is always safe (Idempotency-Keys; an invoice
   * is paid at most once).
   */
  private unavailableMessage(step: string): string {
    if (step === 'invoice_pay') {
      return 'We could not confirm whether your payment went through. Wait a minute, then pull down to refresh. Trying again never charges you twice.';
    }
    if (step === 'invoice_void' || step === 'cancel') {
      return 'We could not confirm that your plan change went through. Wait a minute, then try again. Repeating it is safe and never charges you.';
    }
    return 'Our payment provider did not respond, so nothing changed. Wait a minute, then try again.';
  }

  private logEvent(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ event, ...fields }));
  }
}
