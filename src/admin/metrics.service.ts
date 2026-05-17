import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// MetricsService — read-only counters derived from the Postgres source of
// truth (NOT PostHog). PostHog gets real-time events; this endpoint gets you
// authoritative counts for the same business questions, computed from rows
// the system has actually written.
//
// Anything that would require synthetic revenue or a "fake customer" number
// is deliberately omitted. The only money figure exposed here is the cents
// total of invoices Stripe has reported as paid.
@Injectable()
export class MetricsService {
  constructor(private prisma: PrismaService) {}

  async getOverview(opts: { sinceDays?: number } = {}) {
    const sinceDays = opts.sinceDays ?? 30;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalCoaches,
      totalClients,
      coachesWithProfile,
      activeSubscriptions,
      trialingSubscriptions,
      canceledSubscriptions,
      pastDueSubscriptions,
      paidInvoicesAggregate,
      paymentFailuresSince,
      messagesSent,
      foodLogsSince,
      aiContextProfileCount,
      newUsersSince,
      inviteCodesActive,
      inviteCodesUsedSince,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'coach' } }),
      this.prisma.user.count({ where: { role: 'student' } }),
      this.prisma.coachProfile.count(),
      this.prisma.coachSubscription.count({ where: { status: 'active' } }),
      this.prisma.coachSubscription.count({ where: { status: 'trialing' } }),
      this.prisma.coachSubscription.count({ where: { status: 'canceled' } }),
      this.prisma.coachSubscription.count({ where: { status: 'past_due' } }),
      this.prisma.invoice.aggregate({
        where: { status: 'paid', paid_at: { gte: since } },
        _sum: { amount_paid_cents: true },
        _count: { _all: true },
      }),
      this.prisma.paymentFailure.count({
        where: { occurred_at: { gte: since } },
      }),
      this.prisma.coachMessage.count({
        where: { created_at: { gte: since } },
      }),
      this.prisma.loggedFoodEntry.count({
        where: { logged_at: { gte: since } },
      }),
      this.prisma.userProfile.count(),
      this.prisma.user.count({ where: { created_at: { gte: since } } }),
      this.prisma.inviteCode.count({ where: { revoked: false } }),
      // InviteCode has no updated_at; fall back to summing used_count across
      // all rows so the dashboard shows a non-zero value while we keep this
      // table append-only. The PostHog `invite_redeemed` event provides the
      // window-scoped view.
      this.prisma.inviteCode.aggregate({
        _sum: { used_count: true },
      }),
    ]);

    return {
      window: { since_days: sinceDays, since: since.toISOString() },
      users: {
        total: totalUsers,
        coaches: totalCoaches,
        clients: totalClients,
        new_in_window: newUsersSince,
      },
      coach: {
        with_profile: coachesWithProfile,
      },
      billing: {
        active: activeSubscriptions,
        trialing: trialingSubscriptions,
        past_due: pastDueSubscriptions,
        canceled: canceledSubscriptions,
        invoices_paid_in_window: paidInvoicesAggregate._count._all,
        invoices_paid_amount_cents_in_window:
          paidInvoicesAggregate._sum.amount_paid_cents ?? 0,
        payment_failures_in_window: paymentFailuresSince,
      },
      invites: {
        active_codes: inviteCodesActive,
        // Lifetime redemption total. Window-scoped redemptions are emitted
        // as `invite_redeemed` PostHog events; see docs/metrics.md.
        redemptions_total: inviteCodesUsedSince._sum.used_count ?? 0,
      },
      activity: {
        messages_in_window: messagesSent,
        food_logs_in_window: foodLogsSince,
      },
      ai: {
        users_with_profile: aiContextProfileCount,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // MRR / ARR
  //
  // Strategy: for each ACTIVE (not trialing) coach subscription, find their
  // most recent paid Invoice for the current billing cycle and normalise to
  // a monthly amount.
  //
  // Normalisation rules:
  //   - Invoice period is ≥28 days (monthly cycle): normalise to 30.44 days.
  //   - Invoice period is ≥300 days (annual cycle): divide by 12.
  //   - Invoice period < 28 days or missing: treat the raw amount as monthly.
  //     (Avoids the ×30 inflation bug on same-day or trial-conversion invoices.)
  //
  // Trialing coaches are intentionally excluded from MRR — they have not paid
  // for the current period. They are counted separately so the owner console
  // can show "X trialing" alongside the MRR figure.
  //
  // Multi-currency: amounts are grouped by currency and returned as a map.
  // The `mrr_cents` / `arr_cents` top-level fields are the USD total; all
  // other currencies appear in `by_currency` for display purposes.
  //
  // Source: Stripe webhook pipeline writes Invoice rows. No Stripe API call.
  async getMrrArr() {
    // Only active (paying) subscriptions contribute to MRR.
    // Trialing is surfaced as a separate counter, not added to revenue.
    const [activeSubs, trialingCount] = await Promise.all([
      this.prisma.coachSubscription.findMany({
        where: { status: 'active' },
        select: {
          coach_id: true,
          coach: {
            select: {
              invoices: {
                where: { status: 'paid' },
                orderBy: { paid_at: 'desc' },
                take: 1,
                select: {
                  amount_paid_cents: true,
                  period_start: true,
                  period_end: true,
                  currency: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.coachSubscription.count({ where: { status: 'trialing' } }),
    ]);

    // Per-currency MRR accumulator
    const byCurrency: Record<string, number> = {};
    let activePayingCount = 0;
    let coachesWithNoInvoice = 0;

    for (const sub of activeSubs) {
      const inv = sub.coach.invoices[0];

      if (!inv || inv.amount_paid_cents <= 0) {
        coachesWithNoInvoice++;
        continue;
      }

      const currency = (inv.currency ?? 'usd').toLowerCase();
      let monthlyAmountCents: number;

      if (inv.period_start && inv.period_end) {
        const periodDays =
          (inv.period_end.getTime() - inv.period_start.getTime()) /
          (1000 * 60 * 60 * 24);

        if (periodDays >= 300) {
          // Annual invoice — divide by 12 to get monthly
          monthlyAmountCents = Math.round(inv.amount_paid_cents / 12);
        } else if (periodDays >= 28) {
          // Monthly invoice — normalise to 30.44-day month
          monthlyAmountCents = Math.round(
            (inv.amount_paid_cents / periodDays) * 30.44,
          );
        } else {
          // Period too short to normalise safely (same-day, trial conversion, etc.)
          // Treat the raw amount as a monthly figure to avoid ×30 inflation.
          monthlyAmountCents = inv.amount_paid_cents;
        }
      } else {
        // No period dates on this invoice — treat as monthly (most common cycle).
        monthlyAmountCents = inv.amount_paid_cents;
      }

      byCurrency[currency] = (byCurrency[currency] ?? 0) + monthlyAmountCents;
      activePayingCount++;
    }

    const mrrCents = byCurrency['usd'] ?? 0;
    const arrCents = mrrCents * 12;
    const arpuCents =
      activePayingCount > 0 ? Math.round(mrrCents / activePayingCount) : 0;

    return {
      // USD totals (primary currency for the platform)
      mrr_cents: mrrCents,
      arr_cents: arrCents,
      arpu_cents: arpuCents,
      // Per-currency breakdown for non-USD coaches
      by_currency: byCurrency,
      active_paying_coaches: activePayingCount,
      trialing_coaches: trialingCount,
      coaches_with_no_invoice: coachesWithNoInvoice,
      methodology:
        'MRR includes only coaches with status=active (trialing excluded). ' +
        'Each coach contributes their most recent paid Invoice, normalised to monthly: ' +
        'annual invoices (≥300 days) are divided by 12; monthly invoices (28–299 days) ' +
        'are scaled to 30.44 days; short/missing-period invoices are used as-is. ' +
        'ARR = MRR × 12. ARPU = MRR ÷ active paying coach count.',
    };
  }

  // ---------------------------------------------------------------------------
  // Churn
  //
  // Strategy: identify churned coaches via CoachSubscription rows where
  // status = 'canceled' AND current_period_end is within the lookback window.
  //
  // Why current_period_end, not updated_at:
  //   - `updated_at` is @updatedAt — any write (even unrelated) refreshes it,
  //     making old cancellations appear as newly churned.
  //   - `current_period_end` is set by the customer.subscription.deleted webhook
  //     to the date Stripe actually ended the subscription. A canceled sub whose
  //     current_period_end falls within [since, now] definitively churned in
  //     this window.
  //   - Coaches who canceled but are still in their grace period
  //     (current_period_end > now) are NOT counted as churned yet.
  //
  // Denominator (cohort size): active + trialing NOW + churned in window.
  // This is an approximation — a true cohort would require a snapshot of
  // subscriptions at period_start. The methodology field surfaces this caveat.
  //
  // Revenue churn: sum of each churned coach's last paid invoice (normalised
  // monthly, same rules as getMrrArr) as a fraction of estimated MRR at
  // period start (current MRR + churned MRR).
  async getChurn(opts: { sinceDays?: number } = {}) {
    const sinceDays = opts.sinceDays ?? 30;
    const now = new Date();
    const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

    // Churned in window: canceled subscriptions whose access definitively
    // ended within [since, now] — i.e. current_period_end is in the window.
    const churnedSubs = await this.prisma.coachSubscription.findMany({
      where: {
        status: 'canceled',
        current_period_end: { gte: since, lte: now },
      },
      select: {
        coach_id: true,
        coach: {
          select: {
            invoices: {
              where: { status: 'paid' },
              orderBy: { paid_at: 'desc' },
              take: 1,
              select: {
                amount_paid_cents: true,
                period_start: true,
                period_end: true,
                currency: true,
              },
            },
          },
        },
      },
    });

    // Current active + trialing for denominator approximation
    const [activeCount, trialingCount] = await Promise.all([
      this.prisma.coachSubscription.count({ where: { status: 'active' } }),
      this.prisma.coachSubscription.count({ where: { status: 'trialing' } }),
    ]);

    const churnedCount = churnedSubs.length;
    // Denominator: best approximation of cohort at period start
    const cohortSize = activeCount + trialingCount + churnedCount;
    const logoChurnRate =
      cohortSize > 0
        ? parseFloat(((churnedCount / cohortSize) * 100).toFixed(2))
        : 0;

    // Revenue lost: apply same normalisation rules as getMrrArr
    const revenueLostByCurrency: Record<string, number> = {};
    for (const sub of churnedSubs) {
      const inv = sub.coach.invoices[0];
      if (!inv || inv.amount_paid_cents <= 0) continue;

      const currency = (inv.currency ?? 'usd').toLowerCase();
      let monthlyAmountCents: number;

      if (inv.period_start && inv.period_end) {
        const periodDays =
          (inv.period_end.getTime() - inv.period_start.getTime()) /
          (1000 * 60 * 60 * 24);
        if (periodDays >= 300) {
          monthlyAmountCents = Math.round(inv.amount_paid_cents / 12);
        } else if (periodDays >= 28) {
          monthlyAmountCents = Math.round(
            (inv.amount_paid_cents / periodDays) * 30.44,
          );
        } else {
          monthlyAmountCents = inv.amount_paid_cents;
        }
      } else {
        monthlyAmountCents = inv.amount_paid_cents;
      }

      revenueLostByCurrency[currency] =
        (revenueLostByCurrency[currency] ?? 0) + monthlyAmountCents;
    }

    const revenueChurnCents = revenueLostByCurrency['usd'] ?? 0;
    const { mrr_cents: currentMrrCents } = await this.getMrrArr();
    const mrrAtPeriodStartCents = currentMrrCents + revenueChurnCents;
    const revenueChurnRate =
      mrrAtPeriodStartCents > 0
        ? parseFloat(
            ((revenueChurnCents / mrrAtPeriodStartCents) * 100).toFixed(2),
          )
        : 0;

    return {
      window: { since_days: sinceDays, since: since.toISOString() },
      logo_churn: {
        churned_coaches: churnedCount,
        cohort_size: cohortSize,
        churn_rate_pct: logoChurnRate,
      },
      revenue_churn: {
        lost_mrr_cents: revenueChurnCents,
        lost_by_currency: revenueLostByCurrency,
        mrr_at_period_start_cents: mrrAtPeriodStartCents,
        churn_rate_pct: revenueChurnRate,
      },
      methodology:
        'Churned coaches = subscriptions with status=canceled whose current_period_end ' +
        'falls within the lookback window (avoids updated_at false positives from unrelated writes). ' +
        'Coaches still in their cancellation grace period (current_period_end > now) are excluded. ' +
        'Cohort size = currently active + trialing + churned in window (approximation; a snapshot ' +
        'table would give a precise period-start denominator). ' +
        'Revenue churn uses the same invoice normalisation as getMrrArr.',
    };
  }
}
