import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../connect/fees/payout-readiness.service';
import { ReconciliationService } from '../connect/fees/reconciliation.service';
import { SplitLedgerService } from '../connect/fees/split-ledger.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';
import { AdminAnalyticsService, type RollupGroupBy } from './admin-analytics.service';
import { DunningService } from './dunning.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';
import { RefundDisputeHandlerService } from './refund-dispute-handler.service';

// /v1/admin/payments — OWNER-only payment-ops inspection.
//
// Three jobs:
//   1. Inspect any purchase: status, ledger entries (who got what),
//      pending or failed transfers, dunning state, reminder history.
//   2. List globally failing transfers / active dunning windows so an
//      operator can see what's currently breaking.
//   3. Manually trigger the retry sweepers for transfers and dunning
//      so on-call has a "run it now" button.
//
// All routes are OWNER-gated. There is also a separate /v1/coach/payments
// surface where a coach can read their OWN purchases / failed payments /
// dunning state (no cross-coach data leakage).
@ApiTags('admin-payments')
@Controller('v1/admin/payments')
@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard)
@Roles('owner')
export class AdminPaymentOpsController {
  constructor(
    private prisma: PrismaService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private dunning: DunningService,
    private splits: PurchaseSplitHandlerService,
    // Phase 6-7 — payout readiness, reconciliation, refund/dispute admin
    // entry points, and enterprise rollups. All optional so the legacy
    // unit-test wiring still constructs the controller.
    private payoutReadiness: PayoutReadinessService,
    private reconciliation: ReconciliationService,
    private refundDispute: RefundDisputeHandlerService,
    private analytics: AdminAnalyticsService,
    private stripeConnect: StripeConnectApiService,
  ) {}

  // List purchases, optionally filtered by status / coach / client.
  // Owner-side global view — useful for finding the offending row when
  // support asks "where's my payment".
  @Get('purchases')
  async listPurchases(
    @Query('status') status?: string,
    @Query('coach_user_id') coachUserId?: string,
    @Query('client_user_id') clientUserId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    const rows = await this.prisma.clientPurchase.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(coachUserId ? { coach_user_id: coachUserId } : {}),
        ...(clientUserId ? { client_user_id: clientUserId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return { purchases: rows };
  }

  // Drill-down: full picture for one purchase. Includes ledger, all
  // outgoing transfers, dunning state, and the most recent reminders.
  @Get('purchases/:id')
  async getPurchase(@Param('id') purchaseId: string) {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
      include: { package: true },
    });
    if (!purchase) {
      throw new NotFoundException({
        error: 'PURCHASE_NOT_FOUND',
        message: `No purchase with id ${purchaseId}`,
      });
    }
    const [splitEntries, transfers, dunningState, reminders, policy] =
      await Promise.all([
        this.ledger.findByPurchase(purchase.id),
        this.prisma.connectTransfer.findMany({
          where: { purchase_id: purchase.id },
          orderBy: { created_at: 'desc' },
        }),
        this.prisma.dunningState.findUnique({
          where: { purchase_id: purchase.id },
        }),
        this.prisma.paymentReminder.findMany({
          where: { purchase_id: purchase.id },
          orderBy: { created_at: 'desc' },
          take: 25,
        }),
        this.feePolicy.resolvePolicy(purchase.coach_user_id),
      ]);
    return {
      purchase,
      fee_policy: policy,
      split_ledger: splitEntries,
      transfers,
      dunning: dunningState,
      reminders,
    };
  }

  // Failed payments feed (the dunning queue). Active dunning rows +
  // their last failure metadata. The on-call dashboard reads this.
  @Get('failed')
  async listFailedPayments(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    const rows = await this.prisma.dunningState.findMany({
      where: { status: 'active' },
      orderBy: { last_failure_at: 'desc' },
      take: limit,
    });
    return { failed_payments: rows };
  }

