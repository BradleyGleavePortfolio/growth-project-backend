import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { once } from 'events';
import type { Response } from 'express';
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
import {
  CursorPageQueryDto,
  PAYMENT_OPS_DEFAULT_LIMIT,
  csvHeaderLine,
  csvRowLine,
} from './payment-ops.dto';

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
// P1: Write a chunk to a streaming response while honoring writable
// backpressure. `res.write()` returns false once Node's internal socket
// buffer fills up (e.g. a slow/stalled client). When that happens we MUST
// stop producing and await the 'drain' event before writing more, otherwise
// the buffer (and process memory) grows unbounded with ledger size and the
// O(batchSize) request-memory bound is a lie. Awaiting 'drain' caps in-flight
// memory to roughly one batch + the kernel socket buffer.
async function writeWithBackpressure(
  res: Response,
  chunk: string,
): Promise<void> {
  if (!res.write(chunk)) {
    await once(res, 'drain');
  }
}

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
  @ApiOperation({
    summary: 'List purchases (owner global view, filter by status/coach/client)',
  })
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
  @ApiOperation({
    summary: 'Inspect one purchase: ledger, transfers, dunning, reminders',
  })
  @ApiResponse({ status: 404, description: 'PURCHASE_NOT_FOUND' })
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
  @ApiOperation({ summary: 'List active dunning rows (the failed-payments feed)' })
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
  @ApiOperation({ summary: 'List Connect transfers, optionally filtered by status' })
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
  @ApiOperation({
    summary: 'Global split-ledger view (filter by kind/status/payee)',
  })
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
  @ApiOperation({ summary: 'Manually run the transfer retry sweeper' })
  async runTransferSweeper() {
    return this.splits.runTransferSweeper();
  }

  // Manually trigger the dunning sweeper — cancels any purchase whose
  // grace period has elapsed.
  @Post('dunning/run-sweeper')
  @ApiOperation({ summary: 'Manually run the dunning sweeper' })
  async runDunningSweeper() {
    return this.dunning.runSweeper();
  }

  // DUNNING-V1 — admin override surface. View / advance / reset / cancel /
  // trigger-immediate for one purchase. The Linear / Stripe-style payment-
  // ops dashboard binds buttons directly to these.
  @Get('dunning/:purchaseId')
  @ApiOperation({ summary: 'Get dunning admin view for a purchase' })
  @ApiResponse({ status: 404, description: 'DUNNING_NOT_FOUND' })
  async getDunningState(@Param('purchaseId') purchaseId: string) {
    const view = await this.dunning.getAdminView(purchaseId);
    if (!view.state && !view.purchase) {
      throw new NotFoundException({
        error: 'DUNNING_NOT_FOUND',
        message: `No dunning state or purchase for id ${purchaseId}`,
      });
    }
    return view;
  }

  @Post('dunning/:purchaseId/advance')
  @ApiOperation({ summary: 'Advance the dunning state for a purchase' })
  async advanceDunning(@Param('purchaseId') purchaseId: string) {
    try {
      return await this.dunning.adminAdvance(purchaseId);
    } catch (err) {
      throw new BadRequestException({
        error: 'DUNNING_ADVANCE_FAILED',
        message: (err as Error).message,
      });
    }
  }

  @Post('dunning/:purchaseId/reset')
  @ApiOperation({ summary: 'Reset the dunning state for a purchase' })
  async resetDunning(@Param('purchaseId') purchaseId: string) {
    try {
      return await this.dunning.adminReset(purchaseId);
    } catch (err) {
      throw new BadRequestException({
        error: 'DUNNING_RESET_FAILED',
        message: (err as Error).message,
      });
    }
  }

  @Post('dunning/:purchaseId/cancel')
  @ApiOperation({ summary: 'Cancel dunning for a purchase' })
  async cancelDunning(@Param('purchaseId') purchaseId: string) {
    return this.dunning.adminCancel(purchaseId);
  }

  @Post('dunning/:purchaseId/trigger')
  @ApiOperation({ summary: 'Trigger an immediate dunning reminder' })
  async triggerDunningReminder(@Param('purchaseId') purchaseId: string) {
    try {
      return await this.dunning.adminTriggerImmediate(purchaseId);
    } catch (err) {
      throw new BadRequestException({
        error: 'DUNNING_TRIGGER_FAILED',
        message: (err as Error).message,
      });
    }
  }

  // Read the in-process dunning metrics counter — used by ops dashboards
  // and Prometheus scrape for the entered/recovered/escalated/cancelled
  // funnel.
  @Get('dunning/metrics/snapshot')
  @ApiOperation({ summary: 'Read the in-process dunning metrics counter' })
  async getDunningMetrics() {
    return { metrics: this.dunning.metrics.snapshot() };
  }

  // Inspect a coach's effective fee policy (default + override).
  @Get('coaches/:id/fee-policy')
  @ApiOperation({ summary: "Inspect a coach's effective fee policy" })
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
  @ApiOperation({ summary: "Update a coach's fee-policy override" })
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
  @ApiOperation({ summary: "Inspect a coach's Connect readiness" })
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
  @ApiOperation({ summary: "Get a coach's cached payout readiness" })
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
  @ApiOperation({ summary: "Live Stripe balance + recent payouts for a coach" })
  @ApiResponse({ status: 404, description: 'CONNECT_ACCOUNT_NOT_FOUND' })
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
  @ApiOperation({ summary: "Recent Stripe balance transactions for a coach" })
  @ApiResponse({ status: 404, description: 'CONNECT_ACCOUNT_NOT_FOUND' })
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
  @ApiOperation({ summary: 'Manually run the payout-readiness stale sweeper' })
  async runPayoutReadinessSweeper(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '25', 10) || 25, 100);
    return this.payoutReadiness.runStaleSweep(limit);
  }

  // --- Phase 6 — Reconciliation ---

  // Reconcile one purchase against Stripe's books (live). Hits Stripe
  // for charge + refund detail; persists a ReconciliationSnapshot.
  @Get('reconciliation/:purchaseId')
  @ApiOperation({ summary: 'Reconcile one purchase against Stripe (live)' })
  async getReconciliation(@Param('purchaseId') purchaseId: string) {
    return this.reconciliation.reconcilePurchase(purchaseId);
  }

  // List purchases currently in `drift` — the "needs review" tab.
  @Get('reconciliation/drift/list')
  @ApiOperation({ summary: 'List purchases currently in reconciliation drift' })
  async listReconciliationDrift(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500);
    return { drift: await this.reconciliation.listDrift(limit) };
  }

  // Manually trigger the reconciliation sweeper.
  @Post('reconciliation/run-sweeper')
  @ApiOperation({ summary: 'Manually run the reconciliation sweeper' })
  async runReconciliationSweeper(@Query('limit') limitRaw?: string) {
    const limit = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);
    return this.reconciliation.runSweep(limit);
  }

  // --- Phase 6 — Refunds / Disputes ---

  @Get('refunds')
  @ApiOperation({ summary: 'List refunds, optionally filtered by status/purchase' })
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
  @ApiOperation({ summary: 'List disputes, optionally filtered by status/purchase' })
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
  @ApiOperation({ summary: 'Issue an admin refund (full or partial)' })
  @ApiResponse({ status: 400, description: 'AMOUNT_INVALID' })
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
  @ApiOperation({ summary: 'Enterprise revenue rollup (from/to/groupBy)' })
  @ApiResponse({ status: 400, description: 'GROUP_BY_INVALID' })
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
  @ApiOperation({ summary: "Per-coach earnings rollup (from/to)" })
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
  @ApiOperation({
    summary: "List the calling coach's own purchases (cursor-paginated)",
  })
  async listOwn(
    @Request() req: AuthedRequest,
    @Query() query: CursorPageQueryDto,
  ) {
    // Bounded cursor pagination (B5): cap `take` so the query can never be
    // unbounded, and keep the coach_user_id scope intact so a coach only
    // ever sees their own purchases (RLS/IDOR). Fetch limit+1 to decide
    // whether there's a next page without a second count query.
    const limit = query.limit ?? PAYMENT_OPS_DEFAULT_LIMIT;
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: req.user.id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > limit;
    const purchases = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor = hasMore ? purchases[purchases.length - 1].id : null;
    return { purchases, next_cursor };
  }

  // Coach drill-down on one purchase. Lookup is scoped by
  // `coach_user_id` for non-owner callers and unscoped for OWNER, so
  // missing rows and foreign-owned rows both collapse into a 404
  // PURCHASE_NOT_FOUND (no 403-vs-404 enumeration of other coaches'
  // purchase IDs). Students must never reach this surface.
  @Roles('coach', 'owner')
  @Get('purchases/:id')
  @ApiOperation({ summary: "Inspect one of the coach's own purchases" })
  @ApiResponse({ status: 404, description: 'PURCHASE_NOT_FOUND' })
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
  @ApiOperation({
    summary:
      "List the coach's earnings ledger (cursor-paginated) with a full-ledger summary",
  })
  async earnings(
    @Request() req: AuthedRequest,
    @Query() query: CursorPageQueryDto,
  ) {
    // B6: the page of entries is now bounded + cursor-paginated, and the
    // `summary` is computed over the FULL payee ledger via an aggregate
    // (groupBy) — NOT just the returned page — so the money totals are
    // correct even past the old hardcoded 200-row truncation.
    const limit = query.limit ?? PAYMENT_OPS_DEFAULT_LIMIT;
    const [summary, rows] = await Promise.all([
      this.computeEarningsSummary(req.user.id),
      this.prisma.splitLedgerEntry.findMany({
        where: { payee_user_id: req.user.id },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.cursor
          ? { cursor: { id: query.cursor }, skip: 1 }
          : {}),
      }),
    ]);
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor = hasMore ? entries[entries.length - 1].id : null;
    return { summary, entries, next_cursor };
  }

  // CSV export of the coach's FULL earnings ledger, scoped strictly to
  // req.user.id as payee. Streamed in id-stable cursor batches so the route
  // never issues an unbounded single query yet still returns every row.
  @Roles('coach', 'owner')
  @Get('earnings/export.csv')
  @ApiOperation({
    summary: "Export the coach's full earnings ledger as CSV (payee-scoped)",
  })
  @ApiResponse({ status: 200, description: 'text/csv attachment' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async exportEarningsCsv(
    @Request() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="earnings-${stamp}.csv"`,
    );
    const columns = [
      'id',
      'purchase_id',
      'kind',
      'status',
      'amount_cents',
      'reversed_cents',
      'currency',
      'stripe_charge_id',
      'stripe_transfer_id',
      'posted_at',
      'reversed_at',
      'created_at',
    ] as const;
    // P1: TRUE streaming export. We write the header and then each bounded
    // DB batch DIRECTLY to the response stream and immediately discard it —
    // no `rows` accumulator and no full-CSV string is ever materialized, so
    // total request memory stays O(batchSize) regardless of ledger size
    // (millions of rows will not OOM the process). Each query is still
    // capped via the id-stable cursor, and there is NO total-row cap: the
    // loop drains the entire payee-scoped ledger.
    //
    // Two robustness properties are enforced below:
    //   1. BACKPRESSURE: every write goes through writeWithBackpressure(),
    //      so when the client is slow and the socket buffer fills we await
    //      'drain' before fetching/writing the next batch. This bounds
    //      in-flight memory to ~one batch instead of letting Node buffer the
    //      whole ledger.
    //   2. EARLY EXIT ON DISCONNECT: if the client aborts ('close') or the
    //      stream errors, we stop the DB loop immediately instead of paging
    //      through (potentially millions of) rows for a consumer that is no
    //      longer there.
    let clientGone = false;
    const stop = () => {
      clientGone = true;
    };
    res.once('error', stop);
    res.once('close', stop);
    await writeWithBackpressure(res, csvHeaderLine(columns) + '\r\n');
    const batchSize = 500;
    let cursorId: string | undefined;
    for (;;) {
      if (clientGone) return;
      const batch = await this.prisma.splitLedgerEntry.findMany({
        where: { payee_user_id: req.user.id },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      // Serialize this batch into a single chunk and flush it, then drop the
      // reference so the GC can reclaim it before the next round-trip.
      let chunk = '';
      for (const e of batch) {
        chunk += csvRowLine(columns, e as unknown as Record<string, unknown>);
        chunk += '\r\n';
      }
      if (clientGone) return;
      await writeWithBackpressure(res, chunk);
      if (batch.length < batchSize) break;
      cursorId = batch[batch.length - 1].id;
    }
    if (clientGone) return;
    res.end();
  }

  // Roll up the coach's gross earnings by status over the FULL ledger
  // using a single grouped aggregate (no per-row scan / N+1). The math
  // mirrors the original inline rollup:
  //   posted   = sum(amount) - sum(reversed)  on posted rows
  //   pending  = sum(amount)                  on pending rows
  //   reversed = sum(amount)                  on reversed rows
  private async computeEarningsSummary(payeeUserId: string): Promise<{
    posted_cents: number;
    pending_cents: number;
    reversed_cents: number;
  }> {
    const grouped = await this.prisma.splitLedgerEntry.groupBy({
      by: ['status'],
      where: { payee_user_id: payeeUserId },
      _sum: { amount_cents: true, reversed_cents: true },
    });
    const summary = { posted_cents: 0, pending_cents: 0, reversed_cents: 0 };
    for (const g of grouped) {
      const amount = g._sum.amount_cents ?? 0;
      const reversed = g._sum.reversed_cents ?? 0;
      if (g.status === 'posted') summary.posted_cents += amount - reversed;
      else if (g.status === 'pending') summary.pending_cents += amount;
      else if (g.status === 'reversed') summary.reversed_cents += amount;
    }
    return summary;
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
  @ApiOperation({ summary: "List failed/past-due purchases on the coach's roster" })
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
  @ApiOperation({ summary: "Get the calling coach's effective fee policy" })
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
  @ApiOperation({ summary: "Get the calling coach's payout readiness" })
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
  @ApiOperation({ summary: "Get the calling coach's earnings summary (from/to)" })
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
