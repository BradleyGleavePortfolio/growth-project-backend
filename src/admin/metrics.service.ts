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

  // B5 owner-console stub. The MRR/ARR calc requires resolving each
  // active CoachSubscription's price interval and currency to a normalized
  // monthly figure; that pipeline hasn't shipped yet. Return a
  // not_implemented marker so the owner console can render an honest empty
  // state instead of fabricating a number.
  async getMrrArr() {
    return { not_implemented: true };
  }

  // B5 owner-console stub. Same rationale as getMrrArr — churn over a
  // rolling window requires denominator state that hasn't been backfilled.
  async getChurn(_opts: { sinceDays?: number } = {}) {
    return { not_implemented: true };
  }
}
