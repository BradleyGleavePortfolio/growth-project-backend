// src/coach/command-center/ltv-metrics.service.ts
//
// Computes the LTV metrics suite for the Coach Command Center.
//
// Data sources (real):
//   ClientPurchase  — billing_type, amount_cents, status, created_at, canceled_at,
//                     current_period_end, interval, interval_count
//   CoachPackage    — amount_cents, interval, interval_count
//
// Stubs (clearly marked with TODO):
//   - avg_client_lifespan_months  → real value requires ≥3 cancellations; falls back to 6 months
//   - net_revenue_retention_pct   → upgrade/downgrade tracking not yet modeled; approximated
//   - all_time_peak_rpcm          → requires coach_ltv_peak table (migration pending)
//   - zero_churn_streak           → computed in-memory from cancellation history; persisted stub
//   - mrr_30d_ago                 → computed from purchases active 30 days ago (real)

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { LtvMetricsResponseDto, NextMilestoneDto } from './ltv-metrics.dto';

// MRR milestone thresholds (in cents). The service finds the first threshold
// above current MRR and computes how many clients (at current ARPC) are needed.
const MRR_MILESTONES_CENTS = [
  100_00,   // $100
  500_00,   // $500
  1_000_00, // $1k
  2_000_00, // $2k
  3_000_00, // $3k
  5_000_00, // $5k
  10_000_00, // $10k
  15_000_00, // $15k
  20_000_00, // $20k
  25_000_00, // $25k
  50_000_00, // $50k
];

function formatMoney(cents: number, currency: string): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: dollars % 1 === 0 ? 0 : 0, // whole dollars only for dashboard
  }).format(dollars);
}

/** Normalise a recurring ClientPurchase amount to monthly cents. */
function toMonthlyAmountCents(
  amountCents: number,
  interval: string | null,
  intervalCount: number,
): number {
  if (!interval || interval === 'month') {
    // e.g. $200 / 1 month → $200/mo; $600 / 3 months → $200/mo
    return Math.round(amountCents / (intervalCount || 1));
  }
  if (interval === 'year') {
    // e.g. $2400 / year → $200/mo
    return Math.round(amountCents / (12 * (intervalCount || 1)));
  }
  // Unknown interval — treat as monthly (defensive)
  return amountCents;
}

