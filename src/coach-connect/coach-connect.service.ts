import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConnectService } from '../connect/connect.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { ConnectModuleState } from '../connect/connect.module-state';
import { PayoutReadinessService } from '../connect/fees/payout-readiness.service';
import { AdminAnalyticsService } from '../checkout/admin-analytics.service';
import { readRequirements, type ParsedRequirements } from '../coach-money/coach-money.service';

// Phase 8 — Coach-facing Connect surface for the mobile app.
//
// Wraps the lower-level ConnectService / StripeConnectApiService and
// presents the four typed shapes the mobile contract expects:
//   - ConnectStatus       — "have I onboarded?"
//   - BusinessMetrics     — 30-day revenue / MRR / churn / sub-coach attribution
//   - Payout[]            — recent payouts via Stripe
//   - CoachPackage[]      — packages with active subscriber count
//   - OnboardingLink      — hosted Stripe onboarding URL
//
// Every method that talks to Stripe surfaces the verbatim Stripe error
// via StripeConnectApiError; the controller maps it to an HTTP status.
// Empty-state outputs (no ConnectAccount, no purchases) return real
// zeros rather than placeholder values — the mobile UI distinguishes
// "not configured" (404 / { configured:false }) from "configured but no
// data yet" (real zeros) by the configured flag on ConnectStatus and
// the empty arrays on Payouts/Packages.

/**
 * S-COACH: the truthful onboarding state the coach sees.
 *  - not_started          no Connect account yet
 *  - details_needed       account exists, the coach has not finished Stripe's form
 *  - pending_verification form submitted, Stripe is verifying, nothing due from the coach
 *  - restricted           Stripe needs more from the coach before charges or payouts work
 *  - active               charges and payouts enabled (requirements may still be due later)
 *  - deauthorized         the coach disconnected TGP from their Stripe account
 */
export type CoachConnectState =
  | 'not_started'
  | 'details_needed'
  | 'pending_verification'
  | 'restricted'
  | 'active'
  | 'deauthorized';

export interface CoachConnectStatus {
  configured: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  account_id: string | null;
  last_onboarded_at: string | null;
  /** Legacy union of currently_due, past_due and eventually_due. */
  requirements_due: string[];
  // S-COACH additive fields (older clients ignore them).
  state: CoachConnectState;
  details_submitted: boolean;
  disabled_reason: string | null;
  /** True when Stripe needs something from the coach now (currently_due or past_due). */
  action_required: boolean;
  requirements: ParsedRequirements;
}

export interface BusinessMetrics {
  revenue_30d: number;
  net_30d: number;
  currency: string;
  active_clients: number;
  clients_added_30d: number;
  clients_churned_30d: number;
  mrr: number;
  sub_coach_revenue_30d: number;
  sub_coach_churn_30d: number;
  sub_coach_acquisition_30d: number;
  total_revenue: number;
  generated_at: string;
}

export interface CoachConnectPayout {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  arrival_date: string;
  created_at: string;
  description: string | null;
}

export interface CoachConnectPackage {
  id: string;
  name: string;
  description: string | null;
  type: 'one_time' | 'recurring';
  price: number;
  currency: string;
  interval: 'month' | 'year' | null;
  active: boolean;
  active_subscribers: number;
}

export interface OnboardingLink {
  url: string;
  expires_at: string;
}

export function deriveConnectState(a: {
  deauthorized: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  actionRequired: boolean;
  disabledReason: string | null;
}): CoachConnectState {
  if (a.deauthorized) return 'deauthorized';
  if (a.chargesEnabled && a.payoutsEnabled) return 'active';
  if (!a.detailsSubmitted) return 'details_needed';
  if (a.actionRequired) return 'restricted';
  if (a.disabledReason && a.disabledReason !== 'requirements.pending_verification') {
    return 'restricted';
  }
  return 'pending_verification';
}

// C-676-2 (B-CM1-116): a failed payout's reason is app copy picked by Stripe's
// failure_code, with the coach's next step (an unknown code shows it as a
// reference). Stripe's description and failure_message are never the reason.
const BANK_DETAILS_WRONG = 'The bank details on file are wrong. Correct them in Stripe.';
const BANK_ACCOUNT_UNUSABLE =
  'This bank account cannot take payouts. Add a different bank account in Stripe.';
const BANK_REFUSED =
  'The bank refused this payout. Contact the bank, then check the account in Stripe.';
