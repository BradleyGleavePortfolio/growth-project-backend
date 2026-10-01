import { Injectable, Logger } from '@nestjs/common';
import type {
  ChargeSettlement,
  ClientPurchase,
  ConnectTransfer,
  PayeeRecovery,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  computeAdjustedTargets,
  computeChargeSplit,
  railForPaymentMethodType,
  type ChargeAdjustments,
  type ChargeSplit,
} from '../../payouts-v2/platform-fee.service';
import {
  StripeConnectApiService,
  type StripeBalanceTransactionObject,
  type StripeChargeObject,
} from '../stripe-connect-api.service';
import { FeePolicyService } from './fee-policy.service';
import { SplitLedgerService } from './split-ledger.service';
import {
  TransferOrchestratorService,
  type SettlementTransferKind,
} from './transfer-orchestrator.service';

// ChargeSettlementService — S-FEE. Pays the coach their real net for every
// coach-package charge.
//
// Mechanism (Stripe "separate charges and transfers", with on_behalf_of):
//   1. Checkout creates the charge on the platform with on_behalf_of = the
//      coach's connected account and NO transfer_data / application fee.
//   2. When the charge succeeds (checkout.session.completed one-time,
//      payment_intent.succeeded, invoice.paid for every subscription invoice,
//      guest conversion, or the backstop sweeper) we read the charge with its
//      balance_transaction expanded. balance_transaction.fee is Stripe's
//      ACTUAL fee (international card, currency conversion and all).
//   3. computeChargeSplit (PlatformFeeService, the single fee function)
//      splits the gross: coach_net = gross - stripe_fee - 2% - head-coach.
//   4. We transfer coach_net (and the head-coach split) with
//      source_transaction = the charge. TGP keeps exactly its fee, so the
//      platform net of every charge is >= 0.
//
// Refunds / disputes: applyAdjustments re-derives every party's target with
// computeAdjustedTargets and moves each payee to it: post pending transfers,
// reverse posted transfers, and record whatever a reversal cannot recover
// (the non-returned processing fee, a dispute fee, a reversal Stripe refused)
// as a PayeeRecovery that is netted out of that payee's next transfers.
// Stripe: "It's up to your platform to reconcile any amount owed back to it
// by reducing subsequent transfer amounts or by reversing transfers."
//
// Never settled: purchases with amount_cents <= 0 (free packages and $0
// invite-code grants) and $0 charges. They produce no settlement row, no
// ledger slice, no transfer and no recovery.
//
// Legacy: a charge that already carries destination-charge artefacts
// (transfer / transfer_data / application fee) was created before S-FEE (for
// example a renewal of a subscription minted before this change). Stripe has
// already moved the coach's share, so we record a `legacy_destination`
// settlement for reporting and never create an S-FEE transfer for it; the
// caller runs the unchanged legacy head-coach flow.

export const SETTLEMENT_MECHANISM_SCT = 'separate_charge_transfer';
export const SETTLEMENT_MECHANISM_LEGACY = 'legacy_destination';

export type SettleStatus =
  'skipped_free' | 'awaiting_fee' | 'settled' | 'already_settled' | 'legacy_destination';

export interface SettleOutcome {
  status: SettleStatus;
  charge_id: string | null;
  settlement_id: string | null;
  ledger_entries: number;
  transfers_enqueued: number;
  reason?: string;
}

export type AdjustOutcome =
  'adjusted' | 'unchanged' | 'no_settlement' | 'legacy' | 'deferred' | 'skipped_free';

export interface AdjustmentInput {
  purchase: ClientPurchase;
  charge_id: string;
  // Cumulative refunded amount on the charge (sum of succeeded refunds).
  refunded_cents?: number;
  // Current dispute position on the charge (see disputeAmountsFrom).
  dispute?: { withdrawn_cents: number; fee_cents: number };
}

type Leg = {
  leg: 'coach' | 'head_coach';
  payee_user_id: string;
  target_cents: number;
};

type Tx = Prisma.TransactionClient;

// Stripe flags a charge as a pre-S-FEE destination charge when Stripe itself
// moved funds to a connected account (transfer / transfer_data) or collected
// an application fee on it.
export function isLegacyDestinationCharge(charge: StripeChargeObject): boolean {
  if (typeof charge.transfer === 'string' && charge.transfer.length > 0) return true;
  if (charge.transfer_data && charge.transfer_data.destination) return true;
  if (typeof charge.application_fee === 'string' && charge.application_fee.length > 0) {
    return true;
  }
  return typeof charge.application_fee_amount === 'number' && charge.application_fee_amount > 0;
}

