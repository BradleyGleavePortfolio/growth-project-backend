/**
 * ConnectAccountService — Phase 11 / Track 8
 *
 * Manages Stripe Connect Express accounts for coaches. Uses the same
 * `fetch`-based approach as the existing StripeApiService (billing module),
 * which deliberately avoids the `stripe` npm SDK to keep the bundle lean and
 * tests hermetic. Outbound calls are isolated here; mocking fetch in tests
 * is the only hermetic pattern needed.
 *
 * API key: `STRIPE_SECRET_KEY` (same key already used by the billing module).
 * Connect Client ID: `STRIPE_CONNECT_CLIENT_ID` (new — must be provisioned in
 *   Fly.io secrets and documented in env_example_phase11.md).
 *
 * Endpoints used:
 *   POST https://api.stripe.com/v1/accounts         — createConnectAccount
 *   POST https://api.stripe.com/v1/account_links    — createOnboardingLink
 *   GET  https://api.stripe.com/v1/accounts/:id     — getAccountStatus
 *
 * Pinned API version: 2024-09-30.acacia (matches billing module's pin).
 *
 * Webhook integration (FOLLOW-UP):
 *   When `account.updated` fires with details_submitted=true, set
 *   CoachConnectAccount.onboarding_completed = true and mirror capabilities.
 *   The webhook handler should live in billing/stripe-webhook.controller.ts or
 *   a new talent-marketplace webhook handler, depending on signature-verification
 *   strategy. Documented here for the Track 8.5 implementer.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-09-30.acacia';

@Injectable()
export class ConnectAccountService {
  private readonly logger = new Logger(ConnectAccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Public methods ────────────────────────────────────────────────────────

  /**
   * Create a Stripe Connect Express account for the given user and persist
   * the account ID. Idempotent: if the user already has a Connect account,
   * returns the existing record without creating a new Stripe account.
   *
   * @returns The CoachConnectAccount row (with stripe_account_id populated).
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

    const stripeAccount = await this.stripePost<{ id: string; country: string; default_currency: string }>(
      '/accounts',
      new URLSearchParams({
        type: 'express',
        'email': user.email,
        'capabilities[transfers][requested]': 'true',
        'capabilities[card_payments][requested]': 'true',
        [`metadata[user_id]`]: userId,
      }),
    );

    await this.prisma.coachConnectAccount.create({
      data: {
        user_id: userId,
        stripe_account_id: stripeAccount.id,
        country: stripeAccount.country ?? 'US',
        default_currency: stripeAccount.default_currency ?? 'usd',
      },
    });

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
   * POST to the Stripe API with form-encoded body.
   * Identical posture to StripeApiService in the billing module.
   */
  protected async stripePost<T>(
    path: string,
    body: URLSearchParams,
  ): Promise<T> {
    const key = process.env['STRIPE_SECRET_KEY'];
    if (!key) {
      throw new BadRequestException(
        'STRIPE_SECRET_KEY is not configured — Connect onboarding is unavailable.',
      );
    }

    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const err = (errorBody['error'] as Record<string, unknown>) ?? {};
      throw new BadRequestException(
        `Stripe error: ${String(err['message'] ?? response.statusText)}`,
      );
    }

    return response.json() as Promise<T>;
  }

  protected async stripeFetch<T>(path: string): Promise<T> {
    const key = process.env['STRIPE_SECRET_KEY'];
    if (!key) {
      throw new BadRequestException('STRIPE_SECRET_KEY is not configured.');
    }

    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const err = (errorBody['error'] as Record<string, unknown>) ?? {};
      throw new BadRequestException(
        `Stripe error: ${String(err['message'] ?? response.statusText)}`,
      );
    }

    return response.json() as Promise<T>;
  }
}
