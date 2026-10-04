import { Injectable, Logger } from '@nestjs/common';
import type { ClientPurchase, Prisma, SplitLedgerEntry } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import type { SplitPlan } from './fee-policy.service';

// B-674-1: compare-and-set attempts for one slice reversal before giving up.
export const LEDGER_REVERSAL_CAS_ATTEMPTS = 8;

// B-676-1: the refund or lost chargeback a reversal posting belongs to.
export interface LedgerReversalSource {
  kind: 'refund' | 'dispute';
  /** ChargeRefund.id or ChargeDispute.id. */
  id: string;
  /** When the event took the money back (the Money window it reports in). */
  at: Date;
}

// Closed code only: the slice id, never row contents.
export class LedgerWriteConflictError extends Error {
  readonly code = 'LEDGER_REVERSAL_WRITE_CONFLICT';
  constructor(readonly entryId: string) {
    super(`LEDGER_REVERSAL_WRITE_CONFLICT entry=${entryId}`);
    this.name = 'LedgerWriteConflictError';
  }
}

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
// Round 11 (B-681-2): the 4-column unique no longer makes that set
// exactly-once (stripe_charge_id is null when a legacy row is created, and
// Postgres treats NULLs as distinct), so every legacy row is created with a
// durable identity in the unique idempotency_key column
// (legacyLedgerKey). Two planners that both find no row race on one INSERT;
// the database lets exactly one win, and the loser adopts the winner's row.

export interface SplitLedgerInputs {
  purchase: ClientPurchase;
  plan: SplitPlan;
  platform_account_id: string | null; // for audit only; null fine
  seller_stripe_account_id: string;
  head_coach_stripe_account_id: string | null;
}

interface LegacyEntryArgs {
  purchase_id: string;
  kind: string;
  payee_user_id: string | null;
  payee_stripe_account_id: string | null;
  amount_cents: number;
  currency: string;
}

/**
 * Round 11 (B-681-2) — the durable identity of one legacy per-purchase ledger
 * row: purchase, kind and the payee user (`platform` for TGP's own slice).
 * Round 13: this is exactly the identity upsertEntry looks up. The payee's
 * Stripe account is routing that a reconnection may change, so it is never
 * part of the key. Ids only; the payee user id is the row's own
 * payee_user_id, retained under FINANCE in the deletion manifest.
 */
export function legacyLedgerKey(
  args: Pick<LegacyEntryArgs, 'purchase_id' | 'kind' | 'payee_user_id'>,
): string {
  return `sfee-legacy-ledger:${args.purchase_id}:${args.kind}:${args.payee_user_id ?? 'platform'}`;
}

@Injectable()
export class SplitLedgerService {
  private readonly logger = new Logger(SplitLedgerService.name);

  constructor(private prisma: PrismaService) {}