  // Pending / failed transfers across the platform (operationally the
  // same view but two filters).
  @Get('transfers')
  async listTransfers(
    @Query('status') status?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return {
      transfers: await this.prisma.connectTransfer.findMany({
        where: { ...(status ? { status } : {}) },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
    };
  }

  // Global split-ledger view: filterable by kind / status, useful for a
  // payout reconciliation report.
  @Get('ledger')
  async listLedger(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('payee_user_id') payeeUserId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500);
    return {
      ledger: await this.prisma.splitLedgerEntry.findMany({
        where: {
          ...(kind ? { kind } : {}),
          ...(status ? { status } : {}),
          ...(payeeUserId ? { payee_user_id: payeeUserId } : {}),
        },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
    };
  }

  // Manually trigger the transfer sweeper (retry all due-pending transfers).
  // Used when an operator wants to clear the backlog after a Stripe outage.
  @Post('transfers/run-sweeper')
  async runTransferSweeper() {
    return this.splits.runTransferSweeper();
  }

  // Manually trigger the dunning sweeper — cancels any purchase whose
  // grace period has elapsed.
  @Post('dunning/run-sweeper')
  async runDunningSweeper() {
    return this.dunning.runSweeper();
  }

  // Inspect a coach's effective fee policy (default + override).
  @Get('coaches/:id/fee-policy')
  async getCoachFeePolicy(@Param('id') coachId: string) {
    const [policy, override] = await Promise.all([
      this.feePolicy.resolvePolicy(coachId),
      this.prisma.feePolicy.findUnique({ where: { coach_id: coachId } }),
    ]);
    return { policy, override };
  }

  // Update a coach's fee-policy override. Pass null on either field to
  // fall back to the global default.
  @Patch('coaches/:id/fee-policy')
  async updateCoachFeePolicy(
    @Param('id') coachId: string,
    @Body()
    body: {
      platform_application_fee_bps?: number | null;
      head_coach_split_bps?: number | null;
      notes?: string | null;
    },
  ) {
    return this.feePolicy.upsertOverride(coachId, body);
  }

  // Inspect a coach's Connect readiness — for "why can't this coach
  // accept payments" debugging.
  @Get('coaches/:id/connect')
  async getCoachConnect(@Param('id') coachId: string) {
    const [account, packages, purchasesCount] = await Promise.all([
      this.prisma.connectAccount.findUnique({
        where: { coach_user_id: coachId },
      }),
      this.prisma.coachPackage.findMany({
        where: { coach_id: coachId, archived_at: null },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.clientPurchase.count({ where: { coach_user_id: coachId } }),
    ]);
    return {
      account,
      packages,
      lifetime_purchase_count: purchasesCount,
      payment_ready:
        !!account &&
        !!account.charges_enabled &&
        !account.deauthorized_at,
    };
  }

  // --- Phase 6 — Payout readiness ---

  // Cached payout readiness — UI calls this every time the admin opens
  // a coach detail page. Pass ?refresh=true to force a fresh Stripe
  // poll (used by the "refresh" button next to the widget).
  @Get('coaches/:id/payout-readiness')
  async getCoachPayoutReadiness(
    @Param('id') coachId: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.payoutReadiness.getForCoach(coachId, {
      forceRefresh: refresh === 'true' || refresh === '1',
    });
  }

  // Live balance + most-recent payouts straight from Stripe. Reserved for
  // the "deep dive" admin view since each call hits the Stripe API.
  @Get('coaches/:id/balance')
  async getCoachBalance(@Param('id') coachId: string) {
    const account = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachId },
    });
    if (!account) {
      throw new NotFoundException({
        error: 'CONNECT_ACCOUNT_NOT_FOUND',
        message: `No Stripe Connect account for coach ${coachId}`,
      });
    }
    const [balance, payouts] = await Promise.all([
      this.stripeConnect.retrieveBalance(account.stripe_account_id),
      this.stripeConnect.listPayouts({
        connectedAccountId: account.stripe_account_id,
        limit: 10,
      }),
    ]);
    return {
      stripe_account_id: account.stripe_account_id,
      balance,
      payouts: payouts.data,
    };
  }

  // Recent balance transactions on a coach's connected account — exposes
  // the per-charge Stripe processing fee that admins want to see next to
  // platform/seller splits.
  @Get('coaches/:id/balance-transactions')
  async getCoachBalanceTransactions(
    @Param('id') coachId: string,
    @Query('limit') limitRaw?: string,
    @Query('type') type?: string,
  ) {
    const account = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: coachId },
    });
    if (!account) {
      throw new NotFoundException({
        error: 'CONNECT_ACCOUNT_NOT_FOUND',
        message: `No Stripe Connect account for coach ${coachId}`,
      });
    }
    const limit = Math.min(parseInt(limitRaw ?? '25', 10) || 25, 100);
    const txns = await this.stripeConnect.listBalanceTransactions({
      connectedAccountId: account.stripe_account_id,
      limit,
      type,
    });
    return { transactions: txns.data, has_more: txns.has_more ?? false };
  }

  // Manually refresh the payout-snapshot sweeper. Used after a Stripe
  // outage or onboarding-flow change.
  @Post('payout-readiness/run-sweeper')
  async runPayoutReadinessSweeper(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '25', 10) || 25, 100);
    return this.payoutReadiness.runStaleSweep(limit);
  }

  // --- Phase 6 — Reconciliation ---

  // Reconcile one purchase against Stripe's books (live). Hits Stripe
  // for charge + refund detail; persists a ReconciliationSnapshot.
  @Get('reconciliation/:purchaseId')
  async getReconciliation(@Param('purchaseId') purchaseId: string) {
    return this.reconciliation.reconcilePurchase(purchaseId);
  }

  // List purchases currently in `drift` — the "needs review" tab.
  @Get('reconciliation/drift/list')
  async listReconciliationDrift(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500);
    return { drift: await this.reconciliation.listDrift(limit) };
  }

  // Manually trigger the reconciliation sweeper.
  @Post('reconciliation/run-sweeper')
  async runReconciliationSweeper(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return this.reconciliation.runSweep(limit);
  }

  // --- Phase 6 — Refunds / Disputes ---

  @Get('refunds')
  async listRefunds(
    @Query('status') status?: string,
    @Query('purchase_id') purchaseId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return {
      refunds: await this.refundDispute.listRefunds({
        status,
        purchase_id: purchaseId,
        limit,
      }),
    };
  }

  @Get('disputes')
  async listDisputes(
    @Query('status') status?: string,
    @Query('purchase_id') purchaseId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return {
      disputes: await this.refundDispute.listDisputes({
        status,
        purchase_id: purchaseId,
        limit,
      }),
    };
  }

  // Admin-issued refund. amount_cents omitted = full refund.
  @Post('purchases/:id/refund')
  async refundPurchase(
    @Request() req: AuthedRequest,
    @Param('id') purchaseId: string,
    @Body()
    body: {
      amount_cents?: number;
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
      note?: string | null;
    } = {},
  ) {
    if (
      typeof body.amount_cents === 'number' &&
      (!Number.isInteger(body.amount_cents) || body.amount_cents <= 0)
    ) {
      throw new BadRequestException({
        error: 'AMOUNT_INVALID',
        message: 'amount_cents must be a positive integer',
      });
    }
    return this.refundDispute.createAdminRefund({
      purchase_id: purchaseId,
      amount_cents: body.amount_cents,
      reason: body.reason,
      note: body.note,
      initiated_by_user_id: req.user.id,
    });
  }

  // --- Phase 7 — Enterprise rollup ---

  // Big enterprise rollup. Accepts ?from=ISO&to=ISO&groupBy=day|month|coach.
  // Defaults to last 30 days, group by day.
  @Get('rollup')
  async getEnterpriseRollup(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('groupBy') groupBy?: RollupGroupBy,
  ) {
    const from = parseIsoDate(fromRaw);
    const to = parseIsoDate(toRaw);
    if (groupBy && !['day', 'month', 'coach'].includes(groupBy)) {
      throw new BadRequestException({
        error: 'GROUP_BY_INVALID',
        message: "groupBy must be one of 'day' | 'month' | 'coach'",
      });
    }
    return this.analytics.getEnterpriseRollup({ from, to, groupBy });
  }

  @Get('rollup/coaches/:id')
  async getCoachRollup(
    @Param('id') coachId: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    return this.analytics.getCoachEarnings(coachId, {
      from: parseIsoDate(fromRaw),
      to: parseIsoDate(toRaw),
    });
  }
}

