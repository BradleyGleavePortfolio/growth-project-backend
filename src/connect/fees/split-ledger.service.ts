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
// All rows are idempotent: (purchase_id, kind, payee_user_id) is a
// composite unique. Re-running the planner on the same purchase returns
// the existing rows.

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

  private async upsertEntry(args: {
    purchase_id: string;
    kind: string;
    payee_user_id: string | null;
    payee_stripe_account_id: string | null;
    amount_cents: number;
    currency: string;
  }): Promise<SplitLedgerEntry> {
    // The unique constraint is (purchase_id, kind, payee_user_id). On
    // Postgres NULL is not equal to NULL, so the application_fee row
    // (payee_user_id=null) won't actually be deduped by the unique
    // index — handle that explicitly with a findFirst + create.
    if (args.payee_user_id === null) {
      const existing = await this.prisma.splitLedgerEntry.findFirst({
        where: {
          purchase_id: args.purchase_id,
          kind: args.kind,
          payee_user_id: null,
        },
      });
      if (existing) return existing;
      return this.prisma.splitLedgerEntry.create({
        data: {
          purchase_id: args.purchase_id,
          kind: args.kind,
          payee_user_id: null,
          payee_stripe_account_id: args.payee_stripe_account_id,
          amount_cents: args.amount_cents,
          currency: args.currency,
          status: 'pending',
        },
      });
    }
    return this.prisma.splitLedgerEntry.upsert({
      where: {
        purchase_id_kind_payee_user_id: {
          purchase_id: args.purchase_id,
          kind: args.kind,
          payee_user_id: args.payee_user_id,
        },
      },
      create: {
        purchase_id: args.purchase_id,
        kind: args.kind,
        payee_user_id: args.payee_user_id,
        payee_stripe_account_id: args.payee_stripe_account_id,
        amount_cents: args.amount_cents,
        currency: args.currency,
        status: 'pending',
      },
      update: {
        amount_cents: args.amount_cents,
        payee_stripe_account_id: args.payee_stripe_account_id,
      },
    });
  }
}
