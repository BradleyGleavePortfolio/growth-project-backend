// src/coach/command-center/ltv-metrics.service.ts
//
// Computes the LTV metrics suite for the Coach Command Center.
//
// Data sources (real):
//   ClientPurchase  — billing_type, amount_cents, status, created_at, canceled_at,
//                     current_period_end
//   CoachPackage    — amount_cents, interval, interval_count
//
// Stubs (clearly marked with TODO):
//   - avg_client_lifespan_months  → real value requires ≥3 cancellations; falls back to 6 months
//   - net_revenue_retention_pct   → upgrade/downgrade tracking not yet modeled; approximated
//   - all_time_peak_rpcm          → LTV-3: persisted in coach_ltv_peak (source of truth)
//   - zero_churn_streak           → LTV-3: persisted in coach_ltv_peak (floored, never regresses)
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
    // Issue 1 fix: interval and interval_count live on CoachPackage, not
    // ClientPurchase. Join via the `package` relation.
    const allPurchases = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachUserId },
      select: {
        id: true,
        client_user_id: true,
        amount_cents: true,
        currency: true,
        billing_type: true,
        status: true,
        entitlement_active: true,
        created_at: true,
        canceled_at: true,
        current_period_end: true,
        cancel_at_period_end: true,
        // Issue 1: join CoachPackage to get interval fields
        package: {
          select: {
            interval: true,
            interval_count: true,
          },
        },
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
      // Issue 1: read interval fields from the joined package
      return (
        sum +
        toMonthlyAmountCents(
          p.amount_cents,
          p.package.interval,
          p.package.interval_count ?? 1,
        )
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
      // Issue 1: read interval fields from the joined package
      return (
        sum +
        toMonthlyAmountCents(
          p.amount_cents,
          p.package.interval,
          p.package.interval_count ?? 1,
        )
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
    let lifespanIsEstimate: boolean;
    let lifespanEstimateNote: string | null;
    if (canceledRecurring.length >= 3) {
      const lifespans = canceledRecurring.map((p) => {
        const msAlive =
          (p.canceled_at as Date).getTime() - p.created_at.getTime();
        return msAlive / (1000 * 60 * 60 * 24 * 30.44); // months
      });
      avgLifespanMonths =
        lifespans.reduce((a, b) => a + b, 0) / lifespans.length;
      lifespanIsEstimate = false;
      lifespanEstimateNote = null;
    } else {
      // TODO: Replace 6-month stub once ≥3 cancellation data points exist.
      // The 6-month default is conservative for fitness coaching (industry avg ~4–8 mo).
      avgLifespanMonths = 6;
      lifespanIsEstimate = true;
      lifespanEstimateNote =
        `Based on industry average (only ${canceledRecurring.length} cancellation` +
        `${canceledRecurring.length === 1 ? '' : 's'} recorded — need ≥3 for a real average)`;
      this.logger.log(
        `LTV lifespan stub for coach ${coachUserId}: <3 cancellations, using 6-month default`,
      );
    }

    // ── Estimated LTV ────────────────────────────────────────────────────────
    // LTV-1: estimated_ltv = rpcm × avg_lifespan. When the lifespan is a stub
    // (fewer than 3 cancellations), the LTV figure is itself an estimate, not a
    // hard dollar number. Surface that honestly via estimated_ltv_is_estimate so
    // the frontend can label it as an estimate rather than a real figure.
    const estimatedLtvCents = Math.round(rpcmCents * avgLifespanMonths);
    const estimatedLtvIsEstimate = lifespanIsEstimate;
    const estimatedLtvEstimateNote = lifespanIsEstimate
      ? `Estimated LTV — derived from an estimated client lifespan. ${lifespanEstimateNote ?? ''}`.trim()
      : null;

    // ── Churn Rate (this calendar month) ─────────────────────────────────────
    // Issue 2 fix: group by client_user_id before counting so a client with
    // two purchases counts as ONE client, not two.
    //
    // PR #223 fix: use temporal logic instead of current status to determine
    // "active at start of month". A client who cancels mid-month has
    // status='canceled' by query time, but WAS active at the start of the month.
    // Using status here causes the denominator to exclude them, producing wrong
    // churn (0% when the only client churns, or inflated % otherwise).

    // Clients active at start of month (unique client_user_id).
    // A client was active at start of month if:
    //   - billing_type = 'recurring'
    //   - created_at < startOfMonth (existed before month started)
    //   - canceled_at IS NULL (still active) OR canceled_at >= startOfMonth
    //     (canceled during this month — was active at the start)
    const activeAtStartClientIds = new Set<string>();
    for (const p of allPurchases) {
      if (p.billing_type !== 'recurring') continue;
      const createdBeforeMonth = p.created_at < startOfMonth;
      const notCanceledBeforeMonth =
        p.canceled_at === null || p.canceled_at >= startOfMonth;
      if (createdBeforeMonth && notCanceledBeforeMonth) {
        activeAtStartClientIds.add(p.client_user_id);
      }
    }

    // Clients who canceled this month (unique client_user_id).
    const canceledThisMonthClientIds = new Set(
      allPurchases
        .filter(
          (p) =>
            p.billing_type === 'recurring' &&
            p.canceled_at !== null &&
            (p.canceled_at as Date) >= startOfMonth,
        )
        .map((p) => p.client_user_id), // Issue 2: deduplicate by client
    );

    const churnRatePct =
      activeAtStartClientIds.size > 0
        ? parseFloat(
            (
              (canceledThisMonthClientIds.size / activeAtStartClientIds.size) *
              100
            ).toFixed(1),
          )
        : 0;

    // ── Net Revenue Retention ─────────────────────────────────────────────────
    // Issue 4 fix: rename internal variable to grossRetentionPct and add
    // honest comments. The field name net_revenue_retention_pct is preserved
    // for API compatibility; nrr_is_stub=true signals the frontend.
    //
    // STUB: gross_logo_retention approximation (1 - churn_rate).
    // True NRR requires expansion/contraction MRR data not yet available.
    // Will be accurate once upgrade/downgrade events are tracked.
    const grossRetentionPct = parseFloat(
      Math.max(0, 100 - churnRatePct).toFixed(1),
    );

    // ── Projected Annual Revenue ──────────────────────────────────────────────
    const projectedAnnualCents = mrrCents * 12;

    // ── Zero-Churn Streak + All-Time Peak RPCM (LTV-3: persisted) ─────────────
    // Wave-1 LTV-3: persist both values in the coach_ltv_peak table so they
    // survive the monthly boundary and never regress on a transient recompute.
    //
    // Read the coach's single CoachLtvPeak row (one per coach_id). The PERSISTED
    // values are the source of truth:
    //   - all_time_peak_rpcm: newPeak = max(persistedPeak, currentRpcm).
    //     isNewRpcmRecord is true only when currentRpcm STRICTLY exceeds the
    //     persisted peak (a genuinely new record), in which case we upsert.
    //   - zero_churn_streak: persist as a floor — the recomputed streak can
    //     extend the persisted value but never drop a real historical peak
    //     (e.g. across a month boundary where the in-memory recompute window
    //     would otherwise shrink it).
    const computedStreak = this.computeZeroChurnStreak(allPurchases, now);

    const peakRow = await this.prisma.coachLtvPeak.findUnique({
      where: { coach_id: coachUserId },
    });
    // Stored as RPCM in cents (Decimal). Coerce to a JS number for comparison.
    const persistedPeakCents = peakRow ? Number(peakRow.all_time_peak_rpcm) : 0;
    const persistedStreak = peakRow?.zero_churn_streak ?? 0;

    const allTimePeakRpcmCents = Math.max(persistedPeakCents, rpcmCents);
    const isNewRpcmRecord = rpcmCents > persistedPeakCents;
    // Streak never regresses below the persisted floor.
    const zeroChurnStreakMonths = Math.max(persistedStreak, computedStreak);

    // Persist when either value advanced (or no row exists yet). Upsert by
    // coach_id so there is exactly one row per coach.
    const peakAdvanced = allTimePeakRpcmCents > persistedPeakCents;
    const streakAdvanced = zeroChurnStreakMonths > persistedStreak;
    if (!peakRow || peakAdvanced || streakAdvanced) {
      await this.prisma.coachLtvPeak.upsert({
        where: { coach_id: coachUserId },
        create: {
          coach_id: coachUserId,
          all_time_peak_rpcm: allTimePeakRpcmCents,
          zero_churn_streak: zeroChurnStreakMonths,
        },
        update: {
          all_time_peak_rpcm: allTimePeakRpcmCents,
          zero_churn_streak: zeroChurnStreakMonths,
        },
      });
    }

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
    dto.lifespan_is_estimate = lifespanIsEstimate;
    dto.lifespan_estimate_note = lifespanEstimateNote;
    dto.estimated_ltv_cents = estimatedLtvCents;
    dto.estimated_ltv_label = formatMoney(estimatedLtvCents, currency);
    // LTV-1: explicitly flag the LTV dollar figure as an estimate (stub) so the
    // frontend labels it rather than presenting a hardcoded-lifespan number as real.
    dto.estimated_ltv_is_estimate = estimatedLtvIsEstimate;
    dto.estimated_ltv_estimate_note = estimatedLtvEstimateNote;

    dto.churn_rate_pct = churnRatePct;
    // Issue 4: field name kept for API compat; gross retention approximation
    dto.net_revenue_retention_pct = grossRetentionPct;
    // Issue 4: signal to frontend that this is a stub, not true NRR
    dto.nrr_is_stub = true;

    dto.projected_annual_revenue_cents = projectedAnnualCents;
    dto.projected_annual_revenue_label = formatMoney(projectedAnnualCents, currency);

    dto.mrr_trend = mrrTrend;
    dto.mrr_30d_ago_cents = mrr30dAgoCents;

    dto.zero_churn_streak_months = zeroChurnStreakMonths;
    dto.all_time_peak_rpcm_cents = allTimePeakRpcmCents;
    dto.all_time_peak_rpcm_label = formatMoney(allTimePeakRpcmCents, currency);
    // LTV-3: peak is now persisted in coach_ltv_peak (source of truth), so the
    // value is no longer a best-effort estimate.
    dto.peak_rpcm_is_estimate = false;
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
   *
   * Issue 5 fix: before crediting a month as "zero churn", verify that at
   * least one client existed at the START of that month (created_at <=
   * monthStart). Months before the coach had any clients are skipped entirely
   * (neither counted forward nor backward in the streak).
   */
  private computeZeroChurnStreak(
    purchases: Array<{
      billing_type: string;
      canceled_at: Date | null;
      created_at: Date;
    }>,
    now: Date,
  ): number {
    let streak = 0;
    // Walk backwards month by month starting from last month.
    for (let offset = 1; offset <= 24; offset++) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);

      // Issue 5: check that at least one recurring client existed at the
      // start of this month (created_at <= monthStart).
      const hadClientsAtStart = purchases.some(
        (p) =>
          p.billing_type === 'recurring' &&
          p.created_at <= monthStart,
      );

      if (!hadClientsAtStart) {
        // No clients existed yet — skip this month entirely (don't count it
        // in either direction) and stop the streak walk.
        break;
      }

      const canceledThatMonth = purchases.some(
        (p) =>
          p.billing_type === 'recurring' &&
          p.canceled_at !== null &&
          (p.canceled_at as Date) >= monthStart &&
          (p.canceled_at as Date) < monthEnd,
      );

      if (canceledThatMonth) break;

      streak++;
    }
    return streak;
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
