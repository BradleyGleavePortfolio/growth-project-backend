import { Injectable, Logger } from '@nestjs/common';
import type { ConnectTransfer, Prisma, TransferReversalOp } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { StripeConnectApiError, StripeConnectApiService } from '../stripe-connect-api.service';
import { ReversalUncertainError } from './money-errors';
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

// S-FEE — log / alert codes for a failed transfer attempt.
export const TRANSFER_FAILURE_CODES = {
  // Platform balance cannot cover a transfer that has no source charge
  // (dispute reinstatements) or Stripe reports the balance as insufficient.
  platformBalance: 'SFEE_TRANSFER_PLATFORM_BALANCE_INSUFFICIENT',
  // The coach's connected account cannot receive transfers (restricted,
  // missing the transfers capability, closed or invalid).
  accountRestricted: 'SFEE_TRANSFER_ACCOUNT_RESTRICTED',
  // Anything else (network, Stripe 5xx, rate limit, validation).
  failed: 'SFEE_TRANSFER_FAILED',
} as const;

const ACCOUNT_RESTRICTED_STRIPE_CODES = new Set([
  'account_invalid',
  'account_closed',
  'insufficient_capabilities_for_transfer',
  'transfers_not_allowed',
  'account_country_invalid_address',
]);

export function transferFailureCode(err: unknown): string {
  const stripeCode = err instanceof StripeConnectApiError ? err.stripeCode : null;
  const message = (err as Error)?.message ?? '';
  if (stripeCode === 'balance_insufficient' || stripeCode === 'insufficient_funds') {
    return TRANSFER_FAILURE_CODES.platformBalance;
  }
  if (/insufficient (available )?funds|balance.*insufficient/i.test(message)) {
    return TRANSFER_FAILURE_CODES.platformBalance;
  }
  if (stripeCode && ACCOUNT_RESTRICTED_STRIPE_CODES.has(stripeCode)) {
    return TRANSFER_FAILURE_CODES.accountRestricted;
  }
  if (/capabilit|restricted|transfers? (are )?(not allowed|disabled)/i.test(message)) {
    return TRANSFER_FAILURE_CODES.accountRestricted;
  }
  return TRANSFER_FAILURE_CODES.failed;
}

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

// S-FEE round 4 (B-627-2 / B-627-5) — a fence proves the caller still owns the
// charge's money lock (ChargeLock.fence). Called with the transaction client
// inside the transaction that records a money step, and with no argument right
// before a Stripe money call. Throws (ChargeLockLostError) when ownership is
// lost; the caller stops without moving money.
export type MoneyFence = (db?: Prisma.TransactionClient) => Promise<void>;

// adjust: converge THIS charge's transfer after a refund / dispute. legacy: the
// pre-S-FEE per-refund reversal. Owner decision OR-111-1 removed round 4's
// 'clawback' (reversing a payee's OTHER past transfers): another charge's debt
// is recovered by forward netting only.
export type ReversalPurpose = 'adjust' | 'legacy';

export type ReverseOutcome =
  | { status: 'succeeded'; transfer: ConnectTransfer; op_id: string | null }
  | { status: 'refused'; transfer: ConnectTransfer; op_id: string; error: string };

