import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// AdminAnalyticsService — Phase 7 enterprise rollups.
//
// Source of truth for every dollar metric the admin/owner web console
// renders. Pulls directly from SplitLedgerEntry (immutable ledger) +
// ChargeRefund + ClientPurchase so the numbers reconcile to real money
// state — no double-counted webhook tally.
//
// Why ledger over Stripe API: the ledger is the system of record we
// already trust for end-of-day reporting; Stripe's reporting suite is a
// good audit trail but cannot answer "platform fee revenue grouped by
// head coach" without 4 round-trips per coach.
//
// Time windows: callers pass from/to as ISO timestamps. The default
// window is "last 30 days" if neither is provided. Aggregations are
// computed in-process from filtered ledger rows (counts are bounded by
// the row volume per window; for a multi-million-row deployment the
// caller should narrow the window).

export type RollupGroupBy = 'day' | 'month' | 'coach';

export interface EnterpriseRollup {
  // Overall counts.
  window: { from: Date; to: Date };
  // Gross Merchandise Volume — sum of every paid ClientPurchase.amount_cents
  // in window (gross, before refunds and fees).
  gmv_cents: number;
  // Sum of `application_fee` ledger slices that posted in window.
  // = the platform's 2% TGP take.
  platform_fee_cents: number;
  // Sum of `head_coach_split` ledger slices that posted in window.
  head_coach_split_cents: number;
  // Sum of `destination` ledger slices that posted in window.
  // = the seller coach's gross net before any Stripe processing fee.
  seller_gross_cents: number;
  // Total reversed across all `application_fee` + `destination` slices.
  ledger_reversed_cents: number;
  // Refund + dispute totals.
  refunds_cents: number;
  refund_count: number;
  disputes_open: number;
  disputes_lost_cents: number;
  // Coverage of the data.
  purchases_count: number;
  active_coaches: number;
  payouts_ready_coaches: number;
  // Per-group breakdown (set by groupBy).
  groups: Array<{
    key: string;
    label: string;
    gmv_cents: number;
    platform_fee_cents: number;
    head_coach_split_cents: number;
    seller_gross_cents: number;
    refunds_cents: number;
    purchases_count: number;
  }>;
}

