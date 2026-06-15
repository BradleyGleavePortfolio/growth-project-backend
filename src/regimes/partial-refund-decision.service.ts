/**
 * PartialRefundDecisionService — F2 coach-decision surface for partial refunds.
 *
 * Operator decision (F2 brief §4): a FULL refund already cancels pending drops
 * (PR-16, untouched). A PARTIAL refund must NOT auto-cancel — instead the coach
 * gets a decision card on the affected client offering "Keep drops" or
 * "Unassign drops".
 *
 * Hook: RefundDisputeHandlerService calls `onPartialRefund` when a ChargeRefund
 * is applied whose cumulative amount stays below the purchase amount (so
 * `entitlement_active` remains true). We create a PartialRefundDecision with
 * decision='pending'. The row is keyed on the unique stripe_refund_id so Stripe
 * webhook redelivery collapses to the same pending decision (idempotent).
 *
 * The hook is also gated by FEATURE_NAMED_REGIMES — while the flag is OFF no
 * decision rows are written, so the feature is invisible end-to-end.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { isNamedRegimesEnabled } from './named-regimes.feature';

export interface PendingRefundDecisionItem {
  id: string;
  client_purchase_id: string;
  stripe_refund_id: string;
  decision: string;
  created_at: Date;
  client_user_id: string;
  amount_cents: number;
}

@Injectable()
export class PartialRefundDecisionService {
  private readonly logger = new Logger(PartialRefundDecisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fanout: PurchaseFanoutService,
  ) {}

  /**
   * Create a pending coach-decision row for a partial refund. Called from the
   * refund webhook handler AFTER the ChargeRefund row is applied and the
   * purchase-level state has been (or stays) entitlement_active=true.
   *
   * No-op when the feature flag is OFF. Idempotent under Stripe redelivery via
   * the unique stripe_refund_id (a duplicate insert is swallowed as a no-op).
   *
   * @returns true when a new pending row was created, false otherwise.
   */
  async onPartialRefund(
    args: {
      client_purchase_id: string;
      stripe_refund_id: string;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!isNamedRegimesEnabled()) return false;

    const db = (tx as unknown as PrismaService) ?? this.prisma;

    const existing = await db.partialRefundDecision.findUnique({
      where: { stripe_refund_id: args.stripe_refund_id },
      select: { id: true },
    });
    if (existing) return false;

    await db.partialRefundDecision.create({
      data: {
        client_purchase_id: args.client_purchase_id,
        stripe_refund_id: args.stripe_refund_id,
        decision: 'pending',
      },
    });
    this.logger.log(
      `onPartialRefund: pending decision created for purchase=${args.client_purchase_id} refund=${args.stripe_refund_id}`,
    );
    return true;
  }

  /**
   * List pending partial-refund decisions for the calling coach. Joined to the
   * purchase so the mobile card can show which client + amount is affected.
   */
  async listPendingForCoach(
    coachUserId: string,
  ): Promise<PendingRefundDecisionItem[]> {
    const rows = await this.prisma.partialRefundDecision.findMany({
      where: {
        decision: 'pending',
        client_purchase: { coach_user_id: coachUserId },
      },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        client_purchase_id: true,
        stripe_refund_id: true,
        decision: true,
        created_at: true,
        client_purchase: {
          select: { client_user_id: true, amount_cents: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      client_purchase_id: r.client_purchase_id,
      stripe_refund_id: r.stripe_refund_id,
      decision: r.decision,
      created_at: r.created_at,
      client_user_id: r.client_purchase.client_user_id,
      amount_cents: r.client_purchase.amount_cents,
    }));
  }

  /**
   * Apply a coach decision to a pending partial-refund decision.
   *   - 'keep_drops'     => mark decided, leave ScheduledDrops untouched.
   *   - 'unassign_drops' => mark decided AND cancel the buyer's pending/due
   *                          drops via cancelPendingForPurchase.
   *
   * Validates the decision row exists, is still pending, and belongs to the
   * calling coach (404 otherwise so another coach's decision is never leaked).
   * The decision write + drop-cancel run in one transaction.
   */
  async decide(
    coachUserId: string,
    stripeRefundId: string,
    decision: 'keep_drops' | 'unassign_drops',
  ): Promise<{ id: string; decision: string; drops_canceled: number }> {
    const row = await this.prisma.partialRefundDecision.findUnique({
      where: { stripe_refund_id: stripeRefundId },
      select: {
        id: true,
        decision: true,
        client_purchase_id: true,
        client_purchase: { select: { coach_user_id: true } },
      },
    });
    if (!row || row.client_purchase.coach_user_id !== coachUserId) {
      throw new NotFoundException('Refund decision not found');
    }
    if (row.decision !== 'pending') {
      throw new NotFoundException('Refund decision already decided');
    }

    let dropsCanceled = 0;
    await this.prisma.$transaction(async (tx) => {
      // WHERE-guard on decision='pending' makes the decision write idempotent:
      // a concurrent second decide matches zero rows.
      await tx.partialRefundDecision.updateMany({
        where: { id: row.id, decision: 'pending' },
        data: {
          decision,
          decided_at: new Date(),
          decided_by_coach_id: coachUserId,
        },
      });

      if (decision === 'unassign_drops') {
        dropsCanceled = await this.fanout.cancelPendingForPurchase(
          row.client_purchase_id,
          'partial_refund_decision',
          tx,
        );
      }
    });

    this.logger.log(
      `decide: refund=${stripeRefundId} decision=${decision} drops_canceled=${dropsCanceled} by coach=${coachUserId}`,
    );
    return { id: row.id, decision, drops_canceled: dropsCanceled };
  }
}
