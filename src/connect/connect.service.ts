import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConnectAccount } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from './stripe-connect-api.service';

// ConnectService is the system of record for ConnectAccount rows.
//
// Real-or-flagged contract: every method that talks to Stripe will either
// (a) return a real Stripe response and persist the mirror, or (b) throw a
// StripeConnectApiError surfacing the upstream error verbatim. There is no
// "fake success" path.

export interface ConnectAccountView extends ConnectAccount {
  is_fully_onboarded: boolean;
}

// B-CONNECT-126: at most one not-ready re-read per Stripe account per minute
// in this process, so a client tapping Buy again and again cannot fan out
// Stripe calls. Each re-read is itself bounded by the Stripe client timeout.
export const CONNECT_NOT_READY_SYNC_COOLDOWN_MS = 60_000;

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);

  constructor(
    private prisma: PrismaService,
    private stripeConnect: StripeConnectApiService,
  ) {}

  // Create (or return existing) Express account for a coach. Idempotent:
  // a second call with the same coach returns the row created by the first.
  async createAccountForCoach(
    coachUserId: string,
    opts: { country?: string; email?: string } = {},
  ): Promise<ConnectAccountView> {
    const existing = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (existing) return this.withDerived(existing);

    // Resolve coach email if not supplied — Stripe Express uses it as the
    // pre-fill on the onboarding webview.
    let email = opts.email;
    if (!email) {
      const user = await this.prisma.user.findUnique({
        where: { id: coachUserId },
        select: { email: true },
      });
      email = user?.email ?? undefined;
    }

    const stripeAccount = await this.stripeConnect.createExpressAccount({
      country: opts.country ?? 'US',
      email,
      metadata: { tgp_coach_user_id: coachUserId },
      // Idempotency: one Stripe Express account per coach. Replays at the
      // Stripe edge collapse onto the same account row.
      idempotencyKey: `connect-account-${coachUserId}`,
    });

    const row = await this.prisma.connectAccount.create({
      data: {
        coach_user_id: coachUserId,
        stripe_account_id: stripeAccount.id,
        country: stripeAccount.country ?? opts.country ?? 'US',
        default_currency: stripeAccount.default_currency ?? 'usd',
        charges_enabled: !!stripeAccount.charges_enabled,
        payouts_enabled: !!stripeAccount.payouts_enabled,
        details_submitted: !!stripeAccount.details_submitted,
        requirements_due:
          (stripeAccount.requirements as object | null | undefined) ?? undefined,
        disabled_reason: this.extractDisabledReason(stripeAccount),
      },
    });
    return this.withDerived(row);
  }

  // Mint a one-time hosted onboarding link. Caller (mobile app) opens it.
  async createOnboardingLink(
    coachUserId: string,
  ): Promise<{ url: string; expires_at: number }> {
    const row = await this.requireRow(coachUserId);
    const refreshUrl = this.requireUrlEnv(
      'STRIPE_CONNECT_REFRESH_URL',
      process.env.STRIPE_CONNECT_REFRESH_URL,
    );
    const returnUrl = this.requireUrlEnv(
      'STRIPE_CONNECT_RETURN_URL',
      process.env.STRIPE_CONNECT_RETURN_URL,
    );
    // Idempotency key bucketed per coach + connected account + 5-minute window
    // so retried RPC calls (mobile flaky network) reuse the same Stripe row.
    // Stripe account_links expire in ~5 min so a fresh bucket every 5 min keeps
    // the user out of the "expired link" trap when they retry after a delay.
    const fiveMinBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `account_link:${coachUserId}:${row.stripe_account_id}:${fiveMinBucket}`;
    const link = await this.stripeConnect.createAccountLink({
      account: row.stripe_account_id,
      refreshUrl,
      returnUrl,
      idempotencyKey,
    });
    return { url: link.url, expires_at: link.expires_at };
  }

  // Mint an Express Dashboard login link. Stripe rejects this until the
  // account has `charges_enabled: true`, so we pre-check and throw a clean
  // 409 instead of bubbling Stripe's 400.
  async createDashboardLoginLink(
    coachUserId: string,
  ): Promise<{ url: string }> {
    const row = await this.requireRow(coachUserId);
    if (!row.charges_enabled) {
      throw new ConflictException({
        error: 'CONNECT_ONBOARDING_INCOMPLETE',
        message:
          'Stripe Express Dashboard is not available until onboarding is complete (charges_enabled=true). Finish the onboarding link first.',
      });
    }
    const link = await this.stripeConnect.createLoginLink(row.stripe_account_id);
    return { url: link.url };
  }

  // GET /v1/connect/accounts/me (Settings > Payouts). While the saved status
  // is not ready, re-read the account from Stripe through syncFromStripe,
  // the same write the account.updated webhook makes, so the coach's screen
  // and the checkout payout gate agree even if that webhook never arrives
  // (B-COND-1). A failed Stripe read keeps the saved status.
  async getStatusForCoach(
    coachUserId: string,
  ): Promise<ConnectAccountView | null> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!row) return null;
    const saved = this.withDerived(row);
    if (saved.is_fully_onboarded || row.deauthorized_at) return saved;
    try {
      const synced = await this.syncFromStripe(row.stripe_account_id);
      return synced ? this.withDerived(synced) : saved;
    } catch (err) {
      const cls = err instanceof StripeConnectApiError ? 'stripe' : 'other';
      this.logger.warn(
        `getStatusForCoach: sync failed for coach=${coachUserId} code=CONNECT_STATUS_SYNC_FAILED class=${cls}`,
      );
      return saved;
    }
  }

  // B-CONNECT-126: the in-app Buy gates and GET /coach/connect/status read
  // the saved row, and account.updated for a coach's Express account does not
  // reach the platform webhook. Callers pass a row they found NOT ready; this
  // re-reads it from Stripe through syncFromStripe (the same write as the
  // webhook) and returns the fresh row. Inside the cooldown, for a
  // deauthorized row, or on any failure it returns the saved row unchanged,
  // so the caller gives today's answer and never an exception.
  private readonly notReadySyncAt = new Map<string, number>();

  async refreshNotReady(row: ConnectAccount): Promise<ConnectAccount> {
    if (row.deauthorized_at) return row;
    const now = Date.now();
    const last = this.notReadySyncAt.get(row.stripe_account_id);
    if (last !== undefined && now - last < CONNECT_NOT_READY_SYNC_COOLDOWN_MS) return row;
    this.notReadySyncAt.set(row.stripe_account_id, now);
    try {
      return (await this.syncFromStripe(row.stripe_account_id)) ?? row;
    } catch (err) {
      const cls = err instanceof StripeConnectApiError ? 'stripe' : 'other';
      this.logger.warn(
        `refreshNotReady: sync failed for coach=${row.coach_user_id} code=CONNECT_NOT_READY_SYNC_FAILED class=${cls}`,
      );
      return row;
    }
  }

  // Webhook side. Re-read from Stripe (single source of truth) and update
  // the mirror. Safe to call on every account.* event.
  async syncFromStripe(stripeAccountId: string): Promise<ConnectAccount | null> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { stripe_account_id: stripeAccountId },
    });
    if (!row) {
      this.logger.warn(
        `syncFromStripe: no ConnectAccount mirror for ${stripeAccountId} — ignoring webhook`,
      );
      return null;
    }
    let stripeAccount;
    try {
      stripeAccount = await this.stripeConnect.retrieveAccount(stripeAccountId);
    } catch (err) {
      if (err instanceof StripeConnectApiError) {
        this.logger.warn(
          `syncFromStripe: Stripe rejected retrieve(${stripeAccountId}) code=CONNECT_ACCOUNT_RETRIEVE_FAILED status=${Number(err.httpStatus) || 0}`,
        );
        return row;
      }
      throw err;
    }
    return this.prisma.connectAccount.update({
      where: { stripe_account_id: stripeAccountId },
      data: {
        country: stripeAccount.country ?? row.country,
        default_currency: stripeAccount.default_currency ?? row.default_currency,
        charges_enabled: !!stripeAccount.charges_enabled,
        payouts_enabled: !!stripeAccount.payouts_enabled,
        details_submitted: !!stripeAccount.details_submitted,
        requirements_due:
          (stripeAccount.requirements as object | null | undefined) ?? undefined,
        disabled_reason: this.extractDisabledReason(stripeAccount),
      },
    });
  }

  // Called on account.application.deauthorized. The row stays but is marked
  // deauthorized; the coach must reconnect (a new create call wipes the
  // timestamp via createAccountForCoach upgrade flow, but for v1 the owner
  // intervenes manually).
  async markDeauthorized(stripeAccountId: string): Promise<void> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { stripe_account_id: stripeAccountId },
    });
    if (!row) {
      this.logger.warn(
        `markDeauthorized: no ConnectAccount mirror for ${stripeAccountId}`,
      );
      return;
    }
    await this.prisma.connectAccount.update({
      where: { stripe_account_id: stripeAccountId },
      data: {
        deauthorized_at: new Date(),
        charges_enabled: false,
        payouts_enabled: false,
      },
    });
  }

  private async requireRow(coachUserId: string): Promise<ConnectAccount> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!row) {
      throw new NotFoundException({
        error: 'CONNECT_ACCOUNT_NOT_FOUND',
        message:
          'No Stripe Connect account for this coach yet. Call POST /v1/connect/accounts/create first.',
      });
    }
    return row;
  }

  private requireUrlEnv(name: string, value: string | undefined): string {
    const v = (value ?? '').trim();
    if (!v) {
      throw new StripeConnectApiError(
        `${name} is unset — Stripe Connect onboarding links cannot be issued. Set it in env (mobile deep link or HTTPS URL).`,
        503,
        'configuration_missing',
        'configuration_error',
      );
    }
    return v;
  }

  private extractDisabledReason(
    account: { requirements?: Record<string, unknown> | null },
  ): string | null {
    const req = account.requirements;
    if (!req || typeof req !== 'object') return null;
    const r = (req as Record<string, unknown>)['disabled_reason'];
    return typeof r === 'string' ? r : null;
  }

  private withDerived(row: ConnectAccount): ConnectAccountView {
    return {
      ...row,
      is_fully_onboarded:
        !!row.charges_enabled &&
        !!row.payouts_enabled &&
        !!row.details_submitted &&
        !row.deauthorized_at,
    };
  }
}
