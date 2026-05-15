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

export interface CoachConnectStatus {
  configured: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  account_id: string | null;
  last_onboarded_at: string | null;
  requirements_due: string[];
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
      };
    }
    return {
      configured: !!row.charges_enabled && !!row.payouts_enabled,
      charges_enabled: !!row.charges_enabled,
      payouts_enabled: !!row.payouts_enabled,
      account_id: row.stripe_account_id,
      last_onboarded_at: row.updated_at?.toISOString() ?? null,
      requirements_due: this.extractRequirements(row.requirements_due),
    };
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
          description: snap.last_payout_failure_message ?? null,
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
        description:
          (p as Record<string, unknown>)['description']?.toString() ??
          p.failure_message ??
          null,
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
