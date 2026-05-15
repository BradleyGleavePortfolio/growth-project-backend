import { Injectable, Logger } from '@nestjs/common';
import type {
  ClientPurchase,
  ReconciliationSnapshot,
  SplitLedgerEntry,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../stripe-connect-api.service';

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
  async runSweep(limit = 50): Promise<{ scanned: number; drifted: number; unknown: number }> {
    // Reconcile purchases that have either no snapshot yet, or whose
    // snapshot is older than 24h, and which are in a money-moved state.
    const purchases = await this.prisma.clientPurchase.findMany({
      where: {
        status: { in: ['paid', 'active', 'past_due', 'canceled'] },
        OR: [
          { reconciliation: null },
          {
            reconciliation: {
              last_checked_at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
          },
        ],
      },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
    let drifted = 0;
    let unknown = 0;
    for (const row of purchases) {
      try {
        const result = await this.reconcileFromRow(row);
        if (result.status === 'drift') drifted += 1;
        else if (result.status === 'unknown') unknown += 1;
      } catch (err) {
        this.logger.warn(
          `reconcile failed purchase=${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return { scanned: purchases.length, drifted, unknown };
  }

  private async reconcileFromRow(
    purchase: ClientPurchase,
  ): Promise<ReconciliationResult> {
    const ledger = await this.prisma.splitLedgerEntry.findMany({
      where: { purchase_id: purchase.id },
    });
    const transfers = await this.prisma.connectTransfer.findMany({
      where: { purchase_id: purchase.id },
    });

    const ledgerSums = summarizeLedger(ledger);

    // Stripe side: we need the Charge id. The shortest path is
    // PI -> latest_charge -> Charge. For recurring purchases each renewal
    // has its own Charge — we reconcile only the most recent one
    // (renewals append SplitLedgerEntry rows in the same composite-unique
    // slot for `application_fee` + `destination`, so the most recent
    // Stripe charge is the right comparison).
    const chargeId = await this.resolveChargeId(purchase);
    let stripeAmount: number | null = null;
    let stripeRefunded: number | null = null;
    let stripeAppFee: number | null = null;
    let stripeTransfersCents = 0;
    let notes: string | null = null;

    if (!chargeId) {
      notes = 'no_charge_id_yet';
      return this.persistSnapshot(purchase.id, 'unknown', null, {
        stripe: {
          amount_cents: null,
          refunded_cents: null,
          application_fee_cents: null,
          transfers_cents: null,
        },
        ledger: ledgerSums,
        notes,
      });
    }

    try {
      const charge = await this.stripe.retrieveCharge(chargeId);
      stripeAmount = typeof charge.amount === 'number' ? charge.amount : null;
      stripeRefunded =
        typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
      stripeAppFee =
        typeof charge.application_fee_amount === 'number'
          ? charge.application_fee_amount
          : 0;
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
      const msg =
        err instanceof StripeConnectApiError ? err.message : (err as Error).message;
      this.logger.warn(
        `Stripe charge retrieve failed for purchase=${purchase.id} charge=${chargeId}: ${msg}`,
      );
      notes = `stripe_retrieve_failed: ${msg}`;
      return this.persistSnapshot(purchase.id, 'unknown', null, {
        stripe: {
          amount_cents: null,
          refunded_cents: null,
          application_fee_cents: null,
          transfers_cents: null,
        },
        ledger: ledgerSums,
        notes,
      });
    }

    // Compute drift. Identity we want:
    //   stripe_amount - stripe_refunded
    //     == ledger_destination + ledger_application_fee + ledger_head_coach
    //        - ledger_reversed
    //
    // (left side = real money that left the platform Charge net of refunds;
    //  right side = what our ledger says we accounted for, net of reversals.)
    const stripeNet = (stripeAmount ?? 0) - (stripeRefunded ?? 0);
    const ledgerNet =
      ledgerSums.destination_cents +
      ledgerSums.application_fee_cents +
      ledgerSums.head_coach_cents -
      ledgerSums.reversed_cents;
    const drift = stripeNet - ledgerNet;

    const status: 'ok' | 'drift' = drift === 0 ? 'ok' : 'drift';

    return this.persistSnapshot(purchase.id, status, drift, {
      stripe: {
        amount_cents: stripeAmount,
        refunded_cents: stripeRefunded,
        application_fee_cents: stripeAppFee,
        transfers_cents: stripeTransfersCents,
      },
      ledger: ledgerSums,
      notes: status === 'drift' ? this.describeDrift(drift) : null,
    });
  }

  private async resolveChargeId(
    purchase: ClientPurchase,
  ): Promise<string | null> {
    if (!purchase.stripe_payment_intent_id) {
      // For recurring purchases, the per-renewal charge id lives on the
      // SplitLedgerEntry.stripe_charge_id of the most recent destination
      // slice. Use that as a cheap fallback so we don't have to walk
      // invoices.
      const entry = await this.prisma.splitLedgerEntry.findFirst({
        where: { purchase_id: purchase.id, kind: 'destination' },
        orderBy: { posted_at: 'desc' },
      });
      return entry?.stripe_charge_id ?? null;
    }
    try {
      const pi = await this.stripe.retrievePaymentIntent(
        purchase.stripe_payment_intent_id,
      );
      const latest = typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
      return latest ?? pi.charges?.data?.[0]?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `resolveChargeId failed pi=${purchase.stripe_payment_intent_id}: ${(err as Error).message}`,
      );
      return null;
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
  async getSavedSnapshot(
    purchaseId: string,
  ): Promise<ReconciliationSnapshot | null> {
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