// Stripe payout failure codes (docs.stripe.com/api/payouts/failures).
const PAYOUT_FAILURE_COPY: Record<string, string> = {
  incorrect_account_holder_address: BANK_DETAILS_WRONG,
  incorrect_account_holder_name: BANK_DETAILS_WRONG,
  incorrect_account_holder_tax_id: BANK_DETAILS_WRONG,
  incorrect_account_type: BANK_DETAILS_WRONG,
  invalid_account_number: BANK_DETAILS_WRONG,
  invalid_account_number_length: BANK_DETAILS_WRONG,
  no_account: BANK_DETAILS_WRONG,
  account_closed: BANK_ACCOUNT_UNUSABLE,
  account_frozen: BANK_ACCOUNT_UNUSABLE,
  bank_account_restricted: BANK_ACCOUNT_UNUSABLE,
  bank_account_unusable: BANK_ACCOUNT_UNUSABLE,
  bank_ownership_changed: BANK_ACCOUNT_UNUSABLE,
  debit_not_authorized: BANK_ACCOUNT_UNUSABLE,
  invalid_currency: BANK_ACCOUNT_UNUSABLE,
  unsupported_card: BANK_ACCOUNT_UNUSABLE,
  declined: BANK_REFUSED,
  could_not_process: BANK_REFUSED,
  insufficient_funds:
    'The Stripe balance was too low for this payout. Check the balance in Stripe.',
};

/** What the mobile Money page shows under a payout (C-332-14, C-676-2). */
export function payoutReason(
  status: string,
  description: unknown,
  failureCode: unknown,
): string | null {
  if (status !== 'failed') {
    return typeof description === 'string' && description.length > 0 ? description : null;
  }
  const code =
    typeof failureCode === 'string' && /^[a-z_]{1,64}$/.test(failureCode) ? failureCode : null;
  if (code && Object.prototype.hasOwnProperty.call(PAYOUT_FAILURE_COPY, code)) {
    return PAYOUT_FAILURE_COPY[code];
  }
  return `The payout failed. Open Stripe for details.${code ? ` Reference: ${code}.` : ''}`;
}

@Injectable()
export class CoachConnectService {
  private readonly logger = new Logger(CoachConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connect: ConnectService,
    private readonly stripeConnect: StripeConnectApiService,
    private readonly state: ConnectModuleState,
    private readonly payoutReadiness: PayoutReadinessService,
    private readonly analytics: AdminAnalyticsService,
  ) {}

