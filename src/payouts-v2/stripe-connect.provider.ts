import { Injectable, Logger } from '@nestjs/common';

/**
 * StripeConnect provider abstraction (spec §2.1 / §2.4) — the money-movement
 * surface the Bank-Account Payouts v2 module depends on.
 *
 * OPERATOR-LOCKED DECISION (A): this is injected into the payout services via
 * standard NestJS CONSTRUCTOR INJECTION (keyed by the `STRIPE_CONNECT` token
 * below). NO service locator, NO global registry. Tests inject a fake
 * implementing `StripeConnect` cleanly through the constructor.
 *
 * Phase A wires the Financial Connections + external_account surface needed by
 * §2.4 (link a bank) and §2.5 (routing bookkeeping). Stripe is the
 * merchant-of-record and 1099-K filer in every case (spec §5); the backend
 * never moves money itself.
 */

/** A Stripe Financial Connections session (Stripe-hosted bank-link widget). */
export interface FcSession {
  /** `fcsess_...` */
  id: string;
  /** Client secret the mobile app hands to the Stripe FC widget. */
  client_secret: string;
}

/** A bank `external_account` created on a coach's Connect Custom account. */
export interface ExternalBankAccount {
  /** `ba_...` (bank account) or `fca_...` (financial connections account). */
  id: string;
  last4: string | null;
  bank_name: string | null;
  /** Stripe verification status: 'new' | 'validated' | 'verified' | 'errored'. */
  status: string | null;
}

/**
 * The narrow Stripe Connect contract the payout module needs. Implemented for
 * real by `DefaultStripeConnect` (REST against Stripe); faked in unit tests.
 */
export interface StripeConnect {
  /**
   * Create a Stripe Financial Connections session for the coach's Connect
   * Custom account and return the client secret the FC widget consumes.
   */
  createFinancialConnectionsSession(args: {
    connectedAccountId: string;
  }): Promise<FcSession>;

  /**
   * Exchange a completed Financial Connections session for a bank token and
   * create an `external_account` on the coach's Connect Custom account.
   */
  createExternalAccountFromFcSession(args: {
    connectedAccountId: string;
    fcSessionId: string;
  }): Promise<ExternalBankAccount>;
}

/** DI token for the StripeConnect provider (constructor injection only). */
export const STRIPE_CONNECT = 'STRIPE_CONNECT';

/**
 * Default real implementation. Mirrors the hand-rolled, SDK-free posture of
 * `src/connect/stripe-connect-api.service.ts` (no Stripe SDK; `STRIPE_SECRET_KEY`
 * read at call time; `protected fetchImpl` for hermetic tests). It is inert in
 * practice until `FEATURE_BANK_PAYOUTS_V2` is flipped on — the services that
 * call it short-circuit while the flag is off — so it never fires in v1.
 *
 * Phase A intentionally keeps the live REST bodies minimal: the FC widget and
 * external_account creation are exercised through the injected fake in tests,
 * and the real calls are only reachable behind the (default-OFF) flag. The
 * exact Financial Connections request shape is confirmed against the live
 * Stripe API at flag-flip time (spec §9).
 */
@Injectable()
export class DefaultStripeConnect implements StripeConnect {
  private readonly logger = new Logger(DefaultStripeConnect.name);
  private static readonly STRIPE_API_BASE = 'https://api.stripe.com/v1';
  private static readonly STRIPE_API_VERSION = '2024-09-30.acacia';

  // Overridable in tests; defaults to global fetch.
  protected fetchImpl: typeof fetch = (input: any, init?: any) =>
    (globalThis.fetch as typeof fetch)(input, init);

  private requireSecret(): string {
    const secret = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secret) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    return secret;
  }

  private headers(secret: string): Record<string, string> {
    return {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': DefaultStripeConnect.STRIPE_API_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  async createFinancialConnectionsSession(args: {
    connectedAccountId: string;
  }): Promise<FcSession> {
    const secret = this.requireSecret();
    const res = await this.fetchImpl(
      `${DefaultStripeConnect.STRIPE_API_BASE}/financial_connections/sessions`,
      {
        method: 'POST',
        headers: {
          ...this.headers(secret),
          'Stripe-Account': args.connectedAccountId,
        },
        body: new URLSearchParams({
          'permissions[]': 'payment_method',
          'account_holder[type]': 'account',
        }).toString(),
      },
    );
    const json = (await res.json()) as {
      id?: string;
      client_secret?: string;
    };
    if (!res.ok || !json?.id || !json?.client_secret) {
      throw new Error(
        `Stripe FC session create failed (status ${res.status})`,
      );
    }
    return { id: json.id, client_secret: json.client_secret };
  }

  async createExternalAccountFromFcSession(args: {
    connectedAccountId: string;
    fcSessionId: string;
  }): Promise<ExternalBankAccount> {
    const secret = this.requireSecret();
    const res = await this.fetchImpl(
      `${DefaultStripeConnect.STRIPE_API_BASE}/accounts/${args.connectedAccountId}/external_accounts`,
      {
        method: 'POST',
        headers: this.headers(secret),
        body: new URLSearchParams({
          external_account: args.fcSessionId,
        }).toString(),
      },
    );
    const json = (await res.json()) as {
      id?: string;
      last4?: string | null;
      bank_name?: string | null;
      status?: string | null;
    };
    if (!res.ok || !json?.id) {
      throw new Error(
        `Stripe external_account create failed (status ${res.status})`,
      );
    }
    return {
      id: json.id,
      last4: json.last4 ?? null,
      bank_name: json.bank_name ?? null,
      status: json.status ?? null,
    };
  }
}
