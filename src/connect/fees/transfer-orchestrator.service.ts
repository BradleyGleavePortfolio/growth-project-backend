import { Injectable, Logger } from '@nestjs/common';
import type { ConnectTransfer } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../stripe-connect-api.service';
import { SplitLedgerService } from './split-ledger.service';

// TransferOrchestratorService — mints Stripe Transfers from the platform
// balance and records the result against both ConnectTransfer (operational
// receipt) and SplitLedgerEntry (immutable audit ledger).
//
// S-FEE: coach-package charges are now separate charges and transfers. The
// coach net and the head-coach split of every charge are transfers minted
// here by ChargeSettlementService (enqueueSettlementTransfer), drawn from the
// charge via source_transaction. The legacy head-coach-only flow below
// (enqueueHeadCoachTransfer) remains for pre-S-FEE destination charges only.
//
// Legacy description (pre-S-FEE destination charges):
// Why a follow-on Transfer instead of a second Checkout Session split:
// Stripe Checkout supports exactly ONE destination per session via
// transfer_data. The 2% application fee handles "platform takes a cut";
// it cannot handle a second connected account (head coach) in the same
// API call. The Stripe-correct shape is:
//   1. Checkout charges client, sends `(amount - app_fee)` to seller
//      via transfer_data.
//   2. After the charge succeeds, the platform initiates a Transfer
//      from its own balance to the head coach, with
//      `source_transaction` set to the original Charge id so the funds
//      are debited from that charge.
// Net result: client paid once, platform's books show
//   +app_fee_amount -head_coach_transfer = platform's actual 2%.
//
// Retry: on Stripe-side failure (network, balance-not-available because
// the charge hasn't settled yet, etc.) the row stays in `pending` with
// next_attempt_at = now + exponential backoff. A scheduled sweeper picks
// up due rows and re-tries via the same Stripe-Idempotency-Key so
// double-pays are impossible.

// S-FEE — transfer kinds written by ChargeSettlementService.
//   coach_net / head_coach_split : the payee's share of one settled charge,
//                                  drawn from that charge (source_transaction)
//   *_reinstate                  : funds returned to a payee after a won
//                                  dispute (no source_transaction: the charge's
//                                  funds were already transferred once)
export type SettlementTransferKind =
  'coach_net' | 'head_coach_split' | 'coach_reinstate' | 'head_coach_reinstate';

export interface SettlementTransferInput {
  settlement_id: string;
  purchase_id: string;
  kind: SettlementTransferKind;
  ledger_entry_id: string | null;
  destination_stripe_account_id: string;
  destination_user_id: string;
  amount_cents: number;
  netted_recovery_cents: number;
  currency: string;
  source_stripe_charge_id: string | null;
  idempotency_key: string;
}

function isReinstateKind(kind: string): boolean {
  return kind === 'coach_reinstate' || kind === 'head_coach_reinstate';
}

function describeTransfer(row: ConnectTransfer): string {
  const charge = row.source_stripe_charge_id ?? 'n/a';
  switch (row.kind) {
    case 'coach_net':
      return `TGP coach payout for charge ${charge}`;
    case 'coach_reinstate':
      return `TGP coach payout reinstated after dispute (purchase ${row.purchase_id})`;
    case 'head_coach_reinstate':
      return `TGP head-coach split reinstated after dispute (purchase ${row.purchase_id})`;
    default:
      return `TGP head-coach split for purchase ${row.purchase_id}`;
  }
}

export interface PlanTransferInput {
  purchase_id: string;
  ledger_entry_id: string;
  destination_stripe_account_id: string;
  destination_user_id: string | null;
  amount_cents: number;
  currency: string;
  source_stripe_charge_id: string | null;
}

@Injectable()
export class TransferOrchestratorService {
  private readonly logger = new Logger(TransferOrchestratorService.name);

