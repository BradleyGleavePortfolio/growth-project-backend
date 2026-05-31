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
//   - all_time_peak_rpcm          → LTV-3: persisted in coach_ltv_peak (monotonic high-water mark)
//   - zero_churn_streak           → LTV-3: NOT persisted on the read path — recomputed from
//                                   source every request and returned live (resets on churn).
//                                   Persisting it only introduced a stale-source race (P2).
//   - mrr_30d_ago                 → computed from purchases active 30 days ago (real)

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    // ── Zero-Churn Streak + All-Time Peak RPCM (LTV-3) ───────────────────────
    // Wave-1 LTV-3: ONLY the peak is a persisted value that must survive the
    // monthly boundary. The two values have fundamentally DIFFERENT lifecycles:
    //
    //   - all_time_peak_rpcm is a monotonic HIGH-WATER MARK — it must never
    //     regress, so it is genuinely persisted (it cannot be reconstructed from
    //     a single request's source data).
    //   - zero_churn_streak is the CURRENT consecutive zero-churn run. It is
    //     RECOMPUTED IN FULL from source data on EVERY request
    //     (computeZeroChurnStreak), so the freshly computed value is always
    //     authoritative. It MUST be able to reset to 0 when a client churns (see
    //     DTO zero_churn_streak_months: "Resets to 0 the month any recurring
    //     client cancels").
    //
    // PEAK CONCURRENCY (P1, preserved): the monotonic max is performed inside a
    // `SELECT ... FOR UPDATE` transaction (lockedPeakUpsert) — the row is locked
    // at read time, the live peak is read, GREATEST(live, incoming) is computed,
    // and the row is updated, all serialised on the locked row. A concurrent
    // writer that read a stale (lower) peak can never lower a peak another
    // writer already raised, because it blocks on the lock and re-reads the
    // raised value before computing its own GREATEST.
    //
    // is_new_rpcm_record CORRECTNESS (P0, FIXED): the "new record" flag is
    // derived from the LIVE LOCKED prior peak read in that same transaction, NOT
    // from a statement-start snapshot CTE. The previous CTE captured the peak as
    // of the statement snapshot, which under READ COMMITTED could differ from
    // the (later) row version the GREATEST update applied to — so a request that
    // did NOT advance the high-water mark could still falsely report a new
    // record. Reading the prior peak under FOR UPDATE makes the flag true iff
    // THIS request actually advanced the peak.
    //
    // STREAK STALE-SOURCE RACE (P2 FIX): the streak is NO LONGER PERSISTED on
    // the read path. The previous implementation wrote the snapshot-derived
    // streak back via EXCLUDED, which introduced a stale-source race: request A
    // reads purchases (pre-cancellation) → computes streak 8; a cancellation
    // commits; request B reads the new state → would persist 0; request A
    // reaches the upsert LATER and overwrites the current 0 with its STALE 8,
    // corrupting the stored streak until the next read. Because the streak is
    // recomputed from source on every request, persisting it adds nothing but
    // the race. The fix is to NOT persist the streak from the read path at all:
    // the response returns the FRESHLY COMPUTED current streak, and the atomic
    // upsert leaves zero_churn_streak UNTOUCHED on conflict (it only seeds the
    // column on the initial INSERT, since the column is NOT NULL). This makes
    // the persisted streak irrelevant to the returned value and removes the race
    // entirely.
    const computedStreak = this.computeZeroChurnStreak(allPurchases, now);

    // Snapshot the row as it stood BEFORE our write. This pre-read is used ONLY
    // as a write-avoidance hint (skip the locked upsert when the stored peak
    // already dominates the current RPCM). It is NEVER used to derive a returned
    // value:
    //   - the peak comes from lockedPeakUpsert's GREATEST over the LIVE LOCKED
    //     row (so a stale read can never regress the store),
    //   - the streak comes from the in-memory recompute (never read from
    //     persistence), and
    //   - is_new_rpcm_record is derived from the LIVE LOCKED prior peak the
    //     transaction observed (see below) — NOT from this stale snapshot.
    const peakRow = await this.prisma.coachLtvPeak.findUnique({
      where: { coach_id: coachUserId },
    });
    // Stored as RPCM in cents (Decimal). Coerce to a JS number for comparison.
    const persistedPeakCents = peakRow ? Number(peakRow.all_time_peak_rpcm) : 0;

    // The streak returned to the client is ALWAYS the current recompute — it is
    // never read from, nor written back to, persistence. This is what eliminates
    // the stale-source race: an out-of-order write can no longer feed a
    // persisted streak that anyone reads.
    const zeroChurnStreakMonths = computedStreak;

    // Decide whether to touch the store, avoiding needless writes. Only the PEAK
    // is persisted, so a write is warranted only when:
    //   - there is no row yet (first run — seed the row), or
    //   - the current RPCM exceeds the persisted peak (the monotonic peak can
    //     advance).
    // The streak is never a reason to write, since it is no longer persisted on
    // the read path. The DB enforces peak monotonicity via GREATEST, so even a
    // redundant write is safe.
    const peakCouldAdvance = rpcmCents > persistedPeakCents;

    let allTimePeakRpcmCents: number;
    // is_new_rpcm_record (the "New Record" badge trigger) must be true for AT
    // MOST the single request that actually moved the high-water mark upward.
    let isNewRpcmRecord: boolean;

    if (!peakRow || peakCouldAdvance) {
      // Row-locked transactional upsert: advances/seeds the monotonic peak under
      // a `SELECT ... FOR UPDATE` row lock. On the initial INSERT it also seeds
      // zero_churn_streak with the computed value (the column is NOT NULL with
      // default 0); on the UPDATE path it leaves zero_churn_streak UNTOUCHED.
      // The returned peak is the authoritative monotonic maximum, and
      // priorPeakRpcmCents is the LIVE LOCKED current value observed in the same
      // serialised read+write.
      const persisted = await this.lockedPeakUpsert(
        coachUserId,
        rpcmCents,
        computedStreak,
      );
      allTimePeakRpcmCents = persisted.allTimePeakRpcmCents;
      // P0 FIX: derive is_new_rpcm_record from the LIVE LOCKED prior peak
      // (priorPeakRpcmCents) read under FOR UPDATE in the same transaction as
      // the write — NOT from a statement-start snapshot CTE and NOT from the
      // stale pre-write findUnique. The old snapshot-CTE approach could observe
      // a different (older) row version than the GREATEST update applied,
      // falsely flagging a new record for a request that did NOT advance the
      // high-water mark. Because priorPeakRpcmCents is the locked current value
      // (a concurrent writer that already raised the peak commits BEFORE this
      // FOR UPDATE returns, so we read the raised value), `rpcmCents > prior`
      // is true for AT MOST the single request that genuinely moved the
      // high-water mark upward.
      isNewRpcmRecord = rpcmCents > persisted.priorPeakRpcmCents;
    } else {
      // No write performed — the persisted peak already dominates the current
      // RPCM (rpcmCents <= persistedPeakCents). Such a request can never set a
      // new record regardless of ordering, so is_new is unambiguously false and
      // there is no race to guard against on this branch.
      allTimePeakRpcmCents = persistedPeakCents;
      isNewRpcmRecord = false;
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

  /**
   * Concurrency-safe persistence of the peak RPCM (monotonic high-water mark)
   * AND a provably-correct prior-peak observation for the is_new_rpcm_record
   * flag — both derived from the SAME serialised read+write under a row lock.
   *
   * P0 FIX (snapshot-CTE race): the previous implementation used a single
   * `INSERT ... ON CONFLICT DO UPDATE` whose prior peak was captured by a
   * LEADING read-only `prev` CTE. Under PostgreSQL READ COMMITTED that CTE
   * reads the STATEMENT SNAPSHOT taken when the query began, but the
   * `ON CONFLICT DO UPDATE` clause re-evaluates `GREATEST(...)` against the
   * LATER, CURRENT row version after blocking on a concurrent writer. So the
   * two parts of one statement could observe DIFFERENT row versions:
   *
   *   stored peak = $100; Req A RPCM=$300, Req B RPCM=$250
   *   - both `prev` CTEs capture old_peak=$100 (snapshot)
   *   - A commits row → $300
   *   - B's ON CONFLICT applies GREATEST(300,250)=$300 (monotonic, GOOD)
   *   - B still returns old_peak=$100 from its snapshot CTE → FALSELY reports
   *     is_new_rpcm_record=true ($250>$100) even though it did NOT advance the
   *     high-water mark.
   *
   * Monotonicity was fine; the "new record" FLAG was the bug. The flag must be
   * TRUE iff THIS request actually advanced the high-water mark, which means it
   * must be decided against the LIVE (current, committed) peak — not a snapshot.
   *
   * THE FIX — explicit transaction with `SELECT ... FOR UPDATE` (pessimistic
   * row lock). This serialises the read and the write so that old_peak is
   * EXACTLY the live, locked current value (never a stale snapshot):
   *
   *   1. `SELECT ... FOR UPDATE` the coach's row. If a concurrent writer is
   *      mid-update, this BLOCKS until that writer commits and then returns the
   *      CURRENT committed row — not a snapshot taken at statement start. The
   *      row stays locked for the rest of this transaction, so no other writer
   *      can change the peak between our read and our write.
   *   2. old_peak = the locked current peak (0 if no row yet).
   *   3. new_peak = GREATEST(old_peak, incoming) — the monotonic high-water
   *      mark is preserved exactly as before; it can only ever rise.
   *   4. Persist: UPDATE the locked row to new_peak (no row → INSERT with the
   *      incoming peak and the seed streak).
   *   5. The caller sets is_new_rpcm_record = incoming > old_peak. Because
   *      old_peak is the LIVE locked value (post-A in the scenario above, B
   *      reads $300, so $250 > $300 = false), the flag is true iff this request
   *      genuinely advanced the peak. The snapshot race is gone.
   *
   * Why this is unambiguously correct (no reliance on subtle RETURNING
   * semantics): `SELECT FOR UPDATE` takes the read-time row lock that READ
   * COMMITTED `UPDATE`/`INSERT ... ON CONFLICT` only take at WRITE time. By
   * locking at READ time we close the read→write window in which a concurrent
   * writer could change the row. The blocked transaction then re-reads the
   * latest committed version (PostgreSQL's documented FOR UPDATE behaviour:
   * it waits for the concurrent writer and locks the updated version), so our
   * old_peak == the value the next writer must build on. Read and write are
   * serialised on the same locked row, so `incoming > old_peak` is true for AT
   * MOST the one request that actually moved the high-water mark.
   *
   * The `zero_churn_streak` column is INTENTIONALLY only seeded on the initial
   * INSERT and NEVER written on the UPDATE/conflict path. The streak is the
   * CURRENT consecutive zero-churn run, fully RECOMPUTED from source data on
   * every request (see computeZeroChurnStreak) and returned live, so persisting
   * it on the read path adds nothing but the stale-source race (P2). Leaving it
   * untouched on the update path keeps the persisted streak irrelevant to the
   * returned value (P2 fix preserved).
   *
   * All inputs are passed as bound parameters via Prisma's tagged-template raw
   * API (no string interpolation), keeping the queries injection-safe. The
   * read+write run inside a single `prisma.$transaction` (interactive, default
   * READ COMMITTED) so the row lock is held across both statements.
   */
  private async lockedPeakUpsert(
    coachUserId: string,
    incomingPeakCents: number,
    seedStreak: number,
  ): Promise<{ allTimePeakRpcmCents: number; priorPeakRpcmCents: number }> {
    return this.prisma.$transaction(async (tx) => {
      // Step 1+2: lock the coach's row (if any) and read its LIVE current peak.
      // FOR UPDATE blocks on any concurrent writer and then returns the CURRENT
      // committed row version — NOT a statement-start snapshot. This is the
      // crux of the fix: old_peak is the live locked value, evaluated in the
      // same serialised read+write as the subsequent persist.
      const locked = await tx.$queryRaw<
        Array<{ all_time_peak_rpcm: Prisma.Decimal }>
      >(Prisma.sql`
        SELECT "all_time_peak_rpcm"
        FROM "coach_ltv_peak"
        WHERE "coach_id" = ${coachUserId}
        FOR UPDATE
      `);

      if (locked.length === 0) {
        // No row yet → first run. INSERT the incoming peak and seed the streak.
        // There is no prior high-water mark, so priorPeak is 0 (any positive
        // RPCM is a new record, matching the existing first-run semantics).
        // The unique constraint on coach_id makes a racing duplicate INSERT
        // fail rather than silently double-insert; that surfaces as an error to
        // retry, never a corrupt peak.
        const inserted = await tx.$queryRaw<
          Array<{ new_peak: Prisma.Decimal }>
        >(Prisma.sql`
          INSERT INTO "coach_ltv_peak" (
            "id", "coach_id", "all_time_peak_rpcm", "zero_churn_streak", "updated_at"
          )
          VALUES (
            gen_random_uuid(),
            ${coachUserId},
            ${incomingPeakCents}::numeric,
            ${seedStreak}::int,
            now()
          )
          RETURNING "all_time_peak_rpcm" AS new_peak
        `);
        return {
          allTimePeakRpcmCents: Number(inserted[0].new_peak),
          // No prior record → prior peak is 0.
          priorPeakRpcmCents: 0,
        };
      }

      // Step 3: the live locked prior peak. The row is now locked for the rest
      // of this transaction, so no concurrent writer can move it between here
      // and our UPDATE below.
      const priorPeakRpcmCents = Number(locked[0].all_time_peak_rpcm);
      // Monotonic high-water mark — never regresses.
      const newPeakCents = Math.max(priorPeakRpcmCents, incomingPeakCents);

      // Step 4: persist the (possibly unchanged) peak on the locked row. The
      // streak is NEVER written on this path (P2 fix preserved); only the peak
      // and updated_at change.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "coach_ltv_peak"
        SET "all_time_peak_rpcm" = ${newPeakCents}::numeric,
            "updated_at" = now()
        WHERE "coach_id" = ${coachUserId}
      `);

      return {
        allTimePeakRpcmCents: newPeakCents,
        // The LIVE locked prior peak — used by the caller to decide
        // is_new_rpcm_record = incoming > priorPeak. Because it is the locked
        // current value (not a snapshot), the flag is true iff this request
        // actually advanced the high-water mark.
        priorPeakRpcmCents,
      };
    });
  }

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
