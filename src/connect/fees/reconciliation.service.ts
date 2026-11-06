import { Injectable, Logger } from '@nestjs/common';
import type {
  ChargeSettlement,
  ClientPurchase,
  ConnectTransfer,
  PayeeRecovery,
  ReconciliationSnapshot,
  SplitLedgerEntry,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { StripeConnectApiError, StripeConnectApiService } from '../stripe-connect-api.service';
import {
  SETTLEMENT_MECHANISM_SCT,
  chargeRefundsFromStripe,
  payeePositionCents,
  settlementFailureCode,
} from './charge-settlement.service';
import { isGuestTrialIntent } from '../../storefront/guest-trial-intent';

// S-FEE — per-charge identity for a separate-charge-and-transfer settlement.
// Every check is integer cents; drift is the sum of absolute mismatches.
//   1. Stripe gross / fee / refunded == the settlement's recorded values
//   2. the four ledger slices of the charge sum to its gross
//   3. each payee's position == their current target
//   4. platform: cash kept + recoveries owed - netted in == target platform fee (>= 0)
//
// Round 4 (B-627-3, C-627-3): the platform position is also split into what
// TGP really holds and what it is still owed, so an uncollected receivable is
// never reported as cash:
//   platform_cash_cents       = cash on the charge - cents that belong to
//                               other charges' debts (netted in here) + cents
//                               already collected on this
//                               charge's own recoveries
//   receivable_open_cents     = this charge's recoveries not yet collected
//   platform_net_cents        = platform_cash_cents + receivable_open_cents
// A negative platform_cash_cents is reported as `platform_cash_negative`.
export interface SettlementIdentityInput {
  settlement: ChargeSettlement;
  ledger: SplitLedgerEntry[];
  transfers: ConnectTransfer[];
  recoveries: PayeeRecovery[];
  stripe: { gross_cents: number; fee_cents: number; refunded_cents: number };
}

export function settlementIdentityDrift(input: SettlementIdentityInput): {
  drift_cents: number;
  platform_net_cents: number;
  platform_cash_cents: number;
  receivable_open_cents: number;
  notes: string[];
} {
  const s = input.settlement;
  const notes: string[] = [];
  let drift = 0;
  const check = (label: string, expected: number, actual: number) => {
    if (expected !== actual) {
      drift += Math.abs(expected - actual);
      notes.push(`${label}: expected ${expected}, found ${actual}`);
    }
  };
  check('stripe_gross', s.gross_cents, input.stripe.gross_cents);
  check('stripe_fee', s.stripe_fee_cents ?? 0, input.stripe.fee_cents);
  check('stripe_refunded', s.refunded_cents, input.stripe.refunded_cents);
  const slices = input.ledger.filter((e) => e.stripe_charge_id === s.stripe_charge_id);
  const slicesTotal = slices.reduce((n, e) => n + e.amount_cents, 0);
  if ((s.coach_net_cents ?? 0) >= 0) check('ledger_slices_sum', s.gross_cents, slicesTotal);
  const forPayee = (payee: string | null) => ({
    transfers: input.transfers.filter((t) => t.destination_user_id === payee),
    recoveries: input.recoveries.filter((r) => r.payee_user_id === payee),
  });
  const coach = forPayee(s.coach_user_id);
  check(
    'coach_position',
    s.target_coach_net_cents ?? 0,
    payeePositionCents(coach.transfers, coach.recoveries),
  );
  if (s.head_coach_user_id && (s.head_coach_split_cents ?? 0) > 0) {
    const hc = forPayee(s.head_coach_user_id);
    check(
      'head_coach_position',
      s.target_head_coach_cents ?? 0,
      payeePositionCents(hc.transfers, hc.recoveries),
    );
  }
  let transferred = 0;
  let nettedIn = 0;
  for (const t of input.transfers) {
    // Netting on this charge's transfers paid other charges' debts; it stands
    // even when the transfer finally failed (C-627-6, round 6).
    nettedIn += t.netted_recovery_cents;
    if (t.status === 'failed') continue;
    transferred += t.amount_cents - t.reversed_amount_cents;
  }
  const live = input.recoveries.filter((r) => r.status !== 'released');
  const owed = live.reduce((n, r) => n + r.amount_cents, 0);
  const collected = live.reduce((n, r) => n + Math.min(r.collected_cents, r.amount_cents), 0);
  const cash =
    s.gross_cents -
    (s.stripe_fee_cents ?? 0) -
    s.refunded_cents -
    s.dispute_withdrawn_cents -
    s.dispute_fee_cents -
    transferred;
  const platformNet = cash + owed - nettedIn;
  const platformCash = cash - nettedIn + collected;
  const receivableOpen = owed - collected;
  check('platform_net', s.target_platform_fee_cents ?? 0, platformNet);
  if (platformNet < 0) notes.push(`platform_net_negative: ${platformNet}`);
  if (platformCash < 0) {
    notes.push(`platform_cash_negative: ${platformCash} (receivable_open ${receivableOpen})`);
  }
  return {
    drift_cents: drift,
    platform_net_cents: platformNet,
    platform_cash_cents: platformCash,
    receivable_open_cents: receivableOpen,
    notes,
  };
}

// ReconciliationService — answers "does our ledger match Stripe's books
// for this purchase?". Walks every relevant Stripe object (Charge,
// transfers attached to it, refunds attached to it) and compares each
// side to our SplitLedgerEntry + ConnectTransfer state.
//
// Two failure modes worth handling explicitly:
//   1. Stripe says we charged $100 but the ledger sums to $90.
//      drift_cents = 1000.  status=drift.
//   2. Stripe says a refund was issued but we have no ChargeRefund row.
//      drift_cents = refund_amount.  status=drift.
//
// The snapshot is persisted so the admin UI can list "every purchase
// with status=drift" without recomputing — that's the page operators
// actually use to chase down support tickets.

export interface ReconciliationResult {
  purchase_id: string;
  status: 'ok' | 'drift' | 'unknown';
  drift_cents: number | null;
  stripe: {
    amount_cents: number | null;
    refunded_cents: number | null;
    application_fee_cents: number | null;
    transfers_cents: number | null;
  };
  ledger: {
    destination_cents: number;
    application_fee_cents: number;
    head_coach_cents: number;
    reversed_cents: number;
  };
  notes: string | null;
}

type LedgerSums = ReconciliationResult['ledger'];

/**
 * FIX-1225R3: what one way of reading a purchase came to, before the
 * known-charge check. `accounted` = the charges it read and compared, or
 * found unreadable (its status already says so).
 */
interface ChargeVerdict {
  status: 'ok' | 'drift' | 'unknown';
  drift_cents: number | null;
  stripe: ReconciliationResult['stripe'];
  notes: string | null;
  accounted: Set<string>;
}

const NO_STRIPE_READ: ReconciliationResult['stripe'] = {
  amount_cents: null,
  refunded_cents: null,
  application_fee_cents: null,
  transfers_cents: null,
};

/** MONEY-DAILY: what one purchase's check came to; `failed` = the check threw and wrote no snapshot. */
export interface ReconciliationSweepOutcome {
  purchase_id: string;
  status: 'ok' | 'drift' | 'unknown' | 'failed';
}

/** One runSweep batch. The admin route returns only scanned / drifted / unknown. */
export interface ReconciliationSweepResult {
  scanned: number;
  drifted: number;
  unknown: number;
  failed: number;
  outcomes: ReconciliationSweepOutcome[];
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
  ) {}

  // Reconcile a single ClientPurchase. Always writes a snapshot — that's
  // the authoritative read for the admin UI.
  async reconcilePurchase(purchaseId: string): Promise<ReconciliationResult> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) {
      throw new Error(`Reconcile: no purchase with id ${purchaseId}`);
    }
    return this.reconcileFromRow(purchase);
  }

  // Bulk reconciler — re-checks N purchases (oldest snapshots first).
  // Used by the nightly sweeper.
  async runSweep(
    limit = 50,
    opts: { staleBefore?: Date } = {},
  ): Promise<ReconciliationSweepResult> {
    // Reconcile purchases that have either no snapshot yet, or whose
    // snapshot is older than 24h, and which are in a money-moved state.
    // MONEY-DAILY: the daily check passes staleBefore = its own start time,
    // so one run reaches every purchase once (a snapshot written during the
    // run is newer than that time and drops out of the next batch).
    const staleBefore = opts.staleBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const purchases = await this.prisma.clientPurchase.findMany({
      where: {
        status: { in: [...RECONCILED_PURCHASE_STATUSES] },
        // C01 — $0 grants have no Stripe charge; they are not reconcilable
        // and must not consume the sweep budget.
        source: null,
        OR: [
          { reconciliation: null },
          {
            reconciliation: {
              last_checked_at: { lt: staleBefore },
            },
          },
        ],
      },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
    let drifted = 0;
    let unknown = 0;
    let failed = 0;
    const outcomes: ReconciliationSweepOutcome[] = [];
    for (const row of purchases) {
      try {
        const result = await this.reconcileFromRow(row);
        if (result.status === 'drift') drifted += 1;
        else if (result.status === 'unknown') unknown += 1;
        outcomes.push({ purchase_id: row.id, status: result.status });
      } catch (err) {
        failed += 1;
        outcomes.push({ purchase_id: row.id, status: 'failed' });
        this.logger.warn(`reconcile failed purchase=${row.id}: ${(err as Error).message}`);
      }
    }
    return { scanned: purchases.length, drifted, unknown, failed, outcomes };
  }

  private async reconcileFromRow(purchase: ClientPurchase): Promise<ReconciliationResult> {
    const ledger = await this.prisma.splitLedgerEntry.findMany({
      where: { purchase_id: purchase.id },
    });
    const transfers = await this.prisma.connectTransfer.findMany({
      where: { purchase_id: purchase.id },
    });

    // S-FEE — settlement-backed purchases reconcile per charge.
    const settlements = await this.prisma.chargeSettlement.findMany({
      where: { purchase_id: purchase.id, mechanism: SETTLEMENT_MECHANISM_SCT, status: 'settled' },
      orderBy: { created_at: 'desc' },
      // Every settled charge, not only the newest twelve (Opus C-683-3, round 11).
    });
    // FIX-1225R3 (LS-1225R3 B1): every ChargeSettlement row of any status or
    // mechanism is a charge we were told about (a renewal's row stays
    // awaiting_fee while Stripe or the payout setup is not ready). Each one
    // must be read below, or the purchase is not 'ok'.
    const settlementRows = await this.prisma.chargeSettlement.findMany({
      where: { purchase_id: purchase.id },
      select: { stripe_charge_id: true, status: true, mechanism: true },
      orderBy: { created_at: 'desc' },
    });
    // FIX-1225R3 (LS-1225R3 C1 = LO-1225R3 B1): a web trial keeps its
    // SetupIntent id in stripe_payment_intent_id (isGuestTrialIntent,
    // storefront/guest-trial-intent.ts). A SetupIntent is not a payment intent and names no
    // charge, so it is read as no payment intent here and below.
    const intentId = isGuestTrialIntent(purchase.stripe_payment_intent_id)
      ? null
      : purchase.stripe_payment_intent_id;
    const ledgerSums = summarizeLedger(ledger);

    // LO-1225 B1: a purchase that never charged (a free trial canceled before
    // its first charge, or whose first charge failed) has nothing to match.
    // It is 'ok' (never_charged), not "could not be confirmed yet" every day
    // forever, only when there is no evidence of a charge of any kind: no
    // payment intent (a SetupIntent is none), no ledger row, no transfer, no
    // ChargeSettlement row of any status (FIX-1225R2), and a status that does
    // not claim a payment. A paid or active purchase with nothing recorded
    // stays 'unknown'. Any evidence sends it through the full check below.
    if (
      !intentId &&
      ledger.length === 0 &&
      transfers.length === 0 &&
      settlementRows.length === 0 &&
      NEVER_CHARGED_OK_STATUSES.has(purchase.status)
    ) {
      return this.persistSnapshot(purchase.id, 'ok', 0, {
        stripe: { amount_cents: null, refunded_cents: null, application_fee_cents: null, transfers_cents: null },
        ledger: ledgerSums,
        notes: 'never_charged',
      });
    }

    const verdict =
      settlements.length > 0
        ? await this.reconcileSettlements(purchase, settlements, ledger, transfers)
        : await this.reconcileSingleCharge(purchase, intentId, ledger, transfers, ledgerSums);

    // FIX-1225R3 (LS-1225R3 B1): before any 'ok', every known charge on the
    // purchase is accounted for: each ChargeSettlement row of any status, the
    // payment intent's charge, every ledger slice's and transfer's charge. A
    // charge the verdict above did not read and compare (an older matched
    // charge never speaks for a newer one) leaves the purchase 'unknown'
    // ("could not be confirmed yet"); a drift already found stays 'drift'.
    const unread = new Map<string, string>();
    for (const s of settlementRows) {
      unread.set(
        s.stripe_charge_id,
        s.mechanism === SETTLEMENT_MECHANISM_SCT && s.status !== 'settled'
          ? `settlement_not_settled charge=${s.stripe_charge_id} status=${s.status}`
          : `charge_not_checked charge=${s.stripe_charge_id} status=${s.status}`,
      );
    }
    for (const id of [
      ...ledger.map((e) => e.stripe_charge_id),
      ...transfers.map((t) => t.source_stripe_charge_id),
    ]) {
      if (id && !unread.has(id)) unread.set(id, `charge_not_checked charge=${id}`);
    }
    const unchecked: string[] = [];
    if (intentId && settlements.length > 0) {
      // The settled path reads settlements, not the payment intent: read it.
      const intent = await this.intentCharge(intentId);
      if (!intent.read) unchecked.push(`charge_not_checked payment_intent=${intentId}`);
      else if (intent.chargeId && !unread.has(intent.chargeId)) {
        unread.set(intent.chargeId, `charge_not_checked charge=${intent.chargeId}`);
      }
    }
    for (const [id, note] of unread) if (!verdict.accounted.has(id)) unchecked.push(note);

    if (unchecked.length === 0 || verdict.status === 'drift') {
      const notes = [verdict.notes, ...unchecked].filter((n): n is string => !!n);
      return this.persistSnapshot(purchase.id, verdict.status, verdict.drift_cents, {
        stripe: verdict.stripe,
        ledger: ledgerSums,
        notes: notes.length > 0 ? notes.join('; ').slice(0, 2000) : null,
      });
    }
    // The unread charge is the reason; "no charge id" says nothing more.
    const notes = [...unchecked];
    if (verdict.notes && verdict.notes !== 'no_charge_id_yet') notes.push(verdict.notes);
    return this.persistSnapshot(purchase.id, 'unknown', null, {
      stripe: verdict.stripe,
      ledger: ledgerSums,
      notes: notes.join('; ').slice(0, 2000),
    });
  }

  // A purchase with no settled settlement: one charge (the payment intent's,
  // else the newest destination slice's) against the whole ledger.
  private async reconcileSingleCharge(
    purchase: ClientPurchase,
    intentId: string | null,
    ledger: SplitLedgerEntry[],
    transfers: ConnectTransfer[],
    ledgerSums: LedgerSums,
  ): Promise<ChargeVerdict> {
    // Stripe side: we need the Charge id. The shortest path is
    // PI -> latest_charge -> Charge. For recurring purchases each renewal
    // has its own Charge — we reconcile only the most recent one
    // (renewals append SplitLedgerEntry rows in the same composite-unique
    // slot for `application_fee` + `destination`, so the most recent
    // Stripe charge is the right comparison).
    const chargeId = await this.resolveChargeId(intentId, ledger);
    let stripeAmount: number | null = null;
    let stripeRefunded: number | null = null;
    let stripeAppFee: number | null = null;
    let stripeTransfersCents = 0;

    if (!chargeId) {
      return { status: 'unknown', drift_cents: null, stripe: { ...NO_STRIPE_READ }, notes: 'no_charge_id_yet', accounted: new Set() };
    }
    const accounted = new Set([chargeId]);

    try {
      const charge = await this.stripe.retrieveCharge(chargeId);
      stripeAmount = typeof charge.amount === 'number' ? charge.amount : null;
      stripeRefunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
      stripeAppFee =
        typeof charge.application_fee_amount === 'number' ? charge.application_fee_amount : 0;
      // For every head-coach split we minted as a follow-on Transfer, add
      // its net (amount - reversed) to stripeTransfersCents. We trust our
      // ConnectTransfer row's stripe_transfer_id; pulling the live Stripe
      // Transfer per row would multiply the round-trip count by N.
      for (const t of transfers) {
        if (t.status === 'succeeded' || t.status === 'reversed') {
          stripeTransfersCents += t.amount_cents - t.reversed_amount_cents;
        }
      }
    } catch (err) {
      const msg = err instanceof StripeConnectApiError ? err.message : (err as Error).message;
      this.logger.warn(
        `Stripe charge retrieve failed for purchase=${purchase.id} charge=${chargeId}: ${msg}`,
      );
      return {
        status: 'unknown',
        drift_cents: null,
        stripe: { ...NO_STRIPE_READ },
        notes: `stripe_retrieve_failed: ${msg}`,
        accounted,
      };
    }

    // Compute drift. Identity we want:
    //   stripe_amount - stripe_refunded
    //     == ledger_destination + ledger_application_fee + ledger_head_coach
    //        - ledger_reversed
    //
    // (left side = real money that left the platform Charge net of refunds;
    //  right side = what our ledger says we accounted for, net of reversals.)
    let stripeNet = (stripeAmount ?? 0) - (stripeRefunded ?? 0);
    const ledgerNet =
      ledgerSums.destination_cents +
      ledgerSums.application_fee_cents +
      ledgerSums.head_coach_cents -
      ledgerSums.reversed_cents;
    // LS-1225 B2: a lost dispute takes money back through Stripe's dispute,
    // not a refund (amount_refunded stays 0), and the dispute handler reverses
    // the ledger by the dispute amount. Count Stripe's lost-dispute amount (the
    // ChargeDispute rows the dispute webhook wrote) for this charge on the
    // Stripe side: a lost chargeback reads 'ok' only when the ledger reversal
    // matches it, and 'drift' when the ledger was never reversed. Read for a
    // chargeback_lost purchase, or when the ledger shows a reversal the
    // refunds do not explain (a purchase restarted after a lost dispute).
    if (
      purchase.status === 'chargeback_lost' ||
      (stripeNet !== ledgerNet && ledgerSums.reversed_cents > 0)
    ) {
      const lost = await this.prisma.chargeDispute.findMany({
        where: { purchase_id: purchase.id, stripe_charge_id: chargeId, status: 'lost' },
        select: { amount_cents: true },
      });
      stripeNet -= lost.reduce((sum, d) => sum + d.amount_cents, 0);
    }
    const drift = stripeNet - ledgerNet;

    const status: 'ok' | 'drift' = drift === 0 ? 'ok' : 'drift';

    return {
      status,
      drift_cents: drift,
      stripe: {
        amount_cents: stripeAmount,
        refunded_cents: stripeRefunded,
        application_fee_cents: stripeAppFee,
        transfers_cents: stripeTransfersCents,
      },
      notes: status === 'drift' ? this.describeDrift(drift) : null,
      accounted,
    };
  }

  private async reconcileSettlements(
    purchase: ClientPurchase,
    settlements: ChargeSettlement[],
    ledger: SplitLedgerEntry[],
    transfers: ConnectTransfer[],
  ): Promise<ChargeVerdict> {
    const recoveries = await this.prisma.payeeRecovery.findMany({
      where: { settlement_id: { in: settlements.map((s) => s.id) } },
    });
    let drift = 0;
    let gross = 0;
    let refunded = 0;
    let transferred = 0;
    let platformCash = 0;
    let receivableOpen = 0;
    let pending = 0;
    const notes: string[] = [];
    // FIX-1225R3: a failed read no longer stops the loop, so a drift already
    // found on another charge is reported as drift, not hidden behind unknown.
    const failures: string[] = [];
    const accounted = new Set<string>();
    for (const s of settlements) {
      accounted.add(s.stripe_charge_id);
      let charge;
      let stripeRefunded: number;
      try {
        charge = await this.stripe.retrieveCharge(s.stripe_charge_id, {
          expandBalanceTransaction: true,
        });
        // B-683-1 (round 11): compare refunds in the settlement currency. Round 13 (Opus
        // B-684-3): succeeded refunds only, from the full list (a pending one is not drift).
        const btc = charge.balance_transaction;
        const cur = (typeof btc === 'object' && btc?.currency) || s.currency;
        stripeRefunded = 0;
        if ((charge.amount_refunded ?? 0) > 0) {
          const list = await chargeRefundsFromStripe(this.stripe, s.stripe_charge_id, cur);
          stripeRefunded = list.succeeded_debit_cents;
        }
      } catch (err) {
        failures.push(`stripe_retrieve_failed charge=${s.stripe_charge_id}: ${settlementFailureCode(err)}`);
        continue;
      }
      const bt =
        charge.balance_transaction && typeof charge.balance_transaction === 'object'
          ? charge.balance_transaction
          : null;
      const result = settlementIdentityDrift({
        settlement: s,
        ledger,
        transfers: transfers.filter((t) => t.settlement_id === s.id),
        recoveries: recoveries.filter((r) => r.settlement_id === s.id),
        stripe: {
          gross_cents: bt?.amount ?? charge.amount,
          fee_cents: bt?.fee ?? 0,
          refunded_cents: stripeRefunded,
        },
      });
      drift += result.drift_cents;
      platformCash += result.platform_cash_cents;
      receivableOpen += result.receivable_open_cents;
      gross += bt?.amount ?? charge.amount;
      refunded += stripeRefunded;
      for (const n of result.notes) notes.push(`${s.stripe_charge_id} ${n}`);
      for (const t of transfers) {
        if (t.settlement_id !== s.id || t.status === 'failed') continue;
        // B-683-2 (round 11): a row Stripe has not executed is a promise, not cash.
        if (t.status === 'succeeded' || t.status === 'reversed') {
          transferred += t.amount_cents - t.reversed_amount_cents;
        } else {
          pending += t.amount_cents;
        }
      }
    }
    if (failures.length > 0 && drift === 0) {
      return {
        status: 'unknown',
        drift_cents: null,
        stripe: { ...NO_STRIPE_READ },
        notes: failures.join('; ').slice(0, 2000),
        accounted,
      };
    }
    notes.push(...failures);
    // Cash and receivables are reported separately (B-627-3): an open
    // recovery is money TGP is fronting, not money it has.
    if (receivableOpen > 0 || platformCash < 0) {
      notes.unshift(`platform_cash=${platformCash} receivable_open=${receivableOpen}`);
    }
    if (platformCash < 0) {
      this.logger.error(
        `SFEE_PLATFORM_CASH_NEGATIVE alert=true purchase=${purchase.id} platform_cash=${platformCash} receivable_open=${receivableOpen}`,
      );
    }
    // B-683-2: until Stripe executes every transfer the cash cannot be attested.
    if (pending > 0) notes.unshift(`transfers_pending_cents=${pending}`);
    const status = drift !== 0 ? 'drift' : pending > 0 ? 'unknown' : 'ok';
    return {
      status,
      drift_cents: drift,
      stripe: {
        amount_cents: gross,
        refunded_cents: refunded,
        application_fee_cents: 0,
        transfers_cents: transferred,
      },
      notes: notes.length > 0 ? notes.join('; ').slice(0, 2000) : null,
      accounted,
    };
  }

  private async resolveChargeId(
    intentId: string | null,
    ledger: SplitLedgerEntry[],
  ): Promise<string | null> {
    if (!intentId) {
      // For recurring purchases, the per-renewal charge id lives on the
      // SplitLedgerEntry.stripe_charge_id of the most recent destination
      // slice. Use that as a cheap fallback so we don't have to walk
      // invoices. A web trial's SetupIntent (FIX-1225R3) lands here too.
      // FIX-1225R3: picked from the rows already read, in the order the
      // query used (posted_at desc; Postgres puts a null first).
      const at = (e: SplitLedgerEntry) => (e.posted_at ? e.posted_at.getTime() : Infinity);
      const entry = ledger
        .filter((e) => e.kind === 'destination')
        .reduce<SplitLedgerEntry | null>((best, e) => (!best || at(e) > at(best) ? e : best), null);
      return entry?.stripe_charge_id ?? null;
    }
    return (await this.intentCharge(intentId)).chargeId;
  }

  // The payment intent's charge; read = false when Stripe could not be read.
  private async intentCharge(intentId: string): Promise<{ read: boolean; chargeId: string | null }> {
    try {
      const pi = await this.stripe.retrievePaymentIntent(intentId);
      const latest = typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
      return { read: true, chargeId: latest ?? pi.charges?.data?.[0]?.id ?? null };
    } catch (err) {
      this.logger.warn(`resolveChargeId failed pi=${intentId}: ${(err as Error).message}`);
      return { read: false, chargeId: null };
    }
  }

  private async persistSnapshot(
    purchaseId: string,
    status: 'ok' | 'drift' | 'unknown',
    driftCents: number | null,
    detail: {
      stripe: {
        amount_cents: number | null;
        refunded_cents: number | null;
        application_fee_cents: number | null;
        transfers_cents: number | null;
      };
      ledger: {
        destination_cents: number;
        application_fee_cents: number;
        head_coach_cents: number;
        reversed_cents: number;
      };
      notes: string | null;
    },
  ): Promise<ReconciliationResult> {
    await this.prisma.reconciliationSnapshot.upsert({
      where: { purchase_id: purchaseId },
      create: {
        purchase_id: purchaseId,
        status,
        drift_cents: driftCents,
        stripe_amount_cents: detail.stripe.amount_cents,
        stripe_refunded_cents: detail.stripe.refunded_cents,
        stripe_application_fee_cents: detail.stripe.application_fee_cents,
        stripe_transfers_cents: detail.stripe.transfers_cents,
        ledger_destination_cents: detail.ledger.destination_cents,
        ledger_application_fee_cents: detail.ledger.application_fee_cents,
        ledger_head_coach_cents: detail.ledger.head_coach_cents,
        ledger_reversed_cents: detail.ledger.reversed_cents,
        notes: detail.notes,
        last_checked_at: new Date(),
      },
      update: {
        status,
        drift_cents: driftCents,
        stripe_amount_cents: detail.stripe.amount_cents,
        stripe_refunded_cents: detail.stripe.refunded_cents,
        stripe_application_fee_cents: detail.stripe.application_fee_cents,
        stripe_transfers_cents: detail.stripe.transfers_cents,
        ledger_destination_cents: detail.ledger.destination_cents,
        ledger_application_fee_cents: detail.ledger.application_fee_cents,
        ledger_head_coach_cents: detail.ledger.head_coach_cents,
        ledger_reversed_cents: detail.ledger.reversed_cents,
        notes: detail.notes,
        last_checked_at: new Date(),
      },
    });
    return {
      purchase_id: purchaseId,
      status,
      drift_cents: driftCents,
      stripe: detail.stripe,
      ledger: detail.ledger,
      notes: detail.notes,
    };
  }

  // Pretty-format a drift for the admin notes column.
  private describeDrift(drift: number): string {
    if (drift > 0) {
      return `stripe_over_ledger_by_${drift}_cents — Stripe shows more revenue than the ledger has accounted for (likely a missing transfer/refund row)`;
    }
    return `ledger_over_stripe_by_${Math.abs(drift)}_cents — the ledger has accounted for more than Stripe paid (likely a duplicate or pre-mature row)`;
  }

  // Get the saved snapshot for a purchase (cheap read for the admin UI).
  async getSavedSnapshot(purchaseId: string): Promise<ReconciliationSnapshot | null> {
    return this.prisma.reconciliationSnapshot.findUnique({
      where: { purchase_id: purchaseId },
    });
  }

  // List purchases whose snapshot says drift — drives the "needs review"
  // admin tab.
  async listDrift(limit = 100): Promise<ReconciliationSnapshot[]> {
    return this.prisma.reconciliationSnapshot.findMany({
      where: { status: 'drift' },
      orderBy: { last_checked_at: 'desc' },
      take: Math.min(limit, 500),
    });
  }
}

/**
 * Purchase states the money check reads: every status written to
 * ClientPurchase.status in which a charge can have succeeded. Shared by the
 * admin button and the daily run. FIX-1225R2 (LS-1225R2 B1): built from every
 * writer, not from memory; test/money-daily-states.spec.ts fails when a
 * written status is in neither this list nor UNCHARGED_PURCHASE_STATUSES.
 *   paid, active: checkout and invoice success (checkout-webhook-handler
 *     :1418-1424, :2413-2416; refund-dispute-handler :2000; dunning-v2 :1699)
 *   trialing, past_due, unpaid, paused, canceled: Stripe's own subscription
 *     status, written as is (checkout-webhook-handler :1746 + :1849, :2679 +
 *     :2715; :2990-2995 writes unpaid or past_due; guest-checkout :2001); a
 *     renewal that went unpaid after paid periods is money (LS-1225R2 B1).
 *     client-billing :1142-1146 and :1750 write only active or trialing
 *     (PAID_SUB_STATUSES :105; FIX-1225R3, LS-1225R3 N1). canceled is also written by
 *     client-billing :1820, dunning :805 and :964, account deletion :1027.
 *   refunded, disputed, chargeback_lost: refund-dispute-handler :500, :1981,
 *     :2089, :2138; guest-checkout :1550 (LS-1225 B2).
 */
export const RECONCILED_PURCHASE_STATUSES = [
  'paid',
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
  'refunded',
  'disputed',
  'chargeback_lost',
] as const;

/**
 * Written statuses the check does not read: no charge has succeeded in any
 * of them, so there is nothing to match (and the single-charge read would
 * compare a failed charge's amount as if it were money).
 *   pending: checkout or subscription not finished (checkout.service :592,
 *     :817; subscription-checkout :613, :1029, :1460, :1473;
 *     subscription-attempt :135; checkout-webhook-handler :2479)
 *   payment_failed: the payment did not complete (checkout-webhook-handler
 *     :1612, :2443-2447 via :2584, only when Stripe's current payment intent
 *     status is requires_payment_method or canceled, :55-69)
 *   expired: checkout session expired from pending (checkout-webhook-handler
 *     :1641; subscription-checkout :1041, :1460, :1521)
 *   incomplete, incomplete_expired: first subscription payment never
 *     completed (checkout-webhook-handler :1746 + :1849, :246; guest-checkout
 *     :1980-1990); Stripe never moves a paid plan back to either.
 *   pending_consent, revoked: $0 invite grants (invite-grant :411, :499,
 *     :1040), source set, so never in the sweep anyway (C01).
 */
export const UNCHARGED_PURCHASE_STATUSES = [
  'pending',
  'payment_failed',
  'expired',
  'incomplete',
  'incomplete_expired',
  'pending_consent',
  'revoked',
] as const;

/**
 * States in which a purchase with no evidence of a charge simply never
 * charged (LO-1225 B1): the plan states that do not claim a payment.
 */
const NEVER_CHARGED_OK_STATUSES: ReadonlySet<string> = new Set([
  'trialing',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
]);

function summarizeLedger(rows: SplitLedgerEntry[]): {
  destination_cents: number;
  application_fee_cents: number;
  head_coach_cents: number;
  reversed_cents: number;
} {
  let destination = 0;
  let applicationFee = 0;
  let headCoach = 0;
  let reversed = 0;
  for (const r of rows) {
    if (r.status === 'pending' || r.status === 'failed') {
      // Pending/failed slices haven't moved real money yet — skip them
      // for the Stripe-side comparison.
      continue;
    }
    const net = r.amount_cents;
    if (r.kind === 'destination') destination += net;
    else if (r.kind === 'application_fee') applicationFee += net;
    else if (r.kind === 'head_coach_split') headCoach += net;
    reversed += r.reversed_cents;
  }
  return {
    destination_cents: destination,
    application_fee_cents: applicationFee,
    head_coach_cents: headCoach,
    reversed_cents: reversed,
  };
}
