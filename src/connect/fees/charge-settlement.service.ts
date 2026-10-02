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
import { ChargeLock, isChargeLockBusy } from './charge-lock';
import { FeePolicyService } from './fee-policy.service';
import { DisputeStateUnavailableError, isRetryableMoneyError } from './money-errors';
import { SplitLedgerService } from './split-ledger.service';
import {
  TransferOrchestratorService,
  type MoneyFence,
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
// Concurrency (round 3, B-627-2): every money movement on one charge runs
// under that charge's lock (ChargeLock): settleCharge, applyAdjustments and
// the refund handler's per-refund critical section. Inside the lock the
// targets come from the CUMULATIVE state (sum of the charge's succeeded
// ChargeRefund rows, one per Stripe refund id; the dispute's current balance
// transactions read from Stripe), and each payee is moved from their freshly
// read position to that target. Two refunds delivered together, a duplicate
// delivery, or an admin refund racing its own charge.refunded webhook
// therefore reverse exactly the difference, once. Ledger slices record the
// absolute leg position (syncLegLedger), never an increment.
//
// Backfill (round 3, B-627-1): the sweeper settles every paid invoice whose
// charge has no ChargeSettlement row (matched by charge id, 35-day window,
// resumable cursor), not only purchases that have no settlement at all; a
// charge whose first Stripe read failed keeps an awaiting_fee row that the
// sweeper retries; stale awaiting rows and pending transfers raise alerts.
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

// Sweeper backfill window and bounds (B-627-1).
export const BACKFILL_WINDOW_DAYS = 35;
export const INVOICE_BACKFILL_CURSOR = 'sfee-invoice-backfill-cursor';
export const INVOICE_BACKFILL_PAGES_PER_RUN = 4;
export const STALE_AFTER_MS = 60 * 60_000;
// B-627-3: open recoveries older than this raise an alert with the payee's
// total open exposure; clawback looks back this far for reversible transfers.
export const RECOVERY_ALERT_AFTER_MS = 24 * 60 * 60_000;
export const CLAWBACK_LOOKBACK_DAYS = 90;

export const SETTLEMENT_LOG_CODES = {
  stripeUnavailable: 'SFEE_SETTLEMENT_STRIPE_UNAVAILABLE',
  lockBusy: 'SFEE_CHARGE_LOCK_BUSY',
  staleAwaiting: 'SFEE_SETTLEMENT_STALE',
  staleTransfers: 'SFEE_TRANSFER_STALE',
  invoiceBackfill: 'SFEE_INVOICE_BACKFILL',
  invoiceBackfillFailed: 'SFEE_INVOICE_BACKFILL_FAILED',
  reconcilePending: 'SFEE_RECONCILE_PENDING',
  reversalPending: 'SFEE_REVERSAL_PENDING',
  recoveryOpen: 'SFEE_RECOVERY_OPEN',
  recoveryClawback: 'SFEE_RECOVERY_CLAWBACK',
} as const;

export interface SweepSummary {
  retried: number;
  backfilled: number;
  settled: number;
  invoices_scanned: number;
  invoices_backfilled: number;
  stale_awaiting: number;
  stale_transfers: number;
  reversals_resolved: number;
  reconciled: number;
  clawback_cents: number;
  open_recovery_payees: number;
}

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
  // Cumulative refunded amount on the charge as the caller saw it. Inside the
  // lock the service also sums the charge's succeeded ChargeRefund rows (one
  // per Stripe refund id) and uses the larger, so a stale caller can never
  // move the coach backwards or twice.
  refunded_cents?: number;
  // Dispute position on the charge as the caller saw it (disputeAmountsFrom).
  dispute?: { withdrawn_cents: number; fee_cents: number };
  // When set, the dispute's CURRENT balance transactions are read from Stripe
  // inside the lock, so an older event processed late cannot undo a newer
  // outcome. Round 4 (B-627-4): if that read fails or is malformed nothing
  // moves (DisputeStateUnavailableError; the settlement is flagged for the
  // sweeper) — the event's own position is never used in its place.
  dispute_id?: string | null;
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
    > & { recovery_clawback_cents?: number }
  >,
  recoveries: Array<Pick<PayeeRecovery, 'status' | 'amount_cents'>>,
): number {
  let position = 0;
  for (const t of transfers) {
    if (t.status === 'failed') continue;
    // A clawback reversal moved cents off this transfer to settle a debt on
    // another charge: still paid for this charge (like netting).
    position +=
      t.amount_cents +
      t.netted_recovery_cents -
      t.reversed_amount_cents +
      (t.recovery_clawback_cents ?? 0);
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
  // Per-charge money lock (B-627-2). Public so tests can tune its timing.
  readonly chargeLock: ChargeLock;

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private transfers: TransferOrchestratorService,
  ) {
    this.chargeLock = new ChargeLock(prisma);
  }

  // ---------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------

  /**
   * Run `fn` while holding the charge's money lock (re-entrant within one
   * call chain). Throws ChargeLockBusyError when another worker holds it for
   * longer than the wait budget; nothing has moved in that case.
   */
  withChargeLock<T>(chargeId: string, fn: () => Promise<T>): Promise<T> {
    return this.chargeLock.run(chargeId, fn);
  }

  // B-627-2: the fence for money steps on one charge (see ChargeLock.fence).
  private fenceFor(chargeId: string): MoneyFence {
    return (db?: Tx) => this.chargeLock.fence(chargeId, db);
  }

  /**
   * Settle one Stripe charge for a purchase. Idempotent on the charge id:
   * re-delivery, the sweeper and concurrent webhooks all collapse onto the
   * same ChargeSettlement row, and only one caller wins the claim that writes
   * the ledger slices and transfer rows. Runs under the charge's lock; when
   * the lock stays busy the charge is left as an awaiting_fee row for the
   * sweeper (never dropped).
   */
  async settleCharge(args: {
    purchase: ClientPurchase;
    charge_id: string;
    invoice_id?: string | null;
  }): Promise<SettleOutcome> {
    if (!(args.purchase.amount_cents > 0)) {
      return this.outcome(
        'skipped_free',
        args.charge_id,
        null,
        'Free package or $0 grant: nothing to settle.',
      );
    }
    try {
      return await this.chargeLock.run(args.charge_id, () => this.settleChargeLocked(args));
    } catch (err) {
      if (!isChargeLockBusy(err)) throw err;
      const row = await this.ensureProvisionalRow(args);
      if (row.status !== 'awaiting_fee') {
        return this.outcome(
          row.status === 'legacy_destination' ? 'legacy_destination' : 'already_settled',
          args.charge_id,
          row.id,
        );
      }
      return this.markAwaiting(
        row,
        args.charge_id,
        `${SETTLEMENT_LOG_CODES.lockBusy}: another worker is moving money on this charge; the settlement sweeper retries.`,
      );
    }
  }

  private async settleChargeLocked(args: {
    purchase: ClientPurchase;
    charge_id: string;
    invoice_id?: string | null;
  }): Promise<SettleOutcome> {
    const { purchase } = args;
    const chargeId = args.charge_id;
    const existing = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: chargeId },
    });
    if (existing && existing.status !== 'awaiting_fee') {
      await this.attemptPendingTransfers(existing.id, chargeId);
      return this.outcome(
        existing.status === 'legacy_destination' ? 'legacy_destination' : 'already_settled',
        chargeId,
        existing.id,
      );
    }

    let charge: StripeChargeObject;
    try {
      charge = await this.stripe.retrieveCharge(chargeId, {
        expandBalanceTransaction: true,
      });
    } catch (err) {
      // B-627-1: never lose a charge we were told about. Keep (or create) an
      // awaiting_fee row; the sweeper retries it every run until it settles.
      const row = existing ?? (await this.ensureProvisionalRow(args));
      if (row.status !== 'awaiting_fee') {
        return this.outcome(
          row.status === 'legacy_destination' ? 'legacy_destination' : 'already_settled',
          chargeId,
          row.id,
        );
      }
      return this.markAwaiting(
        row,
        chargeId,
        `${SETTLEMENT_LOG_CODES.stripeUnavailable}: reading the charge from Stripe failed (${(err as Error).message}); the settlement sweeper retries.`,
      );
    }
    if (!(charge.amount > 0)) {
      // A provisional row (written when Stripe was unavailable) is not money.
      if (existing) {
        await this.prisma.chargeSettlement.deleteMany({
          where: { id: existing.id, status: 'awaiting_fee' },
        });
      }
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
          gross_cents: bt?.amount ?? charge.amount,
          currency: (bt?.currency ?? charge.currency ?? purchase.currency).toLowerCase(),
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
      // B-627-2: a holder whose lease was taken over cannot claim (the fence
      // statement also locks the lease row until this transaction commits).
      await this.chargeLock.fence(chargeId, tx);
      // Compare-and-set on the adjustment columns too: an adjustment recorded
      // on the awaiting row after we read it makes this claim miss, and the
      // next pass settles with it (belt and braces; the charge lock already
      // serializes settle and adjust).
      const claim = await tx.chargeSettlement.updateMany({
        where: {
          id: row.id,
          status: 'awaiting_fee',
          refunded_cents: row.refunded_cents,
          dispute_withdrawn_cents: row.dispute_withdrawn_cents,
          dispute_fee_cents: row.dispute_fee_cents,
        },
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
        const sliceCents = Math.max(0, leg.sliceCents);
        const entry = await this.ledger.createChargeEntry(
          {
            ...base,
            kind: leg.ledgerKind,
            payee_user_id: leg.payee,
            payee_stripe_account_id: leg.account,
            amount_cents: sliceCents,
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
        // A refund / dispute that landed before settlement lowers the target
        // below the slice: the difference is recorded as reversed (absolute;
        // syncLegLedger keeps it that way), so the reported net is the target.
        const preReversed = Math.max(0, sliceCents - owed);
        if (amount === 0 && netted === 0) {
          await tx.splitLedgerEntry.update({
            where: { id: entry.id },
            data: {
              status: sliceCents > 0 && preReversed >= sliceCents ? 'reversed' : 'posted',
              posted_at: new Date(),
              reversed_cents: preReversed,
              reversed_at: preReversed > 0 ? new Date() : null,
            },
          });
          continue;
        }
        if (preReversed > 0) {
          await tx.splitLedgerEntry.update({
            where: { id: entry.id },
            data: { reversed_cents: preReversed, reversed_at: new Date() },
          });
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
    for (const id of result.transferIds) await this.safeAttempt(id, chargeId);
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
      this.logger.warn(`SFEE_SETTLEMENT_FAILED purchase=${purchase.id}: ${(err as Error).message}`);
    }
    return outcomes;
  }

  /**
   * Sweeper (every 15 minutes, and the admin endpoint). Bounded; safe to run
   * repeatedly (every write is idempotent per charge and transfer).
   *   1. retry settlements waiting on Stripe (fee not reported yet, Stripe
   *      unavailable on the first read, charge lock busy);
   *   2. settle recent paid purchases that have no settlement at all (first
   *      charge lost: one-time purchases and subscription first invoices);
   *   3. B-627-1: settle every paid invoice whose CHARGE has no settlement
   *      row (a renewal is matched by charge id, never skipped because its
   *      purchase already has an earlier settlement);
   *   4. alert on awaiting_fee rows and pending transfers older than an hour.
   */
  async runSettlementSweep(
    now: Date = new Date(),
    limit = 25,
    deadlineAt?: number,
  ): Promise<SweepSummary> {
    const pastDeadline = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
    let settled = 0;
    const waiting = await this.prisma.chargeSettlement.findMany({
      where: { status: 'awaiting_fee', updated_at: { lte: new Date(now.getTime() - 60_000) } },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
    for (const s of waiting) {
      if (pastDeadline()) break;
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
          `SFEE_SETTLEMENT_RETRY_FAILED charge=${s.stripe_charge_id} purchase=${s.purchase_id}: ${(err as Error).message}`,
        );
      }
    }
    // Paid purchases with no settlement and no ledger at all (a purchase
    // with legacy ledger rows was handled by the pre-S-FEE flow).
    const since = new Date(now.getTime() - BACKFILL_WINDOW_DAYS * 86_400_000);
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
      if (pastDeadline()) break;
      const results = await this.settlePurchase(p);
      settled += results.filter((r) => r.status === 'settled').length;
    }
    const invoices = pastDeadline()
      ? { scanned: 0, backfilled: 0, settled: 0 }
      : await this.backfillPaidInvoices(now, limit, pastDeadline);
    settled += invoices.settled;
    const reversalsResolved = pastDeadline()
      ? 0
      : await this.resolveStuckReversals(now, limit, pastDeadline);
    const reconciled = pastDeadline() ? 0 : await this.rerunFlagged(now, limit, pastDeadline);
    const clawbackCents = pastDeadline()
      ? 0
      : await this.collectRecoveriesByClawback(now, limit, pastDeadline);
    const stale = await this.reportStale(now);
    return {
      retried: waiting.length,
      backfilled: orphans.length,
      settled,
      invoices_scanned: invoices.scanned,
      invoices_backfilled: invoices.backfilled,
      stale_awaiting: stale.awaiting,
      stale_transfers: stale.transfers,
      reversals_resolved: reversalsResolved,
      reconciled,
      clawback_cents: clawbackCents,
      open_recovery_payees: stale.recoveryPayees,
    };
  }

  /**
   * B-627-5 — re-drive reversal operations left pending (lost response,
   * crash after Stripe committed, lock lost mid-flight). A settlement
   * transfer is re-converged under its charge's lock (applyAdjustments
   * resolves the op first); a legacy transfer's op is resolved on its own.
   */
  private async resolveStuckReversals(
    now: Date,
    limit: number,
    pastDeadline: () => boolean,
  ): Promise<number> {
    const ops = await this.transfers.findPendingReversals(new Date(now.getTime() - 60_000), limit);
    let resolved = 0;
    for (const op of ops) {
      if (pastDeadline()) break;
      try {
        const t = await this.prisma.connectTransfer.findUnique({ where: { id: op.transfer_id } });
        if (!t) continue;
        const settlement = t.settlement_id
          ? await this.prisma.chargeSettlement.findUnique({ where: { id: t.settlement_id } })
          : null;
        const purchase = settlement
          ? await this.prisma.clientPurchase.findUnique({ where: { id: settlement.purchase_id } })
          : null;
        if (settlement && purchase) {
          await this.applyAdjustments({ purchase, charge_id: settlement.stripe_charge_id });
        } else {
          await this.transfers.resolvePendingReversals(op.transfer_id);
        }
        resolved += 1;
      } catch (err) {
        this.logger.warn(
          `${SETTLEMENT_LOG_CODES.reversalPending} op=${op.idempotency_key}: still unresolved (${(err as Error).message})`,
        );
      }
    }
    return resolved;
  }

  /** B-627-4 — re-run adjustments that could not finish on canonical state. */
  private async rerunFlagged(
    now: Date,
    limit: number,
    pastDeadline: () => boolean,
  ): Promise<number> {
    const flagged = await this.prisma.chargeSettlement.findMany({
      where: { reconcile_requested_at: { lte: new Date(now.getTime() - 60_000) } },
      orderBy: { reconcile_requested_at: 'asc' },
      take: limit,
    });
    let done = 0;
    for (const s of flagged) {
      if (pastDeadline()) break;
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: s.purchase_id },
      });
      if (!purchase) continue;
      try {
        await this.applyAdjustments({
          purchase,
          charge_id: s.stripe_charge_id,
          dispute_id: s.reconcile_dispute_id,
        });
        done += 1;
      } catch (err) {
        this.logger.warn(
          `${SETTLEMENT_LOG_CODES.reconcilePending} charge=${s.stripe_charge_id}: retry failed (${(err as Error).message})`,
        );
      }
    }
    return done;
  }

  /**
   * B-627-3 — collect open recoveries now instead of waiting for the payee's
   * next sale: reverse the reversible remainder of the payee's other recent
   * transfers (funds still in their Stripe balance), oldest debt first. Each
   * reversal runs under the SOURCE charge's lock with the keyed reversal
   * protocol; the recovery's cents are reserved before Stripe is called and
   * released again if Stripe refuses. Returns the cents collected.
   */
  private async collectRecoveriesByClawback(
    now: Date,
    limit: number,
    pastDeadline: () => boolean,
  ): Promise<number> {
    const open = await this.prisma.payeeRecovery.findMany({
      where: { status: 'open' },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    const since = new Date(now.getTime() - CLAWBACK_LOOKBACK_DAYS * 86_400_000);
    const refusedPayees = new Set<string>();
    let collectedTotal = 0;
    for (const r of open) {
      if (pastDeadline()) break;
      if (refusedPayees.has(r.payee_user_id)) continue;
      const candidates = await this.prisma.connectTransfer.findMany({
        where: {
          destination_user_id: r.payee_user_id,
          currency: r.currency,
          status: 'succeeded',
          stripe_transfer_id: { not: null },
          settlement_id: { not: null },
          created_at: { gte: since },
        },
        orderBy: { created_at: 'desc' },
      });
      for (const c of candidates) {
        if (pastDeadline() || refusedPayees.has(r.payee_user_id)) break;
        if (c.settlement_id === r.settlement_id) continue;
        if (c.amount_cents - c.reversed_amount_cents <= 0) continue;
        const source = await this.prisma.chargeSettlement.findUnique({
          where: { id: c.settlement_id ?? '' },
          select: { stripe_charge_id: true },
        });
        if (!source) continue;
        try {
          const got = await this.chargeLock.run(source.stripe_charge_id, async () => {
            const fence = this.fenceFor(source.stripe_charge_id);
            await this.transfers.resolvePendingReversals(c.id, fence);
            const [t, rec] = await Promise.all([
              this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: c.id } }),
              this.prisma.payeeRecovery.findUniqueOrThrow({ where: { id: r.id } }),
            ]);
            const owed = rec.status === 'open' ? rec.amount_cents - rec.collected_cents : 0;
            const take = Math.min(owed, t.amount_cents - t.reversed_amount_cents);
            if (take <= 0 || t.status !== 'succeeded') {
              return { cents: 0, done: owed <= 0, refused: false };
            }
            const res = await this.transfers.reverse({
              transfer_row_id: t.id,
              amount_cents: take,
              purpose: 'clawback',
              recovery_id: rec.id,
              fence,
            });
            if (res.status === 'refused') return { cents: 0, done: false, refused: true };
            return { cents: take, done: take >= owed, refused: false };
          });
          if (got.refused) refusedPayees.add(r.payee_user_id);
          if (got.cents > 0) {
            collectedTotal += got.cents;
            this.logger.warn(
              `${SETTLEMENT_LOG_CODES.recoveryClawback} recovery=${r.id} payee=${r.payee_user_id} transfer=${c.id} collected=${got.cents}`,
            );
          }
          if (got.done) break;
        } catch (err) {
          this.logger.warn(
            `${SETTLEMENT_LOG_CODES.recoveryClawback} recovery=${r.id} transfer=${c.id}: skipped (${(err as Error).message})`,
          );
          break;
        }
      }
    }
    return collectedTotal;
  }

  /**
   * B-627-1 — walk Stripe's paid invoices of the last BACKFILL_WINDOW_DAYS
   * (newest first, INVOICE_BACKFILL_PAGES_PER_RUN pages of 100 per run) and
   * settle every invoice charge that has no ChargeSettlement row, matched by
   * charge id. The position is kept in a CronLease row's `cursor`, so a large
   * window is covered across runs instead of re-reading the newest pages; at
   * the end of the window the cursor resets to the newest invoice.
   * Only S-FEE purchases are backfilled: a purchase with an S-FEE settlement,
   * or one with no settlement and no legacy ledger rows. Legacy destination
   * subscriptions keep their pre-S-FEE flow.
   */
  private async backfillPaidInvoices(
    now: Date,
    budget: number,
    pastDeadline: () => boolean,
  ): Promise<{ scanned: number; backfilled: number; settled: number }> {
    const createdGte = Math.floor((now.getTime() - BACKFILL_WINDOW_DAYS * 86_400_000) / 1000);
    let cursor: string | null = null;
    try {
      const row = await this.prisma.cronLease.findUnique({
        where: { name: INVOICE_BACKFILL_CURSOR },
      });
      cursor = row?.cursor ?? null;
    } catch (err) {
      this.logger.warn(
        `${SETTLEMENT_LOG_CODES.invoiceBackfillFailed} could not read the backfill cursor; starting from the newest invoice: ${(err as Error).message}`,
      );
    }
    let scanned = 0;
    let backfilled = 0;
    let settled = 0;
    let pages = 0;
    let exhausted = false;
    try {
      while (pages < INVOICE_BACKFILL_PAGES_PER_RUN && !pastDeadline() && backfilled < budget) {
        const page = await this.stripe.listPaidInvoices({
          created_gte: createdGte,
          starting_after: cursor,
          limit: 100,
        });
        pages += 1;
        const data = page.data ?? [];
        const candidates = data
          .map((inv) => ({
            id: inv.id,
            subscription:
              typeof inv.subscription === 'string'
                ? inv.subscription
                : (inv.subscription?.id ?? null),
            charge: typeof inv.charge === 'string' ? inv.charge : (inv.charge?.id ?? null),
            amount_paid: inv.amount_paid ?? 0,
          }))
          .filter(
            (
              inv,
            ): inv is { id: string; subscription: string; charge: string; amount_paid: number } =>
              !!inv.subscription && !!inv.charge && inv.amount_paid > 0,
          );
        const known = new Set(
          candidates.length === 0
            ? []
            : (
                await this.prisma.chargeSettlement.findMany({
                  where: { stripe_charge_id: { in: candidates.map((c) => c.charge) } },
                  select: { stripe_charge_id: true },
                })
              ).map((r) => r.stripe_charge_id),
        );
        const missing = candidates.filter((c) => !known.has(c.charge));
        const purchases =
          missing.length === 0
            ? []
            : await this.prisma.clientPurchase.findMany({
                where: {
                  stripe_subscription_id: { in: [...new Set(missing.map((m) => m.subscription))] },
                  amount_cents: { gt: 0 },
                  OR: [
                    { settlements: { some: { mechanism: SETTLEMENT_MECHANISM_SCT } } },
                    { settlements: { none: {} }, splits: { none: {} } },
                  ],
                },
              });
        const bySub = new Map(purchases.map((p) => [p.stripe_subscription_id, p]));
        let stoppedAt: string | null = null;
        for (const inv of data) {
          if (backfilled >= budget || pastDeadline()) {
            stoppedAt = inv.id;
            break;
          }
          scanned += 1;
          const m = missing.find((x) => x.id === inv.id);
          const purchase = m ? bySub.get(m.subscription) : undefined;
          if (m && purchase) {
            backfilled += 1;
            this.logger.warn(
              `${SETTLEMENT_LOG_CODES.invoiceBackfill} invoice=${m.id} charge=${m.charge} purchase=${purchase.id}: paid invoice had no settlement; settling now`,
            );
            try {
              const o = await this.settleCharge({
                purchase,
                charge_id: m.charge,
                invoice_id: m.id,
              });
              if (o.status === 'settled') settled += 1;
            } catch (err) {
              this.logger.warn(
                `${SETTLEMENT_LOG_CODES.invoiceBackfillFailed} invoice=${m.id} charge=${m.charge}: ${(err as Error).message}`,
              );
            }
          }
          cursor = inv.id;
        }
        if (stoppedAt) break;
        if (!page.has_more || data.length === 0) {
          exhausted = true;
          break;
        }
      }
    } catch (err) {
      this.logger.warn(
        `${SETTLEMENT_LOG_CODES.invoiceBackfillFailed} listing paid invoices failed; the next run resumes from the saved cursor: ${(err as Error).message}`,
      );
    }
    await this.saveBackfillCursor(exhausted ? null : cursor, now);
    return { scanned, backfilled, settled };
  }

  private async saveBackfillCursor(cursor: string | null, now: Date): Promise<void> {
    try {
      await this.prisma.cronLease.upsert({
        where: { name: INVOICE_BACKFILL_CURSOR },
        create: {
          name: INVOICE_BACKFILL_CURSOR,
          holder: 'sfee-settlement-sweep',
          lease_until: now,
          acquired_at: now,
          cursor,
        },
        update: { cursor, acquired_at: now },
      });
    } catch (err) {
      this.logger.warn(
        `${SETTLEMENT_LOG_CODES.invoiceBackfillFailed} could not save the backfill cursor; the next run re-reads from the newest invoice: ${(err as Error).message}`,
      );
    }
  }

  // Alert (error level, alert=true) on money that has waited over an hour,
  // and (B-627-3, C-627-3) on recoveries open for more than a day, with each
  // payee's total open exposure: TGP is fronting that money until it is
  // collected (netting, clawback, or the owner's debit setting).
  private async reportStale(
    now: Date,
  ): Promise<{ awaiting: number; transfers: number; recoveryPayees: number }> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const [awaiting, transfers, reversals, flagged, openRecoveries] = await Promise.all([
      this.prisma.chargeSettlement.count({
        where: { status: 'awaiting_fee', created_at: { lte: cutoff } },
      }),
      this.prisma.connectTransfer.count({
        where: { status: 'pending', settlement_id: { not: null }, created_at: { lte: cutoff } },
      }),
      this.prisma.transferReversalOp.count({
        where: { status: 'pending', created_at: { lte: cutoff } },
      }),
      this.prisma.chargeSettlement.count({
        where: { reconcile_requested_at: { lte: cutoff } },
      }),
      this.prisma.payeeRecovery.findMany({
        where: {
          status: 'open',
          created_at: { lte: new Date(now.getTime() - RECOVERY_ALERT_AFTER_MS) },
        },
        select: {
          payee_user_id: true,
          currency: true,
          amount_cents: true,
          collected_cents: true,
          created_at: true,
        },
      }),
    ]);
    if (reversals > 0) {
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.reversalPending} alert=true ${reversals} transfer reversal(s) have had an unknown outcome for over an hour (see TransferReversalOp.last_error); no recovery is opened for them until they resolve`,
      );
    }
    if (flagged > 0) {
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.reconcilePending} alert=true ${flagged} settlement adjustment(s) have waited over an hour for canonical Stripe state (see ChargeSettlement.reconcile_reason)`,
      );
    }
    const exposure = new Map<string, { cents: number; count: number; oldest: Date }>();
    for (const r of openRecoveries) {
      const k = `${r.payee_user_id}|${r.currency}`;
      const e = exposure.get(k) ?? { cents: 0, count: 0, oldest: r.created_at };
      e.cents += Math.max(0, r.amount_cents - r.collected_cents);
      e.count += 1;
      if (r.created_at < e.oldest) e.oldest = r.created_at;
      exposure.set(k, e);
    }
    for (const [k, e] of exposure) {
      const [payee, currency] = k.split('|');
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.recoveryOpen} alert=true payee=${payee} currency=${currency} open_cents=${e.cents} recoveries=${e.count} oldest=${e.oldest.toISOString()}: TGP is fronting this until it is collected from the payee`,
      );
    }
    if (awaiting > 0) {
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.staleAwaiting} alert=true ${awaiting} charge settlement(s) have waited over an hour (see ChargeSettlement.last_error); coaches are not paid for them yet`,
      );
    }
    if (transfers > 0) {
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.staleTransfers} alert=true ${transfers} coach transfer(s) have been pending over an hour (see ConnectTransfer.last_error)`,
      );
    }
    return { awaiting, transfers, recoveryPayees: exposure.size };
  }

  // ---------------------------------------------------------------------
  // Refunds and disputes
  // ---------------------------------------------------------------------

  /**
   * Re-derive targets after a refund or dispute change and move each payee
   * to their target. Returns `legacy` / `no_settlement` when the charge is
   * not an S-FEE settlement so the caller can run the legacy reversal path.
   *
   * B-627-2: runs under the charge's lock. Inside it the refunded amount is
   * the cumulative total of the charge's succeeded refunds (ChargeRefund rows,
   * unique per Stripe refund id), never the caller's increment, and every
   * payee moves from a position read under the lock. Before releasing, the
   * holder re-reads the refunds and applies any that landed meanwhile, so a
   * waiter that gave up (ChargeLockBusyError) loses nothing.
   */
  async applyAdjustments(input: AdjustmentInput): Promise<AdjustOutcome> {
    if (!(input.purchase.amount_cents > 0)) return 'skipped_free';
    const startedAt = new Date();
    try {
      const outcome = await this.chargeLock.run(input.charge_id, () =>
        this.applyAdjustmentsLocked(input),
      );
      await this.clearReconcileFlag(input.charge_id, startedAt);
      return outcome;
    } catch (err) {
      // Round 4 (B-627-4 / B-627-5): an adjustment that did not finish (no
      // canonical dispute state, unknown reversal outcome, lock lost, or any
      // other failure such as a lost DB receipt) is remembered durably, so the
      // sweeper re-runs it even if Stripe stops redelivering; the error still
      // propagates (the webhook answers non-2xx and Stripe redelivers).
      await this.flagForReconcile(input.charge_id, input.dispute_id ?? null, err);
      throw err;
    }
  }

  private async flagForReconcile(
    chargeId: string,
    disputeId: string | null,
    err: unknown,
  ): Promise<void> {
    try {
      const row = await this.prisma.chargeSettlement.findUnique({
        where: { stripe_charge_id: chargeId },
        select: { id: true, reconcile_dispute_id: true },
      });
      if (!row) return;
      await this.prisma.chargeSettlement.updateMany({
        where: { id: row.id },
        data: {
          reconcile_requested_at: new Date(),
          reconcile_dispute_id: disputeId ?? row.reconcile_dispute_id ?? null,
          reconcile_reason: String((err as Error)?.message ?? err).slice(0, 500),
        },
      });
    } catch (flagErr) {
      this.logger.error(
        `${SETTLEMENT_LOG_CODES.reconcilePending} alert=true charge=${chargeId}: could not flag the settlement for the sweeper (${(flagErr as Error).message}); relying on Stripe redelivery`,
      );
    }
  }

  // Only clears a flag raised before this run started (a newer failure stays).
  private async clearReconcileFlag(chargeId: string, startedAt: Date): Promise<void> {
    await this.prisma.chargeSettlement.updateMany({
      where: { stripe_charge_id: chargeId, reconcile_requested_at: { lte: startedAt } },
      data: { reconcile_requested_at: null, reconcile_reason: null },
    });
  }

  private async applyAdjustmentsLocked(input: AdjustmentInput): Promise<AdjustOutcome> {
    let row = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: input.charge_id },
    });
    if (!row || row.status === 'awaiting_fee') {
      // Settle first (it reads Stripe's amount_refunded), then adjust.
      try {
        await this.settleChargeLocked({ purchase: input.purchase, charge_id: input.charge_id });
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
    // A flagged settlement re-reads its dispute even when this caller only
    // knows about refunds (the sweeper, a transfer.reversed sync).
    const dispute = await this.currentDispute({
      ...input,
      dispute_id: input.dispute_id ?? row.reconcile_dispute_id ?? null,
    });
    let current: ChargeSettlement = row;
    let adjusted = false;

    for (let round = 0; round < 4; round += 1) {
      const refundedOnRecord = await this.succeededRefundCents(input.charge_id);
      const next: ChargeAdjustments = {
        refunded_cents: Math.max(
          current.refunded_cents,
          input.refunded_cents ?? 0,
          refundedOnRecord,
        ),
        dispute_withdrawn_cents: dispute?.withdrawn_cents ?? current.dispute_withdrawn_cents,
        dispute_fee_cents: dispute?.fee_cents ?? current.dispute_fee_cents,
      };
      if (current.status === 'awaiting_fee') {
        // Still no fee from Stripe: remember the adjustment; settleCharge
        // applies it when it computes the split.
        const awaitingId = current.id;
        await this.prisma.$transaction(async (tx) => {
          await this.chargeLock.fence(input.charge_id, tx);
          await tx.chargeSettlement.updateMany({
            where: { id: awaitingId, status: 'awaiting_fee' },
            data: { ...next, adjusted_at: new Date() },
          });
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
        // B-627-2: the adjustment claim is fenced like every money step, so a
        // holder whose lease was taken over cannot rewrite the targets.
        const from = current;
        const claim = await this.prisma.$transaction(async (tx) => {
          await this.chargeLock.fence(input.charge_id, tx);
          return tx.chargeSettlement.updateMany({
            where: {
              id: from.id,
              refunded_cents: from.refunded_cents,
              dispute_withdrawn_cents: from.dispute_withdrawn_cents,
              dispute_fee_cents: from.dispute_fee_cents,
            },
            data: {
              ...next,
              target_platform_fee_cents: targets.platform_fee_cents,
              target_head_coach_cents: targets.head_coach_split_cents,
              target_coach_net_cents: targets.coach_net_cents,
              adjusted_at: new Date(),
            },
          });
        });
        if (claim.count !== 1) {
          const reread: ChargeSettlement | null = await this.prisma.chargeSettlement.findUnique({
            where: { id: current.id },
          });
          if (!reread) return 'no_settlement';
          current = reread;
          continue;
        }
        adjusted = true;
        current = {
          ...current,
          ...next,
          target_platform_fee_cents: targets.platform_fee_cents,
          target_head_coach_cents: targets.head_coach_split_cents,
          target_coach_net_cents: targets.coach_net_cents,
        };
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
      // Drain before release: a refund recorded while we converged (its
      // webhook is waiting on this lock, or gave up) is applied now.
      const after = await this.succeededRefundCents(input.charge_id);
      if (after <= next.refunded_cents) return adjusted ? 'adjusted' : 'unchanged';
    }
    this.logger.warn(
      `applyAdjustments: refunds kept arriving charge=${input.charge_id}; the next delivery converges the rest`,
    );
    return adjusted ? 'adjusted' : 'deferred';
  }

  /** Cumulative succeeded refunds on a charge (one row per Stripe refund id). */
  private async succeededRefundCents(chargeId: string): Promise<number> {
    const rows = await this.prisma.chargeRefund.findMany({
      where: { stripe_charge_id: chargeId, status: 'succeeded' },
      select: { amount_cents: true },
    });
    return rows.reduce((n, r) => n + (r.amount_cents > 0 ? r.amount_cents : 0), 0);
  }

  /**
   * The dispute's current position, read from Stripe under the lock. With a
   * dispute id the canonical read is mandatory (B-627-4): a failed request, a
   * response for another charge or one without balance_transactions throws
   * DisputeStateUnavailableError and nothing moves — the event's own position
   * may be older than what has already been applied (a late `created` after a
   * `won`). Without a dispute id (legacy callers) the caller's position is used.
   */
  private async currentDispute(
    input: AdjustmentInput,
  ): Promise<{ withdrawn_cents: number; fee_cents: number } | null> {
    if (!input.dispute_id) return input.dispute ?? null;
    let fresh: Awaited<ReturnType<StripeConnectApiService['retrieveDispute']>>;
    try {
      fresh = await this.stripe.retrieveDispute(input.dispute_id);
    } catch (err) {
      throw new DisputeStateUnavailableError(
        input.dispute_id,
        input.charge_id,
        (err as Error)?.message ?? 'request failed',
      );
    }
    if (!fresh || !Array.isArray(fresh.balance_transactions)) {
      throw new DisputeStateUnavailableError(
        input.dispute_id,
        input.charge_id,
        'the response has no balance_transactions',
      );
    }
    if (typeof fresh.charge === 'string' && fresh.charge !== input.charge_id) {
      throw new DisputeStateUnavailableError(
        input.dispute_id,
        input.charge_id,
        `the dispute belongs to charge ${fresh.charge}`,
      );
    }
    for (const bt of fresh.balance_transactions) {
      if (typeof bt?.amount !== 'number' || (bt.fee !== undefined && typeof bt.fee !== 'number')) {
        throw new DisputeStateUnavailableError(
          input.dispute_id,
          input.charge_id,
          'a balance transaction has no numeric amount or fee',
        );
      }
    }
    return disputeAmountsFrom(fresh.balance_transactions);
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

  // Caller holds the charge lock. Moves the payee from their position (read
  // here, under the lock) to the target, then records the leg's absolute
  // position on its ledger slice.
  private async convergeLeg(
    row: ChargeSettlement,
    leg: Leg,
    adj: ChargeAdjustments,
    reason: 'refund' | 'dispute',
  ): Promise<void> {
    await this.moveLegToTarget(row, leg, adj, reason);
    await this.syncLegLedger(row, leg);
  }

  private async moveLegToTarget(
    row: ChargeSettlement,
    leg: Leg,
    adj: ChargeAdjustments,
    reason: 'refund' | 'dispute',
  ): Promise<void> {
    const fence = this.fenceFor(row.stripe_charge_id);
    // Post anything still pending first so reversals act on real transfers.
    const pending = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: row.id, destination_user_id: leg.payee_user_id, status: 'pending' },
    });
    for (const t of pending) await this.safeAttempt(t.id, row.stripe_charge_id);

    // B-627-5: resolve every in-flight reversal first (re-driven with its own
    // key, reconciled against Stripe's reversal list). Still unknown ->
    // ReversalUncertainError propagates: no position is computed from a
    // reversal that may or may not have happened, and no recovery is opened.
    const legTransfers = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: row.id, destination_user_id: leg.payee_user_id },
      select: { id: true },
    });
    for (const t of legTransfers) await this.transfers.resolvePendingReversals(t.id, fence);

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
        const res = await this.transfers.reverse({
          transfer_row_id: t.id,
          amount_cents: take,
          purpose: 'adjust',
          fence,
        });
        if (res.status === 'succeeded') {
          need -= take;
          continue;
        }
        // Definitive refusal only (insufficient balance, invalid request):
        // the rest is owed by the payee.
        this.logger.warn(
          `transfer reversal refused transfer=${t.id} charge=${row.stripe_charge_id}: ${res.error}; recording a recovery to collect`,
        );
        break;
      }
      if (need > 0) {
        await this.prisma.$transaction(async (tx) => {
          await fence(tx);
          await this.createRecovery(tx, {
            settlementId: row.id,
            chargeId: row.stripe_charge_id,
            payee: leg.payee_user_id,
            amountCents: need,
            currency: row.currency,
            reason,
            key: `${leg.leg}-${key}`,
          });
        });
      }
      return;
    }

    if (delta > 0) {
      // Cancel what the payee still owes on this charge first.
      const give = await this.prisma.$transaction(async (tx) => {
        await fence(tx);
        let left = delta;
        for (const r of recoveries) {
          if (left <= 0) break;
          if (r.status !== 'open') continue;
          const releasable = r.amount_cents - r.collected_cents;
          const x = Math.min(left, releasable);
          if (x <= 0) continue;
          const remaining = r.amount_cents - x;
          const res = await tx.payeeRecovery.updateMany({
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
          if (res.count === 1) left -= x;
        }
        return left;
      });
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
      const reinstateKey = `tgp-settle-${row.stripe_charge_id}-${leg.leg}-reinstate-${key}`;
      const reinstate = await this.prisma.$transaction(async (tx) => {
        await fence(tx);
        const prior = await tx.connectTransfer.findUnique({
          where: { idempotency_key: reinstateKey },
        });
        if (prior) return prior;
        // B-627-3: money owed on the payee's other charges is netted out of a
        // reinstatement before anything is paid back.
        const netted = await this.netOpenRecoveries(
          tx,
          leg.payee_user_id,
          row.currency,
          give,
          row.id,
        );
        return this.transfers.enqueueSettlementTransfer(
          {
            settlement_id: row.id,
            purchase_id: row.purchase_id,
            kind: leg.leg === 'coach' ? 'coach_reinstate' : 'head_coach_reinstate',
            ledger_entry_id: null,
            destination_stripe_account_id: account.stripe_account_id,
            destination_user_id: leg.payee_user_id,
            amount_cents: give - netted,
            netted_recovery_cents: netted,
            currency: row.currency,
            source_stripe_charge_id: null,
            idempotency_key: reinstateKey,
          },
          tx,
        );
      });
      await this.safeAttempt(reinstate.id, row.stripe_charge_id);
    }
  }

  // The leg's ledger slice records the payee's absolute position on this
  // charge: reversed_cents = slice - (sum of the leg's transfers, net of
  // reversals, plus what they netted). Recomputed from the transfer rows on
  // every adjustment, so a duplicate or concurrent delivery can never count a
  // reversal twice (the old additive applyReversal could).
  private async syncLegLedger(row: ChargeSettlement, leg: Leg): Promise<void> {
    const entry = await this.prisma.splitLedgerEntry.findFirst({
      where: {
        purchase_id: row.purchase_id,
        stripe_charge_id: row.stripe_charge_id,
        kind: leg.leg === 'coach' ? 'destination' : 'head_coach_split',
        payee_user_id: leg.payee_user_id,
      },
    });
    if (!entry) return;
    const transfers = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: row.id, destination_user_id: leg.payee_user_id },
    });
    const position = payeePositionCents(transfers, []);
    await this.ledger.setLegPosition({ entry_id: entry.id, position_cents: position });
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

  // An awaiting_fee row for a charge we know about but could not settle yet
  // (Stripe unavailable, charge lock busy). Provisional gross / currency are
  // the purchase's; the settle claim overwrites them from Stripe.
  private async ensureProvisionalRow(args: {
    purchase: ClientPurchase;
    charge_id: string;
    invoice_id?: string | null;
  }): Promise<ChargeSettlement> {
    const existing = await this.prisma.chargeSettlement.findUnique({
      where: { stripe_charge_id: args.charge_id },
    });
    if (existing) return existing;
    const policy = await this.feePolicy.resolvePolicy(args.purchase.coach_user_id);
    return this.createSettlementRow({
      purchase: args.purchase,
      chargeId: args.charge_id,
      invoiceId: args.invoice_id ?? null,
      grossCents: args.purchase.amount_cents,
      currency: (args.purchase.currency ?? 'usd').toLowerCase(),
      platformBps: policy.platform_application_fee_bps,
      mechanism: SETTLEMENT_MECHANISM_SCT,
    });
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

  private async attemptPendingTransfers(settlementId: string, chargeId: string): Promise<void> {
    const pending = await this.prisma.connectTransfer.findMany({
      where: { settlement_id: settlementId, status: 'pending' },
    });
    for (const t of pending) await this.safeAttempt(t.id, chargeId);
  }

  // Caller holds the charge lock: the attempt is fenced (B-627-2). A lost
  // lock propagates; any other failure leaves the row pending for the sweeper.
  private async safeAttempt(transferId: string, chargeId: string): Promise<ConnectTransfer | null> {
    try {
      return await this.transfers.attempt(transferId, { beforeStripe: this.fenceFor(chargeId) });
    } catch (err) {
      if (isRetryableMoneyError(err)) throw err;
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
