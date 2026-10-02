import { Injectable, Logger } from '@nestjs/common';
import type { ClientPurchase, SplitLedgerEntry } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import type { SplitPlan } from './fee-policy.service';

// SplitLedgerService — append-only ledger of every dollar slice that a
// purchase produces. Three kinds:
//
//   application_fee  : platform's slice (TGP). Posted "synchronously"
//                      against the parent Stripe charge — Stripe deducts
//                      it server-side; we just record it.
//   destination      : the selling coach's gross share routed via the
//                      Checkout Session's transfer_data[destination].
//   head_coach_split : the head-coach 5%-style slice. NOT a Stripe
//                      application fee — we mint a follow-on Transfer
//                      from the platform balance using source_transaction
//                      so it draws from the original charge.
//
// S-FEE: rows are per CHARGE. ChargeSettlementService writes, for every
// settled charge (first charge and each renewal), four slices that sum to the
// charge's gross:
//   application_fee  : TGP's 2% (kept in the platform balance, never paid out)
//   stripe_fee       : Stripe's actual processing fee (payee null; borne by
//                      the coach because it is deducted from the coach net)
//   destination      : the selling coach's net (paid by Transfer)
//   head_coach_split : the head coach's split (paid by Transfer)
// Composite unique: (purchase_id, kind, payee_user_id, stripe_charge_id).
//
// Legacy (pre-S-FEE destination charges, ensurePendingEntries): one set of
// rows per purchase keyed on (purchase_id, kind, payee_user_id), exactly as
// before; renewals of a legacy subscription collapse onto that set.

export interface SplitLedgerInputs {
  purchase: ClientPurchase;
  plan: SplitPlan;
  platform_account_id: string | null; // for audit only; null fine
  seller_stripe_account_id: string;
  head_coach_stripe_account_id: string | null;
}

@Injectable()
export class SplitLedgerService {
  private readonly logger = new Logger(SplitLedgerService.name);

  constructor(private prisma: PrismaService) {}

  // Create the pending ledger rows for a purchase. Safe to call multiple
  // times — composite unique collapses retries to the same set.
  async ensurePendingEntries(
    inputs: SplitLedgerInputs,
  ): Promise<SplitLedgerEntry[]> {
    const { purchase, plan } = inputs;
    const rows: Array<Promise<SplitLedgerEntry>> = [];

    // 1) application_fee — platform slice. payee_user_id intentionally
    //    null (the platform is not a User row).
    if (plan.application_fee_cents > 0) {
      rows.push(
        this.upsertEntry({
          purchase_id: purchase.id,
          kind: 'application_fee',
          payee_user_id: null,
          payee_stripe_account_id: null,
          amount_cents: plan.application_fee_cents,
          currency: purchase.currency,
        }),
      );
    }

    // 2) destination — selling coach's slice.
    rows.push(
      this.upsertEntry({
        purchase_id: purchase.id,
        kind: 'destination',
        payee_user_id: purchase.coach_user_id,
        payee_stripe_account_id: inputs.seller_stripe_account_id,
        amount_cents: plan.destination_cents,
        currency: purchase.currency,
      }),
    );

    // 3) head_coach_split — only when seller is a sub-coach.
    if (
      plan.head_coach_split_cents > 0 &&
      plan.head_coach_id &&
      inputs.head_coach_stripe_account_id
    ) {
      rows.push(
        this.upsertEntry({
          purchase_id: purchase.id,
          kind: 'head_coach_split',
          payee_user_id: plan.head_coach_id,
          payee_stripe_account_id: inputs.head_coach_stripe_account_id,
          amount_cents: plan.head_coach_split_cents,
          currency: purchase.currency,
        }),
      );
    }

    return Promise.all(rows);
  }