// Dispute position from a Stripe Dispute's balance_transactions: the
// principal Stripe withdrew from the platform (net of any reinstatement on a
// won dispute) and the dispute fees Stripe kept (net of any fee returned).
export function disputeAmountsFrom(
  balanceTransactions: Array<{ amount?: number; fee?: number }> | null | undefined,
): { withdrawn_cents: number; fee_cents: number } {
  let amount = 0;
  let fee = 0;
  for (const bt of balanceTransactions ?? []) {
    if (typeof bt.amount === 'number') amount += bt.amount;
    if (typeof bt.fee === 'number') fee += bt.fee;
  }
  return { withdrawn_cents: Math.max(0, -amount), fee_cents: Math.max(0, fee) };
}

function expandedBalanceTransaction(
  charge: StripeChargeObject,
): StripeBalanceTransactionObject | null {
  const bt = charge.balance_transaction;
  if (bt && typeof bt === 'object' && typeof bt.fee === 'number' && typeof bt.amount === 'number') {
    return bt;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function splitOf(row: ChargeSettlement): ChargeSplit | null {
  if (
    row.stripe_fee_cents == null ||
    row.platform_fee_cents == null ||
    row.head_coach_split_cents == null ||
    row.coach_net_cents == null
  ) {
    return null;
  }
  return {
    gross_cents: row.gross_cents,
    stripe_fee_cents: row.stripe_fee_cents,
    platform_fee_cents: row.platform_fee_cents,
    head_coach_split_cents: row.head_coach_split_cents,
    coach_net_cents: row.coach_net_cents,
    platform_net_cents: row.platform_fee_cents,
    savings_cents: 0,
  };
}

function stateKey(adj: ChargeAdjustments): string {
  return `${adj.refunded_cents}-${adj.dispute_withdrawn_cents}-${adj.dispute_fee_cents}`;
}

/** A payee's current position on one settlement: what they hold for it. */
export function payeePositionCents(
  transfers: Array<
    Pick<
      ConnectTransfer,
      'status' | 'amount_cents' | 'netted_recovery_cents' | 'reversed_amount_cents'
    >
  >,
  recoveries: Array<Pick<PayeeRecovery, 'status' | 'amount_cents'>>,
): number {
  let position = 0;
  for (const t of transfers) {
    if (t.status === 'failed') continue;
    position += t.amount_cents + t.netted_recovery_cents - t.reversed_amount_cents;
  }
  for (const r of recoveries) {
    if (r.status === 'released') continue;
    position -= r.amount_cents;
  }
  return position;
}

@Injectable()
export class ChargeSettlementService {
  private readonly logger = new Logger(ChargeSettlementService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private transfers: TransferOrchestratorService,
  ) {}

  // ---------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------

  /**
   * Settle one Stripe charge for a purchase. Idempotent on the charge id:
   * re-delivery, the sweeper and concurrent webhooks all collapse onto the
   * same ChargeSettlement row, and only one caller wins the claim that writes
   * the ledger slices and transfer rows.
   */
  async settleCharge(args: {
    purchase: ClientPurchase;
    charge_id: string;
    invoice_id?: string | null;
  }): Promise<SettleOutcome> {
    const { purchase } = args;
    const chargeId = args.charge_id;
    if (!(purchase.amount_cents > 0)) {
      return this.outcome(
        'skipped_free',
        chargeId,
        null,
        'Free package or $0 grant: nothing to settle.',
      );
    }
    const existing = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: chargeId },
    });
    if (existing && existing.status !== 'awaiting_fee') {
      await this.attemptPendingTransfers(existing.id);
      return this.outcome(
        existing.status === 'legacy_destination' ? 'legacy_destination' : 'already_settled',
        chargeId,
        existing.id,
      );
    }

    const charge = await this.stripe.retrieveCharge(chargeId, {
      expandBalanceTransaction: true,
    });
    if (!(charge.amount > 0)) {
      return this.outcome('skipped_free', chargeId, null, 'The charge is $0: nothing to settle.');
    }
    const policy = await this.feePolicy.resolvePolicy(purchase.coach_user_id);
    const legacy = isLegacyDestinationCharge(charge);
    const bt = expandedBalanceTransaction(charge);
    const row =
      existing ??
      (await this.createSettlementRow({
        purchase,
        chargeId,
        invoiceId: args.invoice_id ?? null,
        grossCents: bt?.amount ?? charge.amount,
        currency: (bt?.currency ?? charge.currency ?? purchase.currency).toLowerCase(),
        platformBps: policy.platform_application_fee_bps,
        mechanism: legacy ? SETTLEMENT_MECHANISM_LEGACY : SETTLEMENT_MECHANISM_SCT,
      }));
    if (row.status !== 'awaiting_fee') {
      // Lost the create race to a concurrent settle; it owns the row.
      return this.outcome(
        row.status === 'legacy_destination' ? 'legacy_destination' : 'already_settled',
        chargeId,
        row.id,
      );
    }

    if (legacy) {
      // Stripe already routed the coach's share (destination charge). Record
      // the observed numbers; never transfer.
      const appFee =
        typeof charge.application_fee_amount === 'number' ? charge.application_fee_amount : 0;
      await this.prisma.chargeSettlement.updateMany({
        where: { id: row.id, status: 'awaiting_fee' },
        data: {
          status: 'legacy_destination',
          mechanism: SETTLEMENT_MECHANISM_LEGACY,
          stripe_balance_transaction_id: bt?.id ?? null,
          stripe_fee_cents: bt?.fee ?? null,
          platform_fee_cents: appFee,
          coach_net_cents: charge.amount - appFee,
          settled_at: new Date(),
          last_error: null,
        },
      });
      return this.outcome('legacy_destination', chargeId, row.id);
    }

    if (charge.status && charge.status !== 'succeeded') {
      return this.markAwaiting(
        row,
        chargeId,
        `The charge is ${charge.status}; it settles once Stripe reports it succeeded.`,
      );
    }
    if (!bt) {
      return this.markAwaiting(
        row,
        chargeId,
        'Stripe has not reported the balance transaction yet; the settlement sweeper retries.',
      );
    }
    const seller = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: purchase.coach_user_id },
    });
    if (!seller?.stripe_account_id) {
      return this.markAwaiting(
        row,
        chargeId,
        'The selling coach has no connected Stripe account; the payout waits until they finish payout setup.',
      );
    }

    // Head-coach split applies only when the head coach can be paid. If the
    // head coach has no connected account the sub-coach keeps the split (TGP
    // never keeps more than its own fee).
    const headCoachId = await this.feePolicy.resolveHeadCoachId(purchase.coach_user_id);
    let headAccountId: string | null = null;
    if (headCoachId && policy.head_coach_split_bps > 0) {
      const headAccount = await this.prisma.connectAccount.findUnique({
        where: { coach_user_id: headCoachId },
      });
      headAccountId = headAccount?.stripe_account_id ?? null;
      if (!headAccountId) {
        this.logger.warn(
          `settleCharge: head coach ${headCoachId} has no connected account; sub-coach ${purchase.coach_user_id} keeps the split for charge=${chargeId}`,
        );
      }
    }
    const headCoachBps = headCoachId && headAccountId ? policy.head_coach_split_bps : 0;

    const split = computeChargeSplit({
      gross_cents: bt.amount,
      stripe_fee_cents: bt.fee,
      platform_bps: policy.platform_application_fee_bps,
      head_coach_bps: headCoachBps,
      rail: railForPaymentMethodType(charge.payment_method_details?.type),
    });
    // A refund can land before we settle (webhook ordering). Stripe's
    // amount_refunded is the truth at this moment.
    const adj: ChargeAdjustments = {
      refunded_cents: Math.max(row.refunded_cents, charge.amount_refunded ?? 0),
      dispute_withdrawn_cents: row.dispute_withdrawn_cents,
      dispute_fee_cents: row.dispute_fee_cents,
    };
    const targets = computeAdjustedTargets(split, adj);
    const currency = bt.currency.toLowerCase();

    const result = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.chargeSettlement.updateMany({
        where: { id: row.id, status: 'awaiting_fee' },
        data: {
          status: 'settled',
          mechanism: SETTLEMENT_MECHANISM_SCT,
          currency,
          rail: railForPaymentMethodType(charge.payment_method_details?.type),
          stripe_balance_transaction_id: bt.id,
          gross_cents: split.gross_cents,
          stripe_fee_cents: split.stripe_fee_cents,
          platform_bps: policy.platform_application_fee_bps,
          head_coach_bps: headCoachBps,
          head_coach_user_id: headCoachBps > 0 ? headCoachId : null,
          platform_fee_cents: split.platform_fee_cents,
          head_coach_split_cents: split.head_coach_split_cents,
          coach_net_cents: split.coach_net_cents,
          refunded_cents: adj.refunded_cents,
          target_platform_fee_cents: targets.platform_fee_cents,
          target_head_coach_cents: targets.head_coach_split_cents,
          target_coach_net_cents: targets.coach_net_cents,
          settled_at: new Date(),
          last_error: null,
        },
      });
      if (claim.count !== 1) return null;

      let ledgerCount = 0;
      const base = { purchase_id: purchase.id, stripe_charge_id: chargeId, currency };
      await this.ledger.createChargeEntry(
        {
          ...base,
          kind: 'application_fee',
          payee_user_id: null,
          payee_stripe_account_id: null,
          amount_cents: split.platform_fee_cents,
          status: 'posted',
        },
        tx,
      );
      await this.ledger.createChargeEntry(
        {
          ...base,
          kind: 'stripe_fee',
          payee_user_id: null,
          payee_stripe_account_id: null,
          amount_cents: split.stripe_fee_cents,
          status: 'posted',
        },
        tx,
      );
      ledgerCount += 2;

      const transferIds: string[] = [];
      const legs: Array<{
        leg: 'coach' | 'head_coach';
        kind: SettlementTransferKind;
        ledgerKind: 'destination' | 'head_coach_split';
        payee: string;
        account: string;
        sliceCents: number;
        targetCents: number;
      }> = [
        {
          leg: 'coach',
          kind: 'coach_net',
          ledgerKind: 'destination',
          payee: purchase.coach_user_id,
          account: seller.stripe_account_id,
          sliceCents: split.coach_net_cents,
          targetCents: targets.coach_net_cents,
        },
      ];
      if (split.head_coach_split_cents > 0 && headCoachId && headAccountId) {
        legs.push({
          leg: 'head_coach',
          kind: 'head_coach_split',
          ledgerKind: 'head_coach_split',
          payee: headCoachId,
          account: headAccountId,
          sliceCents: split.head_coach_split_cents,
          targetCents: targets.head_coach_split_cents,
        });
      }

      for (const leg of legs) {
        const entry = await this.ledger.createChargeEntry(
          {
            ...base,
            kind: leg.ledgerKind,
            payee_user_id: leg.payee,
            payee_stripe_account_id: leg.account,
            amount_cents: Math.max(0, leg.sliceCents),
            status: 'pending',
          },
          tx,
        );
        ledgerCount += 1;
        if (leg.targetCents < 0) {
          // Fees (or an early refund) exceed this payee's share: they owe the rest.
          await this.createRecovery(tx, {
            settlementId: row.id,
            chargeId,
            payee: leg.payee,
            amountCents: -leg.targetCents,
            currency,
            reason: adj.refunded_cents > 0 ? 'refund' : 'fees_exceed_gross',
            key: `${leg.leg}-settle-${stateKey(adj)}`,
          });
        }
        const owed = Math.max(0, leg.targetCents);
        const netted =
          owed > 0 ? await this.netOpenRecoveries(tx, leg.payee, currency, owed, row.id) : 0;
        const amount = owed - netted;
        if (amount === 0 && netted === 0) {
          await tx.splitLedgerEntry.update({
            where: { id: entry.id },
            data: { status: 'posted', posted_at: new Date() },
          });
          continue;
        }
        const transfer = await this.transfers.enqueueSettlementTransfer(
          {
            settlement_id: row.id,
            purchase_id: purchase.id,
            kind: leg.kind,
            ledger_entry_id: entry.id,
            destination_stripe_account_id: leg.account,
            destination_user_id: leg.payee,
            amount_cents: amount,
            netted_recovery_cents: netted,
            currency,
            source_stripe_charge_id: chargeId,
            idempotency_key: `tgp-settle-${chargeId}-${leg.leg}`,
          },
          tx,
        );
        if (transfer.status === 'netted') {
          await tx.splitLedgerEntry.update({
            where: { id: entry.id },
            data: { status: 'posted', posted_at: new Date() },
          });
        } else {
          transferIds.push(transfer.id);
        }
      }
      return { ledgerCount, transferIds };
    });

    if (!result) {
      return this.outcome('already_settled', chargeId, row.id);
    }
    for (const id of result.transferIds) await this.safeAttempt(id);
    return {
      status: 'settled',
      charge_id: chargeId,
      settlement_id: row.id,
      ledger_entries: result.ledgerCount,
      transfers_enqueued: result.transferIds.length,
    };
  }

  /**
   * Settle every known charge of a purchase: the PaymentIntent's charge for a
   * one-time purchase, every paid invoice for a subscription. Used when the
   * charge id is not on hand (subscription-mode Checkout completion, guest
   * conversion, the backstop sweeper). Never throws.
   */
  async settlePurchase(purchase: ClientPurchase): Promise<SettleOutcome[]> {
    if (!(purchase.amount_cents > 0)) {
      return [
        this.outcome('skipped_free', null, null, 'Free package or $0 grant: nothing to settle.'),
      ];
    }
    const outcomes: SettleOutcome[] = [];
    try {
      if (purchase.stripe_subscription_id) {
        const invoices = await this.stripe.listInvoices({
          subscription: purchase.stripe_subscription_id,
          status: 'paid',
          limit: 24,
        });
        for (const inv of invoices.data ?? []) {
          const chargeId = typeof inv.charge === 'string' ? inv.charge : (inv.charge?.id ?? null);
          if (!chargeId || !((inv.amount_paid ?? 0) > 0)) continue;
          outcomes.push(
            await this.settleCharge({ purchase, charge_id: chargeId, invoice_id: inv.id }),
          );
        }
      } else if (purchase.stripe_payment_intent_id) {
        const pi = await this.stripe.retrievePaymentIntent(purchase.stripe_payment_intent_id);
        const chargeId =
          (typeof pi.latest_charge === 'string' ? pi.latest_charge : null) ??
          pi.charges?.data?.[0]?.id ??
          null;
        if (chargeId) outcomes.push(await this.settleCharge({ purchase, charge_id: chargeId }));
      }
    } catch (err) {
      this.logger.warn(`settlePurchase failed purchase=${purchase.id}: ${(err as Error).message}`);
    }
    return outcomes;
  }

  /**
   * Sweeper: retry settlements waiting on Stripe's fee, and settle recent
   * paid purchases that no webhook settled (lost or out-of-order events).
   * Bounded; safe to run repeatedly.
   */
  async runSettlementSweep(
    now: Date = new Date(),
    limit = 25,
  ): Promise<{ retried: number; backfilled: number; settled: number }> {
    let settled = 0;
    const waiting = await this.prisma.chargeSettlement.findMany({
      where: { status: 'awaiting_fee', updated_at: { lte: new Date(now.getTime() - 60_000) } },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
    for (const s of waiting) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: s.purchase_id },
      });
      if (!purchase) continue;
      try {
        const o = await this.settleCharge({
          purchase,
          charge_id: s.stripe_charge_id,
          invoice_id: s.stripe_invoice_id,
        });
        if (o.status === 'settled') settled += 1;
      } catch (err) {
        this.logger.warn(
          `settlement sweep retry failed charge=${s.stripe_charge_id}: ${(err as Error).message}`,
        );
      }
    }
    // Backstop: recent paid purchases with no settlement and no ledger at all
    // (a purchase with legacy ledger rows was handled by the pre-S-FEE flow).
    const since = new Date(now.getTime() - 14 * 86_400_000);
    const orphans = await this.prisma.clientPurchase.findMany({
      where: {
        amount_cents: { gt: 0 },
        created_at: { gte: since, lte: new Date(now.getTime() - 5 * 60_000) },
        status: {
          in: [
            'paid',
            'active',
            'trialing',
            'past_due',
            'canceled',
            'refunded',
            'disputed',
            'chargeback_lost',
          ],
        },
        settlements: { none: {} },
        splits: { none: {} },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    for (const p of orphans) {
      const results = await this.settlePurchase(p);
      settled += results.filter((r) => r.status === 'settled').length;
    }
    return { retried: waiting.length, backfilled: orphans.length, settled };
  }

  // ---------------------------------------------------------------------
  // Refunds and disputes
  // ---------------------------------------------------------------------

  /**
   * Re-derive targets after a refund or dispute change and move each payee
   * to their target. Returns `legacy` / `no_settlement` when the charge is
   * not an S-FEE settlement so the caller can run the legacy reversal path.
   */
  async applyAdjustments(input: AdjustmentInput): Promise<AdjustOutcome> {
    if (!(input.purchase.amount_cents > 0)) return 'skipped_free';
    let row = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: input.charge_id },
    });
    if (!row || row.status === 'awaiting_fee') {
      // Settle first (it reads Stripe's amount_refunded), then adjust.
      try {
        await this.settleCharge({ purchase: input.purchase, charge_id: input.charge_id });
      } catch (err) {
        this.logger.warn(
          `applyAdjustments: settle-first failed charge=${input.charge_id}: ${(err as Error).message}`,
        );
      }
      row = await this.prisma.chargeSettlement.findUnique({
        where: { stripe_charge_id: input.charge_id },
      });
    }
    if (!row) return 'no_settlement';
    if (row.status === 'legacy_destination') return 'legacy';
    let current: ChargeSettlement = row;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next: ChargeAdjustments = {
        refunded_cents: Math.max(
          current.refunded_cents,
          input.refunded_cents ?? current.refunded_cents,
        ),
        dispute_withdrawn_cents: input.dispute?.withdrawn_cents ?? current.dispute_withdrawn_cents,
        dispute_fee_cents: input.dispute?.fee_cents ?? current.dispute_fee_cents,
      };
      if (current.status === 'awaiting_fee') {
        // Still no fee from Stripe: remember the adjustment; settleCharge
        // applies it when it computes the split.
        await this.prisma.chargeSettlement.updateMany({
          where: { id: current.id, status: 'awaiting_fee' },
          data: { ...next, adjusted_at: new Date() },
        });
        return 'deferred';
      }
      const split = splitOf(current);
      if (!split) return 'no_settlement';
      const targets = computeAdjustedTargets(split, next);
      const unchanged =
        next.refunded_cents === current.refunded_cents &&
        next.dispute_withdrawn_cents === current.dispute_withdrawn_cents &&
        next.dispute_fee_cents === current.dispute_fee_cents;
      if (!unchanged) {
        const claim = await this.prisma.chargeSettlement.updateMany({
          where: {
            id: current.id,
            refunded_cents: current.refunded_cents,
            dispute_withdrawn_cents: current.dispute_withdrawn_cents,
            dispute_fee_cents: current.dispute_fee_cents,
          },
          data: {
            ...next,
            target_platform_fee_cents: targets.platform_fee_cents,
            target_head_coach_cents: targets.head_coach_split_cents,
            target_coach_net_cents: targets.coach_net_cents,
            adjusted_at: new Date(),
          },
        });
        if (claim.count !== 1) {
          const reread: ChargeSettlement | null = await this.prisma.chargeSettlement.findUnique({
            where: { id: current.id },
          });
          if (!reread) return 'no_settlement';
          current = reread;
          continue;
        }
      }
      // TGP keeps no fee on refunded / charged-back principal: mirror the
      // platform slice's reduction on its ledger row (absolute, idempotent).
      const platformReversed = split.platform_fee_cents - targets.platform_fee_cents;
      await this.prisma.splitLedgerEntry.updateMany({
        where: {
          purchase_id: current.purchase_id,
          stripe_charge_id: current.stripe_charge_id,
          kind: 'application_fee',
        },
        data: {
          reversed_cents: platformReversed,
          status: targets.platform_fee_cents === 0 && platformReversed > 0 ? 'reversed' : 'posted',
        },
      });
      // Converge every payee to the CURRENT targets (idempotent).
      const legs: Leg[] = [
        {
          leg: 'coach',
          payee_user_id: current.coach_user_id,
          target_cents: targets.coach_net_cents,
        },
      ];
      if (current.head_coach_user_id && split.head_coach_split_cents > 0) {
        legs.push({
          leg: 'head_coach',
          payee_user_id: current.head_coach_user_id,
          target_cents: targets.head_coach_split_cents,
        });
      }
      const reason =
        next.dispute_withdrawn_cents > 0 || next.dispute_fee_cents > 0 ? 'dispute' : 'refund';
      for (const leg of legs) {
        await this.convergeLeg(current, leg, next, reason);
      }
      return unchanged ? 'unchanged' : 'adjusted';
    }
    this.logger.warn(
      `applyAdjustments: gave up after concurrent updates charge=${input.charge_id}`,
    );
    return 'deferred';
  }

  /** True when the charge settled through S-FEE (not a legacy destination charge). */
  async isSeparateChargeTransfer(chargeId: string): Promise<boolean> {
    const row = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: chargeId },
      select: { mechanism: true },
    });
    return row?.mechanism === SETTLEMENT_MECHANISM_SCT;
  }

  /** Purchase that owns a settled charge (refund / dispute routing). */
  async purchaseIdForCharge(chargeId: string): Promise<string | null> {
    const row = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: chargeId },
      select: { purchase_id: true },
    });
    return row?.purchase_id ?? null;
  }

  /** Most recent settled charge of a purchase (admin refund of a renewal). */
  async latestChargeIdForPurchase(purchaseId: string): Promise<string | null> {
    const row = await this.prisma.chargeSettlement.findFirst({
      where: { purchase_id: purchaseId },
      orderBy: { created_at: 'desc' },
      select: { stripe_charge_id: true },
    });
    return row?.stripe_charge_id ?? null;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async convergeLeg(
    row: ChargeSettlement,
    leg: Leg,
    adj: ChargeAdjustments,
    reason: 'refund' | 'dispute',
  ): Promise<void> {
    // Post anything still pending first so reversals act on real transfers.
    const pending = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: row.id, destination_user_id: leg.payee_user_id, status: 'pending' },
    });
    for (const t of pending) await this.safeAttempt(t.id);

    const transfers = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: row.id, destination_user_id: leg.payee_user_id },
      orderBy: { created_at: 'asc' },
    });
    const recoveries = await this.prisma.payeeRecovery.findMany({
      where: { settlement_id: row.id, payee_user_id: leg.payee_user_id },
      orderBy: { created_at: 'asc' },
    });
    const delta = leg.target_cents - payeePositionCents(transfers, recoveries);
    const key = stateKey(adj);

    if (delta < 0) {
      let need = -delta;
      for (const t of transfers) {
        if (need <= 0) break;
        if (t.status !== 'succeeded' || !t.stripe_transfer_id) continue;
        const reversible = t.amount_cents - t.reversed_amount_cents;
        const take = Math.min(need, reversible);
        if (take <= 0) continue;
        try {
          await this.transfers.reverse({ transfer_row_id: t.id, amount_cents: take });
          need -= take;
        } catch (err) {
          this.logger.warn(
            `transfer reversal failed transfer=${t.id} charge=${row.stripe_charge_id}: ${(err as Error).message}; recording a recovery to net from future payouts`,
          );
          break;
        }
      }
      if (need > 0) {
        await this.createRecovery(this.prisma, {
          settlementId: row.id,
          chargeId: row.stripe_charge_id,
          payee: leg.payee_user_id,
          amountCents: need,
          currency: row.currency,
          reason,
          key: `${leg.leg}-${key}`,
        });
      }
      return;
    }

    if (delta > 0) {
      let give = delta;
      // Cancel what the payee still owes on this charge first.
      for (const r of recoveries) {
        if (give <= 0) break;
        if (r.status !== 'open') continue;
        const releasable = r.amount_cents - r.collected_cents;
        const x = Math.min(give, releasable);
        if (x <= 0) continue;
        const remaining = r.amount_cents - x;
        const res = await this.prisma.payeeRecovery.updateMany({
          where: {
            id: r.id,
            amount_cents: r.amount_cents,
            collected_cents: r.collected_cents,
            status: 'open',
          },
          data: {
            amount_cents: remaining,
            status:
              remaining === r.collected_cents
                ? r.collected_cents > 0
                  ? 'collected'
                  : 'released'
                : 'open',
          },
        });
        if (res.count === 1) give -= x;
      }
      if (give <= 0) return;
      // Then pay the rest back (won dispute). No source_transaction: the
      // charge's funds were already transferred once.
      const account = await this.prisma.connectAccount.findUnique({
        where: { coach_user_id: leg.payee_user_id },
      });
      if (!account?.stripe_account_id) {
        this.logger.warn(
          `reinstatement skipped: payee ${leg.payee_user_id} has no connected account (charge=${row.stripe_charge_id})`,
        );
        return;
      }
      const original = transfers.find((t) => t.ledger_entry_id);
      const reinstate = await this.transfers.enqueueSettlementTransfer({
        settlement_id: row.id,
        purchase_id: row.purchase_id,
        kind: leg.leg === 'coach' ? 'coach_reinstate' : 'head_coach_reinstate',
        ledger_entry_id: null,
        destination_stripe_account_id: account.stripe_account_id,
        destination_user_id: leg.payee_user_id,
        amount_cents: give,
        netted_recovery_cents: 0,
        currency: row.currency,
        source_stripe_charge_id: null,
        idempotency_key: `tgp-settle-${row.stripe_charge_id}-${leg.leg}-reinstate-${key}`,
      });
      const posted = await this.safeAttempt(reinstate.id);
      if (posted?.status === 'succeeded' && original?.ledger_entry_id) {
        await this.ledger.undoReversal({
          entry_id: original.ledger_entry_id,
          reinstated_cents: give,
        });
      }
    }
  }

  // Net a payee's open recoveries (oldest first, same currency) against an
  // amount we are about to transfer them. Guarded updates so two concurrent
  // settlements can never collect the same cents twice.
  private async netOpenRecoveries(
    tx: Tx,
    payee: string,
    currency: string,
    available: number,
    excludeSettlementId: string,
  ): Promise<number> {
    const open = await tx.payeeRecovery.findMany({
      where: {
        payee_user_id: payee,
        currency,
        status: 'open',
        settlement_id: { not: excludeSettlementId },
      },
      orderBy: { created_at: 'asc' },
    });
    let netted = 0;
    for (const r of open) {
      const left = available - netted;
      if (left <= 0) break;
      const take = Math.min(left, r.amount_cents - r.collected_cents);
      if (take <= 0) continue;
      const collected = r.collected_cents + take;
      const res = await tx.payeeRecovery.updateMany({
        where: { id: r.id, collected_cents: r.collected_cents, status: 'open' },
        data: {
          collected_cents: collected,
          status: collected >= r.amount_cents ? 'collected' : 'open',
          collected_at: collected >= r.amount_cents ? new Date() : null,
        },
      });
      if (res.count === 1) netted += take;
    }
    return netted;
  }

  private async createRecovery(
    db: Tx | PrismaService,
    args: {
      settlementId: string;
      chargeId: string;
      payee: string;
      amountCents: number;
      currency: string;
      reason: string;
      key: string;
    },
  ): Promise<void> {
    if (args.amountCents <= 0) return;
    const idempotencyKey = `tgp-rec-${args.chargeId}-${args.key}`;
    const existing = await db.payeeRecovery.findUnique({
      where: { idempotency_key: idempotencyKey },
    });
    if (existing) return;
    try {
      await db.payeeRecovery.create({
        data: {
          settlement_id: args.settlementId,
          payee_user_id: args.payee,
          amount_cents: args.amountCents,
          currency: args.currency,
          reason: args.reason,
          status: 'open',
          idempotency_key: idempotencyKey,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  private async createSettlementRow(args: {
    purchase: ClientPurchase;
    chargeId: string;
    invoiceId: string | null;
    grossCents: number;
    currency: string;
    platformBps: number;
    mechanism: string;
  }): Promise<ChargeSettlement> {
    try {
      return await this.prisma.chargeSettlement.create({
        data: {
          purchase_id: args.purchase.id,
          coach_user_id: args.purchase.coach_user_id,
          stripe_charge_id: args.chargeId,
          stripe_invoice_id: args.invoiceId,
          currency: args.currency,
          mechanism: args.mechanism,
          status: 'awaiting_fee',
          platform_bps: args.platformBps,
          gross_cents: args.grossCents,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.prisma.chargeSettlement.findUniqueOrThrow({
        where: { stripe_charge_id: args.chargeId },
      });
    }
  }

  private async markAwaiting(
    row: ChargeSettlement,
    chargeId: string,
    message: string,
  ): Promise<SettleOutcome> {
    await this.prisma.chargeSettlement.updateMany({
      where: { id: row.id, status: 'awaiting_fee' },
      data: { last_error: message },
    });
    this.logger.warn(`settleCharge waiting charge=${chargeId}: ${message}`);
    return this.outcome('awaiting_fee', chargeId, row.id, message);
  }

  private async attemptPendingTransfers(settlementId: string): Promise<void> {
    const pending = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: settlementId, status: 'pending' },
    });
    for (const t of pending) await this.safeAttempt(t.id);
  }

  private async safeAttempt(transferId: string): Promise<ConnectTransfer | null> {
    try {
      return await this.transfers.attempt(transferId);
    } catch (err) {
      this.logger.warn(
        `transfer attempt failed inline transfer=${transferId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private outcome(
    status: SettleStatus,
    chargeId: string | null,
    settlementId: string | null,
    reason?: string,
  ): SettleOutcome {
    return {
      status,
      charge_id: chargeId,
      settlement_id: settlementId,
      ledger_entries: 0,
      transfers_enqueued: 0,
      ...(reason ? { reason } : {}),
    };
  }
}