  // Create the pending ledger rows for a purchase. Safe to call multiple
  // times — composite unique collapses retries to the same set.
  async ensurePendingEntries(inputs: SplitLedgerInputs): Promise<SplitLedgerEntry[]> {
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

  // S-FEE round 8 (B-627-9) — record a transfer slice as posted, inside the
  // transaction that writes the transfer receipt. Compare-and-set: only a
  // slice still pending (or marked failed by a superseded worker) moves to
  // posted; a posted or reversed slice is never regressed or re-dated.
  async markTransferPosted(
    args: { entry_id: string; stripe_transfer_id: string; stripe_charge_id?: string | null },
    db: Pick<PrismaService, 'splitLedgerEntry'>,
    postedAt: Date,
  ): Promise<boolean> {
    const res = await db.splitLedgerEntry.updateMany({
      where: { id: args.entry_id, status: { in: ['pending', 'failed'] } },
      data: {
        status: 'posted',
        stripe_charge_id: args.stripe_charge_id ?? undefined,
        stripe_transfer_id: args.stripe_transfer_id,
        posted_at: postedAt,
        last_error: null,
      },
    });
    return res.count === 1;
  }

  // S-FEE round 8 (B-627-9) — the final-failure twin of markTransferPosted:
  // only a pending slice becomes failed (never a posted or reversed one).
  async markTransferFailed(
    entryId: string,
    message: string,
    db: Pick<PrismaService, 'splitLedgerEntry'>,
  ): Promise<boolean> {
    const res = await db.splitLedgerEntry.updateMany({
      where: { id: entryId, status: 'pending' },
      data: { status: 'failed', last_error: message },
    });
    return res.count === 1;
  }

  async markFailed(entryId: string, message: string): Promise<SplitLedgerEntry> {
    return this.prisma.splitLedgerEntry.update({
      where: { id: entryId },
      data: { status: 'failed', last_error: message },
    });
  }

  // B-676-1: post one event's cents to a slice WITHOUT moving reversed_cents
  // (a transfer reversal operation mirrors the slice total itself). Once per
  // (slice, event); callers run it inside the claim that makes the event's
  // record exactly-once, so a repeat finds the posting and does nothing.
  async postReversalSource(
    args: { entry_id: string; source: LedgerReversalSource; cents: number },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (!(args.cents > 0)) return;
    const where = {
      entry_id: args.entry_id,
      source_kind: args.source.kind,
      source_id: args.source.id,
    };
    if (await db.splitLedgerReversal.findFirst({ where })) return;
    await db.splitLedgerReversal.create({
      data: { ...where, cents: args.cents, posted_at: args.source.at },
    });
  }

  // Apply a (possibly partial) reversal to a ledger entry. Tracks the
  // cumulative reversed_cents — when it reaches amount_cents we flip
  // status=reversed.
  // `db` lets a caller apply the reversal inside its own transaction, next to
  // the claim that makes it happen exactly once (B-641-7).
  // B-674-1 (B-CM1-116): compare-and-set on the reversed_cents read, so a
  // concurrent reversal of another refund is added to, never overwritten; a
  // lost race re-reads; exhaustion throws and rolls the caller's claim back.
  // B-676-1: with `source` (pass a transaction client) the event's cents are
  // posted to SplitLedgerReversal in the same transaction, once per slice.
  async applyReversal(
    args: {
      entry_id: string;
      reversed_cents: number;
      stripe_transfer_id?: string | null;
      source?: LedgerReversalSource;
    },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<SplitLedgerEntry> {
    const source = args.source;
    if (source) {
      const posted = await db.splitLedgerReversal.findFirst({
        where: { entry_id: args.entry_id, source_kind: source.kind, source_id: source.id },
      });
      if (posted) return db.splitLedgerEntry.findUniqueOrThrow({ where: { id: args.entry_id } });
    }
    for (let attempt = 0; attempt < LEDGER_REVERSAL_CAS_ATTEMPTS; attempt++) {
      const current = await db.splitLedgerEntry.findUniqueOrThrow({
        where: { id: args.entry_id },
      });
      const newReversed = Math.min(
        current.amount_cents,
        current.reversed_cents + Math.max(0, args.reversed_cents),
      );
      const fullyReversed = newReversed >= current.amount_cents;
      const data = {
        reversed_cents: newReversed,
        status: fullyReversed ? 'reversed' : current.status,
        reversed_at: fullyReversed ? (current.reversed_at ?? new Date()) : current.reversed_at,
        stripe_transfer_id: args.stripe_transfer_id ?? current.stripe_transfer_id,
      };
      const won = await db.splitLedgerEntry.updateMany({
        where: { id: args.entry_id, reversed_cents: current.reversed_cents },
        data,
      });
      if (won.count !== 1) continue;
      const cents = newReversed - current.reversed_cents;
      if (source && cents > 0) {
        await db.splitLedgerReversal.create({
          data: {
            entry_id: args.entry_id,
            source_kind: source.kind,
            source_id: source.id,
            cents,
            posted_at: source.at,
          },
        });
      }
      return { ...current, ...data };
    }
    throw new LedgerWriteConflictError(args.entry_id);
  }

  async findByPurchase(
    purchaseId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<SplitLedgerEntry[]> {
    return db.splitLedgerEntry.findMany({
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

  private async upsertEntry(args: LegacyEntryArgs): Promise<SplitLedgerEntry> {
    // Legacy per-purchase rows. An existing row for (purchase_id, kind,
    // payee_user_id) is the set every renewal collapses onto; Postgres
    // NULL != NULL, so this also covers the payee-null application_fee row.
    const existing = await this.prisma.splitLedgerEntry.findFirst({
      where: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
      },
      orderBy: { created_at: 'asc' },
    });
    if (existing) return this.refreshLegacyEntry(existing, args);
    const key = legacyLedgerKey(args);
    try {
      return await this.prisma.splitLedgerEntry.create({
        data: {
          purchase_id: args.purchase_id,
          kind: args.kind,
          payee_user_id: args.payee_user_id,
          payee_stripe_account_id: args.payee_stripe_account_id,
          amount_cents: args.amount_cents,
          currency: args.currency,
          status: 'pending',
          idempotency_key: key,
        },
      });
    } catch (err) {
      // B-681-2: another planner created this row first (the unique key let
      // exactly one INSERT win). Adopt its row; never write a second one.
      if ((err as { code?: unknown } | null)?.code !== 'P2002') throw err;
      const winner = await this.prisma.splitLedgerEntry.findUnique({
        where: { idempotency_key: key },
      });
      if (!winner) throw err;
      return this.refreshLegacyEntry(winner, args);
    }
  }

  // A legacy renewal may carry a new amount or a reconnected payee account;
  // the platform row (payee null) is never rewritten, exactly as before.
  private async refreshLegacyEntry(
    existing: SplitLedgerEntry,
    args: LegacyEntryArgs,
  ): Promise<SplitLedgerEntry> {
    if (args.payee_user_id === null) return existing;
    return this.prisma.splitLedgerEntry.update({
      where: { id: existing.id },
      data: {
        amount_cents: args.amount_cents,
        payee_stripe_account_id: args.payee_stripe_account_id,
      },
    });
  }
}
