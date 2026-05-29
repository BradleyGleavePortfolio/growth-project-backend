import { Injectable, Logger } from '@nestjs/common';

// Thin REST client for the Stripe Connect endpoints used by Phase 1:
//   - POST   /v1/accounts                       (create Express account)
//   - GET    /v1/accounts/{id}                  (read for webhook sync)
//   - GET    /v1/accounts?limit=1               (platform-enabled check)
//   - POST   /v1/account_links                  (onboarding link)
//   - POST   /v1/accounts/{id}/login_links      (Express Dashboard link)
//
// Mirrors the structure of src/billing/stripe-api.service.ts intentionally:
// no Stripe SDK, hand-rolled URL-encoded writes, `protected fetchImpl` for
// hermetic tests, and STRIPE_SECRET_KEY read at call time so tests can mutate
// env per-case without re-instantiating.
//
// "Real or flagged, never fake": every method throws a clear StripeConnectApiError
// on misconfiguration or upstream failure. No silent fallbacks.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-09-30.acacia';

export class StripeConnectApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly stripeCode: string | null,
    public readonly stripeType: string | null,
  ) {
    super(message);
    this.name = 'StripeConnectApiError';
  }
}

export interface StripeConnectAccount {
  id: string;
  country?: string;
  default_currency?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: Record<string, unknown> | null;
  // Stripe puts the disabled reason inside `requirements.disabled_reason`
  // but also surfaces a top-level `business_profile`/`capabilities`. We only
  // need `requirements` and `requirements.disabled_reason` for Phase 1.
  [k: string]: unknown;
}

export interface StripeAccountLink {
  object: 'account_link';
  url: string;
  expires_at: number;
  created: number;
}

export interface StripeLoginLink {
  object: 'login_link';
  url: string;
  created: number;
}

export interface StripeCustomerObject {
  id: string;
  email?: string | null;
  invoice_settings?: {
    default_payment_method?: string | null;
  } | null;
  [k: string]: unknown;
}

export interface StripeProductObject {
  id: string;
  name: string;
  active: boolean;
  [k: string]: unknown;
}

export interface StripePriceObject {
  id: string;
  product: string;
  active: boolean;
  unit_amount: number;
  currency: string;
  recurring?: { interval: string; interval_count: number } | null;
  [k: string]: unknown;
}

export interface StripePaymentIntentObject {
  id: string;
  client_secret: string;
  [k: string]: unknown;
}

export interface StripeEphemeralKeyObject {
  id: string;
  secret: string;
  [k: string]: unknown;
}

export interface StripeCheckoutSessionObject {
  id: string;
  url: string;
  payment_intent?: string | null;
  subscription?: string | null;
  customer?: string | null;
  status?: string;
  [k: string]: unknown;
}

export interface StripeSubscriptionObject {
  id: string;
  status: string;
  customer?: string | null;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  items?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

@Injectable()
export class StripeConnectApiService {
  private readonly logger = new Logger(StripeConnectApiService.name);

  // Timeout for all Stripe API calls. Stripe's p99 is well under 5s;
  // 10s gives headroom for retries without tying up a Fly worker indefinitely.
  // Overridable in tests via subclass.
  protected readonly stripeTimeoutMs = 10_000;

  // Overridable in tests via subclass to avoid monkey-patching globalThis.fetch.
  // Wraps every call with an AbortController so hung Stripe connections never
  // block a request thread past stripeTimeoutMs.
  protected fetchImpl: typeof fetch = (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.stripeTimeoutMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  };

  isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  // Sanity-check the secret looks like a Stripe API key. Returns the key
  // string on success; throws on the wrong shape so the caller can refuse
  // to register Connect routes (see ConnectModule onModuleInit).
  requireSecret(): string {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new StripeConnectApiError(
        'STRIPE_SECRET_KEY is unset — Stripe Connect routes are disabled. Set the key in env (sk_test_* in dev, sk_live_* in prod).',
        503,
        'configuration_missing',
        'configuration_error',
      );
    }
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(secret)) {
      throw new StripeConnectApiError(
        'STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_test_* or sk_live_*).',
        503,
        'configuration_invalid',
        'configuration_error',
      );
    }
    return secret;
  }

  // Platform-enabled probe. Issues GET /v1/accounts?limit=1 — succeeds only
  // when the platform's Stripe account has Connect enabled. Returns true on
  // 2xx; throws a StripeConnectApiError on a Stripe error so callers can
  // surface the dashboard URL the owner needs to visit.
  async assertPlatformEnabled(): Promise<true> {
    const secret = this.requireSecret();
    const res = await this.fetchImpl(`${STRIPE_API_BASE}/accounts?limit=1`, {
      method: 'GET',
      headers: this.commonHeaders(secret),
    });
    if (res.ok) return true;
    const parsed = await this.safeJson(res);
    const errEnvelope =
      parsed && typeof parsed === 'object' && 'error' in (parsed as object)
        ? (parsed as { error: Record<string, unknown> }).error
        : null;
    const code = (errEnvelope?.code as string | undefined) ?? null;
    const type = (errEnvelope?.type as string | undefined) ?? null;
    const messageFromStripe =
      (errEnvelope?.message as string | undefined) ?? null;
    // Stripe returns 400 with code "account_invalid" or similar when
    // Connect isn't enabled. Map every non-2xx to a 503 from our side so
    // the controller renders the owner-action message.
    throw new StripeConnectApiError(
      `Stripe Connect platform not enabled — visit https://dashboard.stripe.com/connect/overview and click "Get started". (Stripe said: ${messageFromStripe ?? `HTTP ${res.status}`})`,
      503,
      code,
      type,
    );
  }

  async createExpressAccount(args: {
    country?: string;
    email?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeConnectAccount> {
    const form: Record<string, string> = {
      type: 'express',
      country: args.country ?? 'US',
      'capabilities[card_payments][requested]': 'true',
      'capabilities[transfers][requested]': 'true',
    };
    if (args.email) form.email = args.email;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripeConnectAccount>('/accounts', form, args.idempotencyKey);
  }

  async retrieveAccount(accountId: string): Promise<StripeConnectAccount> {
    return this.get<StripeConnectAccount>(`/accounts/${encodeURIComponent(accountId)}`);
  }

  async createAccountLink(args: {
    account: string;
    refreshUrl: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<StripeAccountLink> {
    if (!args.idempotencyKey) {
      throw new Error('createAccountLink requires an idempotencyKey (R19)');
    }
    const form: Record<string, string> = {
      account: args.account,
      refresh_url: args.refreshUrl,
      return_url: args.returnUrl,
      type: 'account_onboarding',
    };
    return this.post<StripeAccountLink>(
      '/account_links',
      form,
      args.idempotencyKey,
    );
  }

  async createLoginLink(accountId: string): Promise<StripeLoginLink> {
    return this.post<StripeLoginLink>(
      `/accounts/${encodeURIComponent(accountId)}/login_links`,
      {},
    );
  }

  // --- Phase 2-3 — Product / Price / Customer / Checkout ---
  //
  // These calls operate on the PLATFORM account (no Stripe-Account header).
  // Connect destination charges live on the platform; we forward funds to
  // the coach's connected account via `payment_intent_data[transfer_data]`
  // (one_time) or `subscription_data[transfer_data]` (recurring) at
  // checkout time.

  async createCustomer(args: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeCustomerObject> {
    const form: Record<string, string> = {};
    if (args.email) form.email = args.email;
    if (args.name) form.name = args.name;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripeCustomerObject>(
      '/customers',
      form,
      args.idempotencyKey,
    );
  }

  async retrieveCustomer(customerId: string): Promise<StripeCustomerObject> {
    return this.get<StripeCustomerObject>(
      `/customers/${encodeURIComponent(customerId)}`,
    );
  }

  async retrievePaymentMethod(paymentMethodId: string): Promise<{
    id: string;
    card?: {
      brand?: string;
      last4?: string;
      exp_month?: number;
      exp_year?: number;
    };
    [k: string]: unknown;
  }> {
    return this.get(
      `/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    );
  }

  async retrieveSubscription(
    subscriptionId: string,
  ): Promise<StripeSubscriptionObject> {
    return this.get<StripeSubscriptionObject>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  }

  // Stripe Product — represents the package itself (name, description).
  // One Product per CoachPackage. The Stripe Product id is cached on the
  // CoachPackage row.
  async createProduct(args: {
    name: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeProductObject> {
    const form: Record<string, string> = { name: args.name };
    if (args.description) form.description = args.description;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripeProductObject>('/products', form, args.idempotencyKey);
  }

  // Stripe Price — the dollar amount + interval. Immutable on Stripe:
  // any change to amount/currency/interval mints a new Price. We cache
  // the active Price id on CoachPackage.stripe_price_id; PackagesService
  // clears the cache when price-shaping fields change so checkout mints
  // a fresh Price on the next purchase.
  async createPrice(args: {
    product: string;
    unit_amount: number;
    currency: string;
    // PR-14 — widen interval to include 'week'. CoachPackage already
    // accepts week|month|year per PR-6's pricing config; the Stripe API
    // supports all three. Narrower typing here forced PR-6 weekly
    // packages to be unsellable through any path that calls into this
    // helper.
    recurring?: { interval: 'week' | 'month' | 'year'; interval_count?: number };
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripePriceObject> {
    const form: Record<string, string> = {
      product: args.product,
      unit_amount: String(args.unit_amount),
      currency: args.currency,
    };
    if (args.recurring) {
      form['recurring[interval]'] = args.recurring.interval;
      if (args.recurring.interval_count) {
        form['recurring[interval_count]'] = String(args.recurring.interval_count);
      }
    }
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripePriceObject>('/prices', form, args.idempotencyKey);
  }

  // PR-14 — guest storefront recurring support. Mints a Subscription
  // with `payment_behavior=default_incomplete` so the first invoice's
  // PaymentIntent is created (but unconfirmed) and Stripe returns a
  // client_secret the guest confirms client-side via Stripe Elements.
  // After confirmation the subscription transitions active and the
  // existing `customer.subscription.updated` / `invoice.paid` webhooks
  // claim the ClientPurchase row by stripe_subscription_id — no
  // divergent guest-only subscription claim path.
  //
  // `add_invoice_items` carries the one-time price for one-time+recurring
  // combo packages. Stripe attaches the line to the first invoice so the
  // guest is charged the one-off + the first subscription period in a
  // single PaymentIntent. Skipping `add_invoice_items` (pure recurring)
  // produces a regular first-period charge.
  //
  // Connect destination charges: `transfer_data[destination]` routes
  // every invoice (initial + renewals) to the coach's connected account.
  // `application_fee_percent` is the platform's slice (decimal %,
  // 2dp ceiling per CheckoutService.toStripeApplicationFeePercent).
  //
  // Idempotency-key is REQUIRED — Stripe collapses retries on the same
  // idempotency_key to the same Subscription, so a network-dropped retry
  // never double-mints.
  async createSubscription(args: {
    customer: string;
    recurringPriceId: string;
    // One-time-price added to the first invoice (combo packages). Omit
    // for pure-recurring.
    oneTimePriceId?: string;
    transferDestination: string;
    onBehalfOf: string;
    applicationFeePercent?: number;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionObject & {
    latest_invoice?: {
      id?: string;
      payment_intent?: {
        id?: string;
        client_secret?: string;
        status?: string;
      } | string | null;
    } | null;
  }> {
    const form: Record<string, string> = {
      customer: args.customer,
      'items[0][price]': args.recurringPriceId,
      payment_behavior: 'default_incomplete',
      'transfer_data[destination]': args.transferDestination,
      on_behalf_of: args.onBehalfOf,
      // Expand the first invoice + its PaymentIntent so the caller can
      // pull the client_secret without a follow-up Stripe round trip.
      'expand[0]': 'latest_invoice.payment_intent',
      // 3DS / SCA — let Stripe pick the right confirmation flow on the
      // first invoice's PI just like createPaymentIntent above.
      'payment_settings[save_default_payment_method]': 'on_subscription',
    };
    if (args.oneTimePriceId) {
      form['add_invoice_items[0][price]'] = args.oneTimePriceId;
    }
    if (typeof args.applicationFeePercent === 'number' && args.applicationFeePercent > 0) {
      form.application_fee_percent = String(args.applicationFeePercent);
    }
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post('/subscriptions', form, args.idempotencyKey);
  }

  // Checkout Session — the hosted page the client opens to pay. Two
  // payment shapes (mode=payment | subscription) selected by the package.
  //
  // For Connect destination charges we attach `transfer_data[destination]`
  // (one_time) or `subscription_data[transfer_data][destination]` (recurring)
  // pointing at the coach's connected account. Optional
  // application_fee_amount / application_fee_percent is the platform cut;
  // omitted in Phase 2-3 (platform fee config is a Phase 4 concern).
  async createCheckoutSession(args: {
    mode: 'payment' | 'subscription';
    customer: string;
    priceId: string;
    quantity?: number;
    successUrl: string;
    cancelUrl: string;
    destinationAccount: string;
    // Phase 4: application fee (TGP/platform cut). For one_time we pass
    // it as an absolute cents amount on payment_intent_data; for
    // subscription we pass it as a percent on subscription_data
    // (Stripe restricts subscription application fees to percent on
    // Checkout). Both are mutually exclusive with the OTHER mode.
    applicationFeeAmount?: number; // cents — one_time only
    applicationFeePercent?: number; // percent — subscription only
    clientReferenceId?: string;
    metadata?: Record<string, string>;
    subscriptionMetadata?: Record<string, string>;
    paymentIntentMetadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeCheckoutSessionObject> {
    const form: Record<string, string> = {
      mode: args.mode,
      customer: args.customer,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      'line_items[0][price]': args.priceId,
      'line_items[0][quantity]': String(args.quantity ?? 1),
    };
    if (args.clientReferenceId) {
      form.client_reference_id = args.clientReferenceId;
    }
    if (args.mode === 'payment') {
      form['payment_intent_data[transfer_data][destination]'] =
        args.destinationAccount;
      if (
        typeof args.applicationFeeAmount === 'number' &&
        args.applicationFeeAmount > 0
      ) {
        form['payment_intent_data[application_fee_amount]'] = String(
          args.applicationFeeAmount,
        );
      }
      if (args.paymentIntentMetadata) {
        for (const [k, v] of Object.entries(args.paymentIntentMetadata)) {
          form[`payment_intent_data[metadata][${k}]`] = v;
        }
      }
    } else {
      form['subscription_data[transfer_data][destination]'] =
        args.destinationAccount;
      if (
        typeof args.applicationFeePercent === 'number' &&
        args.applicationFeePercent > 0
      ) {
        form['subscription_data[application_fee_percent]'] = String(
          args.applicationFeePercent,
        );
      }
      if (args.subscriptionMetadata) {
        for (const [k, v] of Object.entries(args.subscriptionMetadata)) {
          form[`subscription_data[metadata][${k}]`] = v;
        }
      }
    }
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    // MoR — automatic tax collection. Stripe detects the customer's
    // jurisdiction and adds the correct VAT/GST/sales tax automatically.
    // Collected tax is remitted by TGP as the Merchant of Record.
    form['automatic_tax[enabled]'] = 'true';

    return this.post<StripeCheckoutSessionObject>(
      '/checkout/sessions',
      form,
      args.idempotencyKey,
    );
  }

  // Phase 7 — Payment Sheet (in-app checkout). Creates a PaymentIntent
  // directly on the platform account with destination charges so the
  // mobile Payment Sheet can complete without a browser redirect.
  //
  // Audit #3 P1-10 — destination-charge PaymentIntents now also carry
  // `on_behalf_of` set to the same connected-account id used for
  // transfer_data[destination]. Without on_behalf_of, Stripe treats
  // the platform account as the merchant of record for risk and
  // statement-descriptor purposes, which is wrong for connected-account
  // commerce (the connected coach is the seller). Setting both fields
  // makes the connected account the merchant of record AND the
  // destination of the funds, matching Stripe's documented destination-
  // charge pattern for marketplaces.
  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    // P2-3 — `customer` is optional on Stripe's PaymentIntent endpoint.
    // Guest checkout has no Customer yet; sending `customer=""` is not the
    // same as omitting the field and can be rejected by Stripe.
    customer?: string;
    applicationFeeAmount: number;
    transferDestination: string;
    // Audit #3 P1-10 — connected-account id Stripe should treat as the
    // merchant of record. Required for destination charges; defaults to
    // transferDestination on the caller side so guest-checkout and the
    // in-app Payment Sheet are forced to provide it explicitly.
    onBehalfOf: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripePaymentIntentObject> {
    const form: Record<string, string> = {
      amount: String(params.amount),
      currency: params.currency,
      application_fee_amount: String(params.applicationFeeAmount),
      'transfer_data[destination]': params.transferDestination,
      on_behalf_of: params.onBehalfOf,
      // r48 #1 — 3DS challenge handling.  automatic_payment_methods lets
      // Stripe pick the right method + handle 3DS via the client-side
      // Stripe Elements flow.  allow_redirects=never keeps the SDK from
      // routing the customer to off-host bank redirects we cannot
      // currently complete from the storefront.  The frontend treats
      // `requires_action` as a normal confirm step.
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
    };
    if (typeof params.customer === 'string' && params.customer.length > 0) {
      form.customer = params.customer;
    }
    for (const [k, v] of Object.entries(params.metadata)) {
      form[`metadata[${k}]`] = v;
    }
    return this.post<StripePaymentIntentObject>(
      '/payment_intents',
      form,
      params.idempotencyKey,
    );
  }

  // Phase 7 — create an EphemeralKey scoped to a customer so the mobile
  // Payment Sheet can read saved payment methods without a full server call.
  // The Stripe-Version header must match the SDK version used on the client.
  //
  // R19: every Stripe mutation carries an Idempotency-Key. The caller must
  // pass a deterministic key derived from the parent PaymentIntent key so
  // retries collapse on Stripe's side instead of minting a fresh key per
  // attempt.
  async createEphemeralKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ secret: string }> {
    if (!idempotencyKey) {
      throw new Error('createEphemeralKey requires an idempotencyKey (R19)');
    }
    const secret = this.requireSecret();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': '2024-09-30.acacia',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    };
    const body = new URLSearchParams({ customer: customerId }).toString();
    const res = await this.fetchImpl(`${STRIPE_API_BASE}/ephemeral_keys`, {
      method: 'POST',
      headers,
      body,
    });
    const parsed = await this.parse<StripeEphemeralKeyObject>(res, '/ephemeral_keys');
    return { secret: parsed.secret };
  }

  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<StripeCheckoutSessionObject> {
    return this.get<StripeCheckoutSessionObject>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  // Phase 4: read the PaymentIntent so we can extract the destination
  // charge id (`latest_charge`) used as source_transaction on follow-on
  // transfers.
  async retrievePaymentIntent(piId: string): Promise<{
    id: string;
    latest_charge?: string | null;
    charges?: { data?: Array<{ id?: string }> };
    [k: string]: unknown;
  }> {
    return this.get(`/payment_intents/${encodeURIComponent(piId)}`);
  }

  async retrieveCharge(chargeId: string): Promise<{
    id: string;
    amount: number;
    amount_refunded?: number;
    refunded?: boolean;
    transfer?: string | null;
    application_fee?: string | null;
    application_fee_amount?: number | null;
    payment_intent?: string | null;
    [k: string]: unknown;
  }> {
    return this.get(`/charges/${encodeURIComponent(chargeId)}`);
  }

  // Phase 4: create a follow-on Transfer from the platform balance to a
  // connected account. We always pass `source_transaction` so the
  // transfer is drawn from the original charge's funds and reconciles
  // 1:1 against the parent payment in Stripe's books.
  //
  // Idempotency-key is REQUIRED — Stripe will collapse retries to the
  // same Transfer object even on a flaky network.
  async createTransfer(args: {
    amount: number; // cents
    currency: string;
    destination: string; // acct_*
    source_transaction?: string; // ch_*
    transfer_group?: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{
    id: string;
    amount: number;
    currency: string;
    destination: string;
    source_transaction?: string | null;
    [k: string]: unknown;
  }> {
    const form: Record<string, string> = {
      amount: String(args.amount),
      currency: args.currency,
      destination: args.destination,
    };
    if (args.source_transaction) {
      form.source_transaction = args.source_transaction;
    }
    if (args.transfer_group) form.transfer_group = args.transfer_group;
    if (args.description) form.description = args.description;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post('/transfers', form, args.idempotencyKey);
  }

  async retrieveTransfer(transferId: string): Promise<{
    id: string;
    amount: number;
    amount_reversed?: number;
    reversed?: boolean;
    destination: string;
    [k: string]: unknown;
  }> {
    return this.get(`/transfers/${encodeURIComponent(transferId)}`);
  }

  async reverseTransfer(args: {
    transfer_id: string;
    amount?: number; // cents; full reversal if omitted
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{
    id: string;
    transfer: string;
    amount: number;
    [k: string]: unknown;
  }> {
    const form: Record<string, string> = {};
    if (typeof args.amount === 'number') form.amount = String(args.amount);
    if (args.description) form.description = args.description;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post(
      `/transfers/${encodeURIComponent(args.transfer_id)}/reversals`,
      form,
      args.idempotencyKey,
    );
  }

  // Phase 5: cancel a subscription (used by the dunning sweeper when
  // grace period elapses).
  async cancelSubscription(subId: string): Promise<{
    id: string;
    status: string;
    [k: string]: unknown;
  }> {
    return this.delete(`/subscriptions/${encodeURIComponent(subId)}`);
  }

  // Create a Stripe Billing Portal session for a customer so they can
  // update their payment method. Used for the dunning flow (M10).
  async createBillingPortalSession(args: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ id: string; url: string; [k: string]: unknown }> {
    return this.post('/billing_portal/sessions', {
      customer: args.customerId,
      return_url: args.returnUrl,
    });
  }

  // --- Phase 6 — Payout readiness, balance, refunds, disputes ---
  //
  // All four read methods use Stripe's `Stripe-Account` header to scope
  // the call to the coach's connected account, so platform credentials
  // never expose data from another coach. Refund creation runs on the
  // platform account (refunding the charge we created on the platform).

  // Stripe Balance object — { available[], pending[], connect_reserved[], ... }.
  // Scoped to the connected account via Stripe-Account header.
  async retrieveBalance(connectedAccountId: string): Promise<{
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
    connect_reserved?: Array<{ amount: number; currency: string }>;
    instant_available?: Array<{ amount: number; currency: string }>;
    [k: string]: unknown;
  }> {
    return this.getOnAccount(`/balance`, connectedAccountId);
  }

  // List payouts on a connected account, newest first. Used for the
  // payout-readiness widget ("last paid out ...").
  async listPayouts(args: {
    connectedAccountId: string;
    limit?: number;
    status?: string; // pending | in_transit | paid | failed | canceled
  }): Promise<{
    data: Array<{
      id: string;
      amount: number;
      currency: string;
      status: string;
      arrival_date?: number;
      failure_message?: string | null;
      automatic?: boolean;
      [k: string]: unknown;
    }>;
    has_more?: boolean;
  }> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(args.limit ?? 10, 100)));
    if (args.status) params.set('status', args.status);
    return this.getOnAccount(
      `/payouts?${params.toString()}`,
      args.connectedAccountId,
    );
  }

  // List balance transactions for a connected account — needed for the
  // Stripe-fee column in the admin payment-ops view (the `fee` field on a
  // balance transaction is the per-charge processing fee, which we don't
  // get directly from the Charge object on Destination charges).
  async listBalanceTransactions(args: {
    connectedAccountId: string;
    limit?: number;
    type?: string; // charge | refund | payout | transfer | adjustment | ...
    payout?: string; // filter to a specific payout id
  }): Promise<{
    data: Array<{
      id: string;
      amount: number;
      net: number;
      fee: number;
      currency: string;
      type: string;
      source?: string;
      created?: number;
      [k: string]: unknown;
    }>;
    has_more?: boolean;
  }> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(args.limit ?? 25, 100)));
    if (args.type) params.set('type', args.type);
    if (args.payout) params.set('payout', args.payout);
    return this.getOnAccount(
      `/balance_transactions?${params.toString()}`,
      args.connectedAccountId,
    );
  }

  // Retrieve a single Refund (used for webhook handlers + admin lookup).
  async retrieveRefund(refundId: string): Promise<{
    id: string;
    amount: number;
    currency: string;
    charge?: string | null;
    payment_intent?: string | null;
    status: string;
    reason?: string | null;
    failure_reason?: string | null;
    [k: string]: unknown;
  }> {
    return this.get(`/refunds/${encodeURIComponent(refundId)}`);
  }

  // Create a refund on the platform charge. We always pass
  // `reverse_transfer=true` so Stripe debits the destination account
  // proportionally; otherwise the seller would keep funds we've refunded
  // to the buyer. `refund_application_fee=true` returns our 2% cut so the
  // platform isn't keeping fees on a refunded charge.
  //
  // Idempotency-key is REQUIRED — collapses retries to the same Refund.
  async createRefund(args: {
    charge_id: string;
    amount?: number; // cents; omit = full
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    reverse_transfer?: boolean;
    refund_application_fee?: boolean;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{
    id: string;
    amount: number;
    currency: string;
    charge?: string | null;
    status: string;
    [k: string]: unknown;
  }> {
    const form: Record<string, string> = { charge: args.charge_id };
    if (typeof args.amount === 'number') form.amount = String(args.amount);
    if (args.reason) form.reason = args.reason;
    if (args.reverse_transfer ?? true) form.reverse_transfer = 'true';
    if (args.refund_application_fee ?? true) form.refund_application_fee = 'true';
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post('/refunds', form, args.idempotencyKey);
  }

  async retrieveDispute(disputeId: string): Promise<{
    id: string;
    amount: number;
    currency: string;
    charge?: string | null;
    status: string;
    reason?: string | null;
    evidence_details?: { due_by?: number; submission_count?: number; has_evidence?: boolean };
    balance_transactions?: Array<{ id: string; amount: number; type: string }>;
    [k: string]: unknown;
  }> {
    return this.get(`/disputes/${encodeURIComponent(disputeId)}`);
  }

  // GET that adds the Stripe-Account header so the request is scoped to a
  // connected account (used for balance, payouts, balance transactions).
  protected async getOnAccount<T>(
    path: string,
    connectedAccountId: string,
  ): Promise<T> {
    const secret = this.requireSecret();
    try {
      const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'GET',
        headers: {
          ...this.commonHeaders(secret),
          'Stripe-Account': connectedAccountId,
        },
      });
      return this.parse<T>(res, path);
    } catch (err) {
      this.handleFetchError(err, path);
    }
  }

  private async delete<T>(path: string): Promise<T> {
    const secret = this.requireSecret();
    try {
      const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'DELETE',
        headers: this.commonHeaders(secret),
      });
      return this.parse<T>(res, path);
    } catch (err) {
      this.handleFetchError(err, path);
    }
  }

  private commonHeaders(secret: string): Record<string, string> {
    return {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const secret = this.requireSecret();
    try {
      const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'GET',
        headers: this.commonHeaders(secret),
      });
      return this.parse<T>(res, path);
    } catch (err) {
      this.handleFetchError(err, path);
    }
  }

  private async post<T>(
    path: string,
    form: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    const secret = this.requireSecret();
    const headers: Record<string, string> = {
      ...this.commonHeaders(secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    try {
      const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams(form).toString(),
      });
      return this.parse<T>(res, path);
    } catch (err) {
      this.handleFetchError(err, path);
    }
  }

  // Map fetch-level AbortError (timeout) to a clean StripeConnectApiError
  // with status 503 so callers can surface a typed 503 instead of a raw
  // DOMException bubbling up through NestJS.
  private handleFetchError(err: unknown, path: string): never {
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError');
    if (isAbort) {
      throw new StripeConnectApiError(
        `Stripe API timed out after ${this.stripeTimeoutMs}ms on ${path}`,
        503,
        'request_timeout',
        'api_connection_error',
      );
    }
    throw err;
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const parsed = await this.safeJson(res);
    if (!res.ok) {
      const errEnvelope =
        parsed && typeof parsed === 'object' && 'error' in (parsed as object)
          ? (parsed as { error: Record<string, unknown> }).error
          : null;
      const message =
        (errEnvelope?.message as string | undefined) ??
        `Stripe API ${res.status} on ${path}`;
      const code = (errEnvelope?.code as string | undefined) ?? null;
      const type = (errEnvelope?.type as string | undefined) ?? null;
      throw new StripeConnectApiError(message, res.status, code, type);
    }
    return parsed as T;
  }

  private async safeJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
