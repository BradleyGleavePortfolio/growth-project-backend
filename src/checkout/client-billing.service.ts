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
import { Prisma } from '@prisma/client';
import type { ClientPurchase, DunningState } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { createHash, randomUUID } from 'crypto';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeInvoiceObject,
} from '../connect/stripe-connect-api.service';
import { NotificationKind } from '../notifications/notification-kind';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PrismaService } from '../prisma.service';
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';
import {
  type MoneyTotal,
  formatMinor,
  formatTotals,
  normalizeCurrency,
  singleCurrency,
  totalsByCurrency,
} from './client-billing.money';
import { DunningService } from './dunning.service';
import { isDunningV2Enabled } from './dunning-v2/dunning-v2.feature';
import { DUNNING_V2_REVERSAL_REASON, DunningV2Service } from './dunning-v2/dunning-v2.service';

/**
 * S-DUNNING-R2/R3 — the client's own billing actions, native in the app
 * (OR-110-2: no browser-hosted Stripe portal in the client journey).
 *
 *   1. createCardSetup:  SetupIntent + ephemeral key for the in-app
 *      PaymentSheet (setup mode) on the client's PLATFORM Stripe Customer.
 *   2. getPaymentQuote:  the complete, per-currency list of open invoices the
 *      card update would pay (every delinquent plan, every page). The app
 *      shows it and the client approves exactly those invoices.
 *   3. confirmCardUpdate: make the saved card the default for the Customer
 *      and every live subscription, then (owner ruling 1A) pay each APPROVED
 *      open invoice right away. Per-plan, per-invoice integer-cent results;
 *      money already collected is never dropped by a later failure, and an
 *      invoice whose amount is new or larger than approved is not charged
 *      (outcome approval_required with a fresh quote). Idempotent per
 *      SetupIntent: a repeated confirm after a lost reply returns what the
 *      first one already paid (journal) and never charges twice.
 *   4. cancelPlan: owner ruling 2A in dunning (durable intent, void the
 *      unpaid invoices, end the subscription and access now) unless Stripe
 *      shows the current period was paid meanwhile, in which case owner
 *      13:43 option A applies (access through the paid period, no refund).
 *
 * WHO CHARGES: Stripe's retry schedule (Days 1/3/7) and, since 1A, exactly
 * one more caller: this service's on-session `invoices.pay` for invoices the
 * client approved. Both confirm the invoice's single PaymentIntent, so an
 * invoice is paid at most once.
 *
 * SERIALIZATION: every pay/void/cancel runs under the per-purchase
 * ClientBillingLease (CAS claim, monotonic fence). The holder renews it
 * (CAS on holder) before every Stripe money call and checks it inside every
 * money-write transaction, and releases it only after its last side effect.
 *
 * MONEY: integer minor units as Stripe returns them, never floats, never
 * summed across currencies.
 */

/** Lease length; renewed before every Stripe money call. */
export const BILLING_ACTION_LEASE_MS = 120_000;

/** An open operation older than this is resumed by the reconciler. */
const OPERATION_SETTLE_MS = 5 * 60_000;

/**
 * S-DUNNING-R7 (24 h idempotency residual): Stripe keeps an idempotency key
 * for at least 24 hours and may prune it after that. A replay of a pruned
 * key is a NEW request, so its answer says nothing about the original call.
 * A journaled pay intent whose answer was never recorded is therefore
 * replayed only while its key is provably live: 23 hours after the intent
 * (one hour of margin for clock skew). Past that, the line is settled from
 * Stripe's invoice state alone and is never credited to the card update
 * (`already_paid`, 0 cents collected by it).
 */
export const PAY_KEY_REPLAY_WINDOW_MS = 23 * 60 * 60_000;

/** Page size for the client's own purchases. */
const PURCHASE_PAGE = 100;

/** Purchase statuses that mean "Stripe is still trying to collect". */
const DELINQUENT_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

/** Subscription-backed purchases whose card default must follow the client. */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

const PAID_SUB_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

export type CardUpdateOutcome =
  | 'paid' // every approved open invoice is paid
  | 'saved' // the card is saved; nothing was owed (or nothing payable here)
  | 'requires_action' // the bank wants the client to confirm (3DS) in the app
  | 'declined' // the bank declined a payment (earlier plans may be paid)
  | 'processing' // Stripe accepted a payment; it has not settled yet
  | 'approval_required' // debt is new or larger than approved: nothing extra charged
  | 'payment_uncertain' // a payment's result is not known yet; reconcile
  | 'failed' // a plan could not be paid (provider error); earlier plans may be paid
  | 'in_progress'; // another change to a plan is running

export type PlanPayOutcome =
  | 'paid'
  | 'nothing_due'
  | 'requires_action'
  | 'declined'
  | 'processing'
  | 'approval_required'
  | 'uncertain'
  | 'failed'
  | 'in_progress';

export type InvoiceLineResult =
  | 'paid' // this request (or an earlier confirm with this SetupIntent) paid it
  | 'already_paid' // Stripe already had it paid (e.g. its own retry)
  | 'requires_action'
  | 'declined'
  | 'processing'
  | 'uncertain'
  | 'failed'
  | 'not_approved'
  | 'not_attempted'
  // S-DUNNING-R4 (B-628-11): the intent journaled BEFORE the Stripe call.
  // A line still in this state after a crash means "Stripe may have acted";
  // recovery re-reads the invoice before reporting anything.
  | 'paying'
  | 'voiding';

/** Results whose money truth must be re-read from Stripe before reporting. */
const UNSETTLED_RESULTS: ReadonlySet<string> = new Set([
  'paying',
  'requires_action',
  'uncertain',
  'processing',
]);

export interface InvoiceLine {
  invoice_id: string;
  currency: string;
  /** Integer minor units open when this line was decided. */
  amount_due_cents: number;
  /** Integer minor units collected on this invoice by this card update. */
  amount_paid_cents: number;
  result: InvoiceLineResult;
  decline_code?: string | null;
  /** The Stripe idempotency key of the pay / void call (journaled before it). */
  idempotency_key?: string | null;
  /**
   * S-DUNNING-R7: ISO instant the pay intent was journaled, i.e. the latest
   * possible first use of its key. Server-side only (stripped from replies).
   */
  intent_at?: string | null;
}

/**
 * B-628-11 (R7): what Stripe's canonical state says about a journaled line
 * whose answer was never recorded. `unknown` (the re-read or the key replay
 * failed) is never the same as `open` (conclusively unpaid): an unknown line
 * stays in the journal and keeps the operation open.
 */
type SettleResult =
  | { kind: 'settled'; line: InvoiceLine }
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'unknown' };

export type PlanAccess = 'restored' | 'updating' | 'unchanged';

export interface PlanPayResult {
  purchase_id: string;
  coach_name: string | null;
  currency: string;
  outcome: PlanPayOutcome;
  amount_paid_cents: number;
  amount_due_cents: number;
  access: PlanAccess;
  /** A disputed payment is open on this plan; a card update never settles it. */
  dispute_open: boolean;
  error_code: string | null;
  invoices: InvoiceLine[];
}

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

export interface QuoteLine {
  invoice_id: string;
  purchase_id: string;
  coach_name: string | null;
  currency: string;
  amount_cents: number;
  created: number | null;
}

export interface QuoteDispute {
  purchase_id: string;
  coach_name: string | null;
  currency: string;
  amount_cents: number | null;
}

export interface BillingQuote {
  /** sha256 over the sorted (invoice, amount, currency) lines. */
  quote_id: string;
  /** Every delinquent plan and every page of open invoices was read. */
  complete: true;
  lines: QuoteLine[];
  totals: MoneyTotal[];
  disputes: QuoteDispute[];
}

export interface ApprovedInvoice {
  invoice_id: string;
  amount_cents: number;
  currency: string;
}

export interface CardUpdateResult {
  outcome: CardUpdateOutcome;
  card: SavedCard | null;
  /** Integer minor units paid (single currency only; null when mixed). */
  amount_paid_cents: number | null;
  /** Integer minor units still open (single currency only; null when mixed). */
  amount_due_cents: number | null;
  /** The one currency of the amounts above, or null when mixed / none. */
  currency: string | null;
  paid_totals: MoneyTotal[];
  due_totals: MoneyTotal[];
  /** True only when every delinquent plan's access is confirmed back. */
  access_restored: boolean;
  access_state: 'restored' | 'partial' | 'updating' | 'unchanged';
  plans: PlanPayResult[];
  /** Fresh quote when approval is needed or debt remains. */
  quote: BillingQuote | null;
  /** Present only for `requires_action`: hand to the SDK's handleNextAction. */
  payment_intent_client_secret: string | null;
  /** The plan the bank confirmation belongs to. */
  requires_action_purchase_id: string | null;
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
  /** True when a payment that landed meanwhile kept the paid period (option A). */
  paid_period_kept: boolean;
  message: string;
}

interface InvoicePayOutcome {
  kind:
    | 'paid'
    | 'already_paid'
    | 'requires_action'
    | 'declined'
    | 'processing'
    | 'uncertain'
    | 'failed';
  amountPaidCents: number;
  clientSecret?: string | null;
  declineCode?: string | null;
  errorCode?: string | null;
}

interface Lease {
  purchaseId: string;
  token: string;
  fence: number;
}

type PurchaseWithDunning = ClientPurchase & { dunning: DunningState | null };

type Tx = Prisma.TransactionClient;

/** The lease was taken over by a newer holder; stop before any further write. */
export class BillingLeaseLostError extends Error {
  constructor(readonly purchaseId: string) {
    super(`billing lease lost purchase=${purchaseId}`);
    this.name = 'BillingLeaseLostError';
  }
}

export function isDisputeCycle(state: DunningState | null | undefined): boolean {
  return state?.status === 'active' && state.last_failure_reason === DUNNING_V2_REVERSAL_REASON;
}

function isDelinquent(p: PurchaseWithDunning): boolean {
  return DELINQUENT_STATUSES.has(p.status) || p.dunning?.status === 'active';
}