  // Backoff schedule for failed Stripe transfer attempts. Indexed by
  // current attempt count (0 = first retry). Caps at the last value;
  // max_attempts on the row bounds total retries.
  private static readonly BACKOFF_MINUTES = [1, 5, 15, 60, 240, 1440];

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private ledger: SplitLedgerService,
  ) {}

  // Idempotently create a ConnectTransfer row for the head-coach split.
  // Safe to call on every webhook firing — collapses on idempotency_key.
  async enqueueHeadCoachTransfer(
    input: PlanTransferInput,
  ): Promise<ConnectTransfer> {
    const idempotencyKey = `tgp-tr-${input.purchase_id}-headcoach`;
    return this.prisma.connectTransfer.upsert({
      where: { idempotency_key: idempotencyKey },
      create: {
        purchase_id: input.purchase_id,
        ledger_entry_id: input.ledger_entry_id,
        destination_stripe_account_id: input.destination_stripe_account_id,
        destination_user_id: input.destination_user_id,
        amount_cents: input.amount_cents,
        currency: input.currency,
        source_stripe_charge_id: input.source_stripe_charge_id,
        idempotency_key: idempotencyKey,
        status: 'pending',
        next_attempt_at: new Date(),
      },
      update: {
        source_stripe_charge_id:
          input.source_stripe_charge_id ?? undefined,
        // Resurrect a failed transfer when a new attempt is enqueued.
        ...(input.source_stripe_charge_id
          ? { next_attempt_at: new Date() }
          : {}),
      },
    });
  }

  // S-FEE — create (or return) the transfer row for one settlement leg. The
  // idempotency key is per CHARGE and leg, so every renewal gets its own
  // transfer (the legacy per-purchase key collapsed renewals onto one row).
  // Must run inside the settlement transaction (`db`) so the ledger rows,
  // recovery netting and transfer rows commit together.
  async enqueueSettlementTransfer(
    input: SettlementTransferInput,
    db: Pick<PrismaService, 'connectTransfer'> = this.prisma,
  ): Promise<ConnectTransfer> {
    const existing = await db.connectTransfer.findUnique({
      where: { idempotency_key: input.idempotency_key },
    });
    if (existing) return existing;
    const nettedOnly = input.amount_cents === 0;
    return db.connectTransfer.create({
      data: {
        purchase_id: input.purchase_id,
        settlement_id: input.settlement_id,
        kind: input.kind,
        ledger_entry_id: input.ledger_entry_id,
        destination_stripe_account_id: input.destination_stripe_account_id,
        destination_user_id: input.destination_user_id,
        amount_cents: input.amount_cents,
        netted_recovery_cents: input.netted_recovery_cents,
        currency: input.currency,
        source_stripe_charge_id: input.source_stripe_charge_id,
        idempotency_key: input.idempotency_key,
        // A leg fully covered by netting moves no money at Stripe.
        status: nettedOnly ? 'netted' : 'pending',
        next_attempt_at: nettedOnly ? null : new Date(),
        posted_at: nettedOnly ? new Date() : null,
      },
    });
  }

  // Try to post a pending transfer to Stripe. Updates the
  // ConnectTransfer row + corresponding ledger entry on success or
  // failure. Returns the updated transfer row.
  async attempt(transferId: string): Promise<ConnectTransfer> {
    const row = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: transferId },
    });
    if (row.status === 'succeeded') return row;
    if (row.status === 'reversed') return row;
    if (row.status === 'netted') return row;
    if (row.amount_cents <= 0) return row;
    if (!row.source_stripe_charge_id && !isReinstateKind(row.kind)) {
      // Can't transfer until the parent charge id is known. The webhook
      // pipeline will re-enqueue once it has it.
      return row;
    }
    if (row.attempts >= row.max_attempts) {
      return this.markFailed(row, 'max_attempts_exhausted', /*final=*/ true);
    }

    const attemptCount = row.attempts + 1;
    await this.prisma.connectTransfer.update({
      where: { id: row.id },
      data: {
        last_attempt_at: new Date(),
        attempts: attemptCount,
      },
    });

    try {
      const metadata: Record<string, string> = {
        tgp_purchase_id: row.purchase_id,
        tgp_kind: row.kind,
      };
      if (row.settlement_id) metadata.tgp_settlement_id = row.settlement_id;
      const transfer = await this.stripe.createTransfer({
        amount: row.amount_cents,
        currency: row.currency,
        destination: row.destination_stripe_account_id,
        // Reinstatements have no source charge (its funds already moved once).
        source_transaction: row.source_stripe_charge_id ?? undefined,
        transfer_group: `purchase_${row.purchase_id}`,
        description: describeTransfer(row),
        metadata,
        idempotencyKey: row.idempotency_key,
      });
      const posted = await this.prisma.connectTransfer.update({
        where: { id: row.id },
        data: {
          status: 'succeeded',
          stripe_transfer_id: transfer.id,
          posted_at: new Date(),
          last_error: null,
        },
      });
      if (row.ledger_entry_id) {
        await this.ledger.markPosted({
          entry_id: row.ledger_entry_id,
          stripe_transfer_id: transfer.id,
          stripe_charge_id: row.source_stripe_charge_id ?? undefined,
        });
      }
      return posted;
    } catch (err) {
      const isStripe = err instanceof StripeConnectApiError;
      const message =
        (err as Error)?.message ?? 'unknown transfer error';
      this.logger.warn(
        `transfer attempt failed purchase=${row.purchase_id} attempt=${attemptCount}: ${message}`,
      );
      const finalFailure = attemptCount >= row.max_attempts;
      const final =
        finalFailure ||
        (isStripe &&
          (err as StripeConnectApiError).httpStatus === 400 &&
          /no such/i.test(message));
      return this.markFailed(
        { ...row, attempts: attemptCount },
        message,
        final,
      );
    }
  }

  // Schedule due-but-pending transfers for a sweeper run. Returns rows
  // whose next_attempt_at has elapsed and which are still pending.
  async findDueTransfers(now: Date, limit = 50): Promise<ConnectTransfer[]> {
    return this.prisma.connectTransfer.findMany({
      where: {
        status: 'pending',
        AND: [
          {
            OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }],
          },
          {
            OR: [
              { source_stripe_charge_id: { not: null } },
              { kind: { in: ['coach_reinstate', 'head_coach_reinstate'] } },
            ],
          },
        ],
      },
      orderBy: { next_attempt_at: 'asc' },
      take: limit,
    });
  }

  // Reverse a posted transfer (partial or full). Used by the refund
  // webhook handler when a payment is refunded.
  async reverse(args: {
    transfer_row_id: string;
    amount_cents?: number; // omit = full reversal
  }): Promise<ConnectTransfer> {
    const row = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: args.transfer_row_id },
    });
    if (!row.stripe_transfer_id) {
      throw new Error('cannot reverse transfer with no Stripe id');
    }
    const amount = args.amount_cents ?? row.amount_cents - row.reversed_amount_cents;
    if (amount <= 0) return row;
    const idempotencyKey = `tgp-tr-rev-${row.id}-${row.reversed_amount_cents + amount}`;
    await this.stripe.reverseTransfer({
      transfer_id: row.stripe_transfer_id,
      amount,
      metadata: { tgp_purchase_id: row.purchase_id, tgp_kind: row.kind },
      idempotencyKey,
    });
    const newReversed = row.reversed_amount_cents + amount;
    const fullyReversed = newReversed >= row.amount_cents;
    const updated = await this.prisma.connectTransfer.update({
      where: { id: row.id },
      data: {
        status: fullyReversed ? 'reversed' : row.status,
        reversed_amount_cents: newReversed,
        reversed_at: fullyReversed ? new Date() : row.reversed_at,
      },
    });
    if (row.ledger_entry_id) {
      await this.ledger.applyReversal({
        entry_id: row.ledger_entry_id,
        reversed_cents: amount,
        stripe_transfer_id: row.stripe_transfer_id,
      });
    }
    return updated;
  }

  private async markFailed(
    row: ConnectTransfer,
    message: string,
    finalFailure: boolean,
  ): Promise<ConnectTransfer> {
    const status = finalFailure ? 'failed' : 'pending';
    const nextDelay =
      TransferOrchestratorService.BACKOFF_MINUTES[
        Math.min(
          row.attempts,
          TransferOrchestratorService.BACKOFF_MINUTES.length - 1,
        )
      ];
    const nextAttempt = finalFailure
      ? null
      : new Date(Date.now() + nextDelay * 60_000);
    const updated = await this.prisma.connectTransfer.update({
      where: { id: row.id },
      data: {
        status,
        last_error: message,
        next_attempt_at: nextAttempt,
      },
    });
    if (finalFailure && row.ledger_entry_id) {
      await this.ledger.markFailed(row.ledger_entry_id, message);
    }
    return updated;
  }
}
