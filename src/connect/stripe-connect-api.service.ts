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

  // Overridable in tests via subclass to avoid monkey-patching globalThis.fetch.
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

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
  }): Promise<StripeAccountLink> {
    const form: Record<string, string> = {
      account: args.account,
      refresh_url: args.refreshUrl,
      return_url: args.returnUrl,
      type: 'account_onboarding',
    };
    return this.post<StripeAccountLink>('/account_links', form);
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
    recurring?: { interval: 'month' | 'year'; interval_count?: number };
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
    applicationFeePercent?: number;
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
      if (args.applicationFeePercent) {
        // Stripe charges a percentage as an amount per session; for one_time
        // we compute it later in cents. Phase 2-3 omits it.
      }
      if (args.paymentIntentMetadata) {
        for (const [k, v] of Object.entries(args.paymentIntentMetadata)) {
          form[`payment_intent_data[metadata][${k}]`] = v;
        }
      }
    } else {
      form['subscription_data[transfer_data][destination]'] =
        args.destinationAccount;
      if (args.applicationFeePercent) {
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
    return this.post<StripeCheckoutSessionObject>(
      '/checkout/sessions',
      form,
      args.idempotencyKey,
    );
  }

  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<StripeCheckoutSessionObject> {
    return this.get<StripeCheckoutSessionObject>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  private commonHeaders(secret: string): Record<string, string> {
    return {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const secret = this.requireSecret();
    const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: this.commonHeaders(secret),
    });
    return this.parse<T>(res, path);
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
    const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
    });
    return this.parse<T>(res, path);
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
