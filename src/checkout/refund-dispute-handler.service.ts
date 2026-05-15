import { Injectable, Logger } from '@nestjs/common';
import type {
  ChargeDispute,
  ChargeRefund,
  ClientPurchase,
} from '@prisma/client';
import { PayoutReadinessService } from '../connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../connect/fees/transfer-orchestrator.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';

// RefundDisputeHandlerService — webhook + admin-driven side of the
// refund / dispute / payout pipeline.
//
// Refund webhook flow (charge.refunded, charge.refund.updated):
//   1. Resolve ClientPurchase from charge id (via SplitLedgerEntry or
//      ConnectTransfer.source_stripe_charge_id; fall back to PI metadata).
//   2. Upsert ChargeRefund row (idempotent on stripe_refund_id).
//   3. Apply ledger reversals:
//        - destination slice : reversed_cents += refund amount
//        - application_fee slice : reversed_cents += proportional fee
//        - head_coach_split slice : reversed_cents += proportional split
//          AND reverse the underlying ConnectTransfer via Stripe
//          (TransferOrchestrator.reverse).
//   4. If full refund, flip ClientPurchase.status='refunded',
//      entitlement_active=false. Partial refund keeps the purchase
//      otherwise as-is.
//
// Dispute webhook flow (charge.dispute.*):
//   - opened : create ChargeDispute row, flip ClientPurchase.status='disputed'.
//   - closed (won)            : update ChargeDispute.status='won', clear the
//                               disputed flag on the purchase.
//   - closed (lost)           : update status='lost', apply ledger reversal
//                               equal to the dispute amount + the matching
//                               head-coach transfer reversal.
//   - closed (charge_refunded): the issuer issued a refund — Stripe will
//                               also fire charge.refunded; we just mirror
//                               the dispute status.

@Injectable()
export class RefundDisputeHandlerService {
  private readonly logger = new Logger(RefundDisputeHandlerService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private ledger: SplitLedgerService,
    private transfers: TransferOrchestratorService,
    private payoutReadiness: PayoutReadinessService,
  ) {}