export interface CoachEarningsSummary {
  coach_user_id: string;
  window: { from: Date; to: Date };
  // Earnings this coach actually received as the SELLER (destination kind).
  as_seller: {
    gross_cents: number;
    posted_cents: number;
    pending_cents: number;
    reversed_cents: number;
    refunds_cents: number;
    purchases_count: number;
  };
  // Earnings this coach received as a HEAD COACH (head_coach_split kind).
  as_head_coach: {
    gross_cents: number;
    posted_cents: number;
    pending_cents: number;
    reversed_cents: number;
    sub_coaches_count: number; // # of distinct selling sub-coaches contributing
  };
  // Most-recent payout from PayoutSnapshot (last_payout_*).
  last_payout: {
    stripe_id: string | null;
    amount_cents: number | null;
    status: string | null;
    arrival_at: Date | null;
  };
  // Pending Stripe balance.
  available_cents: number;
  pending_cents: number;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getEnterpriseRollup(opts: {
    from?: Date;
    to?: Date;
    groupBy?: RollupGroupBy;
  }): Promise<EnterpriseRollup> {
    const to = opts.to ?? new Date();
    const from =
      opts.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const groupBy: RollupGroupBy = opts.groupBy ?? 'day';

    const [purchases, ledgerRows, refunds, disputes, accounts, snapshots] =
      await Promise.all([
        this.prisma.clientPurchase.findMany({
          where: {
            created_at: { gte: from, lte: to },
            status: { in: ['paid', 'active', 'past_due', 'canceled', 'refunded', 'disputed', 'chargeback_lost'] },
          },
        }),
        this.prisma.splitLedgerEntry.findMany({
          where: {
            posted_at: { gte: from, lte: to },
          },
        }),
        this.prisma.chargeRefund.findMany({
          where: {
            created_at: { gte: from, lte: to },
            status: 'succeeded',
          },
        }),
        this.prisma.chargeDispute.findMany({
          where: { created_at: { gte: from, lte: to } },
        }),
        this.prisma.connectAccount.findMany({
          where: { charges_enabled: true, deauthorized_at: null },
        }),
        this.prisma.payoutSnapshot.findMany({
          where: { readiness_status: 'ready' },
        }),
      ]);

    // Top-level rollups.
    const gmv = sumBy(purchases, (p) => p.amount_cents);
    const platformFee = sumBy(
      ledgerRows.filter((l) => l.kind === 'application_fee'),
      (l) => l.amount_cents - l.reversed_cents,
    );
    const headCoachSplit = sumBy(
      ledgerRows.filter((l) => l.kind === 'head_coach_split'),
      (l) => l.amount_cents - l.reversed_cents,
    );
    const sellerGross = sumBy(
      ledgerRows.filter((l) => l.kind === 'destination'),
      (l) => l.amount_cents - l.reversed_cents,
    );
    const ledgerReversed = sumBy(ledgerRows, (l) => l.reversed_cents);
    const refundsCents = sumBy(refunds, (r) => r.amount_cents);
    const disputesOpen = disputes.filter(
      (d) => !d.closed_at && d.status !== 'won' && d.status !== 'lost',
    ).length;
    const disputesLost = sumBy(
      disputes.filter((d) => d.status === 'lost'),
      (d) => d.amount_cents,
    );

    // Group breakdown.
    const groupMap = new Map<
      string,
      {
        label: string;
        gmv_cents: number;
        platform_fee_cents: number;
        head_coach_split_cents: number;
        seller_gross_cents: number;
        refunds_cents: number;
        purchases_count: number;
      }
    >();
    const ensure = (key: string, label: string) => {
      let g = groupMap.get(key);
      if (!g) {
        g = {
          label,
          gmv_cents: 0,
          platform_fee_cents: 0,
          head_coach_split_cents: 0,
          seller_gross_cents: 0,
          refunds_cents: 0,
          purchases_count: 0,
        };
        groupMap.set(key, g);
      }
      return g;
    };
    const bucketKey = (d: Date | null | undefined): string => {
      if (!d) return 'unknown';
      const date = new Date(d);
      if (groupBy === 'month') {
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      return date.toISOString().slice(0, 10);
    };
    for (const p of purchases) {
      const key =
        groupBy === 'coach'
          ? p.coach_user_id
          : bucketKey(p.created_at);
      const g = ensure(key, key);
      g.gmv_cents += p.amount_cents;
      g.purchases_count += 1;
    }
    for (const l of ledgerRows) {
      const key =
        groupBy === 'coach'
          ? l.payee_user_id ?? '__platform__'
          : bucketKey(l.posted_at);
      const g = ensure(key, key);
      if (l.kind === 'application_fee') {
        g.platform_fee_cents += l.amount_cents - l.reversed_cents;
      } else if (l.kind === 'head_coach_split') {
        g.head_coach_split_cents += l.amount_cents - l.reversed_cents;
      } else if (l.kind === 'destination') {
        g.seller_gross_cents += l.amount_cents - l.reversed_cents;
      }
    }
    for (const r of refunds) {
      // Refunds don't carry coach_user_id directly — pull from the
      // purchase via the lookup map.
      const purchase = purchases.find((p) => p.id === r.purchase_id);
      const key =
        groupBy === 'coach'
          ? purchase?.coach_user_id ?? '__unknown__'
          : bucketKey(r.created_at);
      const g = ensure(key, key);
      g.refunds_cents += r.amount_cents;
    }

    const groups = Array.from(groupMap.entries())
      .map(([key, g]) => ({
        key,
        label: g.label,
        gmv_cents: g.gmv_cents,
        platform_fee_cents: g.platform_fee_cents,
        head_coach_split_cents: g.head_coach_split_cents,
        seller_gross_cents: g.seller_gross_cents,
        refunds_cents: g.refunds_cents,
        purchases_count: g.purchases_count,
      }))
      .sort((a, b) => {
        if (groupBy === 'coach') return b.gmv_cents - a.gmv_cents;
        return a.key.localeCompare(b.key);
      });

    return {
      window: { from, to },
      gmv_cents: gmv,
      platform_fee_cents: platformFee,
      head_coach_split_cents: headCoachSplit,
      seller_gross_cents: sellerGross,
      ledger_reversed_cents: ledgerReversed,
      refunds_cents: refundsCents,
      refund_count: refunds.length,
      disputes_open: disputesOpen,
      disputes_lost_cents: disputesLost,
      purchases_count: purchases.length,
      active_coaches: accounts.length,
      payouts_ready_coaches: snapshots.length,
      groups,
    };
  }

  async getCoachEarnings(coachUserId: string, opts: {
    from?: Date;
    to?: Date;
  }): Promise<CoachEarningsSummary> {
    const to = opts.to ?? new Date();
    const from =
      opts.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [asSellerLedger, asHeadCoachLedger, sellerPurchases, snapshot, refunds] =
      await Promise.all([
        this.prisma.splitLedgerEntry.findMany({
          where: {
            payee_user_id: coachUserId,
            kind: 'destination',
            created_at: { gte: from, lte: to },
          },
        }),
        this.prisma.splitLedgerEntry.findMany({
          where: {
            payee_user_id: coachUserId,
            kind: 'head_coach_split',
            created_at: { gte: from, lte: to },
          },
        }),
        this.prisma.clientPurchase.findMany({
          where: {
            coach_user_id: coachUserId,
            created_at: { gte: from, lte: to },
          },
        }),
        this.prisma.payoutSnapshot.findUnique({
          where: { coach_user_id: coachUserId },
        }),
        this.prisma.chargeRefund.findMany({
          where: {
            purchase_id: { in: [] as string[] },
            status: 'succeeded',
          },
        }),
      ]);
    // Pull refunds attached to the seller's purchases in window.
    const purchaseIds = sellerPurchases.map((p) => p.id);
    const refundRows =
      purchaseIds.length === 0
        ? []
        : await this.prisma.chargeRefund.findMany({
            where: {
              purchase_id: { in: purchaseIds },
              status: 'succeeded',
              created_at: { gte: from, lte: to },
            },
          });

    const sellerSums = bucketByStatus(asSellerLedger);
    const headCoachSums = bucketByStatus(asHeadCoachLedger);

    const subCoaches = new Set<string>();
    if (asHeadCoachLedger.length) {
      const purchaseIdsHC = asHeadCoachLedger.map((l) => l.purchase_id);
      const sellerOwners = await this.prisma.clientPurchase.findMany({
        where: { id: { in: purchaseIdsHC } },
        select: { coach_user_id: true },
      });
      for (const row of sellerOwners) subCoaches.add(row.coach_user_id);
    }

    // refundRows is unused above — keep the variable name short
    void refunds;

    return {
      coach_user_id: coachUserId,
      window: { from, to },
      as_seller: {
        gross_cents:
          sellerSums.posted_cents + sellerSums.pending_cents,
        posted_cents: sellerSums.posted_cents,
        pending_cents: sellerSums.pending_cents,
        reversed_cents: sellerSums.reversed_cents,
        refunds_cents: sumBy(refundRows, (r) => r.amount_cents),
        purchases_count: sellerPurchases.length,
      },
      as_head_coach: {
        gross_cents:
          headCoachSums.posted_cents + headCoachSums.pending_cents,
        posted_cents: headCoachSums.posted_cents,
        pending_cents: headCoachSums.pending_cents,
        reversed_cents: headCoachSums.reversed_cents,
        sub_coaches_count: subCoaches.size,
      },
      last_payout: {
        stripe_id: snapshot?.last_payout_stripe_id ?? null,
        amount_cents: snapshot?.last_payout_amount_cents ?? null,
        status: snapshot?.last_payout_status ?? null,
        arrival_at: snapshot?.last_payout_arrival_at ?? null,
      },
      available_cents: snapshot?.available_cents ?? 0,
      pending_cents: snapshot?.pending_cents ?? 0,
    };
  }
}

function sumBy<T>(rows: T[], pick: (r: T) => number | null | undefined): number {
  let total = 0;
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

function bucketByStatus(
  rows: Array<{ status: string; amount_cents: number; reversed_cents: number }>,
): { posted_cents: number; pending_cents: number; reversed_cents: number } {
  let posted = 0;
  let pending = 0;
  let reversed = 0;
  for (const r of rows) {
    if (r.status === 'posted') posted += r.amount_cents - r.reversed_cents;
    else if (r.status === 'pending') pending += r.amount_cents;
    reversed += r.reversed_cents;
  }
  return { posted_cents: posted, pending_cents: pending, reversed_cents: reversed };
}