// A Stripe answer that proves the reversal was NOT applied and never will be
// for this key: a 4xx request / card / not-found error. Everything else
// (timeout, network, 5xx, 429 rate limit, 409 or idempotency conflicts, auth)
// leaves the outcome unknown.
export function isDefinitiveStripeRefusal(err: unknown): boolean {
  if (!(err instanceof StripeConnectApiError)) return false;
  if (![400, 402, 404].includes(err.httpStatus)) return false;
  if (err.stripeType === 'idempotency_error' || err.stripeType === 'api_connection_error') {
    return false;
  }
  return err.stripeCode !== 'idempotency_key_in_use' && err.stripeCode !== 'lock_timeout';
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
  async enqueueHeadCoachTransfer(input: PlanTransferInput): Promise<ConnectTransfer> {
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
        source_stripe_charge_id: input.source_stripe_charge_id ?? undefined,
        // Resurrect a failed transfer when a new attempt is enqueued.
        ...(input.source_stripe_charge_id ? { next_attempt_at: new Date() } : {}),
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
  async attempt(
    transferId: string,
    opts: { beforeStripe?: MoneyFence } = {},
  ): Promise<ConnectTransfer> {
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

    // B-627-2: a stale lock holder never starts a Stripe transfer. (The
    // transfer itself is keyed per row, so a holder paused past this point
    // collapses onto the same Stripe transfer.)
    if (opts.beforeStripe) await opts.beforeStripe();
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
      const message = (err as Error)?.message ?? 'unknown transfer error';
      const code = transferFailureCode(err);
      const finalFailure = attemptCount >= row.max_attempts;
      const final =
        finalFailure ||
        (isStripe && (err as StripeConnectApiError).httpStatus === 400 && /no such/i.test(message));
      // S-FEE — every failure is logged with a specific code. Codes that need
      // a person (platform balance, restricted account) and final failures
      // are logged at error level with alert=true for the log-based alerts.
      const needsPerson = final || code !== TRANSFER_FAILURE_CODES.failed;
      const line =
        `${code}${final ? '_FINAL' : ''} transfer=${row.id} kind=${row.kind} ` +
        `purchase=${row.purchase_id} settlement=${row.settlement_id ?? 'none'} ` +
        `attempt=${attemptCount}/${row.max_attempts} alert=${needsPerson}: ${message}`;
      if (needsPerson) this.logger.error(line);
      else this.logger.warn(line);
      return this.markFailed({ ...row, attempts: attemptCount }, `${code}: ${message}`, final);
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

  // Reverse a posted transfer (partial or full).
  //
  // S-FEE round 4 (B-627-5) — durable, keyed reversal operations. The
  // operation (TransferReversalOp: amount, the transfer's reversed total
  // before it, idempotency key) is written BEFORE Stripe is called, in a
  // fenced transaction that also bumps ConnectTransfer.reversal_seq (CAS), so
  // only one operation per transfer is ever in flight. Then:
  //   - Stripe succeeds            -> the op is completed (reversed total =
  //                                   max(current, base + amount); absolute, so
  //                                   a transfer.reversed sync or a second
  //                                   completer never counts it twice);
  //   - Stripe refuses (4xx)       -> the op is refused; the caller may record
  //                                   that amount as a recovery;
  //   - the outcome is unknown     -> the transfer's reversals at Stripe are
  //                                   listed and matched by
  //                                   metadata.tgp_reversal_op; found -> complete,
  //                                   otherwise the op stays pending and
  //                                   ReversalUncertainError is thrown (never a
  //                                   recovery).
  // Before any new reversal, pending ops on the transfer are re-driven with
  // their own key (reconcile by Stripe object first when the op was already
  // sent once), so a lost response, a crash after Stripe committed, or a
  // stale holder resuming all collapse onto one Stripe reversal.
  async reverse(args: {
    transfer_row_id: string;
    amount_cents?: number; // omit = full reversal
    // Caller-chosen operation key (legacy path: one reversal per refund id).
    idempotency_key?: string;
    purpose?: ReversalPurpose;
    fence?: MoneyFence;
  }): Promise<ReverseOutcome> {
    if (args.idempotency_key) {
      const prior = await this.prisma.transferReversalOp.findUnique({
        where: { idempotency_key: args.idempotency_key },
      });
      if (prior) return this.outcomeOf(prior, args.fence);
    }
    await this.resolvePendingReversals(args.transfer_row_id, args.fence);
    const row = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: args.transfer_row_id },
    });
    if (!row.stripe_transfer_id) {
      throw new Error('cannot reverse transfer with no Stripe id');
    }
    const amount = Math.min(
      args.amount_cents ?? row.amount_cents - row.reversed_amount_cents,
      row.amount_cents - row.reversed_amount_cents,
    );
    if (amount <= 0) return { status: 'succeeded', transfer: row, op_id: null };
    const op = await this.startReversal(row, amount, args);
    return this.drive(op, args.fence);
  }

  /**
   * Re-drive every pending reversal operation of a transfer (oldest first).
   * Throws ReversalUncertainError when one is still unresolved.
   */
  async resolvePendingReversals(transferRowId: string, fence?: MoneyFence): Promise<void> {
    const pending = await this.prisma.transferReversalOp.findMany({
      where: { transfer_id: transferRowId, status: 'pending' },
      orderBy: { seq: 'asc' },
    });
    for (const op of pending) await this.drive(op, fence);
  }

  /** Pending reversal operations older than `before` (sweeper). */
  async findPendingReversals(before: Date, limit = 25): Promise<TransferReversalOp[]> {
    return this.prisma.transferReversalOp.findMany({
      where: { status: 'pending', created_at: { lte: before } },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }

  private async outcomeOf(op: TransferReversalOp, fence?: MoneyFence): Promise<ReverseOutcome> {
    if (op.status === 'pending') return this.drive(op, fence);
    const transfer = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: op.transfer_id },
    });
    if (op.status === 'succeeded') return { status: 'succeeded', transfer, op_id: op.id };
    return {
      status: 'refused',
      transfer,
      op_id: op.id,
      error: op.last_error ?? 'refused by Stripe',
    };
  }

  private async startReversal(
    row: ConnectTransfer,
    amount: number,
    args: {
      idempotency_key?: string;
      purpose?: ReversalPurpose;
      fence?: MoneyFence;
    },
  ): Promise<TransferReversalOp> {
    const seq = row.reversal_seq + 1;
    const key = args.idempotency_key ?? `tgp-tr-rev-${row.id}-op${seq}`;
    const purpose = args.purpose ?? 'adjust';
    return this.prisma.$transaction(async (tx) => {
      if (args.fence) await args.fence(tx);
      const slot = await tx.connectTransfer.updateMany({
        where: { id: row.id, reversal_seq: row.reversal_seq },
        data: { reversal_seq: seq },
      });
      if (slot.count !== 1) {
        throw new ReversalUncertainError(
          row.id,
          key,
          'another worker started a reversal on this transfer at the same time',
        );
      }
      return tx.transferReversalOp.create({
        data: {
          transfer_id: row.id,
          seq,
          idempotency_key: key,
          amount_cents: amount,
          base_reversed_cents: row.reversed_amount_cents,
          purpose,
          status: 'pending',
        },
      });
    });
  }

  private async drive(op: TransferReversalOp, fence?: MoneyFence): Promise<ReverseOutcome> {
    const row = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: op.transfer_id },
    });
    if (!row.stripe_transfer_id) throw new Error('cannot reverse transfer with no Stripe id');
    // Sent before and still pending: the response (or our receipt) was lost.
    // Reconcile by the Stripe object first; re-sending is safe only when
    // Stripe shows no reversal for this key (Stripe keys expire after 24 h).
    if (op.attempts > 0) {
      const found = await this.findStripeReversal(row.stripe_transfer_id, op.idempotency_key);
      if (found) return this.completeReversal(op, found.id);
    }
    if (fence) await fence();
    await this.prisma.transferReversalOp.update({
      where: { id: op.id },
      data: { attempts: { increment: 1 }, last_attempt_at: new Date() },
    });
    let stripeReversalId: string;
    try {
      const rev = await this.stripe.reverseTransfer({
        transfer_id: row.stripe_transfer_id,
        amount: op.amount_cents,
        metadata: {
          tgp_purchase_id: row.purchase_id,
          tgp_kind: row.kind,
          tgp_reversal_op: op.idempotency_key,
          tgp_purpose: op.purpose,
        },
        idempotencyKey: op.idempotency_key,
      });
      stripeReversalId = rev.id;
    } catch (err) {
      const message = (err as Error)?.message ?? 'unknown reversal error';
      if (isDefinitiveStripeRefusal(err)) return this.refuseReversal(op, message);
      const found = await this.findStripeReversal(row.stripe_transfer_id, op.idempotency_key);
      if (found) return this.completeReversal(op, found.id);
      await this.prisma.transferReversalOp.updateMany({
        where: { id: op.id, status: 'pending' },
        data: { last_error: message.slice(0, 500) },
      });
      this.logger.error(
        `SFEE_REVERSAL_UNCERTAIN alert=true transfer=${row.id} op=${op.idempotency_key} amount=${op.amount_cents}: ${message}`,
      );
      throw new ReversalUncertainError(row.id, op.idempotency_key, message);
    }
    // Stripe moved the money. If this receipt write fails the op stays
    // pending with attempts > 0, and every retry reconciles by the Stripe
    // object before it may send again.
    return this.completeReversal(op, stripeReversalId);
  }

  // Stripe's reversals on the transfer, matched by our operation key.
  private async findStripeReversal(
    stripeTransferId: string,
    key: string,
  ): Promise<{ id: string; amount: number } | null> {
    try {
      let startingAfter: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res = await this.stripe.listTransferReversals(stripeTransferId, {
          limit: 100,
          starting_after: startingAfter,
        });
        const data = res.data ?? [];
        const hit = data.find((r) => r.metadata?.tgp_reversal_op === key);
        if (hit) return { id: hit.id, amount: hit.amount };
        if (!res.has_more || data.length === 0) return null;
        startingAfter = data[data.length - 1].id;
      }
    } catch (err) {
      this.logger.warn(
        `listing reversals of ${stripeTransferId} failed while reconciling op=${key}: ${(err as Error).message}`,
      );
    }
    return null;
  }

  private async completeReversal(
    op: TransferReversalOp,
    stripeReversalId: string,
  ): Promise<ReverseOutcome> {
    const transfer = await this.prisma.$transaction(async (tx) => {
      const done = await tx.transferReversalOp.updateMany({
        where: { id: op.id, status: 'pending' },
        data: {
          status: 'succeeded',
          stripe_reversal_id: stripeReversalId,
          resolved_at: new Date(),
          last_error: null,
        },
      });
      const t = await tx.connectTransfer.findUniqueOrThrow({ where: { id: op.transfer_id } });
      if (done.count !== 1) return t; // another completer recorded it
      const reversed = Math.min(
        t.amount_cents,
        Math.max(t.reversed_amount_cents, op.base_reversed_cents + op.amount_cents),
      );
      const full = reversed >= t.amount_cents;
      return tx.connectTransfer.update({
        where: { id: t.id },
        data: {
          reversed_amount_cents: reversed,
          status: full ? 'reversed' : t.status,
          reversed_at: full ? new Date() : t.reversed_at,
        },
      });
    });
    if (transfer.ledger_entry_id && !transfer.settlement_id && transfer.stripe_transfer_id) {
      await this.ledger.setReversedTotal({
        entry_id: transfer.ledger_entry_id,
        reversed_total_cents: transfer.reversed_amount_cents,
        stripe_transfer_id: transfer.stripe_transfer_id,
      });
    }
    return { status: 'succeeded', transfer, op_id: op.id };
  }

  private async refuseReversal(op: TransferReversalOp, message: string): Promise<ReverseOutcome> {
    const transfer = await this.prisma.$transaction(async (tx) => {
      await tx.transferReversalOp.updateMany({
        where: { id: op.id, status: 'pending' },
        data: { status: 'refused', last_error: message.slice(0, 500), resolved_at: new Date() },
      });
      return tx.connectTransfer.findUniqueOrThrow({ where: { id: op.transfer_id } });
    });
    this.logger.warn(
      `SFEE_REVERSAL_REFUSED transfer=${op.transfer_id} op=${op.idempotency_key} amount=${op.amount_cents}: ${message}`,
    );
    return { status: 'refused', transfer, op_id: op.id, error: message };
  }

  private async markFailed(
    row: ConnectTransfer,
    message: string,
    finalFailure: boolean,
  ): Promise<ConnectTransfer> {
    const status = finalFailure ? 'failed' : 'pending';
    const nextDelay =
      TransferOrchestratorService.BACKOFF_MINUTES[
        Math.min(row.attempts, TransferOrchestratorService.BACKOFF_MINUTES.length - 1)
      ];
    const nextAttempt = finalFailure ? null : new Date(Date.now() + nextDelay * 60_000);
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