  // Webhook entry point — returns claimed=true iff we matched to a
  // ClientPurchase.
  async handle(event: {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    switch (event.type) {
      case 'charge.refunded':
        return this.onChargeRefunded(event);
      case 'charge.refund.updated':
        return this.onRefundUpdated(event);
      case 'charge.dispute.created':
        return this.onDisputeOpened(event);
      case 'charge.dispute.updated':
        return this.onDisputeUpdated(event);
      case 'charge.dispute.closed':
        return this.onDisputeClosed(event);
      case 'transfer.reversed':
        return this.onTransferReversed(event);
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled':
        return this.onPayoutEvent(event);
      default:
        return { claimed: false };
    }
  }

  // --- Refund pipeline ---

  private async onChargeRefunded(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const charge = event.data.object as {
      id?: string;
      amount?: number;
      amount_refunded?: number;
      refunded?: boolean;
      refunds?: { data?: Array<{ id?: string; amount?: number; status?: string; reason?: string | null }> };
    };
    if (!charge?.id) return { claimed: false, reason: 'no_charge_id' };
    const purchase = await this.resolvePurchaseByCharge(charge.id);
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };

    const refunds = charge.refunds?.data ?? [];
    for (const r of refunds) {
      if (!r.id) continue;
      await this.upsertAndApplyRefund({
        purchase,
        stripe_refund_id: r.id,
        stripe_charge_id: charge.id,
        amount_cents: typeof r.amount === 'number' ? r.amount : 0,
        status: r.status ?? 'pending',
        reason: r.reason ?? null,
      });
    }

    // Update purchase-level state.
    const totalAmount =
      typeof charge.amount === 'number' ? charge.amount : purchase.amount_cents;
    const refundedCents =
      typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
    const fullyRefunded = refundedCents >= totalAmount;
    if (fullyRefunded) {
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: { status: 'refunded', entitlement_active: false },
      });
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  private async onRefundUpdated(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const refund = event.data.object as {
      id?: string;
      charge?: string | null;
      amount?: number;
      status?: string;
      failure_reason?: string | null;
    };
    if (!refund?.id) return { claimed: false };
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: refund.id },
    });
    if (!existing) {
      // No-op: we'll see the parent charge.refunded shortly.
      return { claimed: false, reason: 'no_known_refund' };
    }
    await this.prisma.chargeRefund.update({
      where: { stripe_refund_id: refund.id },
      data: {
        status: refund.status ?? existing.status,
        failure_reason: refund.failure_reason ?? null,
      },
    });
    return { claimed: true, purchase_id: existing.purchase_id };
  }

  // Idempotently create a refund row + apply ledger reversals. Safe to
  // re-run with the same payload — composite-unique on stripe_refund_id
  // + ledger.applyReversal monotonically increases reversed_cents.
  async upsertAndApplyRefund(args: {
    purchase: ClientPurchase;
    stripe_refund_id: string;
    stripe_charge_id: string;
    amount_cents: number;
    status: string;
    reason: string | null;
    note?: string | null;
    initiated_by_user_id?: string | null;
  }): Promise<ChargeRefund> {
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: args.stripe_refund_id },
    });
    const row = existing
      ? await this.prisma.chargeRefund.update({
          where: { stripe_refund_id: args.stripe_refund_id },
          data: {
            status: args.status,
            amount_cents: args.amount_cents,
            reason: args.reason ?? existing.reason,
            note: args.note ?? existing.note,
            initiated_by_user_id:
              args.initiated_by_user_id ?? existing.initiated_by_user_id,
            posted_at: args.status === 'succeeded' ? new Date() : existing.posted_at,
          },
        })
      : await this.prisma.chargeRefund.create({
          data: {
            purchase_id: args.purchase.id,
            stripe_refund_id: args.stripe_refund_id,
            stripe_charge_id: args.stripe_charge_id,
            amount_cents: args.amount_cents,
            status: args.status,
            reason: args.reason,
            note: args.note ?? null,
            initiated_by_user_id: args.initiated_by_user_id ?? null,
            posted_at: args.status === 'succeeded' ? new Date() : null,
          },
        });

    // Apply ledger reversals only once per refund (idempotency flag),
    // and only when the refund is actually `succeeded` — pending refunds
    // shouldn't move our books.
    if (args.status !== 'succeeded' || row.ledger_reversed) return row;

    await this.applyLedgerReversal(args.purchase.id, args.amount_cents);
    await this.applyHeadCoachReversal(args.purchase.id, args.amount_cents);

    return this.prisma.chargeRefund.update({
      where: { id: row.id },
      data: { ledger_reversed: true, transfer_reversed: true },
    });
  }

  // Reverses the destination + application_fee ledger slices
  // proportionally to the refund amount.
  private async applyLedgerReversal(
    purchaseId: string,
    refundAmountCents: number,
  ): Promise<void> {
    const entries = await this.ledger.findByPurchase(purchaseId);
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) return;
    const ratio = refundAmountCents / Math.max(purchase.amount_cents, 1);
    for (const entry of entries) {
      if (entry.kind === 'destination' || entry.kind === 'application_fee') {
        const portion = Math.min(
          entry.amount_cents - entry.reversed_cents,
          Math.floor(entry.amount_cents * ratio),
        );
        if (portion > 0) {
          await this.ledger.applyReversal({
            entry_id: entry.id,
            reversed_cents: portion,
          });
        }
      }
    }
  }

  // Reverse the matching head-coach transfer (if any) proportionally.
  // The Stripe `reverse_transfer=true` flag we set on createRefund means
  // Stripe will automatically reverse the destination's portion, but the
  // head-coach split was a SEPARATE Transfer we minted, so Stripe doesn't
  // know about it — we have to reverse that explicitly.
  private async applyHeadCoachReversal(
    purchaseId: string,
    refundAmountCents: number,
  ): Promise<void> {
    const transfer = await this.prisma.connectTransfer.findFirst({
      where: { purchase_id: purchaseId, status: 'succeeded' },
    });
    if (!transfer) return;
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) return;
    const ratio = refundAmountCents / Math.max(purchase.amount_cents, 1);
    const amount = Math.min(
      transfer.amount_cents - transfer.reversed_amount_cents,
      Math.floor(transfer.amount_cents * ratio),
    );
    if (amount <= 0) return;
    try {
      await this.transfers.reverse({
        transfer_row_id: transfer.id,
        amount_cents: amount,
      });
    } catch (err) {
      this.logger.warn(
        `head-coach transfer reverse failed purchase=${purchaseId}: ${(err as Error).message}`,
      );
    }
  }

  // --- Dispute pipeline ---

  private async onDisputeOpened(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    return this.upsertDispute(event, /*initial=*/ true);
  }

  private async onDisputeUpdated(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    return this.upsertDispute(event, /*initial=*/ false);
  }

  private async onDisputeClosed(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const dispute = event.data.object as {
      id?: string;
      charge?: string | null;
      status?: string;
      amount?: number;
      balance_transactions?: Array<{ id: string }>;
    };
    if (!dispute?.id) return { claimed: false };
    const existing = await this.prisma.chargeDispute.findUnique({
      where: { stripe_dispute_id: dispute.id },
    });
    if (!existing) return { claimed: false };
    const updated = await this.prisma.chargeDispute.update({
      where: { stripe_dispute_id: dispute.id },
      data: {
        status: dispute.status ?? existing.status,
        closed_at: new Date(),
        balance_transaction_id:
          dispute.balance_transactions?.[0]?.id ?? existing.balance_transaction_id,
      },
    });
    // On a `lost` outcome, reverse the destination + application_fee
    // ledger slices and reverse any head-coach transfer.
    if (dispute.status === 'lost' && !updated.ledger_reversed) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      if (purchase) {
        await this.applyLedgerReversal(purchase.id, updated.amount_cents);
        await this.applyHeadCoachReversal(purchase.id, updated.amount_cents);
        await this.prisma.chargeDispute.update({
          where: { id: updated.id },
          data: { ledger_reversed: true },
        });
        await this.prisma.clientPurchase.update({
          where: { id: purchase.id },
          data: { status: 'chargeback_lost', entitlement_active: false },
        });
      }
    } else if (dispute.status === 'won') {
      // Clear the disputed flag so the purchase rejoins the normal feed.
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      if (purchase && purchase.status === 'disputed') {
        await this.prisma.clientPurchase.update({
          where: { id: purchase.id },
          data: { status: 'paid' },
        });
      }
    }
    return { claimed: true, purchase_id: updated.purchase_id };
  }

  private async upsertDispute(
    event: { data: { object: Record<string, unknown> } },
    initial: boolean,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const dispute = event.data.object as {
      id?: string;
      charge?: string | null;
      status?: string;
      amount?: number;
      currency?: string;
      reason?: string;
      evidence_details?: { due_by?: number; submission_count?: number };
    };
    if (!dispute?.id || !dispute.charge) return { claimed: false };
    const purchase = await this.resolvePurchaseByCharge(dispute.charge);
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    const dueBy =
      typeof dispute.evidence_details?.due_by === 'number'
        ? new Date(dispute.evidence_details.due_by * 1000)
        : null;
    const row = await this.prisma.chargeDispute.upsert({
      where: { stripe_dispute_id: dispute.id },
      create: {
        purchase_id: purchase.id,
        stripe_dispute_id: dispute.id,
        stripe_charge_id: dispute.charge,
        amount_cents: typeof dispute.amount === 'number' ? dispute.amount : 0,
        currency: dispute.currency ?? 'usd',
        status: dispute.status ?? 'needs_response',
        reason: dispute.reason ?? null,
        evidence_due_by: dueBy,
      },
      update: {
        status: dispute.status ?? 'needs_response',
        reason: dispute.reason ?? null,
        evidence_due_by: dueBy ?? undefined,
        amount_cents: typeof dispute.amount === 'number' ? dispute.amount : undefined,
      },
    });
    if (initial) {
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: { status: 'disputed' },
      });
    }
    return { claimed: true, purchase_id: row.purchase_id };
  }

  // --- Transfer reversed ---

  private async onTransferReversed(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const transfer = event.data.object as {
      id?: string;
      amount_reversed?: number;
      reversed?: boolean;
      metadata?: Record<string, string>;
    };
    if (!transfer?.id) return { claimed: false };
    const row = await this.prisma.connectTransfer.findFirst({
      where: { stripe_transfer_id: transfer.id },
    });
    if (!row) return { claimed: false };
    const fullyReversed = !!transfer.reversed;
    await this.prisma.connectTransfer.update({
      where: { id: row.id },
      data: {
        reversed_amount_cents:
          typeof transfer.amount_reversed === 'number'
            ? transfer.amount_reversed
            : row.reversed_amount_cents,
        status: fullyReversed ? 'reversed' : row.status,
        reversed_at: fullyReversed ? new Date() : row.reversed_at,
      },
    });
    return { claimed: true, purchase_id: row.purchase_id };
  }

  // --- Payouts ---

  private async onPayoutEvent(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string }> {
    const payout = event.data.object as {
      id?: string;
      amount?: number;
      arrival_date?: number;
      failure_message?: string | null;
      account?: string | null; // connected account id (on Connect webhook)
    };
    if (!payout?.id) return { claimed: false };
    const accountId = payout.account;
    if (!accountId) {
      // Payouts from the platform account, not a connected coach — ignore.
      return { claimed: false, reason: 'platform_payout' };
    }
    const status = (event.type.split('.').pop() ?? 'paid') as string;
    await this.payoutReadiness.recordPayoutEvent({
      stripe_account_id: accountId,
      payout_id: payout.id,
      amount_cents: typeof payout.amount === 'number' ? payout.amount : 0,
      status,
      arrival_at:
        typeof payout.arrival_date === 'number'
          ? new Date(payout.arrival_date * 1000)
          : null,
      failure_message: payout.failure_message ?? null,
    });
    return { claimed: true };
  }

  // --- Helpers ---

  // Resolve a ClientPurchase from a Stripe charge id by walking the
  // SplitLedgerEntry table (which we populate at charge time with
  // stripe_charge_id).
  private async resolvePurchaseByCharge(
    chargeId: string,
  ): Promise<ClientPurchase | null> {
    const entry = await this.prisma.splitLedgerEntry.findFirst({
      where: { stripe_charge_id: chargeId, kind: 'destination' },
    });
    if (entry) {
      return this.prisma.clientPurchase.findUnique({
        where: { id: entry.purchase_id },
      });
    }
    // Fallback — pull the PI off the Charge and match on stripe_payment_intent_id.
    try {
      const charge = await this.stripe.retrieveCharge(chargeId);
      const piId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (!piId) return null;
      return this.prisma.clientPurchase.findFirst({
        where: { stripe_payment_intent_id: piId },
      });
    } catch (err) {
      if (err instanceof StripeConnectApiError) {
        this.logger.warn(
          `resolvePurchaseByCharge: Stripe retrieve charge=${chargeId} failed: ${err.message}`,
        );
      }
      return null;
    }
  }

  // --- Admin entry point — POST a refund via our backend ---

  // Issues a refund against a purchase's underlying charge. Handles the
  // ledger + head-coach reversal as part of the same call so the admin
  // gets a consistent response.
  async createAdminRefund(args: {
    purchase_id: string;
    amount_cents?: number; // omit = full
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    note?: string | null;
    initiated_by_user_id: string;
  }): Promise<ChargeRefund> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: args.purchase_id },
    });
    if (!purchase) {
      throw new Error(`createAdminRefund: no purchase ${args.purchase_id}`);
    }
    // Resolve the underlying charge id. For one_time prefer the saved PI;
    // for recurring use the most recent destination ledger slice.
    const chargeId = await this.resolveChargeIdForPurchase(purchase);
    if (!chargeId) {
      throw new Error(
        `createAdminRefund: no charge id for purchase ${purchase.id}`,
      );
    }
    const idempotencyKey = `tgp-refund-${purchase.id}-${args.amount_cents ?? 'full'}-${args.initiated_by_user_id}`;
    const stripe = await this.stripe.createRefund({
      charge_id: chargeId,
      amount: args.amount_cents,
      reason: args.reason,
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: {
        tgp_purchase_id: purchase.id,
        tgp_initiated_by: args.initiated_by_user_id,
      },
      idempotencyKey,
    });
    return this.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: stripe.id,
      stripe_charge_id: chargeId,
      amount_cents: typeof stripe.amount === 'number' ? stripe.amount : args.amount_cents ?? purchase.amount_cents,
      status: stripe.status ?? 'pending',
      reason: args.reason ?? null,
      note: args.note ?? null,
      initiated_by_user_id: args.initiated_by_user_id,
    });
  }

  private async resolveChargeIdForPurchase(
    purchase: ClientPurchase,
  ): Promise<string | null> {
    if (purchase.stripe_payment_intent_id) {
      try {
        const pi = await this.stripe.retrievePaymentIntent(
          purchase.stripe_payment_intent_id,
        );
        const latest =
          typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
        if (latest) return latest;
      } catch (err) {
        this.logger.warn(
          `retrievePaymentIntent failed: ${(err as Error).message}`,
        );
      }
    }
    const entry = await this.prisma.splitLedgerEntry.findFirst({
      where: { purchase_id: purchase.id, kind: 'destination' },
      orderBy: { posted_at: 'desc' },
    });
    return entry?.stripe_charge_id ?? null;
  }

  // Admin entry — list refunds with filters.
  async listRefunds(opts: {
    status?: string;
    purchase_id?: string;
    limit?: number;
  }): Promise<ChargeRefund[]> {
    return this.prisma.chargeRefund.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.purchase_id ? { purchase_id: opts.purchase_id } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }

  async listDisputes(opts: {
    status?: string;
    purchase_id?: string;
    limit?: number;
  }): Promise<ChargeDispute[]> {
    return this.prisma.chargeDispute.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.purchase_id ? { purchase_id: opts.purchase_id } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }
}