  // S-FEE — create one per-charge ledger slice. Create-only: a slice's amount
  // is immutable once written (adjustments use reversed_cents). Runs inside
  // the settlement transaction (`db`), whose single-winner claim on the
  // ChargeSettlement row is what makes the four slices exactly-once.
  async createChargeEntry(
    args: {
      purchase_id: string;
      stripe_charge_id: string;
      kind: 'application_fee' | 'stripe_fee' | 'destination' | 'head_coach_split';
      payee_user_id: string | null;
      payee_stripe_account_id: string | null;
      amount_cents: number;
      currency: string;
      status: 'pending' | 'posted';
    },
    db: Pick<PrismaService, 'splitLedgerEntry'> = this.prisma,
  ): Promise<SplitLedgerEntry> {
    const existing = await db.splitLedgerEntry.findFirst({
      where: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
        stripe_charge_id: args.stripe_charge_id,
      },
    });
    if (existing) return existing;
    return db.splitLedgerEntry.create({
      data: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
        payee_stripe_account_id: args.payee_stripe_account_id,
        amount_cents: args.amount_cents,
        currency: args.currency,
        stripe_charge_id: args.stripe_charge_id,
        status: args.status,
        posted_at: args.status === 'posted' ? new Date() : null,
      },
    });
  }

  // S-FEE round 3 — record a settlement leg's ABSOLUTE position on its slice:
  // reversed_cents = amount - position, clamped to [0, amount]. Idempotent: a
  // duplicate or concurrent delivery writes the same value, never adds again.
  // A failed slice keeps its status (the transfer never reached the payee).
  async setLegPosition(args: {
    entry_id: string;
    position_cents: number;
  }): Promise<SplitLedgerEntry> {
    const current = await this.prisma.splitLedgerEntry.findUniqueOrThrow({
      where: { id: args.entry_id },
    });
    const reversed = Math.min(
      current.amount_cents,
      Math.max(0, current.amount_cents - args.position_cents),
    );
    const fully = current.amount_cents > 0 && reversed >= current.amount_cents;
    let status = current.status;
    if (status !== 'failed') {
      if (fully) status = 'reversed';
      else if (status === 'reversed') status = 'posted';
    }
    if (reversed === current.reversed_cents && status === current.status) return current;
    return this.prisma.splitLedgerEntry.update({
      where: { id: args.entry_id },
      data: {
        reversed_cents: reversed,
        status,
        reversed_at: reversed > 0 ? (current.reversed_at ?? new Date()) : null,
      },
    });
  }

  // Legacy head-coach transfers (one transfer per slice): mirror the
  // transfer row's cumulative reversed amount (absolute, idempotent).
  async setReversedTotal(args: {
    entry_id: string;
    reversed_total_cents: number;
    stripe_transfer_id?: string | null;
  }): Promise<SplitLedgerEntry> {
    const current = await this.prisma.splitLedgerEntry.findUniqueOrThrow({
      where: { id: args.entry_id },
    });
    const reversed = Math.min(current.amount_cents, Math.max(0, args.reversed_total_cents));
    const fully = current.amount_cents > 0 && reversed >= current.amount_cents;
    return this.prisma.splitLedgerEntry.update({
      where: { id: args.entry_id },
      data: {
        reversed_cents: reversed,
        status: fully ? 'reversed' : current.status,
        reversed_at: fully ? (current.reversed_at ?? new Date()) : current.reversed_at,
        stripe_transfer_id: args.stripe_transfer_id ?? current.stripe_transfer_id ?? undefined,
      },
    });
  }

  // S-FEE — undo part of a reversal (a won dispute reinstated the payee).
  async undoReversal(args: {
    entry_id: string;
    reinstated_cents: number;
  }): Promise<SplitLedgerEntry> {
    const current = await this.prisma.splitLedgerEntry.findUniqueOrThrow({
      where: { id: args.entry_id },
    });
    const newReversed = Math.max(0, current.reversed_cents - args.reinstated_cents);
    return this.prisma.splitLedgerEntry.update({
      where: { id: args.entry_id },
      data: {
        reversed_cents: newReversed,
        status: current.status === 'reversed' ? 'posted' : current.status,
        reversed_at: newReversed === 0 ? null : current.reversed_at,
      },
    });
  }

  // Mark an entry as posted with the Stripe ids that locate it in Stripe's
  // books. Safe to re-call (idempotent on the ledger row).
  async markPosted(args: {
    entry_id: string;
    stripe_charge_id?: string | null;
    stripe_application_fee_id?: string | null;
    stripe_transfer_id?: string | null;
  }): Promise<SplitLedgerEntry> {
    return this.prisma.splitLedgerEntry.update({
      where: { id: args.entry_id },
      data: {
        status: 'posted',
        stripe_charge_id: args.stripe_charge_id ?? undefined,
        stripe_application_fee_id: args.stripe_application_fee_id ?? undefined,
        stripe_transfer_id: args.stripe_transfer_id ?? undefined,
        posted_at: new Date(),
        last_error: null,
      },
    });
  }

  async markFailed(entryId: string, message: string): Promise<SplitLedgerEntry> {
    return this.prisma.splitLedgerEntry.update({
      where: { id: entryId },
      data: { status: 'failed', last_error: message },
    });
  }

  // Apply a (possibly partial) reversal to a ledger entry. Tracks the
  // cumulative reversed_cents — when it reaches amount_cents we flip
  // status=reversed.
  async applyReversal(args: {
    entry_id: string;
    reversed_cents: number;
    stripe_transfer_id?: string | null;
  }): Promise<SplitLedgerEntry> {
    const current = await this.prisma.splitLedgerEntry.findUniqueOrThrow({
      where: { id: args.entry_id },
    });
    const newReversed = Math.min(
      current.amount_cents,
      current.reversed_cents + args.reversed_cents,
    );
    const fullyReversed = newReversed >= current.amount_cents;
    return this.prisma.splitLedgerEntry.update({
      where: { id: args.entry_id },
      data: {
        reversed_cents: newReversed,
        status: fullyReversed ? 'reversed' : current.status,
        reversed_at: fullyReversed ? new Date() : current.reversed_at,
        stripe_transfer_id:
          args.stripe_transfer_id ?? current.stripe_transfer_id ?? undefined,
      },
    });
  }

  async findByPurchase(purchaseId: string): Promise<SplitLedgerEntry[]> {
    return this.prisma.splitLedgerEntry.findMany({
      where: { purchase_id: purchaseId },
      orderBy: [{ kind: 'asc' }, { created_at: 'asc' }],
    });
  }

  async findByPayee(
    payeeUserId: string,
    opts: { limit?: number } = {},
  ): Promise<SplitLedgerEntry[]> {
    return this.prisma.splitLedgerEntry.findMany({
      where: { payee_user_id: payeeUserId },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
    });
  }

  private async upsertEntry(args: {
    purchase_id: string;
    kind: string;
    payee_user_id: string | null;
    payee_stripe_account_id: string | null;
    amount_cents: number;
    currency: string;
  }): Promise<SplitLedgerEntry> {
    // Legacy per-purchase rows. S-FEE moved the unique to include
    // stripe_charge_id (nullable), so the per-purchase dedupe is explicit:
    // findFirst on (purchase_id, kind, payee_user_id), then create or update.
    // Postgres NULL != NULL, so this also covers the payee-null
    // application_fee row exactly as before.
    const existing = await this.prisma.splitLedgerEntry.findFirst({
      where: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
      },
      orderBy: { created_at: 'asc' },
    });
    if (existing) {
      if (args.payee_user_id === null) return existing;
      return this.prisma.splitLedgerEntry.update({
        where: { id: existing.id },
        data: {
          amount_cents: args.amount_cents,
          payee_stripe_account_id: args.payee_stripe_account_id,
        },
      });
    }
    return this.prisma.splitLedgerEntry.create({
      data: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
        payee_stripe_account_id: args.payee_stripe_account_id,
        amount_cents: args.amount_cents,
        currency: args.currency,
        status: 'pending',
      },
    });
  }
}
