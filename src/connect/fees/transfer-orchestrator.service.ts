import { performance } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ConnectTransfer, type TransferReversalOp } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  STRIPE_CONNECT_TIMEOUT_MS,
  StripeConnectApiError,
  StripeConnectApiService,
} from '../stripe-connect-api.service';
import { ReversalUncertainError } from './money-errors';
import { dbErrorKind, moneyErrorDiagnostic, type DbErrorKind } from './money-diagnostics';
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
// up due rows and re-tries via the same Stripe-Idempotency-Key. Stripe may
// prune a key after 24 h, so (round 7, B-627-8) a create whose result was
// never recorded is first looked up at Stripe and only re-sent when a
// complete listing proves it absent.

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

// B-627-8 (round 7): the result of a sent transfer create is not established.
export const TRANSFER_UNCERTAIN_CODE = 'SFEE_TRANSFER_UNCERTAIN';

// B-627-9 (round 8): a create another worker sent recently may still be in
// flight (travelling to Stripe, executing there, or its response travelling
// back), so a listing that does not show it yet proves nothing. A marker
// younger than the in-flight window is held: nothing is sent, nothing is
// failed, and the row is looked up again once the window has passed. The
// window is the Stripe client timeout (after which the sender has stopped
// waiting) plus a margin for Stripe-side execution, listing visibility, and
// a sender process paused between its claim and its request.
export const TRANSFER_IN_FLIGHT_CODE = 'SFEE_TRANSFER_IN_FLIGHT';
export const TRANSFER_IN_FLIGHT_MARGIN_MS = 290_000;
export function transferInFlightWindowMs(stripeTimeoutMs: number): number {
  const timeout =
    Number.isFinite(stripeTimeoutMs) && stripeTimeoutMs > 0
      ? stripeTimeoutMs
      : STRIPE_CONNECT_TIMEOUT_MS;
  return timeout + TRANSFER_IN_FLIGHT_MARGIN_MS;
}
// B-627-9: an outcome write lost its compare-and-set to another worker.
export const TRANSFER_SUPERSEDED_CODE = 'SFEE_TRANSFER_OUTCOME_SUPERSEDED';

// B-627-9 narrowed (round 9). A worker that claimed a send must START the
// Stripe request within this budget of its claim, or it does not send at all.
// The budget plus the Stripe client timeout ends far inside the in-flight
// window (30 s + 10 s against 5 min), and only a worker that finds the claim
// older than the window may take it over. So a sender paused between its
// claim and its request (event-loop stall, frozen machine) can never start
// its request after another worker has read Stripe's listing and acted on
// it: the check runs synchronously at the HTTP boundary (beforeSend in
// StripeConnectApiService.createTransfer, right before fetch).
export const TRANSFER_SEND_START_BUDGET_MS = 30_000;
export const TRANSFER_SEND_ABANDONED_CODE = 'SFEE_TRANSFER_SEND_ABANDONED';
// The attempt budget is spent and the last create is still unresolved: the
// next worker re-sends that same attempt under the same key (adoption).
export const TRANSFER_ADOPTED_CODE = 'SFEE_TRANSFER_ADOPTED';

/** A claimed send that was not started inside its start budget (nothing sent). */
export class TransferSendExpiredError extends Error {
  readonly code = TRANSFER_SEND_ABANDONED_CODE;

  constructor(
    readonly transferRowId: string,
    readonly ageMs: number,
    readonly budgetMs: number,
  ) {
    super(
      `${TRANSFER_SEND_ABANDONED_CODE} transfer=${transferRowId}: the send claim is ${ageMs} ms old ` +
        `(start budget ${budgetMs} ms), so another worker may take it over; the create was not sent`,
    );
    this.name = 'TransferSendExpiredError';
  }
}

// Round 10 (B-627-10, Sol): a log line names a park failure only by this
// closed vocabulary, never by the error's name, message or code (all of them
// are free text a library or caller can set). Round 11: the shared money
// diagnostics vocabulary (money-diagnostics.ts) is the one mapping.
export type ParkFailureKind = DbErrorKind;
export const parkFailureKind: (err: unknown) => ParkFailureKind = dbErrorKind;

// Round 11 (B-682-1): a reversal send that was claimed and not started inside
// the start budget (TRANSFER_SEND_START_BUDGET_MS). Nothing was sent; the op
// stays pending with attempts > 0, so the next driver lists Stripe first.
export const REVERSAL_SEND_ABANDONED_CODE = 'SFEE_REVERSAL_SEND_ABANDONED';
// Round 11 (B-682-1): Stripe holds a second reversal for an operation whose
// receipt names another one. Ids and cents only; a person recovers the extra.
export const REVERSAL_DUPLICATE_CODE = 'SFEE_REVERSAL_DUPLICATE';
class ReversalSendExpiredError extends Error {
  constructor(readonly ageMs: number) {
    super(REVERSAL_SEND_ABANDONED_CODE);
  }
}

function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.getTime() === b.getTime();
}

// B-627-8: the reconciliation lookup of one transfer create.
export type TransferLookup =
  | { kind: 'found'; id: string; amount: number }
  | { kind: 'absent' }
  | { kind: 'unknown'; reason: string };

// Round 14 (B-682-4 / B-682-8): both lookups' list reader. Only complete pages
// (array `data` of items with ids, boolean `has_more`) ending in has_more ===
// false prove absence; anything else is 'unknown' (closed reasons), never sent.
async function scanStripeList<T extends { id: string; amount: number }>(
  noun: 'transfers' | 'reversals',
  maxPages: number,
  readPage: (startingAfter: string | null) => Promise<{ data?: T[]; has_more?: boolean } | null>,
  matches: (item: T) => boolean,
): Promise<TransferLookup> {
  let startingAfter: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await readPage(startingAfter);
    const items = Array.isArray(res?.data) ? (res.data as Array<T | null>) : null;
    const shaped = items?.every((t) => typeof t?.id === 'string' && t.id.length > 0);
    if (!res || !items || !shaped || typeof res.has_more !== 'boolean') {
      return { kind: 'unknown', reason: `list_page_malformed: incomplete ${noun} page` };
    }
    const hit = (items as T[]).find(matches);
    if (hit) return { kind: 'found', id: hit.id, amount: hit.amount };
    if (res.has_more === false) return { kind: 'absent' };
    if (items.length === 0) {
      return { kind: 'unknown', reason: `Stripe reported more ${noun} but sent an empty page` };
    }
    startingAfter = (items[items.length - 1] as T).id;
  }
  return { kind: 'unknown', reason: `more than ${maxPages * 100} ${noun} listed without a match` };
}

