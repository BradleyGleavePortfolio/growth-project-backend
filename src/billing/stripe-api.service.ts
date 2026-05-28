import { Injectable, Logger } from '@nestjs/common';

// Thin REST client over `fetch` for the three outbound Stripe calls this
// backend needs (Customer create, Subscription create, BillingPortal session
// create). The Stripe npm SDK is intentionally not a runtime dependency of
// this module — webhook signature verification is hand-rolled in
// stripe-signature.ts and outbound calls follow the same posture, which keeps
// tests hermetic and isolates network mocking to a single `protected
// fetchImpl`.
//
// Pinned `Stripe-Version` matches the value documented in docs/stripe-setup.md
// for the webhook endpoint. Both must move together.
//
// Stripe accepts only `application/x-www-form-urlencoded` for write requests,
// using its bracketed convention for nested fields (`metadata[key]=value`,
// `items[0][price]=price_...`). Idempotency keys are forwarded on writes.
//
// `STRIPE_SECRET_KEY` is read at call time (not at construct time) so tests
// can mutate the env per-case without re-instantiating the service.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-09-30.acacia';

// Audit P0-7 / P1-2: every outbound Stripe call now carries an explicit
// AbortSignal-driven deadline. Default 10s; tunable via STRIPE_API_TIMEOUT_MS
// for staging/load-test runs. Clamped at 1s minimum so a misconfig can't
// effectively disable Stripe.
const STRIPE_API_TIMEOUT_MS_DEFAULT = 10_000;
function resolveStripeApiTimeoutMs(): number {
  const raw = process.env.STRIPE_API_TIMEOUT_MS;
  if (!raw) return STRIPE_API_TIMEOUT_MS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1_000) return STRIPE_API_TIMEOUT_MS_DEFAULT;
  return n;
}
/** Exposed for tests — see test/ai-credits-stripe-timeout.spec.ts. */
export function _resolveStripeApiTimeoutMs(): number {
  return resolveStripeApiTimeoutMs();
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly stripeCode: string | null,
    public readonly stripeType: string | null,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

export interface CreateCustomerArgs {
  email: string;
  name?: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateSubscriptionArgs {
  customer: string;
  priceId: string;
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateBillingPortalSessionArgs {
  customer: string;
  returnUrl: string;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  [k: string]: unknown;
}

export interface StripeSubscription {
  id: string;
  status: string;
  current_period_end?: number;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ price?: { id?: string } }> };
  [k: string]: unknown;
}

export interface StripePortalSession {
  id: string;
  url: string;
  [k: string]: unknown;
}

// Stream 1 — Coach AI Credits. The checkout session minting path uses
// price_data so we don't have to provision N Stripe Prices ahead of
// time (the three locked tiers + open-ended custom would be four
// products * test+live = 8 product rows just to maintain). price_data
// lets us inline the amount/currency and let Stripe mint the implicit
// Product per-session — same approach the per-package storefront uses.
export interface CreateCreditPackCheckoutArgs {
  customer: string;
  amountCents: number;
  productName: string;
  successUrl: string;
  cancelUrl: string;
  /** Stamped on the session for the webhook to read on payment_succeeded. */
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_status?: string;
  amount_total?: number;
  customer?: string | null;
  metadata?: Record<string, string>;
  payment_intent?: string | null;
  invoice?: string | null;
  [k: string]: unknown;
}

@Injectable()
export class StripeApiService {
  private readonly logger = new Logger(StripeApiService.name);

  // Overridable in tests via subclass to avoid monkey-patching globalThis.fetch.
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  /**
   * R2 NEW-P2-2: Single chokepoint for every outbound Stripe call.
   *
   * Wraps `fetchImpl` with the AbortSignal-driven deadline from
   * `resolveStripeApiTimeoutMs()` and translates the abort into a
   * structured `StripeApiError(504, request_timeout, api_connection_error)`
   * so every call site surfaces the same envelope as a Stripe-side
   * failure. Composes any caller-supplied `init.signal` with the timeout
   * signal via `AbortSignal.any` (Node 20+) so a caller that already
   * threads its own request-cancellation signal does not lose either
   * the timeout OR their cancellation.
   *
   * R6 root fix: BEFORE this helper, only `post()` had timeout
   * discipline. `cancelSubscription` (DELETE + cancel-at-period-end
   * POST) and `deleteSubscriptionItem` (DELETE) called `fetchImpl`
   * directly. They now all flow through here, so a hung Stripe call
   * on ANY method cannot tie up a request handler indefinitely.
   *
   * Behaviour preserved: this helper does NOT parse the body, set
   * headers, encode form data, or build the URL — callers retain full
   * control over those. The only change vs raw `fetchImpl` is the
   * timeout signal + the typed timeout error.
   *
   * `path` is the human-readable identifier used in the timeout error
   * message; pass either the full URL or a short label like
   * `/subscriptions/{id}`. Stripe-side error envelopes are NOT
   * affected — those still come from the `Response` body parsed by
   * the caller.
   */
  protected async stripeFetch(
    url: string,
    init: RequestInit,
    pathForError: string,
  ): Promise<Response> {
    const timeoutMs = resolveStripeApiTimeoutMs();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // Compose caller's signal with the timeout signal so both are
    // honoured. `AbortSignal.any` is available since Node 20 — the
    // backend already requires Node 22+ (see Dockerfile / engines).
    const signal: AbortSignal = init.signal
      ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal])
      : timeoutSignal;
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (err) {
      // AbortSignal.timeout() rejects the fetch with a DOMException
      // whose name is 'TimeoutError'; a caller-cancelled abort fires
      // 'AbortError'. We only translate the timeout case — letting a
      // caller-driven abort propagate as-is keeps the contract clean
      // (caller cancellation is not a Stripe failure).
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new StripeApiError(
          `Stripe API request timed out after ${timeoutMs}ms on ${pathForError}`,
          504,
          'request_timeout',
          'api_connection_error',
        );
      }
      // If the caller's own signal aborted (not the timeout signal),
      // surface as 499 client_closed_request to distinguish from the
      // upstream-timeout case. Practical impact: dashboards can
      // separate "Stripe slow" from "client gave up".
      if (
        err instanceof Error &&
        err.name === 'AbortError' &&
        !timeoutSignal.aborted
      ) {
        throw new StripeApiError(
          `Stripe API request aborted by caller on ${pathForError}`,
          499,
          'client_closed_request',
          'api_connection_error',
        );
      }
      // Defensive: a `TimeoutError`-named error that wasn't from our
      // timeout signal (vanishingly rare — e.g. a polyfill in tests
      // emulating the abort path) still maps to a clean envelope so
      // callers never see a raw DOMException.
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StripeApiError(
          `Stripe API request timed out after ${timeoutMs}ms on ${pathForError}`,
          504,
          'request_timeout',
          'api_connection_error',
        );
      }
      throw err;
    }
  }

  isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  async createCustomer(args: CreateCustomerArgs): Promise<StripeCustomer> {
    const form: Record<string, string> = { email: args.email };
    if (args.name) form.name = args.name;
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripeCustomer>('/customers', form, args.idempotencyKey);
  }

  async createSubscription(
    args: CreateSubscriptionArgs,
  ): Promise<StripeSubscription> {
    const form: Record<string, string> = {
      customer: args.customer,
      'items[0][price]': args.priceId,
      // Expand items so the response carries the price id back to the caller
      // without a follow-up read.
      'expand[0]': 'items',
    };
    if (typeof args.trialPeriodDays === 'number') {
      form.trial_period_days = String(args.trialPeriodDays);
    }
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<StripeSubscription>(
      '/subscriptions',
      form,
      args.idempotencyKey,
    );
  }

  /**
   * Stream 1 — mint a Checkout Session for an AI credit pack. Inline
   * price_data avoids provisioning N Stripe Prices for the locked tiers
   * + open-ended custom; the metadata bag carries the coach_user_id and
   * our internal purchase_id so the webhook can resolve back to the
   * CoachCreditPackPurchase row that was already created in 'pending'
   * state by the controller.
   *
   * `mode: 'payment'` (one-time) — recurring packs are a follow-up.
   */
  async createCreditPackCheckoutSession(
    args: CreateCreditPackCheckoutArgs,
  ): Promise<StripeCheckoutSession> {
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new StripeApiError(
        `createCreditPackCheckoutSession: amountCents must be a positive integer, got ${args.amountCents}`,
        400,
        'invalid_amount',
        'invalid_request_error',
      );
    }
    const form: Record<string, string> = {
      customer: args.customer,
      mode: 'payment',
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(args.amountCents),
      'line_items[0][price_data][product_data][name]': args.productName,
      // Audit P0-2: automatic_tax is DISABLED for AI credit-pack sessions.
      // Rationale: credit packs are a B2B carve-out per the mobile spec —
      // a coach pre-purchasing service-credit, not a taxable end-user
      // good in most US jurisdictions. With automatic_tax enabled,
      // Stripe inflates `amount_total` for taxable jurisdictions, which
      // would break the "$25 buys $25 of AI" face-value promise (the
      // operator override's whole point). Leaving the flag explicit on
      // the form keeps the deviation from the rest of the billing
      // surface auditable. If a future legal review requires tax
      // collection on packs, set this back to 'true' AND update
      // CoachAiCreditPackService.handleStripeEvent's amount-divergence
      // path to credit `amount_total` instead of CCPP.paid_cents.
      'automatic_tax[enabled]': 'false',
    };
    for (const [k, v] of Object.entries(args.metadata)) {
      form[`metadata[${k}]`] = v;
      // Also stamp metadata on the resulting PaymentIntent so a refund
      // flow (PaymentIntent-based) still has the linkage.
      form[`payment_intent_data[metadata][${k}]`] = v;
    }
    return this.post<StripeCheckoutSession>(
      '/checkout/sessions',
      form,
      args.idempotencyKey,
    );
  }

  async createBillingPortalSession(
    args: CreateBillingPortalSessionArgs,
  ): Promise<StripePortalSession> {
    const form = {
      customer: args.customer,
      return_url: args.returnUrl,
    };
    // Portal sessions are short-lived and cheap; no idempotency key.
    return this.post<StripePortalSession>('/billing_portal/sessions', form);
  }

  // Team-mode staff seats — Pro tier only (Q1).
  //
  // Stripe metered staff seats are modelled as a separate subscription
  // line item on the head coach's existing subscription. Each seat is
  // its own line item (quantity = 1) so it can be removed independently
  // without unwinding a quantity counter. The returned id is stored on
  // TeamSubCoachAssignment.stripe_subscription_item_id and used by the
  // remove call below.
  //
  // Idempotency keys are mandatory — head coaches retry on flaky
  // network and we must not double-bill.
  async createSubscriptionItem(args: {
    subscription: string;
    priceId: string;
    quantity?: number;
    metadata?: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; [k: string]: unknown }> {
    const form: Record<string, string> = {
      subscription: args.subscription,
      price: args.priceId,
      quantity: String(args.quantity ?? 1),
    };
    if (args.metadata) {
      for (const [k, v] of Object.entries(args.metadata)) {
        form[`metadata[${k}]`] = v;
      }
    }
    return this.post<{ id: string }>('/subscription_items', form, args.idempotencyKey);
  }

  // Cancel a Stripe subscription. Two modes:
  //   - immediately = false (default): set `cancel_at_period_end=true`.
  //     Stripe keeps the subscription active through the current period
  //     and emits `customer.subscription.updated`; the webhook flips
  //     CoachSubscription.cancel_at_period_end. At period end Stripe
  //     emits `customer.subscription.deleted` which the webhook maps to
  //     status=canceled.
  //   - immediately = true: POST DELETE /subscriptions/{id}. Stripe cancels
  //     in-place and emits `customer.subscription.deleted`. Use only for
  //     owner-initiated emergency cancellation (chargeback, fraud) — coach
  //     self-serve always goes through cancel-at-period-end.
  async cancelSubscription(args: {
    subscriptionId: string;
    immediately?: boolean;
    idempotencyKey: string;
  }): Promise<StripeSubscription> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new StripeApiError(
        'Stripe is not configured (STRIPE_SECRET_KEY unset)',
        500,
        'configuration_missing',
        'configuration_error',
      );
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': args.idempotencyKey,
    };
    // R2 NEW-P2-2: route through stripeFetch so the timeout signal +
    // structured 504 envelope apply uniformly. Path label is the
    // Stripe-style /subscriptions/{id} suffix so timeout-error logs
    // are greppable per coach.
    const subscriptionPath = `/subscriptions/${args.subscriptionId}`;
    if (args.immediately) {
      const res = await this.stripeFetch(
        `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
        { method: 'DELETE', headers },
        subscriptionPath,
      );
      return this.parseSubscriptionResponse(res, args.subscriptionId);
    }
    // cancel-at-period-end: POST /subscriptions/{id} with the flag flipped.
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await this.stripeFetch(
      `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({ cancel_at_period_end: 'true' }).toString(),
      },
      subscriptionPath,
    );
    return this.parseSubscriptionResponse(res, args.subscriptionId);
  }

  private async parseSubscriptionResponse(
    res: Response,
    subId: string,
  ): Promise<StripeSubscription> {
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errEnvelope =
        parsed && typeof parsed === 'object' && 'error' in (parsed as object)
          ? (parsed as { error: Record<string, unknown> }).error
          : null;
      const message =
        (errEnvelope?.message as string | undefined) ??
        `Stripe API ${res.status} on /subscriptions/${subId}`;
      const code = (errEnvelope?.code as string | undefined) ?? null;
      const type = (errEnvelope?.type as string | undefined) ?? null;
      throw new StripeApiError(message, res.status, code, type);
    }
    return parsed as StripeSubscription;
  }

  async deleteSubscriptionItem(args: {
    subscriptionItemId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; deleted: boolean; [k: string]: unknown }> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new StripeApiError(
        'Stripe is not configured (STRIPE_SECRET_KEY unset)',
        500,
        'configuration_missing',
        'configuration_error',
      );
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': args.idempotencyKey,
    };
    // R2 NEW-P2-2: route through stripeFetch — see helper docstring.
    const res = await this.stripeFetch(
      `${STRIPE_API_BASE}/subscription_items/${encodeURIComponent(args.subscriptionItemId)}`,
      { method: 'DELETE', headers },
      `/subscription_items/${args.subscriptionItemId}`,
    );
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errEnvelope =
        parsed && typeof parsed === 'object' && 'error' in (parsed as object)
          ? (parsed as { error: Record<string, unknown> }).error
          : null;
      const message =
        (errEnvelope?.message as string | undefined) ??
        `Stripe API ${res.status} on /subscription_items/${args.subscriptionItemId}`;
      const code = (errEnvelope?.code as string | undefined) ?? null;
      const type = (errEnvelope?.type as string | undefined) ?? null;
      throw new StripeApiError(message, res.status, code, type);
    }
    return parsed as { id: string; deleted: boolean };
  }

  private async post<T>(
    path: string,
    form: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new StripeApiError(
        'Stripe is not configured (STRIPE_SECRET_KEY unset)',
        500,
        'configuration_missing',
        'configuration_error',
      );
    }
    const body = new URLSearchParams(form).toString();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    // R2 NEW-P2-2: route through stripeFetch (the shared chokepoint) so
    // the timeout + structured 504 envelope semantics live in one
    // place. Replaces the inline AbortSignal.timeout + try/catch that
    // P1-2 added to this method; behaviour is preserved exactly.
    const res = await this.stripeFetch(
      `${STRIPE_API_BASE}${path}`,
      { method: 'POST', headers, body },
      path,
    );

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

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
      throw new StripeApiError(message, res.status, code, type);
    }

    return parsed as T;
  }
}
