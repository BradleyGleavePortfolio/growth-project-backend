import { Injectable, Logger } from '@nestjs/common';
import type { PayoutSnapshot } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../stripe-connect-api.service';

// PayoutReadinessService — answers "can this coach actually receive
// money right now?" by polling Stripe's Balance + Payouts APIs scoped to
// the coach's connected account and caching the result on a
// PayoutSnapshot row.
//
// readiness_status:
//   ready             — charges_enabled && payouts_enabled && no
//                       currently_due requirements && available_cents > 0.
//                       (Or 0 available but positive pending — that's a
//                       fresh coach with money on the way.)
//   needs_action      — Stripe wants more info (requirements_due not empty,
//                       or disabled_reason set).
//   deauthorized      — ConnectAccount.deauthorized_at is set; the coach
//                       must reconnect.
//   no_account        — no ConnectAccount row at all (caller handles).
//   stripe_unreachable — the readiness probe could not talk to Stripe;
//                       the cached snapshot status is returned with
//                       refreshed_at NOT updated so a stale read is
//                       distinguishable.
//
// The TTL (stale_after) is 15 minutes by default — short enough that a
// coach finishing onboarding sees an updated state on the next admin
// reload, long enough that a dashboard refresh doesn't slam Stripe's
// rate-limited Balance endpoint.

export const PAYOUT_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

// Subset of PayoutSnapshot columns that callers may patch on upsert.
// Includes Json fields as plain unknown so the wrapper can convert
// null -> Prisma.JsonNull before hitting the DB.
interface SnapshotPatch {
  readiness_status?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  disabled_reason?: string | null;
  available_cents?: number;
  pending_cents?: number;
  in_transit_cents?: number;
  reserved_cents?: number;
  requirements_due?: unknown;
  raw_balance?: unknown;
  last_payout_stripe_id?: string | null;
  last_payout_amount_cents?: number | null;
  last_payout_status?: string | null;
  last_payout_arrival_at?: Date | null;
  last_payout_failure_message?: string | null;
}

export type PayoutReadinessStatus =
  | 'ready'
  | 'needs_action'
  | 'deauthorized'
  | 'no_account'
  | 'stripe_unreachable';

export interface PayoutReadinessView {
  coach_user_id: string;
  stripe_account_id: string | null;
  readiness_status: PayoutReadinessStatus;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_due: unknown;
  disabled_reason: string | null;
  available_cents: number;
  pending_cents: number;
  in_transit_cents: number;
  reserved_cents: number;
  currency: string;
  last_payout: {
    stripe_id: string | null;
    amount_cents: number | null;
    status: string | null;
    arrival_at: Date | null;
    failure_message: string | null;
  };
  next_payout_at: Date | null;
  refreshed_at: Date;
  stale: boolean;
}

@Injectable()
export class PayoutReadinessService {
  private readonly logger = new Logger(PayoutReadinessService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
  ) {}

