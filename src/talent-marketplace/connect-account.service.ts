/**
 * ConnectAccountService — Phase 11 / Track 8
 *
 * Manages Stripe Connect Express accounts for coaches. Uses the same
 * `fetch`-based approach as the existing StripeApiService (billing module),
 * which deliberately avoids the `stripe` npm SDK to keep the bundle lean and
 * tests hermetic. Outbound calls are isolated here; mocking fetch in tests
 * is the only hermetic pattern needed.
 *
 * Race protection:
 *   - CoachConnectAccount.user_id has a UNIQUE constraint in the database, so
 *     two concurrent createConnectAccount(userId) calls cannot both insert a
 *     row. The loser's INSERT raises P2002, which we catch and resolve to the
 *     winning row.
 *   - createConnectAccount forwards a deterministic `Idempotency-Key`
 *     (`stripe-connect-<userId>`) to Stripe so a duplicate POST never charges
 *     a second account through the upstream API either.
 *
 * Network safety:
 *   - Every outbound fetch is wrapped in an AbortController with a 10s
 *     timeout. A timeout surfaces as ServiceUnavailableException with the
 *     safe code `PAYMENTS_PROVIDER_TIMEOUT`.
 *   - Stripe error responses are logged server-side; the client only ever
 *     sees a generic `PAYMENTS_PROVIDER_ERROR` / `CONNECT_ONBOARDING_UNAVAILABLE`
 *     so env var names and upstream details never leak.
 *
 * Endpoints used:
 *   POST https://api.stripe.com/v1/accounts         — createConnectAccount
 *   POST https://api.stripe.com/v1/account_links    — createOnboardingLink
 *   GET  https://api.stripe.com/v1/accounts/:id     — getAccountStatus
 *
 * Pinned API version: 2024-09-30.acacia (matches billing module's pin).
 */

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-09-30.acacia';
const STRIPE_TIMEOUT_MS = 10_000;

