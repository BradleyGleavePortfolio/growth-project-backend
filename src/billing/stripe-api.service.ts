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

@Injectable()
export class StripeApiService {
  private readonly logger = new Logger(StripeApiService.name);

  // Overridable in tests via subclass to avoid monkey-patching globalThis.fetch.
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

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

  // r50 Dunning v1 — POST /v1/invoices/:id/pay
  //
  // Triggers Stripe to attempt collection on an open invoice using the
  // customer's default payment method. We pass an Idempotency-Key so
  // a duplicate worker tick (e.g. Fly redeploy mid-tick) collapses to
  // the same Stripe attempt rather than producing a second charge.
  //
  // The returned shape carries the post-attempt invoice status:
  //   'paid' / 'uncollectible' / 'open' / 'void'
  // The worker treats 'paid' as success and anything else as failure for
  // the purposes of advancing the DunningCase state.
  async payInvoice(args: {
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status?: string; paid?: boolean; [k: string]: unknown }> {
    return this.post(
      `/invoices/${encodeURIComponent(args.invoiceId)}/pay`,
      {},
      args.idempotencyKey,
    );
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
    if (args.immediately) {
      const res = await this.fetchImpl(
        `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
        { method: 'DELETE', headers },
      );
      return this.parseSubscriptionResponse(res, args.subscriptionId);
    }
    // cancel-at-period-end: POST /subscriptions/{id} with the flag flipped.
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await this.fetchImpl(
      `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({ cancel_at_period_end: 'true' }).toString(),
      },
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
    const res = await this.fetchImpl(
      `${STRIPE_API_BASE}/subscription_items/${encodeURIComponent(args.subscriptionItemId)}`,
      { method: 'DELETE', headers },
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

    const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body,
    });

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