/** Stripe idempotency key of a 1A invoice payment (journaled before the call). */
export function payIdempotencyKey(invoiceId: string, setupIntentId: string): string {
  return `tgp-1a-pay-${invoiceId}-${setupIntentId}`;
}

/** Stripe idempotency key of a 2A invoice void (journaled before the call). */
export function voidIdempotencyKey(invoiceId: string): string {
  return `tgp-2a-void-${invoiceId}`;
}

function errorCodeOf(err: HttpException): string {
  const body = err.getResponse();
  if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
    return (body as { code: string }).code;
  }
  return 'BILLING_ACTION_FAILED';
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
    // C-628-2: never hand the app an empty or mismatched publishable key
    // (PaymentSheet would fail with a generic init error). Checked before
    // any Stripe call so no orphan SetupIntent is created.
    const publishableKey = this.requirePublishableKey();
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
        publishable_key: publishableKey,
        merchant_display_name: 'The Growth Project',
      };
    } catch (err) {
      throw this.stripeFailure(err, 'card_setup');
    }
  }

  // ── 2. The complete quote the client approves before paying ──────────────

  async getPaymentQuote(clientUserId: string): Promise<BillingQuote> {
    await this.requireCustomer(clientUserId);
    const purchases = await this.livePurchases(clientUserId);
    return this.buildQuote(purchases.filter(isDelinquent));
  }

  private async buildQuote(delinquent: PurchaseWithDunning[]): Promise<BillingQuote> {
    const coachNames = await this.coachNames(delinquent);
    const lines: QuoteLine[] = [];
    const disputes: QuoteDispute[] = [];
    for (const p of delinquent) {
      let invoices: StripeInvoiceObject[];
      try {
        invoices = await this.stripe.listOpenInvoices(p.stripe_subscription_id as string);
      } catch (err) {
        throw this.stripeFailure(err, 'invoice_list');
      }
      invoices.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      for (const inv of invoices) {
        const due = this.dueCents(inv);
        if (due <= 0) continue;
        lines.push({
          invoice_id: inv.id,
          purchase_id: p.id,
          coach_name: coachNames.get(p.coach_user_id) ?? null,
          currency: normalizeCurrency(inv.currency ?? p.currency),
          amount_cents: due,
          created: typeof inv.created === 'number' ? inv.created : null,
        });
      }
      if (isDisputeCycle(p.dunning)) {
        const amount = p.dunning?.last_failed_amount_cents;
        disputes.push({
          purchase_id: p.id,
          coach_name: coachNames.get(p.coach_user_id) ?? null,
          currency: normalizeCurrency(p.currency),
          amount_cents: Number.isInteger(amount) ? (amount as number) : null,
        });
      }
    }
    return {
      quote_id: this.quoteDigest(lines),
      complete: true,
      lines,
      totals: totalsByCurrency(lines),
      disputes,
    };
  }

  private quoteDigest(lines: QuoteLine[]): string {
    const canon = [...lines]
      .map((l) => `${l.invoice_id}:${l.amount_cents}:${l.currency}`)
      .sort()
      .join('|');
    return createHash('sha256').update(canon).digest('hex');
  }

  // ── 3. Card saved -> set defaults -> (1A) pay the approved invoices ──────

  async confirmCardUpdate(
    clientUserId: string,
    setupIntentId: string,
    approvedInvoices: ApprovedInvoice[] = [],
  ): Promise<CardUpdateResult> {
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
      const pm = si.payment_method;
      paymentMethodId = typeof pm === 'string' ? pm : (pm?.id ?? '');
      if (si.status !== 'succeeded' || !paymentMethodId) {
        throw new ConflictException({
          code: 'SETUP_INTENT_NOT_CONFIRMED',
          error: 'SETUP_INTENT_NOT_CONFIRMED',
          message:
            'Your new card was not saved yet, so nothing was charged. Add the card again to finish.',
        });
      }
    } catch (err) {
      throw this.stripeFailure(err, 'card_confirm');
    }

    // B-628-4: every live subscription, every page (no silent cap).
    const purchases = await this.livePurchases(clientUserId);

    // Defaults first: Stripe retries (and every future renewal) charge the
    // subscription's default before the customer's, so both must move to the
    // new card. Idempotent per SetupIntent, so a retried confirm is a no-op.
    // Nothing has been charged at this point, so a failure here truthfully
    // says so.
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

    const approved = new Map<string, ApprovedInvoice>();
    for (const a of approvedInvoices) {
      approved.set(a.invoice_id, { ...a, currency: normalizeCurrency(a.currency) });
    }
    const delinquent = purchases.filter(isDelinquent);
    // B-322-2 / B-628-2: a replay of a confirm whose reply was lost reports
    // what that confirm paid, even though the plan is no longer delinquent.
    const replayed = await this.replayedPlans(
      purchases.filter((p) => !isDelinquent(p)),
      setupIntentId,
      paymentMethodId,
    );
    const coachNames = await this.coachNames([...delinquent, ...replayed.map((r) => r.purchase)]);
    const plans: PlanPayResult[] = [];
    for (const r of replayed) {
      plans.push(
        this.replayPlan(r.purchase, r.lines, coachNames.get(r.purchase.coach_user_id) ?? null),
      );
    }
    const secrets = new Map<string, string | null>();
    for (const purchase of delinquent) {
      const out = await this.payPlan(
        purchase,
        paymentMethodId,
        setupIntentId,
        approved,
        coachNames.get(purchase.coach_user_id) ?? null,
      );
      plans.push(out.plan);
      if (out.clientSecret !== undefined) secrets.set(purchase.id, out.clientSecret);
    }

    const paidTotals = totalsByCurrency(
      plans.flatMap((p) =>
        p.invoices.map((l) => ({ currency: l.currency, amount_cents: l.amount_paid_cents })),
      ),
    );
    const anyPaid = paidTotals.length > 0;
    const actionable = plans.filter((p) => p.outcome !== 'nothing_due');

    // Nothing moved and every plan is held by another running change: the
    // same 409 as a double tap (the card itself is saved either way).
    if (!anyPaid && actionable.length > 0 && actionable.every((p) => p.outcome === 'in_progress')) {
      throw this.inProgress();
    }
    return this.composeCardResult(card, plans, delinquent, secrets);
  }

  /**
   * Pay one plan's approved open invoices, oldest first, under the fenced
   * lease. Never throws for a Stripe outcome: every result is recorded per
   * invoice in the plan's journal row and returned, so money collected on
   * an earlier plan is never dropped by this one.
   */
  private async payPlan(
    purchase: PurchaseWithDunning,
    paymentMethodId: string,
    setupIntentId: string,
    approved: Map<string, ApprovedInvoice>,
    coachName: string | null,
  ): Promise<{ plan: PlanPayResult; clientSecret?: string | null }> {
    const currency = normalizeCurrency(purchase.currency);
    const plan: PlanPayResult = {
      purchase_id: purchase.id,
      coach_name: coachName,
      currency,
      outcome: 'nothing_due',
      amount_paid_cents: 0,
      amount_due_cents: 0,
      access: 'unchanged',
      dispute_open: isDisputeCycle(purchase.dunning),
      error_code: null,
      invoices: [],
    };
    let lease: Lease;
    try {
      lease = await this.claimLease(purchase.id, 'paying');
    } catch (err) {
      if (err instanceof ConflictException) {
        plan.outcome = 'in_progress';
        plan.error_code = 'BILLING_ACTION_IN_PROGRESS';
        return { plan };
      }
      throw err;
    }
    let attemptedPay = false;
    // B-628-11 (R7): a journaled line Stripe could not settle (re-read or
    // key replay failed). It stays in the journal as it was, the operation
    // stays open, and the plan answers `uncertain`, never "nothing due".
    let unresolved = false;
    let clientSecret: string | null = null;
    let opId: string | null = null;
    const lines: InvoiceLine[] = [];
    try {
      const op = await this.openCardOperation(lease, purchase.id, setupIntentId);
      opId = op.id;
      // Invoices an earlier confirm with this SetupIntent already paid (its
      // reply was lost) are no longer open: carry them so the answer stays
      // the truth.
      for (const prior of op.lines) {
        if (prior.amount_paid_cents > 0) {
          lines.push({ ...prior, result: 'paid' });
          continue;
        }
        // A bank confirmation / unknown result from the earlier confirm:
        // if the invoice is paid now, that payment belongs to this update.
        // B-628-11: a `paying` intent whose receipt never committed is
        // settled from Stripe, so collected money is never reported as 0.
        if (UNSETTLED_RESULTS.has(prior.result)) {
          const settled = await this.settledLine(
            prior,
            paymentMethodId,
            setupIntentId,
            op.createdAt,
          );
          if (settled.kind === 'settled') {
            lines.push(settled.line);
          } else if (settled.kind === 'unknown') {
            // Kept verbatim (result, key, intent time); the open-invoice
            // loop below skips it, so it is never paid a second time here.
            lines.push(prior);
            unresolved = true;
          }
          // `open`: conclusively unpaid, re-decided by the loop below.
          // `closed`: void / uncollectible, nothing was collected.
        }
      }
      let invoices: StripeInvoiceObject[];
      try {
        invoices = await this.stripe.listOpenInvoices(purchase.stripe_subscription_id as string);
      } catch (err) {
        const listCode = errorCodeOf(this.stripeFailure(err, 'invoice_list'));
        plan.error_code = unresolved ? 'PAYMENT_RESULT_UNKNOWN' : listCode;
        await this.saveOperation(
          lease,
          op.id,
          unresolved ? 'paying' : 'failed',
          lines,
          plan.error_code,
          !unresolved,
        );
        this.fillPlan(plan, lines);
        plan.outcome = unresolved ? 'uncertain' : 'failed';
        return { plan };
      }
      invoices.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      let stop: PlanPayOutcome | null = null;
      for (const inv of invoices) {
        const due = this.dueCents(inv);
        if (due <= 0 || lines.some((l) => l.invoice_id === inv.id)) continue;
        const cur = normalizeCurrency(inv.currency ?? purchase.currency);
        const base = {
          invoice_id: inv.id,
          currency: cur,
          amount_due_cents: due,
          amount_paid_cents: 0,
        };
        if (stop) {
          lines.push({ ...base, result: 'not_attempted' });
          continue;
        }
        // B-628-3: only what the client approved, at most the approved
        // amount, in the approved currency.
        const ok = approved.get(inv.id);
        if (!ok || ok.currency !== cur || due > ok.amount_cents) {
          lines.push({ ...base, result: 'not_approved' });
          stop = 'approval_required';
          continue;
        }
        await this.renewLease(lease);
        // B-628-11: commit the invoice identity, currency, approved amount
        // and idempotency key BEFORE the pay call. If this write fails no
        // money has moved; if a later write fails, recovery finds this line.
        const intent: InvoiceLine = {
          ...base,
          result: 'paying',
          idempotency_key: payIdempotencyKey(inv.id, setupIntentId),
          intent_at: new Date().toISOString(),
        };
        lines.push(intent);
        await this.saveOperation(lease, op.id, 'paying', lines, null, false);
        attemptedPay = true;
        const out = await this.payOne(inv, paymentMethodId, setupIntentId);
        intent.amount_paid_cents = out.amountPaidCents;
        intent.result = out.kind;
        intent.decline_code = out.declineCode ?? null;
        await this.saveOperation(lease, op.id, 'paying', lines, null, false);
        if (out.kind === 'requires_action') {
          stop = 'requires_action';
          clientSecret = out.clientSecret ?? null;
        } else if (out.kind === 'declined') {
          stop = 'declined';
        } else if (out.kind === 'processing') {
          stop = 'processing';
        } else if (out.kind === 'uncertain') {
          stop = 'uncertain';
          plan.error_code = out.errorCode ?? 'PAYMENT_RESULT_UNKNOWN';
        } else if (out.kind === 'failed') {
          stop = 'failed';
          plan.error_code = out.errorCode ?? 'STRIPE_REQUEST_FAILED';
        }
      }
      this.fillPlan(plan, lines);
      // B-628-11 (R7): money of an unresolved line may have moved, so the
      // plan is `uncertain` (a pending bank step keeps its own outcome).
      if (unresolved && stop !== 'requires_action') {
        stop = 'uncertain';
        plan.error_code = 'PAYMENT_RESULT_UNKNOWN';
      }
      if (stop) {
        plan.outcome = stop;
      } else {
        plan.outcome = lines.some((l) => l.result === 'paid' || l.result === 'already_paid')
          ? 'paid'
          : 'nothing_due';
        // A dispute is never settled by a card update or a renewal payment
        // (B-628-8): access stays as the dispute cycle decides.
        if (!plan.dispute_open) {
          plan.access = await this.restoreAfterPayment(
            purchase,
            lease,
            lines.some((l) => l.result === 'paid'),
          );
        }
      }
      // Uncertain / processing / bank-confirmation rows stay open so the
      // reconciler re-reads Stripe and restores access when they settle.
      const terminal = !['uncertain', 'processing', 'requires_action'].includes(plan.outcome);
      await this.saveOperation(lease, op.id, plan.outcome, lines, plan.error_code, terminal);
      return { plan, clientSecret };
    } catch (err) {
      // A `paying` line whose answer was not recorded is reported as
      // unknown (never as unpaid); the journal keeps the intent.
      this.fillPlan(
        plan,
        lines.map((l) => (l.result === 'paying' ? { ...l, result: 'uncertain' as const } : l)),
      );
      if (err instanceof BillingLeaseLostError) {
        plan.outcome = 'in_progress';
        plan.error_code = 'BILLING_ACTION_SUPERSEDED';
        return { plan };
      }
      // Unexpected failure: if a payment was attempted its result is not
      // known, so never claim nothing was charged.
      this.logger.error(
        `card update: plan failed purchase=${purchase.id} op=${opId ?? 'none'}: ${(err as Error).message}`,
      );
      const moneyUnknown = attemptedPay || unresolved;
      plan.outcome = moneyUnknown ? 'uncertain' : 'failed';
      plan.error_code = moneyUnknown
        ? 'PAYMENT_RESULT_UNKNOWN'
        : err instanceof HttpException
          ? errorCodeOf(err)
          : 'BILLING_ACTION_FAILED';
      return { plan };
    } finally {
      await this.releaseLease(lease);
    }
  }

  /**
   * Plans that are no longer delinquent (a webhook restored them) but carry
   * a journal row of THIS SetupIntent: the replay reports what that confirm
   * collected and (B-628-11, R7) every line Stripe could not settle yet, as
   * `uncertain`. Read-only: the operation stays open for the reconciler.
   */
  private async replayedPlans(
    candidates: PurchaseWithDunning[],
    setupIntentId: string,
    paymentMethodId: string,
  ): Promise<Array<{ purchase: PurchaseWithDunning; lines: InvoiceLine[] }>> {
    if (candidates.length === 0) return [];
    const ops = await this.prisma.clientBillingOperation.findMany({
      where: {
        kind: 'card_pay',
        setup_intent_id: setupIntentId,
        purchase_id: { in: candidates.map((p) => p.id) },
      },
    });
    const out: Array<{ purchase: PurchaseWithDunning; lines: InvoiceLine[] }> = [];
    for (const p of candidates) {
      const lines: InvoiceLine[] = [];
      for (const o of ops.filter((x) => x.purchase_id === p.id)) {
        for (const l of this.linesOf(o.lines)) {
          if (l.amount_paid_cents > 0) {
            lines.push({ ...l, result: 'paid' });
            continue;
          }
          // B-628-11: the pay landed but its receipt never committed (and the
          // webhook has since restored the plan): Stripe says what was paid.
          if (UNSETTLED_RESULTS.has(l.result)) {
            const settled = await this.settledLine(l, paymentMethodId, setupIntentId, o.created_at);
            if (settled.kind === 'settled' && settled.line.amount_paid_cents > 0) {
              lines.push({ ...settled.line, result: 'paid' });
            } else if (settled.kind === 'unknown') {
              lines.push({ ...l, result: 'uncertain' });
            }
          }
        }
      }
      if (lines.length > 0) out.push({ purchase: p, lines });
    }
    return out;
  }

  private replayPlan(
    purchase: PurchaseWithDunning,
    lines: InvoiceLine[],
    coachName: string | null,
  ): PlanPayResult {
    const unknown = lines.some((l) => l.result === 'uncertain');
    const plan: PlanPayResult = {
      purchase_id: purchase.id,
      coach_name: coachName,
      currency: normalizeCurrency(purchase.currency),
      outcome: unknown ? 'uncertain' : 'paid',
      amount_paid_cents: 0,
      amount_due_cents: 0,
      access: 'unchanged',
      dispute_open: isDisputeCycle(purchase.dunning),
      error_code: unknown ? 'PAYMENT_RESULT_UNKNOWN' : null,
      invoices: [],
    };
    this.fillPlan(plan, lines);
    const cycleOpen = purchase.dunning?.status === 'active';
    plan.access = purchase.entitlement_active && !cycleOpen ? 'restored' : 'updating';
    return plan;
  }

  /**
   * B-628-11: settle a journaled line whose answer was never recorded, from
   * Stripe's canonical state.
   *
   *   - the invoice re-read fails            -> `unknown` (never "unpaid");
   *   - open / draft                         -> `open` (conclusively unpaid);
   *   - void / uncollectible                 -> `closed`;
   *   - paid, line `paying` / `uncertain` (the answer of OUR call is not
   *     known): within PAY_KEY_REPLAY_WINDOW_MS of the intent the call is
   *     re-asked with the SAME idempotency key. Stripe replays the original
   *     answer: a success means this update paid it; a definitive refusal
   *     means someone else did (`already_paid`); anything else (5xx, 429,
   *     409 key in use, lost reply) is `unknown`. A paid invoice cannot be
   *     charged again, so the replay never moves money. Past the window the
   *     key may be pruned and a replay would be a new request, so it is
   *     never sent and the line is `already_paid` (not credited);
   *   - paid, line `requires_action` / `processing` (Stripe told OUR call
   *     its PaymentIntent was waiting on the bank / settling): this update's
   *     payment.
   *
   * `fallbackIntentAt` (the operation's creation, never later than the
   * intent) dates lines journaled before `intent_at` existed.
   */
  private async settledLine(
    prior: InvoiceLine,
    paymentMethodId: string | null,
    setupIntentId: string,
    fallbackIntentAt: Date,
  ): Promise<SettleResult> {
    const fresh = await this.safeRetrieveInvoice(prior.invoice_id);
    if (!fresh) return { kind: 'unknown' };
    if (fresh.status === 'void' || fresh.status === 'uncollectible') return { kind: 'closed' };
    if (fresh.status !== 'paid') return { kind: 'open' };
    if (prior.result === 'paying' || prior.result === 'uncertain') {
      if (!this.keyReplayable(prior, fallbackIntentAt)) {
        // The reconciler settles intents within the hour, so this means it
        // was down for most of a day: the journal may now under-credit this
        // update (never over-credit it). Ids only; support checks Stripe.
        this.logEvent('billing.card_pay_settled_without_replay', {
          invoice_id: prior.invoice_id,
        });
        Sentry.captureMessage('billing card pay intent settled past its key window', {
          level: 'warning',
          tags: { code: 'CARD_PAY_SETTLED_WITHOUT_REPLAY' },
          extra: { invoice_id: prior.invoice_id },
        });
        return {
          kind: 'settled',
          line: { ...prior, amount_paid_cents: 0, result: 'already_paid' },
        };
      }
      if (!paymentMethodId) return { kind: 'unknown' };
      const out = await this.replayPay(
        fresh,
        paymentMethodId,
        prior.idempotency_key ?? payIdempotencyKey(prior.invoice_id, setupIntentId),
      );
      if (out.kind === 'unknown') return { kind: 'unknown' };
      if (out.kind === 'already_paid') {
        return {
          kind: 'settled',
          line: { ...prior, amount_paid_cents: 0, result: 'already_paid' },
        };
      }
      return {
        kind: 'settled',
        line: {
          ...prior,
          amount_paid_cents: out.amountPaidCents || prior.amount_due_cents,
          result: 'paid',
        },
      };
    }
    return {
      kind: 'settled',
      line: {
        ...prior,
        amount_paid_cents: this.paidCents(fresh, null) || prior.amount_due_cents,
        result: 'paid',
      },
    };
  }

  /** True while the line's idempotency key is provably still kept by Stripe. */
  private keyReplayable(line: InvoiceLine, fallbackIntentAt: Date): boolean {
    const parsed = line.intent_at ? Date.parse(line.intent_at) : Number.NaN;
    const intentAt = Number.isFinite(parsed) ? parsed : fallbackIntentAt.getTime();
    return Date.now() - intentAt < PAY_KEY_REPLAY_WINDOW_MS;
  }

  /**
   * Re-ask an unrecorded pay call with its own key. Only a successful paid
   * answer credits this update. Only an answer that IS the original
   * operation's result proves our call did not pay (B-628-11 R9): a 402 or a
   * 400 invalid_request_error carrying Stripe's `Idempotent-Replayed: true`,
   * i.e. the cached result of this key's first execution. Stripe caches
   * every request that began executing, so a first execution refused
   * because the invoice is already settled is replayed as such on the next
   * ask. Everything else is unknown: a 400 / 402 that is not a replay (a
   * pre-execution validation failure, or this key's first execution
   * happening now), 401 / 403 (refused before execution), 404, 409 "key in
   * use", 429, an idempotency error, 5xx and transport errors. An unknown
   * line keeps its intent and the operation stays open until an
   * authoritative answer arrives (or the 23 h window settles it).
   */
  private async replayPay(
    inv: StripeInvoiceObject,
    paymentMethodId: string,
    idempotencyKey: string,
  ): Promise<
    { kind: 'paid'; amountPaidCents: number } | { kind: 'already_paid' } | { kind: 'unknown' }
  > {
    try {
      const res = await this.stripe.payInvoice({
        invoiceId: inv.id,
        paymentMethodId,
        idempotencyKey,
      });
      return res.status === 'paid'
        ? { kind: 'paid', amountPaidCents: this.paidCents(res, inv) }
        : { kind: 'unknown' };
    } catch (err) {
      const definitive =
        err instanceof StripeConnectApiError &&
        err.idempotentReplayed &&
        (err.httpStatus === 402 ||
          (err.httpStatus === 400 && err.stripeType === 'invalid_request_error'));
      if (!definitive) {
        this.logger.warn(
          `card update: pay replay not definitive invoice=${inv.id}: ${
            err instanceof StripeConnectApiError ? err.httpStatus : 'transport'
          }`,
        );
      }
      return definitive ? { kind: 'already_paid' } : { kind: 'unknown' };
    }
  }

  /** Reply lines: an intent whose answer is not recorded reads `uncertain`. */
  private fillPlan(plan: PlanPayResult, lines: InvoiceLine[]): void {
    plan.invoices = lines.map((l) =>
      l.result === 'paying' ? { ...l, result: 'uncertain' as const } : l,
    );
    plan.amount_paid_cents = lines.reduce((s, l) => s + l.amount_paid_cents, 0);
    plan.amount_due_cents = lines
      .filter((l) => l.result !== 'paid' && l.result !== 'already_paid')
      .reduce((s, l) => s + l.amount_due_cents, 0);
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
        idempotencyKey: payIdempotencyKey(inv.id, setupIntentId),
      });
      if (res.status === 'paid') {
        return { kind: 'paid', amountPaidCents: this.paidCents(res, inv) };
      }
      return { kind: 'processing', amountPaidCents: 0 };
    } catch (err) {
      // Stripe is the truth: re-read before reporting anything (C-628-1:
      // paid is checked first on every branch, including bank action).
      const fresh = await this.safeRetrieveInvoice(inv.id);
      if (fresh?.status === 'paid') {
        // A lost / non-definitive answer to OUR pay call and the invoice is
        // paid now: that is this card update's payment (the new card is the
        // default every collector uses), reported in integer cents. A
        // definitive 4xx means Stripe had it paid before our call. C-628-14:
        // a 429 never ran, so whatever paid the invoice was not this call.
        // C-628-15: a 409 means a request with this key is still running;
        // it may be the one that paid, so the answer waits for the replay.
        if (err instanceof StripeConnectApiError && err.httpStatus === 409) {
          return { kind: 'uncertain', amountPaidCents: 0, errorCode: 'PAYMENT_RESULT_UNKNOWN' };
        }
        const lostReply = !(err instanceof StripeConnectApiError) || err.httpStatus >= 500;
        return lostReply
          ? { kind: 'paid', amountPaidCents: this.paidCents(fresh, inv) }
          : { kind: 'already_paid', amountPaidCents: 0 };
      }
      if (!(err instanceof StripeConnectApiError)) {
        // Lost response: the payment may or may not have landed.
        return { kind: 'uncertain', amountPaidCents: 0, errorCode: 'PAYMENT_RESULT_UNKNOWN' };
      }
      if (err.stripeCode === 'invoice_payment_intent_requires_action') {
        const pi = fresh?.payment_intent;
        const secret = pi && typeof pi === 'object' ? (pi.client_secret ?? null) : null;
        if (!secret) {
          return { kind: 'uncertain', amountPaidCents: 0, errorCode: 'PAYMENT_RESULT_UNKNOWN' };
        }
        return { kind: 'requires_action', amountPaidCents: 0, clientSecret: secret };
      }
      if (err.stripeType === 'card_error' || err.httpStatus === 402) {
        return {
          kind: 'declined',
          amountPaidCents: 0,
          declineCode: err.declineCode ?? err.stripeCode ?? null,
        };
      }
      if (
        err.httpStatus >= 500 ||
        err.httpStatus === 429 ||
        err.httpStatus === 409 ||
        fresh == null
      ) {
        // Stripe did not answer definitively and we could not re-read it.
        return { kind: 'uncertain', amountPaidCents: 0, errorCode: 'PAYMENT_RESULT_UNKNOWN' };
      }
      // A definitive Stripe refusal (4xx, invoice still unpaid): not charged.
      this.logger.warn(
        `card update: invoice pay refused invoice=${inv.id}: ${err.httpStatus} ${err.stripeCode ?? ''}`,
      );
      return { kind: 'failed', amountPaidCents: 0, errorCode: 'STRIPE_REQUEST_FAILED' };
    }
  }

  /**
   * Restore access now instead of waiting for the webhook (which re-runs the
   * same idempotent steps). `knownPaid`: Stripe just answered `paid`.
   * Otherwise access returns only when Stripe's subscription is active again
   * (never on a guess). Then re-read our own rows: `restored` only when the
   * purchase is entitled and no dunning cycle is still active; `updating`
   * when the payment is in but our rows did not follow yet (the invoice.paid
   * webhook finishes it).
   */
  private async restoreAfterPayment(
    purchase: PurchaseWithDunning,
    lease: Lease | null,
    knownPaid: boolean,
  ): Promise<PlanAccess> {
    let subPaid = false;
    let subStatus: string | null = null;
    let periodEnd: Date | null = purchase.current_period_end;
    try {
      const sub = await this.stripe.retrieveSubscription(purchase.stripe_subscription_id as string);
      subStatus = String(sub.status);
      subPaid = PAID_SUB_STATUSES.has(subStatus);
      if (typeof sub.current_period_end === 'number') {
        periodEnd = new Date(sub.current_period_end * 1000);
      }
    } catch (err) {
      this.logger.warn(
        `card update: post-pay subscription read deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
      );
    }
    if (!knownPaid && !subPaid) return 'unchanged';
    try {
      await this.fencedTx(lease, async (tx) => {
        if (subPaid && subStatus) {
          await tx.clientPurchase.updateMany({
            where: { id: purchase.id, status: { in: [...DELINQUENT_STATUSES] } },
            data: {
              status: subStatus,
              entitlement_active: true,
              current_period_end: periodEnd,
              access_expires_at: periodEnd,
            },
          });
        }
        if (this.dunningV2) {
          await this.dunningV2.applyImmediateClear(purchase.id, 'card_update', tx);
        }
      });
    } catch (err) {
      if (err instanceof BillingLeaseLostError) throw err;
      this.logger.warn(
        `card update: access restore deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
      );
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
    const fresh = await this.prisma.clientPurchase.findUnique({
      where: { id: purchase.id },
      include: { dunning: true },
    });
    const confirmed =
      fresh != null &&
      fresh.entitlement_active === true &&
      !DELINQUENT_STATUSES.has(fresh.status) &&
      !(fresh.dunning && fresh.dunning.status === 'active');
    if (!confirmed) {
      this.logEvent('billing.card_update_access_updating', { purchase_id: purchase.id });
    }
    return confirmed ? 'restored' : 'updating';
  }

  private composeCardResult(
    card: SavedCard | null,
    plans: PlanPayResult[],
    delinquent: PurchaseWithDunning[],
    secrets: Map<string, string | null>,
  ): CardUpdateResult {
    const allLines = plans.flatMap((p) => p.invoices);
    const paidTotals = totalsByCurrency(
      allLines.map((l) => ({ currency: l.currency, amount_cents: l.amount_paid_cents })),
    );
    const open = plans.filter((p) =>
      [
        'requires_action',
        'declined',
        'processing',
        'approval_required',
        'uncertain',
        'failed',
        'in_progress',
      ].includes(p.outcome),
    );
    const dueTotals = totalsByCurrency(
      allLines
        .filter((l) => l.result !== 'paid' && l.result !== 'already_paid')
        .map((l) => ({ currency: l.currency, amount_cents: l.amount_due_cents })),
    );
    const has = (o: PlanPayOutcome) => plans.find((p) => p.outcome === o);
    let outcome: CardUpdateOutcome;
    let focus: PlanPayResult | undefined;
    if ((focus = has('requires_action'))) outcome = 'requires_action';
    else if ((focus = has('uncertain'))) outcome = 'payment_uncertain';
    else if ((focus = has('declined'))) outcome = 'declined';
    else if ((focus = has('processing'))) outcome = 'processing';
    else if ((focus = has('failed'))) outcome = 'failed';
    else if ((focus = has('in_progress'))) outcome = 'in_progress';
    else if ((focus = has('approval_required'))) outcome = 'approval_required';
    else if (plans.some((p) => p.outcome === 'paid')) outcome = 'paid';
    else outcome = 'saved';

    const paidPlans = plans.filter((p) => p.outcome === 'paid' || p.amount_paid_cents > 0);
    let accessState: CardUpdateResult['access_state'] = 'unchanged';
    if (paidPlans.length > 0) {
      const restored = plans.filter((p) => p.access === 'restored').length;
      const updating = plans.some((p) => p.access === 'updating');
      if (updating) accessState = 'updating';
      else if (restored > 0 && restored === delinquent.length) accessState = 'restored';
      else if (restored > 0) accessState = 'partial';
    }
    const focusDue = focus
      ? totalsByCurrency(
          focus.invoices
            .filter((l) => l.result !== 'paid' && l.result !== 'already_paid')
            .map((l) => ({ currency: l.currency, amount_cents: l.amount_due_cents })),
        )
      : [];
    const quote: BillingQuote | null =
      outcome === 'approval_required' || open.length > 0
        ? {
            quote_id: this.quoteDigest(this.quoteLinesFrom(plans)),
            complete: true,
            lines: this.quoteLinesFrom(plans),
            totals: dueTotals,
            disputes: plans
              .filter((p) => p.dispute_open)
              .map((p) => ({
                purchase_id: p.purchase_id,
                coach_name: p.coach_name,
                currency: p.currency,
                amount_cents: this.disputeAmount(delinquent, p.purchase_id),
              })),
          }
        : null;
    const single = singleCurrency(totalsByCurrency([...paidTotals, ...dueTotals]));
    const mixed = totalsByCurrency([...paidTotals, ...dueTotals]).length > 1;
    const declineLine = focus?.invoices.find((l) => l.result === 'declined');
    return {
      outcome,
      card,
      amount_paid_cents: mixed ? null : (paidTotals[0]?.amount_cents ?? 0),
      amount_due_cents: mixed ? null : (dueTotals[0]?.amount_cents ?? 0),
      currency: mixed ? null : (single ?? plans[0]?.currency ?? null),
      paid_totals: paidTotals,
      due_totals: dueTotals,
      access_restored: accessState === 'restored',
      access_state: accessState,
      // The journal's Stripe idempotency keys stay server-side.
      plans: plans.map((p) => ({
        ...p,
        invoices: p.invoices.map(
          ({ idempotency_key: _key, intent_at: _intentAt, ...line }) => line,
        ),
      })),
      quote,
      payment_intent_client_secret:
        outcome === 'requires_action' && focus ? (secrets.get(focus.purchase_id) ?? null) : null,
      requires_action_purchase_id:
        outcome === 'requires_action' && focus ? focus.purchase_id : null,
      decline_code: declineLine?.decline_code ?? null,
      message: this.cardMessage(
        outcome,
        card,
        paidTotals,
        focusDue,
        accessState,
        plans,
        delinquent,
      ),
    };
  }

  private quoteLinesFrom(plans: PlanPayResult[]): QuoteLine[] {
    return plans.flatMap((p) =>
      p.invoices
        .filter((l) => l.result !== 'paid' && l.result !== 'already_paid')
        .map((l) => ({
          invoice_id: l.invoice_id,
          purchase_id: p.purchase_id,
          coach_name: p.coach_name,
          currency: l.currency,
          amount_cents: l.amount_due_cents,
          created: null,
        })),
    );
  }

  private disputeAmount(delinquent: PurchaseWithDunning[], purchaseId: string): number | null {
    const p = delinquent.find((x) => x.id === purchaseId);
    const v = p?.dunning?.last_failed_amount_cents;
    return Number.isInteger(v) ? (v as number) : null;
  }

  /**
   * Plain, specific copy that always states known collected money first and
   * never says "nothing was charged" after a partial success.
   */
  private cardMessage(
    outcome: CardUpdateOutcome,
    card: SavedCard | null,
    paid: MoneyTotal[],
    due: MoneyTotal[],
    access: CardUpdateResult['access_state'],
    plans: PlanPayResult[],
    delinquent: PurchaseWithDunning[],
  ): string {
    const ending = card?.last4 ? ` ending ${card.last4}` : '';
    const parts: string[] = [`Your card${ending} is saved.`];
    const anyPaid = paid.length > 0;
    if (anyPaid) parts.push(`${formatTotals(paid)} went through.`);
    const dueText = due.length > 0 ? formatTotals(due) : null;
    const other = anyPaid ? ' for your other plan' : '';
    switch (outcome) {
      case 'paid':
        if (access === 'restored') {
          parts.push(
            plans.length > 1 ? 'Your plans are active again.' : 'Your plan is active again.',
          );
        } else if (access === 'partial') {
          parts.push('That plan is active again.');
        } else {
          parts.push(
            'Your payment is in. Your access is still updating; pull down to refresh in a minute.',
          );
        }
        break;
      case 'saved':
        parts.push(
          plans.some((p) => p.dispute_open)
            ? 'There was no open invoice to pay, so nothing was charged.'
            : 'Your next payment will use it.',
        );
        break;
      case 'requires_action':
        parts.push(
          `Your bank wants you to confirm the payment${dueText ? ` of ${dueText}` : ''}${other}.`,
        );
        break;
      case 'declined':
        parts.push(
          anyPaid
            ? `Your bank declined the payment${dueText ? ` of ${dueText}` : ''}${other}, so that amount was not charged. Try a different card, or call your bank and try again.`
            : `Your bank declined the payment${dueText ? ` of ${dueText}` : ''}, so nothing was charged. Try a different card, or call your bank and try again.`,
        );
        break;
      case 'processing':
        parts.push(
          `The payment${dueText ? ` of ${dueText}` : ''}${other} is processing. Your plan updates as soon as it clears.`,
        );
        break;
      case 'payment_uncertain':
        parts.push(
          `The payment${dueText ? ` of ${dueText}` : ''}${other} is not confirmed yet. Wait a minute, then pull down to refresh. Trying again never charges you twice.`,
        );
        break;
      case 'failed':
        parts.push(
          anyPaid
            ? `The payment${dueText ? ` of ${dueText}` : ''}${other} did not go through because the payment provider could not complete it, so that amount was not charged. Try again in a minute.`
            : `The payment${dueText ? ` of ${dueText}` : ''} did not go through because the payment provider could not complete it, so nothing was charged. Try again in a minute.`,
        );
        break;
      case 'in_progress':
        parts.push(
          `Another change to ${anyPaid ? 'your other plan' : 'your plan'} is still being processed. Pull down in a few seconds to see the result.`,
        );
        break;
      case 'approval_required':
        parts.push(
          `${anyPaid ? 'You also owe' : 'You owe'} ${dueText ?? 'a new amount'} that you have not approved yet, so it was not charged. Review the amount, then confirm to pay it.`,
        );
        break;
    }
    const disputes = plans.filter((p) => p.dispute_open);
    if (disputes.length > 0) {
      const amounts = totalsByCurrency(
        disputes.map((p) => ({
          currency: p.currency,
          amount_cents: this.disputeAmount(delinquent, p.purchase_id) ?? 0,
        })),
      );
      parts.push(
        `Your bank reversed an earlier payment${amounts.length ? ` of ${formatTotals(amounts)}` : ''}. Saving a card does not settle that; contact support at ${SUPPORT_EMAIL} to sort it out.`,
      );
    }
    return parts.join(' ');
  }

  // ── 4. Cancel: 2A in dunning, option A otherwise ──────────────────────────

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
    const pending = await this.openCancelOperation(purchase.id);
    if (purchase.status === 'canceled') {
      return {
        outcome: 'already_ended',
        purchase_id: purchase.id,
        access_ends_at: (purchase.canceled_at ?? purchase.access_expires_at)?.toISOString() ?? null,
        voided_invoice_count: 0,
        voided_amount_cents: 0,
        currency: purchase.currency,
        paid_period_kept: false,
        message: 'This plan has already ended. Nothing more will be charged for it.',
      };
    }
    // A previous 2A request recorded its intent but did not finish: resume.
    if (pending || purchase.dunning?.client_canceled_at) return this.runDunningCancel(purchase);
    if (!isDelinquent(purchase)) return this.cancelAtPeriodEnd(purchase);
    return this.runDunningCancel(purchase);
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
        throw this.stripeFailure(err, 'cancel_schedule');
      }
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          cancel_at_period_end: true,
          ...(periodEnd ? { current_period_end: periodEnd } : {}),
        },
      });
      this.logEvent('billing.client_cancel_scheduled', {
        purchase_id: purchase.id,
        access_ends_at: periodEnd?.toISOString() ?? null,
      });
    }
    return this.scheduledResult(purchase, periodEnd, false);
  }

  private scheduledResult(
    purchase: ClientPurchase,
    periodEnd: Date | null,
    paidMeanwhile: boolean,
  ): CancelPlanResult {
    const date = periodEnd ? periodEnd.toISOString().slice(0, 10) : null;
    const lead = paidMeanwhile
      ? 'Your latest payment went through before your plan ended, so you keep the period you paid for.'
      : 'Your plan is canceled.';
    return {
      outcome: 'scheduled',
      purchase_id: purchase.id,
      access_ends_at: periodEnd?.toISOString() ?? null,
      voided_invoice_count: 0,
      voided_amount_cents: 0,
      currency: purchase.currency,
      paid_period_kept: paidMeanwhile,
      message: date
        ? `${lead} You keep access until ${date}, the end of the period you paid for, and you will not be charged again.`
        : `${lead} You keep access until the end of the period you paid for, and you will not be charged again.`,
    };
  }

  /**
   * Owner 2A with a durable intent and a canonical paid-period check:
   *   1. list every open invoice (all pages);
   *   2. nothing open and Stripe's latest invoice is PAID: the client is not
   *      in dunning any more -> option A (B-628-1: paid before the list);
   *   3. record the intent (journal row + client_canceled_at) BEFORE the
   *      first void, under the fenced lease (B-628-5);
   *   4. void every open invoice (lease renewed before each void);
   *   5. re-read Stripe: latest invoice paid (a retry won the race between
   *      list and void) -> option A; unknown -> stop, reconciler resumes;
   *   6. cancel the subscription now (no proration, no refund) and end
   *      access in one fenced transaction.
   * Every step is idempotent, so the reconciler and a retried request
   * resume from any point.
   */
  private async runDunningCancel(purchase: PurchaseWithDunning): Promise<CancelPlanResult> {
    const lease = await this.claimLease(purchase.id, 'canceling');
    try {
      let invoices: StripeInvoiceObject[];
      try {
        invoices = await this.stripe.listOpenInvoices(purchase.stripe_subscription_id as string);
      } catch (err) {
        throw this.stripeFailure(err, 'invoice_list');
      }
      const existing = await this.openCancelOperation(purchase.id);
      if (invoices.length === 0 && !existing) {
        const period = await this.latestPeriodState(purchase);
        if (period === 'paid') return await this.keepPaidPeriod(purchase, lease, null);
        if (period === 'unknown') throw this.planChangeUnknown(0);
      }
      const opId = await this.recordCancelIntent(purchase, lease, existing?.id ?? null);
      // Lines of a resumed operation are the invoices it already voided,
      // plus (B-628-11) any `voiding` intent whose receipt never committed:
      // Stripe's canonical state decides those before anything is counted.
      const lines: InvoiceLine[] = [];
      for (const prior of existing?.lines ?? []) {
        if (prior.result !== 'voiding') {
          lines.push(prior);
          continue;
        }
        const fresh = await this.safeRetrieveInvoice(prior.invoice_id);
        if (fresh?.status === 'void') {
          lines.push({ ...prior, result: 'not_attempted' });
        } else if (fresh == null) {
          // Unknown: keep the intent; the reconciler resumes.
          await this.saveOperation(
            lease,
            opId,
            'voiding',
            [...lines, prior],
            'VOID_INCOMPLETE',
            false,
          );
          throw this.planChangeUnknown(lines.length);
        }
        // Paid meanwhile: step 5 decides. Still open: voided again below.
      }
      let voidedCount = lines.length;
      let voidedCents = lines.reduce((sum, l) => sum + l.amount_due_cents, 0);
      for (const inv of invoices) {
        if (lines.some((l) => l.invoice_id === inv.id)) continue;
        const due = this.dueCents(inv);
        await this.renewLease(lease);
        // B-628-11: commit the void intent (identity, currency, amount, key)
        // before the Stripe call.
        const intent: InvoiceLine = {
          invoice_id: inv.id,
          currency: normalizeCurrency(inv.currency ?? purchase.currency),
          amount_due_cents: due,
          amount_paid_cents: 0,
          result: 'voiding',
          idempotency_key: voidIdempotencyKey(inv.id),
        };
        lines.push(intent);
        await this.saveOperation(lease, opId, 'voiding', lines, null, false);
        try {
          await this.stripe.voidInvoice({
            invoiceId: inv.id,
            idempotencyKey: voidIdempotencyKey(inv.id),
          });
        } catch (err) {
          const fresh = await this.safeRetrieveInvoice(inv.id);
          if (fresh?.status === 'paid') {
            // A Stripe retry paid it between list and void; step 5 decides.
            lines.splice(lines.indexOf(intent), 1);
            await this.saveOperation(lease, opId, 'voiding', lines, null, false);
            continue;
          }
          if (fresh?.status !== 'void') {
            // The intent stays recorded: the reconciler finishes the cancel.
            if (fresh != null) lines.splice(lines.indexOf(intent), 1);
            await this.saveOperation(lease, opId, 'voiding', lines, 'VOID_INCOMPLETE', false);
            if (
              err instanceof StripeConnectApiError &&
              err.httpStatus < 500 &&
              err.httpStatus !== 429 &&
              fresh != null
            ) {
              throw this.cancelIncomplete(voidedCount);
            }
            throw this.planChangeUnknown(voidedCount);
          }
        }
        voidedCount += 1;
        voidedCents += due;
        intent.result = 'not_attempted';
        await this.saveOperation(lease, opId, 'voiding', lines, null, false);
      }
      const period = await this.latestPeriodState(purchase);
      if (period === 'paid') return await this.keepPaidPeriod(purchase, lease, opId);
      if (period === 'unknown') throw this.planChangeUnknown(voidedCount);
      if (period !== 'canceled') {
        await this.saveOperation(lease, opId, 'canceling', lines, null, false);
        await this.renewLease(lease);
        await this.cancelSubscriptionNow(purchase, voidedCount, opId, lease, lines);
      }
      return await this.endAccessNow(purchase, lease, opId, lines, voidedCount, voidedCents);
    } finally {
      await this.releaseLease(lease);
    }
  }

  /** 'paid' when Stripe's latest invoice for the subscription is paid. */
  private async latestPeriodState(
    purchase: ClientPurchase,
  ): Promise<'paid' | 'unpaid' | 'canceled' | 'unknown'> {
    let sub;
    try {
      sub = await this.stripe.retrieveSubscription(purchase.stripe_subscription_id as string);
    } catch (err) {
      this.logger.warn(
        `cancel: subscription re-read failed purchase=${purchase.id}: ${(err as Error).message}`,
      );
      return 'unknown';
    }
    const status = String(sub.status);
    if (status === 'canceled') return 'canceled';
    const latest = sub.latest_invoice as
      string | { id?: string; status?: string } | null | undefined;
    const latestId = typeof latest === 'string' ? latest : (latest?.id ?? null);
    if (!latestId) return PAID_SUB_STATUSES.has(status) ? 'paid' : 'unpaid';
    try {
      const inv = await this.stripe.retrieveInvoice(latestId);
      return inv.status === 'paid' ? 'paid' : 'unpaid';
    } catch (err) {
      this.logger.warn(
        `cancel: latest invoice re-read failed purchase=${purchase.id}: ${(err as Error).message}`,
      );
      return 'unknown';
    }
  }

  /**
   * Option A fallback: the period is paid, so the client keeps it and the
   * plan ends at period end. Our rows follow Stripe; the dunning cycle is
   * closed because nothing is owed.
   */
  private async keepPaidPeriod(
    purchase: PurchaseWithDunning,
    lease: Lease,
    opId: string | null,
  ): Promise<CancelPlanResult> {
    let periodEnd = purchase.current_period_end ?? purchase.access_expires_at;
    let status = 'active';
    await this.renewLease(lease);
    try {
      const sub = await this.stripe.setCancelAtPeriodEnd({
        subscriptionId: purchase.stripe_subscription_id as string,
        idempotencyKey: `tgp-cancel-ape-${purchase.stripe_subscription_id}`,
      });
      if (typeof sub.current_period_end === 'number') {
        periodEnd = new Date(sub.current_period_end * 1000);
      }
      if (PAID_SUB_STATUSES.has(String(sub.status))) status = String(sub.status);
    } catch (err) {
      throw this.stripeFailure(err, 'cancel_schedule');
    }
    await this.fencedTx(lease, async (tx) => {
      await tx.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          cancel_at_period_end: true,
          ...(periodEnd ? { current_period_end: periodEnd, access_expires_at: periodEnd } : {}),
          ...(DELINQUENT_STATUSES.has(purchase.status) ? { status, entitlement_active: true } : {}),
        },
      });
      if (purchase.dunning) {
        await tx.dunningState.updateMany({
          where: { id: purchase.dunning.id },
          data: { client_canceled_at: null },
        });
      }
      if (this.dunningV2) await this.dunningV2.applyImmediateClear(purchase.id, 'retry', tx);
      if (opId) {
        await tx.clientBillingOperation.update({
          where: { id: opId },
          data: { phase: 'kept_paid_period', completed_at: new Date() },
        });
      }
    });
    if (this.dunning) {
      try {
        await this.dunning.recordResolution(purchase.id);
      } catch (err) {
        this.logger.warn(
          `cancel: v1 resolution deferred to webhook purchase=${purchase.id}: ${(err as Error).message}`,
        );
      }
    }
    this.logEvent('billing.client_cancel_paid_meanwhile', {
      purchase_id: purchase.id,
      access_ends_at: periodEnd?.toISOString() ?? null,
    });
    return this.scheduledResult(purchase, periodEnd, true);
  }

  private async cancelSubscriptionNow(
    purchase: ClientPurchase,
    voidedCount: number,
    opId: string,
    lease: Lease,
    lines: InvoiceLine[],
  ): Promise<void> {
    try {
      await this.stripe.cancelSubscription(purchase.stripe_subscription_id as string);
    } catch (err) {
      let canceled = false;
      try {
        const sub = await this.stripe.retrieveSubscription(
          purchase.stripe_subscription_id as string,
        );
        canceled = String(sub.status) === 'canceled';
      } catch (readErr) {
        this.logger.warn(
          `cancel: subscription re-read after cancel failure purchase=${purchase.id}: ${(readErr as Error).message}`,
        );
      }
      if (!canceled) {
        await this.saveOperation(lease, opId, 'canceling', lines, 'CANCEL_INCOMPLETE', false);
        this.logEvent('billing.client_cancel_incomplete', { purchase_id: purchase.id });
        throw this.cancelIncomplete(voidedCount);
      }
    }
  }

  /** End access locally (one fenced transaction) once Stripe is canceled. */
  private async endAccessNow(
    purchase: ClientPurchase,
    lease: Lease,
    opId: string,
    lines: InvoiceLine[],
    voidedCount: number,
    voidedCents: number,
  ): Promise<CancelPlanResult> {
    const now = new Date();
    await this.fencedTx(lease, async (tx) => {
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
      await tx.clientBillingOperation.update({
        where: { id: opId },
        data: {
          phase: 'ended',
          lines: this.toJson(lines),
          error_code: null,
          completed_at: now,
        },
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
    const currency = lines[0]?.currency ?? normalizeCurrency(purchase.currency);
    return {
      outcome: 'ended',
      purchase_id: purchase.id,
      access_ends_at: now.toISOString(),
      voided_invoice_count: voidedCount,
      voided_amount_cents: voidedCents,
      currency,
      paid_period_kept: false,
      message:
        voidedCount > 0
          ? `Your plan has ended. The unpaid ${formatMinor(voidedCents, currency)} is canceled, so you will not be charged for it. Your data stays in your account until you delete it.`
          : 'Your plan has ended, and you will not be charged again. Your data stays in your account until you delete it.',
    };
  }

  /**
   * Hourly reconciler (ClientBillingReconciler):
   *   a. resume every open operation whose last write is older than 5 min:
   *      a 2A cancel continues from its journal (with the same paid-period
   *      check); a card payment whose answer was lost, still processing or
   *      waiting on the bank is re-read from Stripe and access restored once
   *      paid;
   *   b. under FEATURE_DUNNING_V2, apply 2A to an active cycle whose
   *      subscription was set to cancel at period end outside the app.
   */
  async reconcile(
    now: Date = new Date(),
  ): Promise<{ finished: number; applied: number; failed: number }> {
    let finished = 0;
    let applied = 0;
    let failed = 0;
    const settle = new Date(now.getTime() - OPERATION_SETTLE_MS);
    const ops = await this.prisma.clientBillingOperation.findMany({
      where: { completed_at: null, updated_at: { lte: settle } },
      orderBy: { updated_at: 'asc' },
      take: 100,
    });
    for (const op of ops) {
      try {
        const purchase = await this.prisma.clientPurchase.findUnique({
          where: { id: op.purchase_id },
          include: { dunning: true },
        });
        if (!purchase) continue;
        if (op.kind === 'cancel') {
          if (purchase.status === 'canceled') {
            await this.prisma.clientBillingOperation.update({
              where: { id: op.id },
              data: { phase: 'ended', completed_at: now },
            });
          } else {
            await this.runDunningCancel(purchase);
          }
          finished += 1;
        } else if (op.kind === 'card_pay') {
          if (await this.reconcileCardOperation(purchase, op.id)) finished += 1;
        }
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `reconcile: operation ${op.kind} failed op=${op.id} purchase=${op.purchase_id}: ${(err as Error).message}`,
        );
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
          await this.runDunningCancel({ ...purchase, dunning: state });
          applied += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `reconcile: 2A failed purchase=${row.purchase_id}: ${(err as Error).message}`,
          );
        }
      }
    }
    return { finished, applied, failed };
  }

  /**
   * Server-side truth for a card payment whose result was not final: re-read
   * each unsettled invoice; record what Stripe collected and restore access
   * once nothing is left unsettled. Returns true when the operation closed.
   */
  private async reconcileCardOperation(
    purchase: PurchaseWithDunning,
    opId: string,
  ): Promise<boolean> {
    const lease = await this.claimLease(purchase.id, 'paying');
    try {
      const op = await this.prisma.clientBillingOperation.findUnique({ where: { id: opId } });
      if (!op || op.completed_at) return true;
      const lines = this.linesOf(op.lines);
      let unsettled = false;
      // B-628-11: a `paying` / `uncertain` intent is settled with the
      // update's own card (same idempotency key, inside the key's replay
      // window), never charged anew in the background.
      let paymentMethodId: string | null = null;
      if (
        op.setup_intent_id &&
        lines.some((l) => l.result === 'paying' || l.result === 'uncertain')
      ) {
        try {
          const si = await this.stripe.retrieveSetupIntent(op.setup_intent_id);
          const pm = si.payment_method;
          paymentMethodId = typeof pm === 'string' ? pm : (pm?.id ?? null);
        } catch (err) {
          this.logger.warn(
            `reconcile: setup intent re-read failed op=${opId}: ${(err as Error).message}`,
          );
        }
      }
      for (const l of lines) {
        if (!UNSETTLED_RESULTS.has(l.result)) continue;
        const settled = await this.settledLine(
          l,
          paymentMethodId,
          op.setup_intent_id ?? '',
          op.created_at,
        );
        if (settled.kind === 'settled') {
          l.result = settled.line.result;
          l.amount_paid_cents = settled.line.amount_paid_cents;
        } else if (settled.kind === 'closed') {
          l.result = 'failed';
        } else {
          // `open` (still unpaid) or `unknown` (Stripe could not say): kept.
          unsettled = true;
        }
      }
      if (unsettled) {
        // A bank confirmation the client never finished: after 7 days the
        // invoice is Stripe's again (its retries / the next card update).
        const expired = op.created_at.getTime() < Date.now() - 7 * 24 * 60 * 60_000;
        await this.saveOperation(
          lease,
          opId,
          expired ? 'expired' : op.phase,
          lines,
          op.error_code,
          expired,
        );
        return expired;
      }
      if (lines.some((l) => l.result === 'paid') && !isDisputeCycle(purchase.dunning)) {
        await this.restoreAfterPayment(purchase, lease, true);
      }
      await this.saveOperation(lease, opId, 'reconciled', lines, null, true);
      return true;
    } finally {
      await this.releaseLease(lease);
    }
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  private toJson(lines: InvoiceLine[]): Prisma.InputJsonValue {
    return lines.map((l) => ({
      invoice_id: l.invoice_id,
      currency: l.currency,
      amount_due_cents: l.amount_due_cents,
      amount_paid_cents: l.amount_paid_cents,
      result: l.result,
      decline_code: l.decline_code ?? null,
      idempotency_key: l.idempotency_key ?? null,
      intent_at: l.intent_at ?? null,
    }));
  }

  private linesOf(v: unknown): InvoiceLine[] {
    if (!Array.isArray(v)) return [];
    const out: InvoiceLine[] = [];
    for (const raw of v) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.invoice_id !== 'string') continue;
      const paid = Number.isInteger(r.amount_paid_cents) ? (r.amount_paid_cents as number) : 0;
      const due = Number.isInteger(r.amount_due_cents) ? (r.amount_due_cents as number) : 0;
      out.push({
        invoice_id: r.invoice_id,
        currency: normalizeCurrency(typeof r.currency === 'string' ? r.currency : null),
        amount_due_cents: due,
        amount_paid_cents: paid,
        result: (typeof r.result === 'string' ? r.result : 'uncertain') as InvoiceLineResult,
        decline_code: typeof r.decline_code === 'string' ? r.decline_code : null,
        idempotency_key: typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
        intent_at: typeof r.intent_at === 'string' ? r.intent_at : null,
      });
    }
    return out;
  }

  /** The card_pay journal row of this purchase + SetupIntent (created once). */
  private async openCardOperation(
    lease: Lease,
    purchaseId: string,
    setupIntentId: string,
  ): Promise<{ id: string; lines: InvoiceLine[]; createdAt: Date }> {
    const existing = await this.prisma.clientBillingOperation.findFirst({
      where: { purchase_id: purchaseId, kind: 'card_pay', setup_intent_id: setupIntentId },
      orderBy: { created_at: 'asc' },
    });
    if (existing) {
      return {
        id: existing.id,
        lines: this.linesOf(existing.lines),
        createdAt: existing.created_at,
      };
    }
    const id = randomUUID();
    const createdAt = new Date();
    await this.fencedTx(lease, async (tx) => {
      await tx.clientBillingOperation.create({
        data: {
          id,
          purchase_id: purchaseId,
          kind: 'card_pay',
          phase: 'started',
          fence: lease.fence,
          setup_intent_id: setupIntentId,
          lines: this.toJson([]),
        },
      });
    });
    return { id, lines: [], createdAt };
  }

  private async openCancelOperation(
    purchaseId: string,
  ): Promise<{ id: string; lines: InvoiceLine[] } | null> {
    const row = await this.prisma.clientBillingOperation.findFirst({
      where: { purchase_id: purchaseId, kind: 'cancel', completed_at: null },
      orderBy: { created_at: 'desc' },
    });
    return row ? { id: row.id, lines: this.linesOf(row.lines) } : null;
  }

  /**
   * B-628-5: the durable 2A intent, written BEFORE the first void in one
   * fenced transaction: the journal row (usable when no DunningState exists)
   * and the cycle's client_canceled_at (stops notices and the Day-10 lock,
   * and makes the webhook ignore live subscription updates).
   */
  private async recordCancelIntent(
    purchase: PurchaseWithDunning,
    lease: Lease,
    existingId: string | null,
  ): Promise<string> {
    const id = existingId ?? randomUUID();
    const now = new Date();
    await this.fencedTx(lease, async (tx) => {
      if (existingId) {
        await tx.clientBillingOperation.update({
          where: { id },
          data: { fence: lease.fence, phase: 'voiding' },
        });
      } else {
        await tx.clientBillingOperation.create({
          data: {
            id,
            purchase_id: purchase.id,
            kind: 'cancel',
            phase: 'voiding',
            fence: lease.fence,
            lines: this.toJson([]),
          },
        });
      }
      if (purchase.dunning) {
        await tx.dunningState.updateMany({
          where: { id: purchase.dunning.id, client_canceled_at: null },
          data: { client_canceled_at: now },
        });
      }
    });
    return id;
  }

  private async saveOperation(
    lease: Lease,
    opId: string,
    phase: string,
    lines: InvoiceLine[],
    errorCode: string | null,
    complete: boolean,
  ): Promise<void> {
    await this.fencedTx(lease, async (tx) => {
      await tx.clientBillingOperation.update({
        where: { id: opId },
        data: {
          phase,
          fence: lease.fence,
          lines: this.toJson(lines),
          error_code: errorCode,
          ...(complete ? { completed_at: new Date() } : {}),
        },
      });
    });
  }

  // ── Lease (B-628-9) ───────────────────────────────────────────────────────

  /**
   * CAS claim of the per-purchase lease: free when no holder or expired.
   * Every claim increments the fence. Works with or without a DunningState.
   */
  private async claimLease(purchaseId: string, action: 'paying' | 'canceling'): Promise<Lease> {
    try {
      await this.prisma.clientBillingLease.upsert({
        where: { purchase_id: purchaseId },
        create: { purchase_id: purchaseId, holder: null, holder_until: null, fence: 0 },
        update: {},
      });
    } catch (err) {
      // Two first-time claimers raced on the create; the row exists now.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    const now = new Date();
    const token = `${action}:${randomUUID()}`;
    const res = await this.prisma.clientBillingLease.updateMany({
      where: {
        purchase_id: purchaseId,
        OR: [{ holder: null }, { holder_until: null }, { holder_until: { lte: now } }],
      },
      data: {
        holder: token,
        holder_until: new Date(now.getTime() + BILLING_ACTION_LEASE_MS),
        fence: { increment: 1 },
      },
    });
    if (res.count !== 1) throw this.inProgress();
    const row = await this.prisma.clientBillingLease.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!row || row.holder !== token) throw this.inProgress();
    return { purchaseId, token, fence: row.fence };
  }

  /** CAS on holder; extends the lease. Throws when a newer holder took over. */
  private async renewLease(lease: Lease): Promise<void> {
    const res = await this.prisma.clientBillingLease.updateMany({
      where: { purchase_id: lease.purchaseId, holder: lease.token },
      data: { holder_until: new Date(Date.now() + BILLING_ACTION_LEASE_MS) },
    });
    if (res.count !== 1) throw new BillingLeaseLostError(lease.purchaseId);
  }

  /**
   * Run money-writes in one transaction that first re-checks the lease with
   * a CAS on holder (the row lock it takes also blocks a competing claimer
   * until commit). `lease` null runs without a fence (no money moved).
   */
  private async fencedTx(lease: Lease | null, fn: (tx: Tx) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (lease) {
        const ok = await tx.clientBillingLease.updateMany({
          where: { purchase_id: lease.purchaseId, holder: lease.token },
          data: { holder_until: new Date(Date.now() + BILLING_ACTION_LEASE_MS) },
        });
        if (ok.count !== 1) throw new BillingLeaseLostError(lease.purchaseId);
      }
      await fn(tx);
    });
  }

  private async releaseLease(lease: Lease | null): Promise<void> {
    if (!lease) return;
    try {
      await this.prisma.clientBillingLease.updateMany({
        where: { purchase_id: lease.purchaseId, holder: lease.token },
        data: { holder: null, holder_until: null },
      });
    } catch (err) {
      // An unreleased lease expires on its own after BILLING_ACTION_LEASE_MS.
      this.logger.warn(
        `billing lease release failed purchase=${lease.purchaseId}: ${(err as Error).message}`,
      );
    }
  }

  private inProgress(): ConflictException {
    return new ConflictException({
      code: 'BILLING_ACTION_IN_PROGRESS',
      error: 'BILLING_ACTION_IN_PROGRESS',
      message:
        'Another change to this plan is still being processed. Wait a few seconds, then pull down to see the result.',
    });
  }

  private cancelIncomplete(voidedCount: number): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'CANCEL_INCOMPLETE',
      error: 'CANCEL_INCOMPLETE',
      message:
        voidedCount > 0
          ? 'Your unpaid invoice is canceled, so you will not be charged for it, but your plan did not finish ending. It finishes automatically within the hour, or tap End my plan again in a minute.'
          : 'Your plan did not finish ending, and nothing was charged. It finishes automatically within the hour, or tap End my plan again in a minute.',
    });
  }

  private planChangeUnknown(voidedCount: number): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PLAN_CHANGE_RESULT_UNKNOWN',
      error: 'PLAN_CHANGE_RESULT_UNKNOWN',
      message:
        voidedCount > 0
          ? 'Your unpaid invoice is canceled, but the payment provider has not confirmed the rest of the change yet. It finishes automatically within the hour; pull down to refresh.'
          : 'The payment provider did not confirm your plan, so nothing changed yet. Wait a minute, then try again. Repeating it is safe and never charges you.',
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Every live subscription purchase of the client, every page. */
  private async livePurchases(clientUserId: string): Promise<PurchaseWithDunning[]> {
    const out: PurchaseWithDunning[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: PurchaseWithDunning[] = await this.prisma.clientPurchase.findMany({
        where: {
          client_user_id: clientUserId,
          billing_type: 'recurring',
          stripe_subscription_id: { not: null },
          status: { in: LIVE_SUBSCRIPTION_STATUSES },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: { dunning: true },
        orderBy: { id: 'asc' },
        take: PURCHASE_PAGE,
      });
      out.push(...page);
      if (page.length < PURCHASE_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    return out.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  private async coachNames(purchases: ClientPurchase[]): Promise<Map<string, string>> {
    const ids = [...new Set(purchases.map((p) => p.coach_user_id))];
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    for (const u of users) if (u.name) out.set(u.id, u.name);
    return out;
  }

  private requirePublishableKey(): string {
    const pk = (process.env.STRIPE_PUBLISHABLE_KEY ?? '').trim();
    const sk = (process.env.STRIPE_SECRET_KEY ?? '').trim();
    const pkMode = pk.startsWith('pk_live_') ? 'live' : pk.startsWith('pk_test_') ? 'test' : null;
    const skMode = /^(sk|rk)_live_/.test(sk) ? 'live' : /^(sk|rk)_test_/.test(sk) ? 'test' : null;
    if (!pkMode || (skMode && skMode !== pkMode)) {
      this.logger.error(
        `client billing: publishable key ${pkMode ? `mode ${pkMode} does not match the secret key mode` : 'is missing or invalid'}`,
      );
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        error: 'PAYMENTS_NOT_CONFIGURED',
        message:
          'Card updates are not available right now, and nothing was charged. Contact support with the reference below.',
      });
    }
    return pk;
  }

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

  private async mirrorCard(
    customerRowId: string,
    paymentMethodId: string,
  ): Promise<SavedCard | null> {
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
    } catch (err) {
      this.logger.warn(`invoice re-read failed invoice=${invoiceId}: ${(err as Error).message}`);
      return null;
    }
  }

  private dueCents(inv: StripeInvoiceObject): number {
    const v = inv.amount_remaining ?? inv.amount_due ?? 0;
    return Number.isInteger(v) && v > 0 ? v : 0;
  }

  private paidCents(res: StripeInvoiceObject, before: StripeInvoiceObject | null): number {
    const v = res.amount_paid;
    if (Number.isInteger(v) && (v as number) > 0) return v as number;
    return before ? this.dueCents(before) : 0;
  }

  /**
   * Map a Stripe/transport failure to a specific, actionable error with a
   * stable machine code (B-628-10: the production envelope keeps only
   * `code` and `message`, so the code alone tells the app whether money may
   * have moved).
   */
  private stripeFailure(err: unknown, step: string): HttpException {
    if (err instanceof HttpException) return err;
    const moneyStep = step === 'invoice_pay';
    const planStep = step === 'invoice_void' || step === 'cancel' || step === 'cancel_schedule';
    if (err instanceof StripeConnectApiError) {
      this.logger.warn(
        `client billing ${step}: Stripe ${err.httpStatus} ${err.stripeCode ?? ''} ${err.message}`,
      );
      const unavailable = err.httpStatus >= 500 || err.httpStatus === 429;
      if (unavailable) return this.unavailable(step);
      return new HttpException(
        {
          code: 'STRIPE_REQUEST_FAILED',
          error: 'STRIPE_REQUEST_FAILED',
          message: planStep
            ? 'The payment provider could not complete this plan change, so your plan is unchanged. Try again, or contact support with the reference below.'
            : 'The payment provider could not complete this change, so nothing was charged. Try again, or contact support with the reference below.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    const message = (err as Error)?.message ?? '';
    if (
      err instanceof TypeError ||
      /fetch failed|ECONN|ETIMEDOUT|socket hang up|aborted/i.test(message)
    ) {
      // Transport failure before Stripe answered (DNS, reset, TLS, timeout).
      this.logger.warn(`client billing ${step}: Stripe unreachable: ${message}`);
      return this.unavailable(step);
    }
    if (/STRIPE_SECRET_KEY/i.test(message)) {
      return new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        error: 'PAYMENTS_NOT_CONFIGURED',
        message:
          'Card payments are not available right now, and nothing was charged. Contact support with the reference below.',
      });
    }
    this.logger.error(`client billing ${step}: unexpected ${message}`);
    if (moneyStep || planStep) {
      return this.unavailable(step);
    }
    return new HttpException(
      {
        code: 'BILLING_ACTION_FAILED',
        error: 'BILLING_ACTION_FAILED',
        message: 'This change did not complete. Contact support with the reference below.',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Truthful 503 when Stripe did not answer: a lost response on a payment
   * or a plan change may still have taken effect, so those carry their own
   * codes and never claim "nothing changed".
   */
  private unavailable(step: string): HttpException {
    if (step === 'invoice_pay') {
      return new ServiceUnavailableException({
        code: 'PAYMENT_RESULT_UNKNOWN',
        error: 'PAYMENT_RESULT_UNKNOWN',
        message:
          'Your payment is not confirmed yet. Wait a minute, then pull down to refresh. Trying again never charges you twice.',
      });
    }
    if (step === 'invoice_void' || step === 'cancel' || step === 'cancel_schedule') {
      return new ServiceUnavailableException({
        code: 'PLAN_CHANGE_RESULT_UNKNOWN',
        error: 'PLAN_CHANGE_RESULT_UNKNOWN',
        message:
          'Your plan change is not confirmed yet. It finishes automatically within the hour; pull down to refresh, or try again. Repeating it is safe and never charges you.',
      });
    }
    return new ServiceUnavailableException({
      code: 'STRIPE_UNAVAILABLE',
      error: 'STRIPE_UNAVAILABLE',
      message:
        'The payment provider did not respond, so nothing changed. Wait a minute, then try again.',
    });
  }

  private logEvent(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ event, ...fields }));
  }
}