@Injectable()
export class ConnectAccountService {
  private readonly logger = new Logger(ConnectAccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public methods ────────────────────────────────────────────────────────

  /**
   * Create a Stripe Connect Express account for the given user and persist
   * the account ID. Idempotent on multiple axes:
   *   - DB unique constraint on user_id guarantees one row per user.
   *   - Stripe `Idempotency-Key: stripe-connect-<userId>` guarantees Stripe
   *     does not bill two accounts under retry.
   *
   * @returns The Stripe account id.
   */
  async createConnectAccount(userId: string): Promise<string> {
    const existing = await this.prisma.coachConnectAccount.findUnique({
      where: { user_id: userId },
    });
    if (existing) {
      return existing.stripe_account_id;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const stripeAccount = await this.stripePost<{
      id: string;
      country: string;
      default_currency: string;
    }>(
      '/accounts',
      new URLSearchParams({
        type: 'express',
        email: user.email,
        'capabilities[transfers][requested]': 'true',
        'capabilities[card_payments][requested]': 'true',
        'metadata[user_id]': userId,
      }),
      `stripe-connect-${userId}`,
    );

    try {
      await this.prisma.coachConnectAccount.create({
        data: {
          user_id: userId,
          stripe_account_id: stripeAccount.id,
          country: stripeAccount.country ?? 'US',
          default_currency: stripeAccount.default_currency ?? 'usd',
        },
      });
    } catch (err) {
      // Lost a concurrent insert race. Stripe is idempotent on the same key,
      // so the parallel request received the same account id from Stripe and
      // won the DB insert. Return the persisted account id.
      if (this.isUniqueViolation(err)) {
        const winner = await this.prisma.coachConnectAccount.findUnique({
          where: { user_id: userId },
        });
        if (winner) {
          this.logger.warn(
            `Lost CoachConnectAccount insert race for user ${userId}; using existing row`,
          );
          return winner.stripe_account_id;
        }
      }
      throw err;
    }

    this.logger.log(`Created Connect account ${stripeAccount.id} for user ${userId}`);
    return stripeAccount.id;
  }

  /**
   * Generate a Stripe-hosted onboarding URL for the given user. Creates the
   * Connect Express account first if one does not exist.
   *
   * `FRONTEND_URL` env var (already used elsewhere in the app) is used for
   * the return/refresh URLs so the user lands back in the app after completing
   * onboarding.
   *
   * @returns { url: string } — the Stripe-hosted onboarding URL.
   */
  async createOnboardingLink(userId: string): Promise<{ url: string }> {
    const accountId = await this.createConnectAccount(userId);

    const baseUrl =
      process.env['FRONTEND_URL'] ?? 'https://app.thegrowthproject.app';

    const link = await this.stripePost<{ url: string; expires_at: number }>(
      '/account_links',
      new URLSearchParams({
        account: accountId,
        type: 'account_onboarding',
        refresh_url: `${baseUrl}/coach/connect/refresh`,
        return_url: `${baseUrl}/coach/connect/complete`,
      }),
    );

    return { url: link.url };
  }

  /**
   * Return the Connect account status for the user. Returns null if no
   * account has been created yet.
   */
  async getAccountStatus(userId: string): Promise<{
    stripe_account_id: string;
    onboarding_completed: boolean;
    capabilities: unknown;
  } | null> {
    const record = await this.prisma.coachConnectAccount.findUnique({
      where: { user_id: userId },
      select: {
        stripe_account_id: true,
        onboarding_completed: true,
        capabilities: true,
      },
    });

    if (!record) return null;

    // Refresh capabilities from Stripe if onboarding is not yet complete.
    if (!record.onboarding_completed) {
      const stripeAccount = await this.stripeFetch<{
        id: string;
        details_submitted: boolean;
        capabilities: Record<string, string>;
      }>(`/accounts/${record.stripe_account_id}`);

      if (stripeAccount.details_submitted) {
        await this.prisma.coachConnectAccount.update({
          where: { user_id: userId },
          data: {
            onboarding_completed: true,
            capabilities: stripeAccount.capabilities,
          },
        });
        record.onboarding_completed = true;
        (record as { capabilities: unknown }).capabilities = stripeAccount.capabilities;
      }
    }

    return record;
  }

  // ─── Internal: low-level Stripe helpers ───────────────────────────────────

  /**
   * POST to the Stripe API with form-encoded body and an optional idempotency
   * key. Wraps fetch with a 10s AbortController timeout. Error envelopes are
   * normalised: callers only ever see safe Nest exceptions with non-leaking
   * messages; the actual Stripe response is logged on the server side.
   */
  protected async stripePost<T>(
    path: string,
    body: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<T> {
    const key = this.readStripeKey();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await this.fetchWithTimeout(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      await this.logAndThrowStripeError(response, path);
    }

    return response.json() as Promise<T>;
  }

  protected async stripeFetch<T>(path: string): Promise<T> {
    const key = this.readStripeKey();

    const response = await this.fetchWithTimeout(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
    });

    if (!response.ok) {
      await this.logAndThrowStripeError(response, path);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Read the Stripe secret key. Missing config is a server-side incident, not
   * a user-facing error: we log the env var name internally but throw a
   * generic 500 with a safe code so the client never sees `STRIPE_SECRET_KEY`.
   */
  private readStripeKey(): string {
    const key = process.env['STRIPE_SECRET_KEY'];
    if (!key) {
      this.logger.error(
        'STRIPE_SECRET_KEY is not configured — Connect onboarding cannot proceed',
      );
      throw new InternalServerErrorException('CONNECT_ONBOARDING_UNAVAILABLE');
    }
    return key;
  }

  /**
   * fetch wrapper that aborts after STRIPE_TIMEOUT_MS. Translates AbortError
   * into a typed ServiceUnavailableException with a safe client code; the
   * real cause is logged on the server.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (this.isAbortError(err)) {
        this.logger.error(
          `Stripe request timed out after ${STRIPE_TIMEOUT_MS}ms for ${url}`,
        );
        throw new ServiceUnavailableException('PAYMENTS_PROVIDER_TIMEOUT');
      }
      // Network / DNS / TLS failure. Log details and surface a safe code.
      this.logger.error(
        `Stripe request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('PAYMENTS_PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the Stripe error body for server logs and throw a safe exception.
   * Never includes the raw Stripe message in the thrown exception — that
   * message can name the API key, the requested endpoint, or PII supplied to
   * Stripe (email, etc.) and must not reach the client.
   */
  private async logAndThrowStripeError(
    response: Response,
    path: string,
  ): Promise<never> {
    const errorBody = (await response
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    const err = (errorBody['error'] as Record<string, unknown>) ?? {};
    this.logger.error(
      `Stripe ${response.status} on ${path}: code=${String(err['code'] ?? 'unknown')} type=${String(err['type'] ?? 'unknown')} message=${String(err['message'] ?? response.statusText)}`,
    );
    throw new ServiceUnavailableException('PAYMENTS_PROVIDER_ERROR');
  }

  private isAbortError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'AbortError'
    );
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
