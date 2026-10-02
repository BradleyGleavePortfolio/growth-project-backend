/**
 * Stateful Stripe stand-in for the S-DUNNING-R2 specs (native card update,
 * owner rulings 1A / 2A). Models exactly the Stripe behaviour those paths
 * rely on, with integer minor units everywhere:
 *
 *   - an invoice owns ONE PaymentIntent and can be paid at most once; paying
 *     a paid (or void) invoice errors; voiding a paid invoice errors;
 *   - `invoices.pay` charges the given card on-session: ok / declined
 *     (card_error + decline_code) / 3DS (`invoice_payment_intent_requires_action`);
 *   - Stripe's own retry charges the SUBSCRIPTION's default payment method
 *     (Stripe's priority: subscription default before customer default);
 *   - voiding the latest open invoice of a past_due subscription makes it
 *     active (Stripe docs, "Subscription invoices");
 *   - POSTs carry Idempotency-Keys and a replayed key returns the first result.
 *
 * Every charge is appended to `charges`, so a spec can prove "charged once".
 */
import { StripeConnectApiError } from '../../src/connect/stripe-connect-api.service';

export type CardBehavior = 'ok' | 'decline' | 'requires_action';

export interface FakeInvoice {
  id: string;
  object: 'invoice';
  status: 'open' | 'paid' | 'void';
  subscription: string;
  customer: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  created: number;
  payment_intent: { id: string; status: string; client_secret: string };
}

export interface FakeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end: number;
  default_payment_method: string | null;
  cancel_at_period_end: boolean;
  latest_invoice: string | null;
}

export interface FakeSetupIntent {
  id: string;
  status: string;
  client_secret: string;
  customer: string;
  payment_method: string | null;
  usage: string;
  metadata: Record<string, string>;
}

export interface FakeCharge {
  invoice: string;
  payment_method: string;
  amount: number;
  by: 'tgp_pay' | 'stripe_retry' | 'client_3ds';
}

export class FakeStripeBilling {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly subs = new Map<string, FakeSubscription>();
  readonly customers = new Map<string, { id: string; default_payment_method: string | null }>();
  readonly setupIntents = new Map<string, FakeSetupIntent>();
  readonly cards = new Map<
    string,
    { behavior: CardBehavior; brand: string; last4: string; exp_month: number; exp_year: number }
  >();
  readonly charges: FakeCharge[] = [];
  readonly calls: Array<{ op: string; key?: string; args?: unknown }> = [];
  private readonly idem = new Map<string, { ok: unknown } | { err: unknown }>();
  private seq = 0;

  /** Test hooks: run before a pay / void / cancel executes (e.g. a race). */
  beforePay?: (invoiceId: string) => Promise<void> | void;
  beforeVoid?: (invoiceId: string) => Promise<void> | void;
  /** Number of upcoming cancelSubscription calls that fail with a 503. */
  cancelFailures = 0;
  /** S-DUNNING-R3: subscriptions whose open-invoice list answers 503. */
  readonly listFailures = new Set<string>();
  /** S-DUNNING-R3: upcoming pays that SETTLE, then lose the reply (timeout). */
  loseNextPayReply = 0;

  addCard(id: string, behavior: CardBehavior, last4: string, brand = 'visa'): void {
    this.cards.set(id, { behavior, brand, last4, exp_month: 12, exp_year: 2030 });
  }

  addInvoice(
    inv: Partial<FakeInvoice> & { id: string; subscription: string; amount_due: number },
  ): FakeInvoice {
    const full: FakeInvoice = {
      object: 'invoice',
      status: 'open',
      customer: 'cus_dv2_client',
      amount_paid: 0,
      amount_remaining: inv.amount_due,
      currency: 'usd',
      created: 0,
      payment_intent: {
        id: `pi_for_${inv.id}`,
        status: 'requires_payment_method',
        client_secret: `pi_for_${inv.id}_secret_test`,
      },
      ...inv,
    };
    this.invoices.set(full.id, full);
    const sub = this.subs.get(full.subscription);
    if (sub) sub.latest_invoice = full.id;
    return full;
  }

  // ── Stripe API surface (StripeConnectApiService shape) ──────────────────