function transferGroupOf(row: Pick<ConnectTransfer, 'purchase_id'>): string {
  return `purchase_${row.purchase_id}`;
}

// A Stripe transfer is this row's operation when it carries the row's key in
// metadata.tgp_transfer_op. Transfers created before round 7 carry no key;
// those match on everything the old create sent (purchase, kind, amount and
// source charge), which is one transfer per legacy row.
export function isTransferOf(
  t: {
    amount: number;
    source_transaction?: string | null;
    metadata?: Record<string, string> | null;
  },
  row: Pick<
    ConnectTransfer,
    'idempotency_key' | 'purchase_id' | 'kind' | 'amount_cents' | 'source_stripe_charge_id'
  >,
): boolean {
  const op = t.metadata?.tgp_transfer_op;
  if (op) return op === row.idempotency_key;
  return (
    t.metadata?.tgp_purchase_id === row.purchase_id &&
    t.metadata?.tgp_kind === row.kind &&
    t.amount === row.amount_cents &&
    (t.source_transaction ?? null) === (row.source_stripe_charge_id ?? null)
  );
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

// B-627-5 (round 6): the reconciliation lookup of one reversal operation.
export type ReversalLookup = TransferLookup;

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
  // Reversal listing pages (100 each) read before the lookup is 'unknown'.
  static readonly REVERSAL_LIST_MAX_PAGES = 10;
  // Transfer listing pages (100 each) read before the lookup is 'unknown'.
  static readonly TRANSFER_LIST_MAX_PAGES = 10;

  // B-627-9: how long a sent create is treated as in flight (5 min at the
  // default 10 s Stripe timeout).
  readonly inFlightWindowMs: number;
  // B-627-9 narrowed (round 9): a claimed send starts within this or never.
  readonly sendStartBudgetMs = TRANSFER_SEND_START_BUDGET_MS;
  // Wall clock for the transfer-create protocol. Tests move it forward to
  // model a later sweep; production always reads the real time.
  clock: () => Date = () => new Date();

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private ledger: SplitLedgerService,
  ) {
    this.inFlightWindowMs = transferInFlightWindowMs(stripe?.requestTimeoutMs);
  }

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
  //
  // S-FEE round 7 (B-627-8) — every create is a durable, recoverable
  // operation, like round 6's reversals. The row is the operation record: its
  // idempotency_key is the stable operation identity, sent to Stripe both as
  // the Idempotency-Key and as metadata.tgp_transfer_op. Before Stripe is
  // called, `stripe_send_unresolved_at` is set (CAS on `attempts`, so only one
  // worker sends per attempt). It is cleared only once the result is known:
  //   - Stripe returned the transfer      -> ledger + receipt written;
  //   - a definitive refusal (4xx)        -> nothing moved, retried later;
  //   - anything else (timeout, 5xx, lost response, a receipt write that
  //     failed after Stripe moved the money) leaves it set.
  // While it is set, the next attempt first reads Stripe's transfer list:
  //   found   -> the receipt is repaired, nothing is sent;
  //   unknown -> listing failed or was incomplete: nothing is sent, the row
  //              stays pending and SFEE_TRANSFER_UNCERTAIN alerts (an unknown
  //              payment is never treated as failed, so no repay alert);
  //   absent  -> a complete listing proves it never executed: sent again,
  //              or (attempt budget spent) failed with a repay alert.
  // Stripe may prune an idempotency key after 24 h, after which the same key
  // creates a new transfer; the lookup is what makes an aged retry safe.
  //
  // S-FEE round 8 (B-627-9) — "absent" is proof only once the create can no
  // longer be in flight. A marker younger than inFlightWindowMs (Stripe
  // client timeout + margin, 5 min by default) belongs to a create that may
  // still execute (another worker may be awaiting it): the row is held —
  // nothing sent, nothing failed, no alert — and looked up again when the
  // window ends. Every outcome write (markFailed, scheduleRecheck,
  // recordPosted) is a compare-and-set; a lost CAS re-reads the row and
  // leaves the winner's result in place.
  //
  // S-FEE round 9 (B-627-9 narrowed) — elapsed time is never proof that an
  // unresolved create will not execute: its sender may be paused between its
  // claim and its request. So:
  //   - a send claim is identified by (attempts, stripe_send_unresolved_at);
  //     every claim and every outcome write compares both;
  //   - after the claim commits, the sender re-proves the charge lease (fence)
  //     and its claim (re-read), and at the HTTP boundary (synchronously,
  //     right before fetch) that the claim is younger than
  //     sendStartBudgetMs; otherwise it sends nothing
  //     (SFEE_TRANSFER_SEND_ABANDONED) and leaves the claim for adoption;
  //   - an unresolved create proven absent after the in-flight window is
  //     never failed. With budget left it is re-sent as the next attempt;
  //     at the budget it is ADOPTED: the same attempt is re-sent under the
  //     same Stripe idempotency key (SFEE_TRANSFER_ADOPTED). Its result is
  //     then Stripe's answer for that key: a transfer is recorded; a
  //     definitive refusal is the proven final failure (Stripe replays that
  //     answer to any late request with the key, and no late request can
  //     start past its budget); anything else stays pending with an alert
  //     and is adopted again after the window and the backoff.
  // Bound: a request already handed to the HTTP client is cut by the Stripe
  // client timeout and, while Stripe keeps its idempotency key (at least
  // 24 h), collapses with any adopted send of the same key. Only a process
  // frozen inside fetch for longer than that is outside the bound; its late
  // result is then caught by SFEE_TRANSFER_RECOVERED / SFEE_TRANSFER_DUPLICATE.
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

    // B-627-8: an earlier create's result is not established. Establish it
    // at Stripe before anything else (including the attempt budget: a
    // transfer that may exist is never reported as failed).
    let adopt = false;
    if (row.stripe_send_unresolved_at) {
      const lookup = await this.findStripeTransfer(row);
      if (lookup.kind === 'found') return this.recordPosted(row, lookup.id, 'reconciled');
      // B-627-9: a create sent inside the in-flight window may still execute
      // (another worker may be waiting on it right now). Its absence from the
      // listing proves nothing yet: hold, never send and never fail.
      const inFlightUntil = row.stripe_send_unresolved_at.getTime() + this.inFlightWindowMs;
      if (this.clock().getTime() < inFlightUntil) {
        return this.holdInFlight(row, new Date(inFlightUntil), lookup);
      }
      if (lookup.kind === 'unknown') {
        return this.holdUncertain(row, `transfer lookup unavailable: ${lookup.reason}`, false);
      }
      // absent: a complete listing, read after the in-flight window, shows no
      // transfer for this operation so far. Round 9: that is not proof it
      // can never execute, so it is never failed from here. At the budget
      // the unresolved attempt is adopted (re-sent under its own key).
      adopt = row.attempts >= row.max_attempts && row.status === 'pending';
    }

    if (!adopt && row.attempts >= row.max_attempts) {
      // No unresolved create (the last one was definitively refused, or none
      // was sent): nothing can still execute, so the failure is proven.
      return this.markFailed(row, 'max_attempts_exhausted', /*final=*/ true);
    }

    // B-627-2: a stale lock holder never starts a Stripe transfer.
    if (opts.beforeStripe) await opts.beforeStripe();
    const attemptCount = adopt ? row.attempts : row.attempts + 1;
    const sentAt = this.clock();
    // Round 9: the start budget is also measured on the monotonic clock, so
    // a wall-clock step backward during a pause cannot shorten it.
    const sentMono = performance.now();
    // Durable "sent" marker, written before Stripe is called. The CAS on the
    // claim identity (attempts + marker) lets exactly one worker send this
    // attempt; a worker that loses it returns the row and leaves the result
    // to the winner. B-627-9: never for a row that already has a Stripe
    // transfer, and the row being sent is pending (every outcome write below
    // is a CAS on pending + this claim). An adoption keeps the attempt count
    // and moves the marker, so a stale holder of the old claim no longer
    // matches anything.
    const claim = await this.prisma.connectTransfer.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        stripe_transfer_id: null,
        stripe_send_unresolved_at: row.stripe_send_unresolved_at,
      },
      data: {
        status: 'pending',
        attempts: attemptCount,
        last_attempt_at: sentAt,
        stripe_send_unresolved_at: sentAt,
      },
    });
    if (claim.count !== 1) {
      return this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: row.id } });
    }
    const sent: ConnectTransfer = {
      ...row,
      status: 'pending',
      attempts: attemptCount,
      last_attempt_at: sentAt,
      stripe_send_unresolved_at: sentAt,
    };
    if (adopt) {
      this.logger.warn(
        `${TRANSFER_ADOPTED_CODE} transfer=${row.id} kind=${row.kind} purchase=${row.purchase_id} ` +
          `op=${row.idempotency_key} attempt=${attemptCount}/${row.max_attempts} ` +
          `prior_sent_at=${row.stripe_send_unresolved_at?.toISOString() ?? 'unknown'}: the attempt budget is spent ` +
          'and its last create is unresolved and not at Stripe; re-sent under the same key, never failed from elapsed time',
      );
    }

    // Round 9: re-prove the charge lease and this claim after the awaited
    // claim, right before the external call.
    const abandoned = await this.reproveSendClaim(sent, sentMono, opts.beforeStripe);
    if (abandoned) return abandoned;

    let stripeTransferId: string;
    try {
      const metadata: Record<string, string> = {
        tgp_purchase_id: row.purchase_id,
        tgp_kind: row.kind,
        // B-627-8: the operation identity the reconciliation lookup matches.
        tgp_transfer_op: row.idempotency_key,
        tgp_transfer_row: row.id,
      };
      if (row.settlement_id) metadata.tgp_settlement_id = row.settlement_id;
      const transfer = await this.stripe.createTransfer({
        amount: row.amount_cents,
        currency: row.currency,
        destination: row.destination_stripe_account_id,
        // Reinstatements have no source charge (its funds already moved once).
        source_transaction: row.source_stripe_charge_id ?? undefined,
        transfer_group: transferGroupOf(row),
        description: describeTransfer(row),
        metadata,
        idempotencyKey: row.idempotency_key,
        // Round 9: the last synchronous check before the request starts.
        beforeSend: () => this.assertSendStartable(sent, sentMono),
      });
      stripeTransferId = transfer.id;
    } catch (err) {
      if (err instanceof TransferSendExpiredError) return this.abandonSend(sent, err.message);
      // B-682-2 (round 11): logs and last_error name the failure by the
      // closed diagnostic only; the error text only feeds the classification.
      const message = (err as Error)?.message ?? '';
      const diag = moneyErrorDiagnostic(err);
      const code = transferFailureCode(err);
      if (isDefinitiveStripeRefusal(err)) {
        // Proven not executed: the marker is cleared and the row is retried
        // (or finally failed) like before.
        const final =
          attemptCount >= row.max_attempts ||
          ((err as StripeConnectApiError).httpStatus === 400 && /no such/i.test(message));
        // S-FEE — every failure is logged with a specific code. Codes that
        // need a person (platform balance, restricted account) and final
        // failures are logged at error level with alert=true.
        const needsPerson = final || code !== TRANSFER_FAILURE_CODES.failed;
        const line =
          `${code}${final ? '_FINAL' : ''} transfer=${row.id} kind=${row.kind} ` +
          `purchase=${row.purchase_id} settlement=${row.settlement_id ?? 'none'} ` +
          `attempt=${attemptCount}/${row.max_attempts} alert=${needsPerson}: ${diag}`;
        if (needsPerson) this.logger.error(line);
        else this.logger.warn(line);
        return this.markFailed(sent, `${code}: ${diag}`, final, { resolved: true });
      }
      // The outcome is unknown: Stripe may have moved the money. Look first.
      const lookup = await this.findStripeTransfer(sent);
      if (lookup.kind === 'found') return this.recordPosted(sent, lookup.id, 'reconciled');
      if (lookup.kind === 'unknown') {
        return this.holdUncertain(
          sent,
          `${diag}; transfer lookup unavailable: ${lookup.reason}`,
          true,
        );
      }
      // Not visible yet. The request may still be completing at Stripe, so
      // this is never final: the marker stays and the next attempt looks
      // again (after the in-flight window) before it may re-send the same key.
      // At the budget the payout stays open and needs a person to watch it.
      const budgetSpent = attemptCount >= row.max_attempts;
      const needsPerson = budgetSpent || code !== TRANSFER_FAILURE_CODES.failed;
      const line =
        `${code} transfer=${row.id} kind=${row.kind} ` +
        `purchase=${row.purchase_id} settlement=${row.settlement_id ?? 'none'} ` +
        `attempt=${attemptCount}/${row.max_attempts} alert=${needsPerson}: ${diag}; ` +
        'not visible at Stripe yet, re-checked before any re-send' +
        (budgetSpent
          ? `; attempt budget spent: the payout of ${row.amount_cents} ${row.currency} stays pending and is ` +
            're-sent under the same key after the backoff, never failed without a definitive Stripe answer'
          : '');
      if (needsPerson) this.logger.error(line);
      else this.logger.warn(line);
      return this.markFailed(sent, `${code}: ${diag}`, false, { resolved: false });
    }
    return this.recordPosted(sent, stripeTransferId, 'created');
  }

  // B-627-9 — the compare-and-set every outcome write of one claimed attempt
  // uses: the row is still pending, has no Stripe transfer recorded, and is
  // still on the attempt this worker read or claimed. A newer claim, a
  // receipt written by another worker, or a final status all make it miss.
  // Round 9: the claim identity includes the marker, so an adoption (same
  // attempt count, new marker) also makes a stale worker's write miss.
  private openOutcomeWhere(row: ConnectTransfer): Prisma.ConnectTransferWhereInput {
    return {
      id: row.id,
      status: 'pending',
      stripe_transfer_id: null,
      attempts: row.attempts,
      stripe_send_unresolved_at: row.stripe_send_unresolved_at,
    };
  }

  // B-627-9 narrowed (round 9) — after the claim is committed and before any
  // Stripe call: the charge lease is re-proven (fence), the claim is re-read
  // (still pending, no Stripe transfer, this attempt and this marker), and
  // the claim is still inside its start budget. Returns null when the send
  // may start, otherwise the row to return (nothing was sent). A lost lease
  // still throws ChargeLockLostError (retryable) after the claim is parked.
  private async reproveSendClaim(
    sent: ConnectTransfer,
    sentMono: number,
    fence?: MoneyFence,
  ): Promise<ConnectTransfer | null> {
    if (fence) {
      try {
        await fence();
      } catch (err) {
        // Park the claim (best effort), then surface the lock loss itself.
        try {
          await this.abandonSend(sent, 'the charge lock was lost after the claim');
        } catch (parkErr) {
          this.logger.warn(
            `${TRANSFER_SEND_ABANDONED_CODE} transfer=${sent.id} park_error=${parkFailureKind(parkErr)}: ` +
              'parking the claim failed; it is due for the sweeper as it is',
          );
        }
        throw err;
      }
    }
    let live: ConnectTransfer;
    try {
      live = await this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: sent.id } });
    } catch {
      return this.abandonSend(sent, 'the claim could not be re-read');
    }
    const ownsClaim =
      live.status === 'pending' &&
      !live.stripe_transfer_id &&
      live.attempts === sent.attempts &&
      sameInstant(live.stripe_send_unresolved_at, sent.stripe_send_unresolved_at);
    if (!ownsClaim) {
      this.logger.warn(
        `${TRANSFER_SEND_ABANDONED_CODE} transfer=${sent.id} kind=${sent.kind} attempt=${sent.attempts}: ` +
          `the claim moved before the Stripe call (status=${live.status} attempts=${live.attempts} ` +
          `stripe_transfer=${live.stripe_transfer_id ?? 'none'}); nothing sent, the recorded state stands`,
      );
      return live;
    }
    try {
      this.assertSendStartable(sent, sentMono);
    } catch (err) {
      if (err instanceof TransferSendExpiredError) return this.abandonSend(sent, err.message);
      throw err;
    }
    return null;
  }

  // Throws TransferSendExpiredError when the claim is older than the start
  // budget. Synchronous: StripeConnectApiService calls it right before fetch.
  // The age is the larger of the wall-clock age (counts a suspended machine,
  // and is what other workers compare the marker with) and the monotonic age
  // (immune to a wall-clock step backward).
  private assertSendStartable(sent: ConnectTransfer, sentMono: number): void {
    const claimedAt = sent.stripe_send_unresolved_at?.getTime() ?? 0;
    const wallAge = this.clock().getTime() - claimedAt;
    const monoAge = Math.round(performance.now() - sentMono);
    const age = Math.max(wallAge, monoAge);
    if (age > this.sendStartBudgetMs) {
      throw new TransferSendExpiredError(sent.id, age, this.sendStartBudgetMs);
    }
  }

  // Round 9 — this worker claimed a send and did not start it. Nothing moved.
  // The claim stays unresolved (it may not be cleared: this worker cannot
  // prove that no other request with the key exists) and is due again when
  // its in-flight window ends; the next worker looks it up and re-sends or
  // adopts it under the same key.
  private async abandonSend(sent: ConnectTransfer, reason: string): Promise<ConnectTransfer> {
    const claimedAt = sent.stripe_send_unresolved_at ?? this.clock();
    const at = new Date(claimedAt.getTime() + this.inFlightWindowMs);
    this.logger.warn(
      `${TRANSFER_SEND_ABANDONED_CODE} transfer=${sent.id} kind=${sent.kind} attempt=${sent.attempts}/${sent.max_attempts} ` +
        `claimed_at=${claimedAt.toISOString()} recheck_at=${at.toISOString()}: ${reason}; nothing sent to Stripe, ` +
        'the claim is looked up and re-sent under the same key after its in-flight window',
    );
    return this.scheduleRecheck(sent, {
      at,
      message: `${TRANSFER_SEND_ABANDONED_CODE}: ${reason}`,
    });
  }

  // B-627-9 — an outcome write lost its CAS: another worker moved the row
  // first. Re-read it; its recorded state stands and nothing here overwrites
  // it (no failure, no repay alert, no second receipt).
  private async reconcileLostOutcome(
    row: ConnectTransfer,
    wanted: 'failed' | 'retry' | 'recheck' | 'posted',
    stripeTransferId?: string,
  ): Promise<ConnectTransfer> {
    const fresh = await this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: row.id } });
    if (
      wanted === 'posted' &&
      stripeTransferId &&
      fresh.stripe_transfer_id &&
      fresh.stripe_transfer_id !== stripeTransferId
    ) {
      this.logger.error(
        `SFEE_TRANSFER_DUPLICATE alert=true transfer=${row.id} kind=${row.kind} purchase=${row.purchase_id} ` +
          `recorded_stripe_transfer=${fresh.stripe_transfer_id} also_at_stripe=${stripeTransferId} amount=${row.amount_cents} ` +
          `currency=${row.currency}: Stripe holds two transfers for one payout row; reverse ${stripeTransferId} once confirmed`,
      );
      return fresh;
    }
    this.logger.warn(
      `${TRANSFER_SUPERSEDED_CODE} transfer=${row.id} kind=${row.kind} wanted=${wanted} attempt=${row.attempts}: ` +
        `the row moved first (status=${fresh.status} attempts=${fresh.attempts} ` +
        `stripe_transfer=${fresh.stripe_transfer_id ?? 'none'}); its recorded result stands`,
    );
    return fresh;
  }

  // B-627-8 / B-627-9 — record a transfer Stripe holds. The receipt and the
  // ledger slice commit in one transaction (the commit point that clears the
  // unresolved marker). Compare-and-set, independent of the caller's
  // snapshot: only a row still pending (or marked failed by a superseded
  // worker) with no other Stripe transfer becomes succeeded; a succeeded,
  // reversed or netted row is never regressed or re-dated. If the write
  // fails the marker stays set, the row stays pending, and the next attempt
  // finds the transfer at Stripe and records it again; it never sends a
  // second one.
  private async recordPosted(
    row: ConnectTransfer,
    stripeTransferId: string,
    how: 'created' | 'reconciled',
  ): Promise<ConnectTransfer> {
    const postedAt = this.clock();
    const data = {
      status: 'succeeded',
      stripe_transfer_id: stripeTransferId,
      posted_at: postedAt,
      last_error: null,
      next_attempt_at: null,
      stripe_send_unresolved_at: null,
    };
    const sameTransfer = [{ stripe_transfer_id: null }, { stripe_transfer_id: stripeTransferId }];
    let recorded: 'from_pending' | 'from_failed' | null;
    try {
      recorded = await this.prisma.$transaction(async (tx) => {
        const fromPending = await tx.connectTransfer.updateMany({
          where: { id: row.id, status: 'pending', OR: sameTransfer },
          data,
        });
        let won: 'from_pending' | 'from_failed' | null =
          fromPending.count === 1 ? 'from_pending' : null;
        if (!won) {
          const fromFailed = await tx.connectTransfer.updateMany({
            where: { id: row.id, status: 'failed', OR: sameTransfer },
            data,
          });
          if (fromFailed.count === 1) won = 'from_failed';
        }
        if (won && row.ledger_entry_id) {
          await this.ledger.markTransferPosted(
            {
              entry_id: row.ledger_entry_id,
              stripe_transfer_id: stripeTransferId,
              stripe_charge_id: row.source_stripe_charge_id,
            },
            tx,
            postedAt,
          );
        }
        return won;
      });
    } catch (err) {
      const diag = moneyErrorDiagnostic(err);
      this.logger.error(
        `SFEE_TRANSFER_RECEIPT_PENDING alert=true transfer=${row.id} kind=${row.kind} stripe_transfer=${stripeTransferId} amount=${row.amount_cents}: Stripe holds this transfer but the receipt was not written (${diag}); the next attempt records it from Stripe and sends nothing`,
      );
      return this.scheduleRecheck(row, { message: `SFEE_TRANSFER_RECEIPT_PENDING: ${diag}` });
    }
    if (!recorded) return this.reconcileLostOutcome(row, 'posted', stripeTransferId);
    if (recorded === 'from_failed') {
      this.logger.error(
        `SFEE_TRANSFER_RECOVERED alert=true transfer=${row.id} kind=${row.kind} settlement=${row.settlement_id ?? 'none'} ` +
          `payee=${row.destination_user_id ?? 'unknown'} stripe_transfer=${stripeTransferId} amount=${row.amount_cents} ` +
          `currency=${row.currency}: Stripe holds this transfer although the row had been marked failed; recorded as paid. ` +
          'Do not repay; cancel any repayment started from the earlier SFEE_TRANSFER_FAILED alert',
      );
    } else if (how === 'reconciled') {
      this.logger.log(
        `SFEE_TRANSFER_RECONCILED transfer=${row.id} kind=${row.kind} stripe_transfer=${stripeTransferId}: found at Stripe, receipt recorded, nothing re-sent`,
      );
    }
    return this.readBack(row, data);
  }

  // The row after a write this worker won (falls back to the written values
  // when the read itself fails; the write already committed).
  private async readBack(
    row: ConnectTransfer,
    data: Partial<ConnectTransfer>,
  ): Promise<ConnectTransfer> {
    try {
      return await this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: row.id } });
    } catch {
      return { ...row, ...data };
    }
  }

  // B-627-8 — the result of a sent create cannot be established (Stripe's
  // transfer list could not be read in full). Nothing is sent; the row stays
  // pending with its marker and is looked up again on the next sweep.
  private async holdUncertain(
    row: ConnectTransfer,
    diagnostic: string,
    justSent: boolean,
  ): Promise<ConnectTransfer> {
    this.logger.error(
      `SFEE_TRANSFER_UNCERTAIN alert=true transfer=${row.id} kind=${row.kind} purchase=${row.purchase_id} ` +
        `settlement=${row.settlement_id ?? 'none'} op=${row.idempotency_key} amount=${row.amount_cents} ` +
        `unresolved_since=${row.stripe_send_unresolved_at?.toISOString() ?? 'unknown'}: ${diagnostic}; ` +
        (justSent ? 'outcome unknown' : 'not re-sent') +
        ', looked up again before any re-send',
    );
    return this.scheduleRecheck(row, { message: `${TRANSFER_UNCERTAIN_CODE}: ${diagnostic}` });
  }

  // B-627-9 — a create sent inside the in-flight window is not visible at
  // Stripe yet. Nothing is sent and nothing is failed (the sender records the
  // result); the row is looked up again once the window has passed. Not an
  // alert: this is the normal shape of two workers overlapping on one row.
  private async holdInFlight(
    row: ConnectTransfer,
    until: Date,
    lookup: TransferLookup,
  ): Promise<ConnectTransfer> {
    const sentAt = row.stripe_send_unresolved_at;
    this.logger.warn(
      `${TRANSFER_IN_FLIGHT_CODE} transfer=${row.id} kind=${row.kind} purchase=${row.purchase_id} ` +
        `op=${row.idempotency_key} attempt=${row.attempts}/${row.max_attempts} ` +
        `sent_at=${sentAt?.toISOString() ?? 'unknown'} hold_until=${until.toISOString()} lookup=${lookup.kind}: ` +
        'a create sent inside the in-flight window may still execute at Stripe; nothing sent, nothing failed, looked up again after the window',
    );
    return this.scheduleRecheck(row, { at: until });
  }

  // B-627-9 — CAS on the attempt that was read or claimed. A lost CAS means
  // another worker moved the row (a newer claim, a receipt, a final status):
  // re-read and leave its state alone.
  private async scheduleRecheck(
    row: ConnectTransfer,
    opts: { message?: string; at?: Date },
  ): Promise<ConnectTransfer> {
    const data: { next_attempt_at: Date; last_error?: string } = {
      next_attempt_at: opts.at ?? this.retryAt(row),
    };
    if (opts.message) data.last_error = opts.message.slice(0, 500);
    let won: boolean;
    try {
      const res = await this.prisma.connectTransfer.updateMany({
        where: this.openOutcomeWhere(row),
        data,
      });
      won = res.count === 1;
    } catch (err) {
      // The row is still pending with its marker; the sweeper picks it up.
      // Round 11 (C-685-2 / B-682-2): the closed DB error kind only.
      this.logger.warn(
        `SFEE_TRANSFER_RECHECK_UNSCHEDULED transfer=${row.id} error_kind=${dbErrorKind(err)}: ` +
          'the re-check was not written; the row stays pending and the sweeper picks it up',
      );
      return { ...row, ...data };
    }
    if (!won) return this.reconcileLostOutcome(row, 'recheck');
    return { ...row, ...data };
  }

  // Next retry time: the backoff for this attempt, and never inside the
  // in-flight window of a create whose result is still unresolved.
  private retryAt(row: ConnectTransfer, unresolvedSince?: Date | null): Date {
    const delay =
      TransferOrchestratorService.BACKOFF_MINUTES[
        Math.min(row.attempts, TransferOrchestratorService.BACKOFF_MINUTES.length - 1)
      ];
    const backoff = this.clock().getTime() + delay * 60_000;
    const marker = unresolvedSince === undefined ? row.stripe_send_unresolved_at : unresolvedSince;
    const window = marker ? marker.getTime() + this.inFlightWindowMs : 0;
    return new Date(Math.max(backoff, window));
  }
  // B-627-8 — Stripe's transfers to the row's destination in its transfer
  // group, matched by the operation key (answers: scanStripeList).
  private async findStripeTransfer(row: ConnectTransfer): Promise<TransferLookup> {
    try {
      // The Stripe object is created after the row; one hour of slack covers
      // clock skew between the database and Stripe.
      const createdGte = Math.floor(row.created_at.getTime() / 1000) - 3600;
      return await scanStripeList(
        'transfers',
        TransferOrchestratorService.TRANSFER_LIST_MAX_PAGES,
        (startingAfter) =>
          this.stripe.listTransfers({
            destination: row.destination_stripe_account_id,
            transfer_group: transferGroupOf(row),
            created_gte: createdGte,
            limit: 100,
            starting_after: startingAfter,
          }),
        (t) => isTransferOf(t, row),
      );
    } catch (err) {
      const reason = moneyErrorDiagnostic(err);
      this.logger.warn(
        `listing transfers for transfer=${row.id} op=${row.idempotency_key} failed: ${reason}`,
      );
      return { kind: 'unknown', reason: `listing failed: ${reason}` };
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
   * B-COACH-5 (owner reconcile, B-641-7): record a reversal Stripe already
   * holds (found on the transfer's complete reversal list) as a completed
   * operation, with no Stripe call. One transaction takes the transfer's
   * reversal slot, writes the operation already succeeded (it is never
   * pending, so no driver can send it) and adds it to the recorded total
   * (base = the recorded total, as for every operation; a legacy
   * transfer.reversed only observes, B-674-3). A reversal an operation
   * already recorded (stripe_reversal_id is unique) is returned as recorded.
   */
  async recordFoundReversal(args: {
    transfer_row_id: string;
    stripe_reversal_id: string;
    amount_cents: number;
    idempotency_key: string;
  }): Promise<ReverseOutcome> {
    await this.resolvePendingReversals(args.transfer_row_id);
    const recorded = async () =>
      (await this.prisma.transferReversalOp.findUnique({
        where: { stripe_reversal_id: args.stripe_reversal_id },
      })) ??
      (await this.prisma.transferReversalOp.findUnique({
        where: { idempotency_key: args.idempotency_key },
      }));
    const prior = await recorded();
    if (prior) return this.outcomeOf(prior);
    const row = await this.prisma.connectTransfer.findUniqueOrThrow({
      where: { id: args.transfer_row_id },
    });
    const amount = Math.min(args.amount_cents, row.amount_cents);
    if (!(amount > 0)) return { status: 'succeeded', transfer: row, op_id: null };
    let written: { transfer: ConnectTransfer; op_id: string } | null = null;
    try {
      written = await this.prisma.$transaction(async (tx) => {
        const slot = await tx.connectTransfer.updateMany({
          where: { id: row.id, reversal_seq: row.reversal_seq },
          data: { reversal_seq: row.reversal_seq + 1 },
        });
        if (slot.count !== 1) return null;
        const op = await tx.transferReversalOp.create({
          data: {
            transfer_id: row.id,
            seq: row.reversal_seq + 1,
            idempotency_key: args.idempotency_key,
            amount_cents: amount,
            base_reversed_cents: row.reversed_amount_cents,
            purpose: 'legacy',
            status: 'succeeded',
            stripe_reversal_id: args.stripe_reversal_id,
            resolved_at: new Date(),
          },
        });
        const t = await tx.connectTransfer.findUniqueOrThrow({ where: { id: row.id } });
        const reversed = Math.min(
          t.amount_cents,
          Math.max(t.reversed_amount_cents, op.base_reversed_cents + op.amount_cents),
        );
        const full = reversed >= t.amount_cents;
        const transfer = await tx.connectTransfer.update({
          where: { id: t.id },
          data: {
            reversed_amount_cents: reversed,
            status: full ? 'reversed' : t.status,
            reversed_at: full ? new Date() : t.reversed_at,
          },
        });
        return { transfer, op_id: op.id };
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    if (!written) {
      // Another writer took the slot or recorded this reversal first.
      const raced = await recorded();
      if (raced) return this.outcomeOf(raced);
      throw new ReversalUncertainError(
        row.id,
        args.idempotency_key,
        'another worker started a reversal on this transfer at the same time',
      );
    }
    const { transfer } = written;
    if (transfer.ledger_entry_id && !transfer.settlement_id && transfer.stripe_transfer_id) {
      await this.ledger.setReversedTotal({
        entry_id: transfer.ledger_entry_id,
        reversed_total_cents: transfer.reversed_amount_cents,
        stripe_transfer_id: transfer.stripe_transfer_id,
      });
    }
    return { status: 'succeeded', transfer, op_id: written.op_id };
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
    // B-627-5 / C-627-4 (round 6): only a complete listing that proves the
    // reversal absent allows a re-send. A failed or incomplete listing is
    // unknown: the op stays pending, nothing is sent, and the caller gets
    // SFEE_REVERSAL_UNCERTAIN until Stripe can be read again.
    if (op.attempts > 0) {
      const lookup = await this.findStripeReversal(row.stripe_transfer_id, op.idempotency_key);
      if (lookup.kind === 'found') return this.completeReversal(op, lookup.id);
      if (lookup.kind === 'unknown') {
        const diagnostic = `reversal lookup unavailable: ${lookup.reason}`;
        await this.prisma.transferReversalOp.updateMany({
          where: { id: op.id, status: 'pending' },
          data: { last_error: diagnostic.slice(0, 500) },
        });
        this.logger.error(
          `SFEE_REVERSAL_UNCERTAIN alert=true transfer=${row.id} op=${op.idempotency_key} amount=${op.amount_cents}: ${diagnostic}; not re-sent`,
        );
        throw new ReversalUncertainError(row.id, op.idempotency_key, diagnostic);
      }
    }
    // Round 11 (B-682-1): the transfer-send protocol, for reversals. Claim the
    // send with a CAS on the attempt this worker read (attempts only grows,
    // by one per claim), re-prove the lease and the claim after that await,
    // and start the request only inside the start budget (checked again
    // synchronously at the HTTP boundary). A claim that is not started stays
    // pending with attempts > 0, so the next driver lists Stripe first.
    if (fence) await fence();
    const claimedAt = this.clock();
    const claimedMono = performance.now();
    const claimedAttempts = op.attempts + 1;
    const claim = await this.prisma.transferReversalOp.updateMany({
      where: {
        id: op.id,
        status: 'pending',
        attempts: op.attempts,
        last_attempt_at: op.last_attempt_at,
      },
      data: { attempts: claimedAttempts, last_attempt_at: claimedAt },
    });
    if (claim.count !== 1) return this.reversalMoved(op, 'claim_lost');
    if (fence) await fence();
    const live = await this.prisma.transferReversalOp.findUnique({
      where: { idempotency_key: op.idempotency_key },
    });
    if (
      live?.status !== 'pending' ||
      live.attempts !== claimedAttempts ||
      !sameInstant(live.last_attempt_at, claimedAt)
    ) {
      return this.reversalMoved(op, 'claim_moved');
    }
    const startable = () => {
      const age = Math.max(
        this.clock().getTime() - claimedAt.getTime(),
        Math.round(performance.now() - claimedMono),
      );
      if (age > this.sendStartBudgetMs) throw new ReversalSendExpiredError(age);
    };
    let stripeReversalId: string;
    try {
      startable();
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
        beforeSend: startable,
      });
      stripeReversalId = rev.id;
    } catch (err) {
      if (err instanceof ReversalSendExpiredError) {
        this.logger.warn(
          `${REVERSAL_SEND_ABANDONED_CODE} transfer=${row.id} op=${op.idempotency_key} attempt=${claimedAttempts} ` +
            `age_ms=${err.ageMs} budget_ms=${this.sendStartBudgetMs}: nothing sent; the op stays pending and ` +
            'the next driver lists Stripe before any re-send',
        );
        return this.reversalMoved(op, 'send_abandoned');
      }
      // B-682-2 (round 11): closed diagnostics only (logs, last_error, errors).
      const diag = moneyErrorDiagnostic(err);
      if (isDefinitiveStripeRefusal(err)) {
        return this.refuseReversal(op, diag);
      }
      const lookup = await this.findStripeReversal(row.stripe_transfer_id, op.idempotency_key);
      if (lookup.kind === 'found') return this.completeReversal(op, lookup.id);
      const diagnostic =
        lookup.kind === 'unknown' ? `${diag}; reversal lookup unavailable: ${lookup.reason}` : diag;
      await this.prisma.transferReversalOp.updateMany({
        where: { id: op.id, status: 'pending' },
        data: { last_error: diagnostic.slice(0, 500) },
      });
      this.logger.error(
        `SFEE_REVERSAL_UNCERTAIN alert=true transfer=${row.id} op=${op.idempotency_key} amount=${op.amount_cents}: ${diagnostic}`,
      );
      throw new ReversalUncertainError(row.id, op.idempotency_key, diagnostic);
    }
    // Stripe moved the money. If this receipt write fails the op stays
    // pending with attempts > 0, and every retry reconciles by the Stripe
    // object before it may send again.
    return this.completeReversal(op, stripeReversalId);
  }

  // B-627-5 — Stripe's reversals on the transfer, matched by the operation
  // key (answers: scanStripeList; a list error is 'unknown' too).
  private async findStripeReversal(stripeTransferId: string, key: string): Promise<ReversalLookup> {
    try {
      return await scanStripeList(
        'reversals',
        TransferOrchestratorService.REVERSAL_LIST_MAX_PAGES,
        (startingAfter) =>
          this.stripe.listTransferReversals(stripeTransferId, {
            limit: 100,
            starting_after: startingAfter,
          }),
        (r) => r.metadata?.tgp_reversal_op === key,
      );
    } catch (err) {
      const reason = moneyErrorDiagnostic(err);
      this.logger.warn(
        `listing reversals of ${stripeTransferId} failed while reconciling op=${key}: ${reason}`,
      );
      return { kind: 'unknown', reason: `listing failed: ${reason}` };
    }
  }

  // Round 11 (B-682-1): this worker's claim lost (or it did not start its
  // send). The recorded state stands: a resolved op returns its outcome, a
  // pending one is retried by the next driver (SFEE_REVERSAL_UNCERTAIN).
  private async reversalMoved(op: TransferReversalOp, why: string): Promise<ReverseOutcome> {
    const live = await this.prisma.transferReversalOp.findUnique({
      where: { idempotency_key: op.idempotency_key },
    });
    if (live && live.status !== 'pending') return this.outcomeOf(live);
    throw new ReversalUncertainError(
      op.transfer_id,
      op.idempotency_key,
      `${why}: the operation is still pending under another attempt; nothing sent by this worker`,
    );
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
      if (done.count !== 1) {
        // Another completer recorded it. Round 11 (B-682-1): when its receipt
        // names another Stripe reversal, Stripe holds two for one operation.
        const recorded = await tx.transferReversalOp.findUnique({
          where: { idempotency_key: op.idempotency_key },
        });
        if (recorded && recorded.stripe_reversal_id !== stripeReversalId) {
          this.logger.error(
            `${REVERSAL_DUPLICATE_CODE} alert=true transfer=${op.transfer_id} op=${op.idempotency_key} ` +
              `amount=${op.amount_cents} status=${recorded.status} ` +
              `recorded_stripe_reversal=${recorded.stripe_reversal_id ?? 'none'} also_at_stripe=${stripeReversalId}: ` +
              'Stripe holds a reversal the books do not record; recover those cents by hand',
          );
        }
        return t;
      }
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

  private async refuseReversal(
    op: TransferReversalOp,
    diagnostic: string,
  ): Promise<ReverseOutcome> {
    const transfer = await this.prisma.$transaction(async (tx) => {
      await tx.transferReversalOp.updateMany({
        where: { id: op.id, status: 'pending' },
        data: { status: 'refused', last_error: diagnostic.slice(0, 500), resolved_at: new Date() },
      });
      return tx.connectTransfer.findUniqueOrThrow({ where: { id: op.transfer_id } });
    });
    this.logger.warn(
      `SFEE_REVERSAL_REFUSED transfer=${op.transfer_id} op=${op.idempotency_key} amount=${op.amount_cents}: ${diagnostic}`,
    );
    return { status: 'refused', transfer, op_id: op.id, error: diagnostic };
  }

  // B-627-9 — every write is a CAS on the attempt that was read or claimed
  // (openOutcomeWhere). The ledger slice and the final status commit in one
  // transaction, and the repay alert is raised only by the worker that won:
  // a row another worker recorded (or is still sending) is never failed.
  private async markFailed(
    row: ConnectTransfer,
    message: string,
    finalFailure: boolean,
    // B-627-8: resolved = the last create is proven not executed (definitive
    // refusal), so its unresolved marker is cleared. Unresolved keeps it.
    send: { resolved: boolean } = { resolved: true },
  ): Promise<ConnectTransfer> {
    const status = finalFailure ? 'failed' : 'pending';
    const nextAttempt = finalFailure
      ? null
      : this.retryAt(row, send.resolved ? null : row.stripe_send_unresolved_at);
    const data = {
      status,
      last_error: message,
      next_attempt_at: nextAttempt,
      ...(send.resolved ? { stripe_send_unresolved_at: null } : {}),
    };
    const won = await this.prisma.$transaction(async (tx) => {
      const res = await tx.connectTransfer.updateMany({ where: this.openOutcomeWhere(row), data });
      if (res.count !== 1) return false;
      if (finalFailure && row.ledger_entry_id) {
        await this.ledger.markTransferFailed(row.ledger_entry_id, message, tx);
      }
      return true;
    });
    if (!won) return this.reconcileLostOutcome(row, finalFailure ? 'failed' : 'retry');
    if (finalFailure && row.settlement_id) {
      // C-627-6 (round 6): exact amounts for the operator. Netted cents stay
      // collected (they settled another charge's debt); only amount_cents is
      // owed to the payee, and the reconciliation gap on the charge is that.
      // C-627-8 (Opus, round 9): the amount owed can move after this alert (a
      // later refund or dispute on the same charge), so the alert names the
      // live source of truth instead of a fixed repayment amount.
      const position = row.kind.startsWith('head_coach') ? 'head_coach_position' : 'coach_position';
      this.logger.error(
        `SFEE_TRANSFER_FAILED alert=true transfer=${row.id} settlement=${row.settlement_id} purchase=${row.purchase_id} ` +
          `payee=${row.destination_user_id ?? 'unknown'} owed_cents_at_failure=${row.amount_cents} ` +
          `netted_cents=${row.netted_recovery_cents} currency=${row.currency}: before repaying, re-read the ${position} gap ` +
          `of GET /api/v1/admin/payments/reconciliation/${row.purchase_id} and repay that gap only (a later refund or dispute ` +
          'on this charge changes it); the netted cents already settled an earlier hold',
      );
    }
    return this.readBack(row, data);
  }
}