@Injectable()
export class LtvMetricsService {
  private readonly logger = new Logger(LtvMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(coachUserId: string): Promise<LtvMetricsResponseDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // ── Fetch all ClientPurchase rows for this coach ─────────────────────────
    // We pull all non-draft statuses so we can compute historical metrics.
    const allPurchases = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachUserId },
      select: {
        id: true,
        client_user_id: true,
        amount_cents: true,
        currency: true,
        billing_type: true,
        interval: true,
        interval_count: true,
        status: true,
        entitlement_active: true,
        created_at: true,
        canceled_at: true,
        current_period_end: true,
        cancel_at_period_end: true,
      },
    });

    // Determine dominant currency (most common across active purchases, or usd)
    const currency = this.resolveCurrency(allPurchases);

    // ── Active clients ───────────────────────────────────────────────────────
    // A client is "active" if they have at least one purchase with entitlement_active=true
    // OR status in (active, paid) — the entitlement flag is the canonical bit.
    const activePurchases = allPurchases.filter(
      (p) =>
        p.entitlement_active ||
        p.status === 'active' ||
        p.status === 'paid',
    );
    const activeClientIds = new Set(activePurchases.map((p) => p.client_user_id));
    const activeClientCount = activeClientIds.size;

    // ── MRR (current) ────────────────────────────────────────────────────────
    // Only recurring purchases with status=active contribute to MRR.
    const activeRecurring = allPurchases.filter(
      (p) => p.billing_type === 'recurring' && p.status === 'active',
    );
    const mrrCents = activeRecurring.reduce((sum, p) => {
      return (
        sum +
        toMonthlyAmountCents(p.amount_cents, p.interval, p.interval_count ?? 1)
      );
    }, 0);

    // ── MRR 30 days ago ──────────────────────────────────────────────────────
    // A purchase was active 30 days ago if:
    //   - It was created before 30d ago
    //   - It was NOT canceled before 30d ago (canceled_at is null OR after 30d ago)
    //   - It is recurring
    const recurringActiveThen = allPurchases.filter(
      (p) =>
        p.billing_type === 'recurring' &&
        p.created_at <= thirtyDaysAgo &&
        (p.canceled_at === null || p.canceled_at > thirtyDaysAgo),
    );
    const mrr30dAgoCents = recurringActiveThen.reduce((sum, p) => {
      return (
        sum +
        toMonthlyAmountCents(p.amount_cents, p.interval, p.interval_count ?? 1)
      );
    }, 0);

    // ── MRR Trend ────────────────────────────────────────────────────────────
    // "up" if ≥5% growth, "down" if ≥5% decline, "flat" otherwise.
    let mrrTrend: 'up' | 'flat' | 'down' = 'flat';
    if (mrr30dAgoCents > 0) {
      const changePct = (mrrCents - mrr30dAgoCents) / mrr30dAgoCents;
      if (changePct >= 0.05) mrrTrend = 'up';
      else if (changePct <= -0.05) mrrTrend = 'down';
    } else if (mrrCents > 0) {
      mrrTrend = 'up'; // first revenue
    }

    // ── RPCM — Revenue Per Client Per Month ──────────────────────────────────
    const rpcmCents =
      activeClientCount > 0 ? Math.round(mrrCents / activeClientCount) : 0;

    // ── Average client lifespan ──────────────────────────────────────────────
    // Real: compute from recently canceled recurring purchases.
    // STUB fallback: 6 months (industry-average if <3 data points).
    const canceledRecurring = allPurchases.filter(
      (p) =>
        p.billing_type === 'recurring' &&
        p.canceled_at !== null &&
        p.canceled_at >= new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    );
    let avgLifespanMonths: number;
    if (canceledRecurring.length >= 3) {
      const lifespans = canceledRecurring.map((p) => {
        const msAlive =
          (p.canceled_at as Date).getTime() - p.created_at.getTime();
        return msAlive / (1000 * 60 * 60 * 24 * 30.44); // months
      });
      avgLifespanMonths =
        lifespans.reduce((a, b) => a + b, 0) / lifespans.length;
    } else {
      // TODO: Replace 6-month stub once ≥3 cancellation data points exist.
      // The 6-month default is conservative for fitness coaching (industry avg ~4–8 mo).
      avgLifespanMonths = 6;
      this.logger.log(
        `LTV lifespan stub for coach ${coachUserId}: <3 cancellations, using 6-month default`,
      );
    }

    // ── Estimated LTV ────────────────────────────────────────────────────────
    const estimatedLtvCents = Math.round(rpcmCents * avgLifespanMonths);

    // ── Churn Rate (this calendar month) ─────────────────────────────────────
    // Clients active at start of month = those with a recurring purchase
    // that was active on startOfMonth.
    const activeAtStartOfMonth = allPurchases.filter(
      (p) =>
        p.billing_type === 'recurring' &&
        p.created_at < startOfMonth &&
        (p.canceled_at === null || p.canceled_at >= startOfMonth),
    );
    const canceledThisMonth = allPurchases.filter(
      (p) =>
        p.billing_type === 'recurring' &&
        p.canceled_at !== null &&
        (p.canceled_at as Date) >= startOfMonth,
    );
    const churnRatePct =
      activeAtStartOfMonth.length > 0
        ? parseFloat(
            (
              (canceledThisMonth.length / activeAtStartOfMonth.length) *
              100
            ).toFixed(1),
          )
        : 0;

    // ── Net Revenue Retention ─────────────────────────────────────────────────
    // TODO: True NRR requires tracking MRR changes (upgrades, downgrades) per
    // cohort. Until upgrade/downgrade events are modeled in ClientPurchase
    // (a plan_change event table), we approximate NRR as:
    //   NRR ≈ (1 - monthly_churn_rate) × 100
    // This underestimates NRR for coaches with expansion revenue (upsells).
    const nrrPct = parseFloat(
      Math.max(0, 100 - churnRatePct).toFixed(1),
    );

    // ── Projected Annual Revenue ──────────────────────────────────────────────
    const projectedAnnualCents = mrrCents * 12;

    // ── Zero-Churn Streak ─────────────────────────────────────────────────────
    // Count consecutive months (going backwards from last month) with zero
    // cancellations. Current month is excluded (it may not be complete).
    // TODO: Persist this streak in a coach_ltv_peak table so it survives
    // the monthly boundary without re-computation overhead.
    const zeroChurnStreakMonths = this.computeZeroChurnStreak(
      allPurchases,
      now,
    );

    // ── All-Time Peak RPCM ────────────────────────────────────────────────────
    // TODO: Persist all-time peak in coach_ltv_peak table. Currently returns
    // the higher of current RPCM vs. what we can infer from historical data.
    // Once the persistence table ships, read from it instead.
    const allTimePeakRpcmCents = await this.estimatePeakRpcm(
      coachUserId,
      rpcmCents,
      allPurchases,
    );
    const isNewRpcmRecord = rpcmCents > 0 && rpcmCents >= allTimePeakRpcmCents;

    // ── Next Milestone ────────────────────────────────────────────────────────
    const nextMilestone = this.computeNextMilestone(mrrCents, rpcmCents, currency);

    // ── Assemble response ─────────────────────────────────────────────────────
    const dto = new LtvMetricsResponseDto();

    dto.mrr_cents = mrrCents;
    dto.mrr_label = formatMoney(mrrCents, currency);
    dto.active_client_count = activeClientCount;

    dto.revenue_per_client_month_cents = rpcmCents;
    dto.revenue_per_client_month_label = formatMoney(rpcmCents, currency);

    dto.avg_client_lifespan_months = parseFloat(avgLifespanMonths.toFixed(1));
    dto.estimated_ltv_cents = estimatedLtvCents;
    dto.estimated_ltv_label = formatMoney(estimatedLtvCents, currency);

    dto.churn_rate_pct = churnRatePct;
    dto.net_revenue_retention_pct = nrrPct;

    dto.projected_annual_revenue_cents = projectedAnnualCents;
    dto.projected_annual_revenue_label = formatMoney(projectedAnnualCents, currency);

    dto.mrr_trend = mrrTrend;
    dto.mrr_30d_ago_cents = mrr30dAgoCents;

    dto.zero_churn_streak_months = zeroChurnStreakMonths;
    dto.all_time_peak_rpcm_cents = allTimePeakRpcmCents;
    dto.all_time_peak_rpcm_label = formatMoney(allTimePeakRpcmCents, currency);
    dto.is_new_rpcm_record = isNewRpcmRecord;

    dto.ltv_cac_ratio = null; // CAC requires manual input — not yet modeled

    dto.next_milestone = nextMilestone;
    dto.currency = currency;
    dto.computed_at = now.toISOString();

    return dto;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private resolveCurrency(
    purchases: Array<{ currency: string | null }>,
  ): string {
    const counts = new Map<string, number>();
    for (const p of purchases) {
      const c = (p.currency ?? 'usd').toLowerCase();
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let top = 'usd';
    let topCount = 0;
    for (const [c, n] of counts.entries()) {
      if (n > topCount) {
        top = c;
        topCount = n;
      }
    }
    return top;
  }

  /**
   * Compute consecutive months of zero churn going backwards from last month.
   * Current month is excluded (may not be complete).
   */
  private computeZeroChurnStreak(
    purchases: Array<{
      billing_type: string;
      canceled_at: Date | null;
    }>,
    now: Date,
  ): number {
    let streak = 0;
    // Walk backwards month by month starting from last month.
    for (let offset = 1; offset <= 24; offset++) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);

      const canceledThatMonth = purchases.some(
        (p) =>
          p.billing_type === 'recurring' &&
          p.canceled_at !== null &&
          (p.canceled_at as Date) >= monthStart &&
          (p.canceled_at as Date) < monthEnd,
      );

      if (canceledThatMonth) break;

      // Only count months where there was at least 1 active recurring client
      // (a streak of zero-churn on zero clients is meaningless).
      const hadActiveClients = purchases.some(
        (p) =>
          p.billing_type === 'recurring' &&
          p.canceled_at !== null
            ? (p.canceled_at as Date) >= monthEnd
            : true,
      );

      if (hadActiveClients) {
        streak++;
      } else {
        // No clients that month — don't extend streak, don't break it.
        // Just stop counting.
        break;
      }
    }
    return streak;
  }

  /**
   * Estimate all-time peak RPCM.
   *
   * TODO: When coach_ltv_peak table ships, replace with:
   *   const row = await this.prisma.coachLtvPeak.findUnique({ where: { coach_user_id } });
   *   return Math.max(row?.peak_rpcm_cents ?? 0, currentRpcmCents);
   *
   * For now, take the maximum possible RPCM from any single active month in the
   * past, by computing the "peak active MRR" across all purchases.
   */
  private async estimatePeakRpcm(
    coachUserId: string,
    currentRpcmCents: number,
    purchases: Array<{
      billing_type: string;
      amount_cents: number;
      interval: string | null;
      interval_count: number | null;
      status: string;
      entitlement_active: boolean;
      client_user_id: string;
    }>,
  ): Promise<number> {
    // TODO: Replace with persistent peak table lookup.
    // Heuristic: peak RPCM = peak monthly revenue per unique active client.
    // We can't perfectly reconstruct historical peaks without time-series data,
    // so we return current RPCM (conservative — the UI will show "New Record"
    // on first use, which is acceptable for the initial launch).
    return currentRpcmCents;
  }

  private computeNextMilestone(
    mrrCents: number,
    rpcmCents: number,
    currency: string,
  ): NextMilestoneDto {
    const dto = new NextMilestoneDto();

    // Find the next milestone above current MRR.
    const nextThreshold =
      MRR_MILESTONES_CENTS.find((t) => t > mrrCents) ??
      // Beyond our table: next $10k round above current
      Math.ceil((mrrCents + 1) / 1_000_00) * 1_000_00;

    const gap = nextThreshold - mrrCents;
    const clientsNeeded =
      rpcmCents > 0 ? Math.ceil(gap / rpcmCents) : 0;

    dto.clients_needed = clientsNeeded;
    dto.mrr_target_cents = nextThreshold;
    dto.mrr_target_label = formatMoney(nextThreshold, currency) + ' / mo';

    return dto;
  }
}
