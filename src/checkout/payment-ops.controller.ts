import {
  Body,
  Controller,
  ForbiddenException,
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
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import { SplitLedgerService } from '../connect/fees/split-ledger.service';
import { PrismaService } from '../prisma.service';
import { DunningService } from './dunning.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';

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
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminPaymentOpsController {
  constructor(
    private prisma: PrismaService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private dunning: DunningService,
    private splits: PurchaseSplitHandlerService,
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
  ) {}

  // Coach's own purchases — same data the OWNER drill-down view exposes,
  // but scoped to this coach.
  @Get('purchases')
  async listOwn(@Request() req: AuthedRequest) {
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: req.user.id },
      orderBy: { created_at: 'desc' },
    });
    return { purchases: rows };
  }

  @Get('purchases/:id')
  async getOwn(
    @Request() req: AuthedRequest,
    @Param('id') purchaseId: string,
  ) {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) {
      throw new NotFoundException({
        error: 'PURCHASE_NOT_FOUND',
        message: `No purchase with id ${purchaseId}`,
      });
    }
    if (purchase.coach_user_id !== req.user.id && req.user.role !== 'owner') {
      throw new ForbiddenException({
        error: 'NOT_YOUR_PURCHASE',
        message: 'Coaches can only inspect their own purchases',
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
  @Get('fee-policy')
  async getOwnFeePolicy(@Request() req: AuthedRequest) {
    const [policy, override] = await Promise.all([
      this.feePolicy.resolvePolicy(req.user.id),
      this.prisma.feePolicy.findUnique({ where: { coach_id: req.user.id } }),
    ]);
    return { policy, override };
  }
}
