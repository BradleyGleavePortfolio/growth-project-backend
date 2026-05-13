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