  async createSetupIntent(args: {
    customer: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FakeSetupIntent> {
    this.calls.push({ op: 'createSetupIntent', key: args.idempotencyKey, args });
    return this.once(`seti:${args.idempotencyKey}`, () => {
      this.seq += 1;
      const si: FakeSetupIntent = {
        id: `seti_test${this.seq}`,
        status: 'requires_payment_method',
        client_secret: `seti_test${this.seq}_secret_x`,
        customer: args.customer,
        payment_method: null,
        usage: 'off_session',
        metadata: { ...(args.metadata ?? {}) },
      };
      this.setupIntents.set(si.id, si);
      return { ...si };
    });
  }

  async retrieveSetupIntent(id: string): Promise<FakeSetupIntent> {
    this.calls.push({ op: 'retrieveSetupIntent', args: id });
    const si = this.setupIntents.get(id);
    if (!si) {
      throw new StripeConnectApiError(
        `No such setupintent: '${id}'`,
        404,
        'resource_missing',
        'invalid_request_error',
      );
    }
    return { ...si, metadata: { ...si.metadata } };
  }

  async createEphemeralKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ secret: string }> {
    this.calls.push({ op: 'createEphemeralKey', key: idempotencyKey, args: customerId });
    return { secret: `ek_test_${customerId}` };
  }

  async setCustomerDefaultPaymentMethod(args: {
    customerId: string;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    this.calls.push({ op: 'setCustomerDefaultPaymentMethod', key: args.idempotencyKey, args });
    const c = this.customers.get(args.customerId);
    if (c) c.default_payment_method = args.paymentMethodId;
    return { id: args.customerId };
  }

  async setSubscriptionDefaultPaymentMethod(args: {
    subscriptionId: string;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<FakeSubscription> {
    this.calls.push({ op: 'setSubscriptionDefaultPaymentMethod', key: args.idempotencyKey, args });
    const sub = this.mustSub(args.subscriptionId);
    sub.default_payment_method = args.paymentMethodId;
    return { ...sub };
  }

  async listOpenInvoices(subscriptionId: string): Promise<FakeInvoice[]> {
    this.calls.push({ op: 'listOpenInvoices', args: subscriptionId });
    if (this.listFailures.has(subscriptionId)) {
      throw new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_error');
    }
    return [...this.invoices.values()]
      .filter((i) => i.subscription === subscriptionId && i.status === 'open')
      .sort((a, b) => b.created - a.created) // Stripe lists newest first
      .map((i) => this.copy(i));
  }

  async retrieveInvoice(id: string): Promise<FakeInvoice> {
    this.calls.push({ op: 'retrieveInvoice', args: id });
    const inv = this.invoices.get(id);
    if (!inv) {
      throw new StripeConnectApiError(
        `No such invoice: '${id}'`,
        404,
        'resource_missing',
        'invalid_request_error',
      );
    }
    return this.copy(inv);
  }

  async payInvoice(args: {
    invoiceId: string;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<FakeInvoice> {
    this.calls.push({ op: 'payInvoice', key: args.idempotencyKey, args });
    if (this.beforePay) await this.beforePay(args.invoiceId);
    const paid = this.once(`pay:${args.idempotencyKey}`, () => {
      const inv = this.invoices.get(args.invoiceId);
      if (!inv) {
        throw new StripeConnectApiError(
          'No such invoice',
          404,
          'resource_missing',
          'invalid_request_error',
        );
      }
      if (inv.status !== 'open') {
        throw new StripeConnectApiError(
          `Invoice ${inv.id} is ${inv.status} and cannot be paid.`,
          400,
          null,
          'invalid_request_error',
        );
      }
      const card = this.cards.get(args.paymentMethodId);
      if (!card || card.behavior === 'decline') {
        inv.payment_intent.status = 'requires_payment_method';
        throw new StripeConnectApiError(
          'Your card has insufficient funds.',
          402,
          'card_declined',
          'card_error',
          'insufficient_funds',
        );
      }
      if (card.behavior === 'requires_action') {
        inv.payment_intent.status = 'requires_action';
        throw new StripeConnectApiError(
          'Payment for this invoice requires additional user action.',
          402,
          'invoice_payment_intent_requires_action',
          'invalid_request_error',
        );
      }
      this.settle(inv, args.paymentMethodId, 'tgp_pay');
      return this.copy(inv);
    });
    if (this.loseNextPayReply > 0) {
      this.loseNextPayReply -= 1;
      // The charge landed; the answer never reached us.
      throw new StripeConnectApiError('Stripe API timed out', 503, 'request_timeout', 'api_error');
    }
    return paid;
  }

  async voidInvoice(args: { invoiceId: string; idempotencyKey: string }): Promise<FakeInvoice> {
    this.calls.push({ op: 'voidInvoice', key: args.idempotencyKey, args });
    if (this.beforeVoid) await this.beforeVoid(args.invoiceId);
    return this.once(`void:${args.idempotencyKey}`, () => {
      const inv = this.invoices.get(args.invoiceId);
      if (!inv || inv.status !== 'open') {
        throw new StripeConnectApiError(
          'You can only pass in open invoices.',
          400,
          null,
          'invalid_request_error',
        );
      }
      inv.status = 'void';
      inv.amount_remaining = 0;
      inv.payment_intent.status = 'canceled';
      const sub = this.subs.get(inv.subscription);
      if (sub && sub.status === 'past_due' && sub.latest_invoice === inv.id) sub.status = 'active';
      return this.copy(inv);
    });
  }

  async setCancelAtPeriodEnd(args: {
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<FakeSubscription> {
    this.calls.push({ op: 'setCancelAtPeriodEnd', key: args.idempotencyKey, args });
    const sub = this.mustSub(args.subscriptionId);
    sub.cancel_at_period_end = true;
    return { ...sub };
  }

  async cancelSubscription(subId: string): Promise<{ id: string; status: string }> {
    this.calls.push({ op: 'cancelSubscription', args: subId });
    if (this.cancelFailures > 0) {
      this.cancelFailures -= 1;
      throw new StripeConnectApiError(
        'Stripe API timed out',
        503,
        'request_timeout',
        'api_connection_error',
      );
    }
    const sub = this.mustSub(subId);
    sub.status = 'canceled';
    return { id: sub.id, status: sub.status };
  }

  async retrieveSubscription(id: string): Promise<FakeSubscription> {
    this.calls.push({ op: 'retrieveSubscription', args: id });
    return { ...this.mustSub(id) };
  }

  async retrievePaymentMethod(id: string): Promise<{ id: string; card?: Record<string, unknown> }> {
    const c = this.cards.get(id);
    return {
      id,
      card: c
        ? { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year }
        : undefined,
    };
  }

  // ── Test-side actions (what the app SDK / Stripe itself would do) ───────

  /** The in-app PaymentSheet confirms the SetupIntent with a card. */
  confirmSetupIntentInSheet(setupIntentId: string, paymentMethodId: string): void {
    const si = this.setupIntents.get(setupIntentId);
    if (!si) throw new Error(`unknown SetupIntent ${setupIntentId}`);
    si.status = 'succeeded';
    si.payment_method = paymentMethodId;
  }

  /** The client passes 3DS in the app (handleNextAction) for an invoice. */
  completeBankConfirmation(invoiceId: string): void {
    const inv = this.invoices.get(invoiceId);
    if (!inv || inv.status !== 'open') throw new Error(`invoice ${invoiceId} not open`);
    const pm = this.subs.get(inv.subscription)?.default_payment_method ?? 'pm_unknown';
    this.settle(inv, pm, 'client_3ds');
  }

  /** Stripe's scheduled retry: charges the subscription's default card. */
  stripeRetry(invoiceId: string): 'paid' | 'failed' | 'not_open' {
    const inv = this.invoices.get(invoiceId);
    if (!inv || inv.status !== 'open') return 'not_open';
    const sub = this.mustSub(inv.subscription);
    const pm =
      sub.default_payment_method ??
      this.customers.get(sub.customer)?.default_payment_method ??
      null;
    const card = pm ? this.cards.get(pm) : undefined;
    if (!pm || !card || card.behavior !== 'ok') return 'failed';
    this.settle(inv, pm, 'stripe_retry');
    return 'paid';
  }

  callsOf(op: string) {
    return this.calls.filter((c) => c.op === op);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private settle(inv: FakeInvoice, pm: string, by: FakeCharge['by']): void {
    if (inv.status !== 'open') throw new Error(`double charge attempted on ${inv.id}`);
    inv.status = 'paid';
    inv.amount_paid = inv.amount_due;
    inv.amount_remaining = 0;
    inv.payment_intent.status = 'succeeded';
    this.charges.push({ invoice: inv.id, payment_method: pm, amount: inv.amount_due, by });
    const sub = this.subs.get(inv.subscription);
    const stillOpen = [...this.invoices.values()].some(
      (i) => i.subscription === inv.subscription && i.status === 'open',
    );
    if (sub && !stillOpen && sub.status !== 'canceled') sub.status = 'active';
  }

  private once<T>(key: string, fn: () => T): T {
    const hit = this.idem.get(key);
    if (hit) {
      if ('err' in hit) throw hit.err;
      return hit.ok as T;
    }
    try {
      const ok = fn();
      this.idem.set(key, { ok });
      return ok;
    } catch (err) {
      this.idem.set(key, { err });
      throw err;
    }
  }

  private mustSub(id: string): FakeSubscription {
    const sub = this.subs.get(id);
    if (!sub) {
      throw new StripeConnectApiError(
        `No such subscription: '${id}'`,
        404,
        'resource_missing',
        'invalid_request_error',
      );
    }
    return sub;
  }

  private copy(inv: FakeInvoice): FakeInvoice {
    return { ...inv, payment_intent: { ...inv.payment_intent } };
  }
}