  // Return the cached snapshot if it's fresh; refresh from Stripe otherwise.
  async getForCoach(
    coachUserId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<PayoutReadinessView> {
    const account = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachUserId },
    });
    if (!account) {
      return this.emptyView(coachUserId, 'no_account');
    }
    if (account.deauthorized_at) {
      const snapshot = await this.upsertSnapshot(coachUserId, account.stripe_account_id, {
        readiness_status: 'deauthorized',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: account.details_submitted,
      });
      return this.toView(snapshot, /*stale=*/ false);
    }

    const cached = await this.prisma.payoutSnapshot.findUnique({
      where: { coach_user_id: coachUserId },
    });
    const now = Date.now();
    const fresh =
      cached &&
      !opts.forceRefresh &&
      cached.stale_after &&
      cached.stale_after.getTime() > now;
    if (fresh && cached) {
      return this.toView(cached, /*stale=*/ false);
    }

    // Refresh from Stripe. On failure we still return the cached row
    // (marked stale=true) so the UI degrades gracefully.
    try {
      const refreshed = await this.refresh(coachUserId, account.stripe_account_id);
      return this.toView(refreshed, /*stale=*/ false);
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      this.logger.warn(
        `PayoutReadinessService refresh failed coach=${coachUserId}: ${msg}`,
      );
      if (cached) return this.toView(cached, /*stale=*/ true);
      // No cache yet — synthesize a "stripe_unreachable" view so the UI
      // can render something instead of erroring out.
      return {
        ...this.emptyView(coachUserId, 'stripe_unreachable'),
        stripe_account_id: account.stripe_account_id,
      };
    }
  }

  // Force a refresh and persist. Used on webhook receipt and by the
  // periodic sweeper.
  async refresh(
    coachUserId: string,
    stripeAccountId: string,
  ): Promise<PayoutSnapshot> {
    // Pull account flags + balance + last payout in parallel — three
    // independent reads.
    const [account, balance, payouts] = await Promise.all([
      this.stripe.retrieveAccount(stripeAccountId),
      this.stripe.retrieveBalance(stripeAccountId),
      this.stripe.listPayouts({
        connectedAccountId: stripeAccountId,
        limit: 1,
      }),
    ]);

    const available = pickCurrency(balance.available, 'usd');
    const pending = pickCurrency(balance.pending, 'usd');
    const reserved = pickCurrency(
      (balance.connect_reserved as Array<{ amount: number; currency: string }>) ??
        [],
      'usd',
    );
    // in_transit is the sum of all payouts in `pending|in_transit` state.
    // Stripe Balance doesn't carry it directly, so we re-derive by summing
    // the most recent pending/in_transit payouts in one extra call. Bound
    // to 25 rows — anything more is operationally weird and we'd rather
    // under-report than make this read slow.
    let inTransitCents = 0;
    try {
      const pendingPayouts = await this.stripe.listPayouts({
        connectedAccountId: stripeAccountId,
        limit: 25,
        status: 'in_transit',
      });
      for (const p of pendingPayouts.data ?? []) {
        if (p.currency === 'usd') inTransitCents += p.amount;
      }
    } catch (err) {
      this.logger.warn(
        `listPayouts(in_transit) failed coach=${coachUserId}: ${(err as Error).message}`,
      );
    }

    const requirements = account.requirements as Record<string, unknown> | null | undefined;
    const currentlyDue =
      requirements && Array.isArray(requirements['currently_due'])
        ? (requirements['currently_due'] as unknown[]).length
        : 0;
    const pastDue =
      requirements && Array.isArray(requirements['past_due'])
        ? (requirements['past_due'] as unknown[]).length
        : 0;
    const disabledReason =
      requirements && typeof requirements['disabled_reason'] === 'string'
        ? (requirements['disabled_reason'] as string)
        : null;
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const detailsSubmitted = !!account.details_submitted;

    const readiness = this.computeReadinessStatus({
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      currently_due_count: currentlyDue,
      past_due_count: pastDue,
      disabled_reason: disabledReason,
      available_cents: available,
      pending_cents: pending,
    });

    const lastPayout = payouts.data?.[0] ?? null;

    const snapshot = await this.upsertSnapshot(
      coachUserId,
      stripeAccountId,
      {
        readiness_status: readiness,
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        details_submitted: detailsSubmitted,
        requirements_due:
          requirements && typeof requirements === 'object' && !Array.isArray(requirements)
            ? (requirements as object)
            : null,
        disabled_reason: disabledReason,
        available_cents: available,
        pending_cents: pending,
        in_transit_cents: inTransitCents,
        reserved_cents: reserved,
        raw_balance: balance as unknown as object,
        last_payout_stripe_id: lastPayout?.id ?? null,
        last_payout_amount_cents:
          typeof lastPayout?.amount === 'number' ? lastPayout.amount : null,
        last_payout_status: lastPayout?.status ?? null,
        last_payout_arrival_at: toDate(lastPayout?.arrival_date ?? null),
        last_payout_failure_message: lastPayout?.failure_message ?? null,
      },
    );
    return snapshot;
  }

  // Called from the payout.* webhook handlers to fold a single payout
  // event into the snapshot without a full refresh.
  async recordPayoutEvent(args: {
    stripe_account_id: string;
    payout_id: string;
    amount_cents: number;
    status: string;
    arrival_at: Date | null;
    failure_message: string | null;
  }): Promise<PayoutSnapshot | null> {
    const account = await this.prisma.connectAccount.findUnique({
      where: { stripe_account_id: args.stripe_account_id },
    });
    if (!account) return null;
    // Only overwrite "last_payout_*" fields if this payout is more recent
    // than the cached one. Use arrival_at; fall back to "now" when missing.
    const current = await this.prisma.payoutSnapshot.findUnique({
      where: { coach_user_id: account.coach_user_id },
    });
    const eventTime = args.arrival_at?.getTime() ?? Date.now();
    if (
      current?.last_payout_arrival_at &&
      current.last_payout_arrival_at.getTime() > eventTime
    ) {
      // Keep the existing more-recent record; touch refreshed_at so the
      // UI knows we processed the event.
      return this.prisma.payoutSnapshot.update({
        where: { coach_user_id: account.coach_user_id },
        data: {
          refreshed_at: new Date(),
          stale_after: new Date(Date.now() + PAYOUT_SNAPSHOT_TTL_MS),
        },
      });
    }
    return this.upsertSnapshot(account.coach_user_id, args.stripe_account_id, {
      last_payout_stripe_id: args.payout_id,
      last_payout_amount_cents: args.amount_cents,
      last_payout_status: args.status,
      last_payout_arrival_at: args.arrival_at,
      last_payout_failure_message: args.failure_message,
    });
  }

  // Sweeper hook — refresh the N stalest snapshots. Bounded so a single
  // run doesn't burn Stripe rate limit.
  async runStaleSweep(limit = 25): Promise<{ scanned: number; refreshed: number; failed: number }> {
    const now = new Date();
    const stale = await this.prisma.payoutSnapshot.findMany({
      where: {
        OR: [{ stale_after: null }, { stale_after: { lte: now } }],
      },
      orderBy: { refreshed_at: 'asc' },
      take: limit,
    });
    let refreshed = 0;
    let failed = 0;
    for (const row of stale) {
      try {
        await this.refresh(row.coach_user_id, row.stripe_account_id);
        refreshed += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof StripeConnectApiError) {
          this.logger.warn(
            `sweep refresh failed coach=${row.coach_user_id}: ${err.message}`,
          );
        } else {
          this.logger.warn(
            `sweep refresh failed coach=${row.coach_user_id}: ${(err as Error).message}`,
          );
        }
      }
    }
    return { scanned: stale.length, refreshed, failed };
  }

  // Internal helpers.

  private computeReadinessStatus(args: {
    charges_enabled: boolean;
    payouts_enabled: boolean;
    currently_due_count: number;
    past_due_count: number;
    disabled_reason: string | null;
    available_cents: number;
    pending_cents: number;
  }): PayoutReadinessStatus {
    if (!args.charges_enabled || !args.payouts_enabled) return 'needs_action';
    if (args.past_due_count > 0 || args.currently_due_count > 0) {
      return 'needs_action';
    }
    if (args.disabled_reason) return 'needs_action';
    return 'ready';
  }

  private async upsertSnapshot(
    coachUserId: string,
    stripeAccountId: string,
    patch: SnapshotPatch,
  ): Promise<PayoutSnapshot> {
    const refreshedAt = new Date();
    const staleAfter = new Date(refreshedAt.getTime() + PAYOUT_SNAPSHOT_TTL_MS);
    // Normalize JSON columns so Prisma's `NullableJsonNullValueInput` typing
    // is satisfied (null must be `Prisma.JsonNull`, undefined means "don't touch").
    const requirements =
      patch.requirements_due === undefined
        ? undefined
        : patch.requirements_due === null
          ? Prisma.JsonNull
          : (patch.requirements_due as Prisma.InputJsonValue);
    const rawBalance =
      patch.raw_balance === undefined
        ? undefined
        : patch.raw_balance === null
          ? Prisma.JsonNull
          : (patch.raw_balance as Prisma.InputJsonValue);
    const common = {
      stripe_account_id: stripeAccountId,
      refreshed_at: refreshedAt,
      stale_after: staleAfter,
      readiness_status: patch.readiness_status,
      charges_enabled: patch.charges_enabled,
      payouts_enabled: patch.payouts_enabled,
      details_submitted: patch.details_submitted,
      disabled_reason: patch.disabled_reason,
      available_cents: patch.available_cents,
      pending_cents: patch.pending_cents,
      in_transit_cents: patch.in_transit_cents,
      reserved_cents: patch.reserved_cents,
      requirements_due: requirements,
      raw_balance: rawBalance,
      last_payout_stripe_id: patch.last_payout_stripe_id,
      last_payout_amount_cents: patch.last_payout_amount_cents,
      last_payout_status: patch.last_payout_status,
      last_payout_arrival_at: patch.last_payout_arrival_at,
      last_payout_failure_message: patch.last_payout_failure_message,
    };
    return this.prisma.payoutSnapshot.upsert({
      where: { coach_user_id: coachUserId },
      create: {
        coach_user_id: coachUserId,
        ...common,
      },
      update: common,
    });
  }

  private toView(row: PayoutSnapshot, stale: boolean): PayoutReadinessView {
    return {
      coach_user_id: row.coach_user_id,
      stripe_account_id: row.stripe_account_id,
      readiness_status: row.readiness_status as PayoutReadinessStatus,
      charges_enabled: row.charges_enabled,
      payouts_enabled: row.payouts_enabled,
      details_submitted: row.details_submitted,
      requirements_due: row.requirements_due,
      disabled_reason: row.disabled_reason,
      available_cents: row.available_cents,
      pending_cents: row.pending_cents,
      in_transit_cents: row.in_transit_cents,
      reserved_cents: row.reserved_cents,
      currency: row.currency,
      last_payout: {
        stripe_id: row.last_payout_stripe_id,
        amount_cents: row.last_payout_amount_cents,
        status: row.last_payout_status,
        arrival_at: row.last_payout_arrival_at,
        failure_message: row.last_payout_failure_message,
      },
      next_payout_at: row.next_payout_at,
      refreshed_at: row.refreshed_at,
      stale,
    };
  }

  private emptyView(
    coachUserId: string,
    status: PayoutReadinessStatus,
  ): PayoutReadinessView {
    return {
      coach_user_id: coachUserId,
      stripe_account_id: null,
      readiness_status: status,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: null,
      disabled_reason: null,
      available_cents: 0,
      pending_cents: 0,
      in_transit_cents: 0,
      reserved_cents: 0,
      currency: 'usd',
      last_payout: {
        stripe_id: null,
        amount_cents: null,
        status: null,
        arrival_at: null,
        failure_message: null,
      },
      next_payout_at: null,
      refreshed_at: new Date(0),
      stale: true,
    };
  }
}

function pickCurrency(
  rows: Array<{ amount: number; currency: string }> | undefined,
  currency: string,
): number {
  if (!rows) return 0;
  let total = 0;
  for (const r of rows) {
    if (r.currency === currency) total += r.amount;
  }
  return total;
}

function toDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}