// /v1/coach/payments — COACH OR OWNER, self-only. Reads the coach's own
// purchase / split / dunning data. The coach can never see another
// coach's data here — every query is scoped to req.user.id (the
// authenticated coach) and never accepts a coach_id query arg.
@ApiTags('coach-payments')
@Controller('v1/coach/payments')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class CoachPaymentOpsController {
  constructor(
    private prisma: PrismaService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private payoutReadiness: PayoutReadinessService,
    private analytics: AdminAnalyticsService,
  ) {}

  // Coach's own purchases — same data the OWNER drill-down view exposes,
  // but scoped to this coach.
  //
  // Coach inspects own purchase roster (scoped by req.user.id in the
  // service). Never expose to students — leaks other students' purchase
  // identifiers, amounts, and statuses.
  @Roles('coach', 'owner')
  @Get('purchases')
  async listOwn(@Request() req: AuthedRequest) {
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: req.user.id },
      orderBy: { created_at: 'desc' },
    });
    return { purchases: rows };
  }

  // Coach drill-down on one purchase. Lookup is scoped by
  // `coach_user_id` for non-owner callers and unscoped for OWNER, so
  // missing rows and foreign-owned rows both collapse into a 404
  // PURCHASE_NOT_FOUND (no 403-vs-404 enumeration of other coaches'
  // purchase IDs). Students must never reach this surface.
  @Roles('coach', 'owner')
  @Get('purchases/:id')
  async getOwn(
    @Request() req: AuthedRequest,
    @Param('id') purchaseId: string,
  ) {
    const where =
      req.user.role === 'owner'
        ? { id: purchaseId }
        : { id: purchaseId, coach_user_id: req.user.id };
    const purchase = await this.prisma.clientPurchase.findFirst({ where });
    if (!purchase) {
      throw new NotFoundException({
        error: 'PURCHASE_NOT_FOUND',
        message: `No purchase with id ${purchaseId}`,
      });
    }
    const [splitEntries, transfers, dunningState] = await Promise.all([
      this.ledger.findByPurchase(purchase.id),
      this.prisma.connectTransfer.findMany({
        where: { purchase_id: purchase.id },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.dunningState.findUnique({
        where: { purchase_id: purchase.id },
      }),
    ]);
    return {
      purchase,
      split_ledger: splitEntries,
      transfers,
      dunning: dunningState,
    };
  }

  // Coach's lifetime earnings ledger — all `destination` and
  // `head_coach_split` ledger entries where the coach is the payee.
  //
  // Coach reads their own payout ledger (scoped by req.user.id as payee).
  // Exposes amounts, statuses, and reversal history; never let students
  // see this.
  @Roles('coach', 'owner')
  @Get('earnings')
  async earnings(@Request() req: AuthedRequest) {
    const entries = await this.ledger.findByPayee(req.user.id, { limit: 200 });
    // Roll up gross earnings by status.
    const summary = entries.reduce(
      (acc, e) => {
        if (e.status === 'posted') acc.posted_cents += e.amount_cents - e.reversed_cents;
        else if (e.status === 'pending') acc.pending_cents += e.amount_cents;
        else if (e.status === 'reversed') acc.reversed_cents += e.amount_cents;
        return acc;
      },
      { posted_cents: 0, pending_cents: 0, reversed_cents: 0 },
    );
    return { summary, entries };
  }

  // Coach's failed / past-due payments and active dunning windows for
  // the coach's roster — so a coach can see "who on my roster is failing
  // to pay" without going through support.
  //
  // Coach reads dunning state on their own roster (scoped by
  // coach_user_id = req.user.id). Exposes other-student payment-failure
  // PII; must never be reachable by students.
  @Roles('coach', 'owner')
  @Get('failed')
  async failedOnRoster(@Request() req: AuthedRequest) {
    const purchases = await this.prisma.clientPurchase.findMany({
      where: {
        coach_user_id: req.user.id,
        OR: [{ status: 'past_due' }, { status: 'payment_failed' }],
      },
      include: { dunning: true },
      orderBy: { updated_at: 'desc' },
      take: 100,
    });
    return { failed: purchases };
  }

  // Effective fee policy for this coach (default + override). Lets a
  // coach see exactly what cut the platform / head coach is taking.
  //
  // Coach inspects their own fee policy (default + override). Scoped by
  // req.user.id. Students have no fee-policy semantics; OWNER for support.
  @Roles('coach', 'owner')
  @Get('fee-policy')
  async getOwnFeePolicy(@Request() req: AuthedRequest) {
    const [policy, override] = await Promise.all([
      this.feePolicy.resolvePolicy(req.user.id),
      this.prisma.feePolicy.findUnique({ where: { coach_id: req.user.id } }),
    ]);
    return { policy, override };
  }

  // Phase 6 coach-facing — payout readiness for the calling coach. Same
  // cached snapshot the admin endpoint reads, scoped to req.user.id so a
  // coach can never see another coach's payout state.
  //
  // Coach reads their own Stripe Connect payout readiness (charges
  // enabled, payouts enabled, KYC requirements). Scoped by req.user.id;
  // students have no Connect surface.
  @Roles('coach', 'owner')
  @Get('payout-readiness')
  async getOwnPayoutReadiness(
    @Request() req: AuthedRequest,
    @Query('refresh') refresh?: string,
  ) {
    return this.payoutReadiness.getForCoach(req.user.id, {
      forceRefresh: refresh === 'true' || refresh === '1',
    });
  }

  // Phase 7 coach-facing — earnings summary for the calling coach.
  // Accepts ?from=ISO&to=ISO; defaults to last 30 days.
  //
  // Coach reads their own enterprise rollup (gross/net by period).
  // Scoped by req.user.id in the analytics service; students must never
  // see revenue numbers.
  @Roles('coach', 'owner')
  @Get('summary')
  async getOwnEarningsSummary(
    @Request() req: AuthedRequest,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ) {
    return this.analytics.getCoachEarnings(req.user.id, {
      from: parseIsoDate(fromRaw),
      to: parseIsoDate(toRaw),
    });
  }
}

// Internal date-parse helper for ?from/?to query strings.
function parseIsoDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      error: 'DATE_INVALID',
      message: `Could not parse date '${raw}' (expected ISO 8601)`,
    });
  }
  return d;
}