  // GET /coach/connect/status — Stripe Connect onboarding state.
  async getStatus(coachUserId: string): Promise<CoachConnectStatus> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!row) {
      return {
        configured: false,
        charges_enabled: false,
        payouts_enabled: false,
        account_id: null,
        last_onboarded_at: null,
        requirements_due: [],
        state: 'not_started',
        details_submitted: false,
        disabled_reason: null,
        action_required: false,
        requirements: readRequirements(null),
      };
    }
    const requirements = readRequirements(row.requirements_due);
    const chargesEnabled = !!row.charges_enabled && !row.deauthorized_at;
    const payoutsEnabled = !!row.payouts_enabled && !row.deauthorized_at;
    const actionRequired =
      requirements.currently_due.length > 0 || requirements.past_due.length > 0;
    return {
      configured: chargesEnabled && payoutsEnabled,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      account_id: row.stripe_account_id,
      last_onboarded_at: row.updated_at?.toISOString() ?? null,
      requirements_due: this.extractRequirements(row.requirements_due),
      state: deriveConnectState({
        deauthorized: !!row.deauthorized_at,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted: !!row.details_submitted,
        actionRequired,
        disabledReason: row.disabled_reason ?? null,
      }),
      details_submitted: !!row.details_submitted,
      disabled_reason: row.disabled_reason ?? null,
      action_required: actionRequired,
      requirements,
    };
  }

  // POST /coach/connect/status/refresh — re-read the account from Stripe
  // (the webhook can lag the coach's return from hosted onboarding by
  // seconds) and return the fresh status. `refreshed: false` means Stripe
  // could not be reached and the status is the last mirrored copy.
  async refreshStatus(coachUserId: string): Promise<CoachConnectStatus & { refreshed: boolean }> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
      select: { stripe_account_id: true, updated_at: true },
    });
    let refreshed = false;
    if (row && this.stripeConnect.isConfigured()) {
      try {
        // syncFromStripe returns the untouched mirror when Stripe rejects the
        // read, so a moved updated_at is the proof that Stripe answered.
        const synced = await this.connect.syncFromStripe(row.stripe_account_id);
        refreshed = !!synced && synced.updated_at.getTime() !== row.updated_at.getTime();
      } catch (err) {
        // B-676-2: closed code and error class only (provider text is free text).
        const cls = err instanceof StripeConnectApiError ? 'stripe' : 'other';
        this.logger.warn(
          `refreshStatus: sync failed for coach=${coachUserId} code=CONNECT_REFRESH_FAILED class=${cls}`,
        );
      }
    }
    const status = await this.getStatus(coachUserId);
    return { ...status, refreshed };
  }

  // POST /coach/connect/onboarding-link — Stripe-hosted onboarding URL.
  async createOnboardingLink(
    coachUserId: string,
  ): Promise<OnboardingLink> {
    this.assertConnectReady();
    // Reuse the existing service so the row is lazily created if
    // missing (the legacy flow required a separate `/create` call).
    let row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!row) {
      const user = await this.prisma.user.findUnique({
        where: { id: coachUserId },
        select: { email: true },
      });
      const view = await this.connect.createAccountForCoach(coachUserId, {
        email: user?.email ?? undefined,
      });
      row = view;
    }
    const link = await this.connect.createOnboardingLink(coachUserId);
    return {
      url: link.url,
      expires_at: new Date(link.expires_at * 1000).toISOString(),
    };
  }

  // GET /coach/connect/payouts — recent payouts from Stripe.
  async listPayouts(
    coachUserId: string,
    limit = 10,
  ): Promise<CoachConnectPayout[]> {
    const row = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!row) return [];

    if (!this.stripeConnect.isConfigured()) {
      // No Stripe key — return what we know from the cached snapshot
      // instead of throwing. The last payout is mirrored on
      // PayoutSnapshot for exactly this case.
      const snap = await this.prisma.payoutSnapshot.findUnique({
        where: { coach_user_id: coachUserId },
      });
      if (!snap?.last_payout_stripe_id) return [];
      return [
        {
          id: snap.last_payout_stripe_id,
          amount: (snap.last_payout_amount_cents ?? 0) / 100,
          currency: snap.currency,
          status: this.normalizePayoutStatus(snap.last_payout_status),
          arrival_date:
            snap.last_payout_arrival_at?.toISOString() ??
            new Date(0).toISOString(),
          created_at:
            snap.last_payout_arrival_at?.toISOString() ??
            new Date(0).toISOString(),
          // C-676-2: the mirror keeps no failure_code, so no free text either.
          description: payoutReason(
            this.normalizePayoutStatus(snap.last_payout_status),
            null,
            null,
          ),
        },
      ];
    }

    try {
      const resp = await this.stripeConnect.listPayouts({
        connectedAccountId: row.stripe_account_id,
        limit: Math.min(Math.max(1, limit), 50),
      });
      return resp.data.map((p) => ({
        id: p.id,
        amount: typeof p.amount === 'number' ? p.amount / 100 : 0,
        currency: p.currency ?? row.default_currency ?? 'usd',
        status: this.normalizePayoutStatus(p.status),
        arrival_date: p.arrival_date
          ? new Date(p.arrival_date * 1000).toISOString()
          : new Date(0).toISOString(),
        created_at:
          typeof (p as Record<string, unknown>)['created'] === 'number'
            ? new Date(
                ((p as Record<string, unknown>)['created'] as number) * 1000,
              ).toISOString()
            : new Date(0).toISOString(),
        // C-332-14 / C-676-2: the app shows a failed payout's description as
        // its reason, so it carries app copy for Stripe's failure_code.
        description: payoutReason(
          this.normalizePayoutStatus(p.status),
          (p as Record<string, unknown>)['description'],
          p.failure_code,
        ),
      }));
    } catch (err) {
      if (err instanceof StripeConnectApiError) {
        this.logger.warn(
          `listPayouts: Stripe rejected for coach=${coachUserId}: ${err.message}`,
        );
        throw err;
      }
      throw err;
    }
  }

  // GET /coach/connect/packages — packages with active subscriber count.
  async listPackages(
    coachUserId: string,
  ): Promise<CoachConnectPackage[]> {
    const packages = await this.prisma.coachPackage.findMany({
      where: { coach_id: coachUserId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
    if (packages.length === 0) return [];

    // Active subscriber count: ClientPurchase rows with
    // entitlement_active=true. For one-time packages we report 0 per
    // the mobile contract (the field is documented as 0 for one_time).
    const subscribers = await this.prisma.clientPurchase.groupBy({
      by: ['package_id'],
      where: {
        package_id: { in: packages.map((p) => p.id) },
        entitlement_active: true,
        coach_user_id: coachUserId,
        // C01 — $0 grants are reported separately, not as subscribers.
        source: null,
      },
      _count: { _all: true },
    });
    const countByPackage = new Map<string, number>();
    for (const row of subscribers) countByPackage.set(row.package_id, row._count._all);

    return packages.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: p.billing_type === 'recurring' ? 'recurring' : 'one_time',
      price: p.amount_cents / 100,
      currency: p.currency,
      interval:
        p.billing_type === 'recurring'
          ? p.interval === 'year'
            ? 'year'
            : 'month'
          : null,
      active: p.is_active,
      active_subscribers:
        p.billing_type === 'recurring' ? countByPackage.get(p.id) ?? 0 : 0,
    }));
  }

  // GET /coach/connect/metrics — revenue / MRR / churn / sub-coach attribution.
  // Sources every dollar from the ledger via AdminAnalyticsService.
  async getMetrics(coachUserId: string): Promise<BusinessMetrics> {
    const now = new Date();
    const thirtyAgo = new Date(now.getTime() - 30 * 86_400_000);
    const earnings = await this.analytics.getCoachEarnings(coachUserId, {
      from: thirtyAgo,
      to: now,
    });
    const lifetime = await this.analytics.getCoachEarnings(coachUserId, {
      from: new Date(0),
      to: now,
    });

    // Active subscribers (recurring + entitlement_active) -> MRR.
    const activeRecurring = await this.prisma.clientPurchase.findMany({
      where: {
        coach_user_id: coachUserId,
        entitlement_active: true,
        billing_type: 'recurring',
        source: null, // C01 — grants carry $0 and are not MRR
      },
      select: { amount_cents: true, package: { select: { interval: true } } },
    });
    const mrr =
      activeRecurring.reduce((acc, p) => {
        const monthly =
          p.package?.interval === 'year' ? p.amount_cents / 12 : p.amount_cents;
        return acc + monthly;
      }, 0) / 100;

    const activeClients = await this.prisma.user.count({
      where: { coach_id: coachUserId, role: 'student', deleted_at: null },
    });
    const clientsAdded30d = await this.prisma.user.count({
      where: {
        coach_id: coachUserId,
        role: 'student',
        created_at: { gte: thirtyAgo },
      },
    });
    const clientsChurned30d = await this.prisma.clientPurchase.count({
      where: {
        coach_user_id: coachUserId,
        status: 'canceled',
        canceled_at: { gte: thirtyAgo },
        source: null, // C01 — revoked grants are status 'revoked' and excluded anyway
      },
    });

    // Sub-coach attribution. The "as_head_coach" earnings bucket on
    // AdminAnalyticsService is the revenue this coach received as a
    // HEAD coach (5% split from a sub-coach's sale). That is the
    // honest "sub-coach attributed revenue" number.
    const subCoachRevenue30d = earnings.as_head_coach.posted_cents / 100;
    const subCoaches = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: coachUserId, archived_at: null },
      select: { sub_coach_id: true },
    });
    const subCoachIds = subCoaches.map((s) => s.sub_coach_id);

    const subCoachAcquisition30d =
      subCoachIds.length === 0
        ? 0
        : await this.prisma.user.count({
            where: {
              coach_id: { in: subCoachIds },
              role: 'student',
              created_at: { gte: thirtyAgo },
            },
          });
    const subCoachChurn30d =
      subCoachIds.length === 0
        ? 0
        : await this.prisma.clientPurchase.count({
            where: {
              coach_user_id: { in: subCoachIds },
              status: 'canceled',
              canceled_at: { gte: thirtyAgo },
              source: null, // C01
            },
          });

    return {
      revenue_30d: earnings.as_seller.posted_cents / 100,
      net_30d: (earnings.as_seller.posted_cents - earnings.as_seller.refunds_cents) / 100,
      currency: 'usd',
      active_clients: activeClients,
      clients_added_30d: clientsAdded30d,
      clients_churned_30d: clientsChurned30d,
      mrr: Math.round(mrr * 100) / 100,
      sub_coach_revenue_30d: subCoachRevenue30d,
      sub_coach_churn_30d: subCoachChurn30d,
      sub_coach_acquisition_30d: subCoachAcquisition30d,
      total_revenue:
        (lifetime.as_seller.posted_cents + lifetime.as_head_coach.posted_cents) /
        100,
      generated_at: now.toISOString(),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────

  private assertConnectReady(): void {
    if (!this.state.ready) {
      throw new ServiceUnavailableException({
        error: 'CONNECT_NOT_CONFIGURED',
        message:
          this.state.reason ??
          'Stripe Connect is not configured on this environment.',
      });
    }
  }

  private extractRequirements(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const out = new Set<string>();
    for (const k of ['currently_due', 'past_due', 'eventually_due']) {
      const v = r[k];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string') out.add(item);
        }
      }
    }
    return [...out];
  }

  private normalizePayoutStatus(
    raw: string | null | undefined,
  ): CoachConnectPayout['status'] {
    const allowed: CoachConnectPayout['status'][] = [
      'pending',
      'in_transit',
      'paid',
      'failed',
      'canceled',
    ];
    if (raw && (allowed as string[]).includes(raw)) {
      return raw as CoachConnectPayout['status'];
    }
    return 'pending';
  }

  // expose for tests / payout readiness consumers; safe to call when
  // STRIPE_SECRET_KEY is unset.
  async refreshReadiness(coachUserId: string): Promise<void> {
    const account = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
      select: { stripe_account_id: true },
    });
    if (!account) return;
    try {
      await this.payoutReadiness.refresh(coachUserId, account.stripe_account_id);
    } catch (err) {
      this.logger.warn(
        `refreshReadiness failed for coach=${coachUserId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
