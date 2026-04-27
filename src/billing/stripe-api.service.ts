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
