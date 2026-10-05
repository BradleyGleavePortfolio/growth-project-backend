import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ChargeDispute,
  ChargeRefund,
  ClientPurchase,
  ConnectTransfer,
  Prisma,
} from '@prisma/client';
import * as Sentry from '@sentry/node';
import {
  ChargeSettlementService,
  chargeRefundsFromStripe,
  disputeAmountsFrom,
  isLegacyDestinationCharge,
  settlementFailureCode,
} from '../connect/fees/charge-settlement.service';
import {
  isRetryableMoneyError,
  RefundStateUnavailableError,
  ReversalUncertainError,
} from '../connect/fees/money-errors';
import { PayoutReadinessService } from '../connect/fees/payout-readiness.service';
import {
  SplitLedgerService,
  type LedgerReversalSource,
} from '../connect/fees/split-ledger.service';
import {
  TransferOrchestratorService,
  type ReverseOutcome,
} from '../connect/fees/transfer-orchestrator.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayoutNoticeService } from './payout-notice.service';
import { NotificationKind } from '../notifications/notification-kind';
import { PurchaseFanoutService } from '../packages/purchase-fanout.service';
import { PartialRefundDecisionService } from '../regimes/partial-refund-decision.service';
import { PrismaService } from '../prisma.service';

// PR-16 — outer tx forwarded by BillingService.handleEvent through
// CheckoutWebhookHandlerService.handle. Used to keep cancelPendingForPurchase
// inside the same $transaction as the entitlement flip on the refund /
// dispute paths.
type WebhookTx = Prisma.TransactionClient;

// B-641-7: one Stripe reversal per refund, whoever sends it.
export const refundTransferReversalKey = (refundRowId: string): string =>
  `tgp-tr-rev-refund-${refundRowId}`;
// B-674-5 / B-674-10: one Stripe reversal per lost chargeback, every attempt.
export const disputeTransferReversalKey = (disputeRowId: string): string =>
  `tgp-tr-rev-dispute-${disputeRowId}`;
export const DISPUTE_TRANSFER_REVERSAL_STUCK_CODE = 'DISPUTE_TRANSFER_REVERSAL_STUCK';
export const TRANSFER_REVERSAL_UNATTRIBUTED_CODE = 'TRANSFER_REVERSAL_UNATTRIBUTED';
// A chargeback's head-coach reversal attempted (amount stamped), not recorded.
const DISPUTE_TRANSFER_OWED = {
  transfer_reversed_at: null,
  transfer_reversal_amount_cents: { not: null },
};
// B-674-11: a chargeback attempted by the sweep waits this long before the
// next sweep (every 15 minutes) may claim it again.
export const DISPUTE_TRANSFER_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
// Stripe keeps idempotency keys for 24 hours; retry well inside that.
export const REFUND_TRANSFER_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
// B-641-8: pages per sweep run (x limit rows), so one run is bounded.
export const REFUND_TRANSFER_SWEEP_MAX_PAGES = 20;
// C-674-12: an attempt this close to the refund's success is its first pass.
const REFUND_FIRST_PASS_MS = 60_000;
// Operator alert (Sentry tag) and runbook for a reversal still owed past the
// window. Machine code only; no free text reaches Sentry.
export const REFUND_TRANSFER_REVERSAL_REVIEW_CODE = 'REFUND_TRANSFER_REVERSAL_REVIEW';
export const REFUND_TRANSFER_REVERSAL_RUNBOOK = 'docs/runbooks/refund-transfer-reversal-review.md';
export type RefundTransferReversalOutcome =
  'reversed' | 'nothing_owed' | 'already_done' | 'pending' | 'needs_review';

// B-641-11 (Sol): Stripe error codes a transfer reversal can answer with.
// Anything else logs as `other`; an error's name or message never reaches a
// log line (both are free text an exception can carry).
const STRIPE_REVERSAL_ERROR_CODES = new Set([
  'amount_too_large',
  'api_key_expired',
  'balance_insufficient',
  'idempotency_key_in_use',
  'idempotency_error',
  'insufficient_funds',
  'lock_timeout',
  'parameter_invalid_integer',
  'parameter_missing',
  'rate_limit',
  'request_timeout', // C-674-5: client timeout; Stripe may have made it
  'resource_missing',
  'transfer_already_reversed',
]);

// Machine code of a failed reversal attempt for logs, from a closed catalog.
function transferReversalErrorCode(err: unknown): string {
  if (err instanceof ReversalUncertainError) return err.code;
  if (err instanceof StripeConnectApiError) {
    const status =
      Number.isInteger(err.httpStatus) && err.httpStatus >= 100 && err.httpStatus <= 599
        ? err.httpStatus
        : 0;
    const code =
      err.stripeCode === null
        ? 'none'
        : STRIPE_REVERSAL_ERROR_CODES.has(err.stripeCode)
          ? err.stripeCode
          : 'other';
    return `stripe_${status}_${code}`;
  }
  const closed = err instanceof ServiceUnavailableException ? err.getResponse() : null;
  const code = (closed as { code?: unknown } | null)?.code;
  return code === 'TRANSFER_REVERSALS_LIST_INCOMPLETE' || code === 'TRANSFER_REVERSALS_TOO_MANY'
    ? code
    : 'error';
}

// B-641-9: the named Stripe reversal already settles another refund.
function transferReversalAssignedElsewhere(): ConflictException {
  return new ConflictException({
    code: 'TRANSFER_REVERSAL_ASSIGNED_TO_OTHER_REFUND',
    error: 'TRANSFER_REVERSAL_ASSIGNED_TO_OTHER_REFUND',
    message:
      'That reversal is already recorded for a different refund. Pick the reversal for this refund, or reconcile without an id.',
  });
}

// The refund or chargeback a Stripe reversal was made for: the ids TGP puts
// in metadata, or the event-scoped operation key (metadata tgp_reversal_op).
function reversalEvent(r: {
  metadata?: Record<string, string> | null;
}): { kind: 'refund' | 'dispute'; id: string } | null {
  const m = r.metadata ?? {};
  if (m.tgp_charge_refund_id) return { kind: 'refund', id: m.tgp_charge_refund_id };
  if (m.tgp_charge_dispute_id) return { kind: 'dispute', id: m.tgp_charge_dispute_id };
  const op = m.tgp_reversal_op ?? '';
  for (const [kind, prefix] of [
    ['refund', refundTransferReversalKey('')],
    ['dispute', disputeTransferReversalKey('')],
  ] as const) {
    if (op.startsWith(prefix)) {
      return { kind, id: op.slice(prefix.length).replace(/-(review|found-.*)$/, '') };
    }
  }
  return null;
}

// A276 P0-2 + P1-1 (refix) — deep-link routes for coach in-app alerts.
// Mirrors the guest-checkout path; mobile deep-link routing config owns
// the surface that these tgp:// URIs hit.
const COACH_REFUND_DEEP_LINK = 'tgp://coach/billing/refunds';
const COACH_DISPUTE_DEEP_LINK = 'tgp://coach/billing/disputes';

// Round 17 (Opus B-684-8): Stripe refund statuses that never change again.
const FAILED_REFUND_STATUSES = new Set(['failed', 'canceled']);
// Round 19 (B-684-12): status compare-and-set retries before the delivery fails closed.
const REFUND_STATUS_CAS_ATTEMPTS = 5;

/** A refund's status only moves forward; an older event never rewrites a newer outcome. */
function nextRefundStatus(current: string, incoming: string): string {
  if (FAILED_REFUND_STATUSES.has(current)) return current;
  if (current === 'succeeded' && (incoming === 'pending' || incoming === 'requires_action')) {
    return current;
  }
  return incoming;
}

// RefundDisputeHandlerService — webhook + admin-driven side of the
// refund / dispute / payout pipeline.
//
// Refund webhook flow (charge.refunded, charge.refund.updated):
//   1. Resolve ClientPurchase from charge id (via SplitLedgerEntry or
//      ConnectTransfer.source_stripe_charge_id; fall back to PI metadata).
//   2. Upsert ChargeRefund row (idempotent on stripe_refund_id).
//   3. Apply ledger reversals:
//        - destination slice : reversed_cents += refund amount
//        - application_fee slice : reversed_cents += proportional fee
//        - head_coach_split slice : reversed_cents += proportional split
//          AND reverse the underlying ConnectTransfer via Stripe
//          (TransferOrchestrator.reverse).
//   4. If full refund, flip ClientPurchase.status='refunded',
//      entitlement_active=false. Partial refund keeps the purchase
//      otherwise as-is.
//
// Dispute webhook flow (charge.dispute.*):
//   - opened : create ChargeDispute row, flip ClientPurchase.status='disputed'.
//   - closed (won)            : update ChargeDispute.status='won', clear the
//                               disputed flag on the purchase.
//   - closed (lost)           : update status='lost', apply ledger reversal
//                               equal to the dispute amount + the matching
//                               head-coach transfer reversal.
//   - closed (charge_refunded): the issuer issued a refund — Stripe will
//                               also fire charge.refunded; we just mirror
//                               the dispute status.

@Injectable()
export class RefundDisputeHandlerService {
  private readonly logger = new Logger(RefundDisputeHandlerService.name);

  // A276 P0-2 + P1-1 (refix) — NotificationsService is a HARD dependency,
  // not @Optional(). Coach notification is on the money path: a refund
  // or chargeback that doesn't reach the coach is functionally identical
  // to the bug fix 6 was meant to solve (coach learns about lost money
  // only by glancing at Stripe). If DI ever fails to provide this,
  // module boot fails — the alternative (silent no-op) is the exact
  // anti-pattern P1-4 flagged.
  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private ledger: SplitLedgerService,
    private transfers: TransferOrchestratorService,
    private payoutReadiness: PayoutReadinessService,
    private notifications: NotificationsService,
    // PR-16 — drip-drop cancellation seam. @Optional() so legacy
    // unit-test wiring that hand-constructs this service without the
    // packages module still compiles; production wiring (CheckoutModule
    // imports PackagesModule) always provides it.
    @Optional() private fanout?: PurchaseFanoutService,
    // F2 — partial-refund coach-decision seam. @Optional() so legacy unit-test
    // wiring that hand-constructs this service still compiles; production
    // wiring (CheckoutModule imports RegimesModule) always provides it. The
    // service itself no-ops when FEATURE_NAMED_REGIMES is OFF.
    @Optional() private partialRefundDecisions?: PartialRefundDecisionService,
    // S-FEE — per-charge settlement. Refunds / disputes on a separate-charge-
    // and-transfer charge re-derive every payee's target here (coach bears
    // the refunded principal and every Stripe fee; TGP is never out the
    // processing or dispute fee). @Optional() for legacy hand-built wiring;
    // production (CheckoutModule imports ConnectModule) always provides it.
    @Optional() private settlements?: ChargeSettlementService,
    // S-FEE round 5 (OR-111-1) — delivers the exact-amount payout notices the
    // settlement writes for each refund / chargeback / dispute outcome
    // (push + in-app + email). @Optional() for legacy hand-built wiring.
    @Optional() private payoutNotices?: PayoutNoticeService,
  ) {}

  // Webhook entry point — returns claimed=true iff we matched to a
  // ClientPurchase.
  //
  // PR-16: `tx` is the outer Prisma $transaction client opened by
  // BillingService.handleEvent. Routed handlers that revoke entitlement
  // (charge.refunded full-refund branch, charge.dispute.closed lost branch)
  // pass it through to cancelPendingForPurchase so the cancel commits
  // atomically with the entitlement flip. Side-effect handlers that do
  // NOT revoke entitlement (refund.updated, dispute.created/updated,
  // transfer.reversed, payout.*) ignore it.
  async handle(
    event: {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    },
    tx?: WebhookTx,
  ): Promise<{
    claimed: boolean;
    reason?: string;
    purchase_id?: string;
    deferredPayoutNoticeChargeId?: string;
  }> {
    const result = await this.route(event, tx);
    const chargeId = this.payoutNoticeChargeId(event);
    if (!chargeId) return result;
    // C-627-7 (round 6): inside BillingService's webhook $transaction the
    // push / email HTTP calls must not run; the caller delivers after commit
    // (deliverPayoutNotices) and the sweeper is the backstop. Without an
    // outer transaction (direct callers) delivery runs here.
    if (tx) return { ...result, deferredPayoutNoticeChargeId: chargeId };
    await this.deliverPayoutNotices(chargeId);
    return result;
  }

  // The charge whose payout notices this event may have recorded.
  private payoutNoticeChargeId(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): string | null {
    // Round 17 (Sol B-684-4): refund.updated carries the refund, like charge.refund.updated.
    if (!this.payoutNotices) return null;
    if (!event.type.startsWith('charge.') && event.type !== 'refund.updated') return null;
    const obj = event.data.object as { id?: unknown; charge?: unknown };
    if (event.type === 'charge.refunded') return typeof obj.id === 'string' ? obj.id : null;
    return typeof obj.charge === 'string' ? obj.charge : null;
  }

  // OR-111-1: deliver the payout notices the settlement recorded for this
  // charge once the money step (and its lock) is done and no transaction is
  // open. Best effort, never throws: the notices are durable rows and the
  // sweeper re-delivers undelivered ones.
  async deliverPayoutNotices(chargeId: string): Promise<void> {
    if (!this.payoutNotices) return;
    try {
      await this.payoutNotices.dispatchForCharge(chargeId);
    } catch (err) {
      this.logger.warn(
        `SFEE_NOTICE_DISPATCH_DEFERRED charge=${chargeId}: ${settlementFailureCode(err)}; the sweeper delivers it`,
      );
    }
  }

  private async route(
    event: {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    },
    tx?: WebhookTx,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    switch (event.type) {
      case 'charge.refunded':
        return this.onChargeRefunded(event, tx);
      case 'charge.refund.updated':
      case 'refund.updated':
        return this.onRefundUpdated(event);
      case 'charge.dispute.created':
        return this.onDisputeOpened(event);
      case 'charge.dispute.updated':
        return this.onDisputeUpdated(event);
      case 'charge.dispute.closed':
        return this.onDisputeClosed(event, tx);
      case 'transfer.reversed':
        return this.onTransferReversed(event);
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled':
        return this.onPayoutEvent(event);
      default:
        return { claimed: false };
    }
  }

  // --- Refund pipeline ---

  private async onChargeRefunded(
    event: {
      data: { object: Record<string, unknown> };
    },
    _outerTx?: WebhookTx,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    // PR-16: _outerTx is accepted for interface symmetry but the refund
    // path opens its OWN inner $transaction for the entitlement flip
    // (see fullyRefunded branch below). cancelPendingForPurchase rides
    // THAT inner tx so the cancel + status='refunded' flip + guestCheckout
    // mirror commit-or-rollback together. The Stripe HTTP / ledger
    // reversal writes deliberately stay on this.prisma (P1-3 anti-pattern
    // avoidance — see existing code comments) so the outer billing tx
    // would not be the right boundary for them either.
    const charge = event.data.object as {
      id?: string;
      amount?: number;
      amount_refunded?: number;
      refunded?: boolean;
      refunds?: {
        data?: Array<{ id?: string; amount?: number; status?: string; reason?: string | null }>;
        has_more?: boolean;
      };
    };
    if (!charge?.id) return { claimed: false, reason: 'no_charge_id' };
    const purchase = await this.resolvePurchaseByCharge(charge.id);
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };

    // A276 P0-2 (refix) — track per-refund-id transitions so we emit
    // exactly one COACH_ALERT per refund.id even under Stripe redelivery.
    // upsertAndApplyRefund returns { ledger_just_reversed: boolean } so
    // we know which refund ids transitioned this delivery; redeliveries
    // see ledger_reversed already true and skip.
    const refunds = await this.completeRefunds(charge);
    // Round 17 (Opus B-684-8): converge on the rows as written, so a stale snapshot never
    // counts a refund this service already knows has failed.
    let succeededCents = 0;
    const newlyAppliedRefunds: Array<{
      id: string;
      amount_cents: number;
      reason: string | null;
    }> = [];
    for (const r of refunds) {
      if (!r.id) continue;
      const outcome = await this.upsertAndApplyRefund({
        purchase,
        stripe_refund_id: r.id,
        stripe_charge_id: charge.id,
        amount_cents: typeof r.amount === 'number' ? r.amount : 0,
        status: r.status ?? 'pending',
        reason: r.reason ?? null,
      });
      if (outcome.row.status === 'succeeded')
        succeededCents += Math.max(0, outcome.row.amount_cents);
      if (outcome.ledger_just_reversed) {
        newlyAppliedRefunds.push({
          id: r.id,
          amount_cents: typeof r.amount === 'number' ? r.amount : 0,
          reason: r.reason ?? null,
        });
      }
    }

    // Update purchase-level state. A276 P1-2 (refix) — the GuestCheckout
    // and ClientPurchase paths both transition to 'refunded' when the
    // CUMULATIVE amount_refunded reaches the charge amount (Stripe's
    // refunded charges carry the running total). Partial refunds keep
    // entitlement_active true; the client keeps the access they paid
    // net-of-credit for.
    const totalAmount = typeof charge.amount === 'number' ? charge.amount : purchase.amount_cents;
    const refundedCents = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
    const fullyRefunded = totalAmount > 0 && refundedCents >= totalAmount;
    // R81 (PR-395 follow-up, F5) — refund/chargeback behaviour for the Roman P4
    // first-payment celebration is RETAIN-BY-DESIGN: a refund (even a full one)
    // or a chargeback does NOT un-record the CoachFirstPaymentNotification
    // ledger row. The "you landed your first client" celebration is a once-ever,
    // permanent milestone keyed to the coach's first SUCCESSFUL charge; a later
    // refund does not retroactively erase that they made a first sale. The
    // practical consequence is intentional and accepted: a coach whose only
    // payment is fully refunded will not see the celebration fire again on a
    // genuinely-new future first payment. This handler therefore deliberately
    // never references coachFirstPaymentNotification (verified by
    // first-payment-refund-retention.spec.ts). If product later wants the
    // celebration to be re-armable, delete the ledger row inside the inner
    // $transaction below — but that is a deliberate product decision, not a bug.
    if (fullyRefunded) await this.revokeFullyRefunded(purchase);

    // F2 — partial-refund coach-decision surface. When the refund is NOT a
    // full refund, entitlement_active stays true (the fullyRefunded branch
    // above never runs) and we do NOT auto-cancel drops. Instead we create a
    // pending PartialRefundDecision per newly-applied refund id so the coach
    // gets a "Keep drops / Unassign drops" card. The service no-ops when
    // FEATURE_NAMED_REGIMES is OFF and is idempotent on the unique
    // stripe_refund_id under Stripe redelivery. Gated on ledger_just_reversed
    // (newlyAppliedRefunds) so a re-issued/pending refund never spawns a
    // duplicate decision.
    if (!fullyRefunded && this.partialRefundDecisions) {
      for (const r of newlyAppliedRefunds) {
        await this.partialRefundDecisions.onPartialRefund({
          client_purchase_id: purchase.id,
          stripe_refund_id: r.id,
        });
      }
    }

    // A276 P0-2 (refix) — emit COACH_ALERT once per refund id whose
    // ledger reversal we just applied in THIS delivery. Order matters:
    // we fire AFTER the purchase-level status update so a coach who
    // taps through sees the correct entitlement state immediately.
    // Notifier failures are caught inside emitRefundCoachAlert; the
    // refund + ledger writes have already committed and we never roll
    // them back on a downstream-signal failure.
    for (const r of newlyAppliedRefunds) {
      await this.emitRefundCoachAlert({
        purchase,
        amount_cents: r.amount_cents,
        stripe_refund_id: r.id,
        stripe_charge_id: charge.id,
        reason: r.reason,
      });
    }

    // B-684-1 (round 11): the settlement also converges once more, under the charge lock,
    // after the per-refund alerts, so a retried delivery loses none of them. Round 13 (Opus
    // B-684-3): on the SUCCEEDED refunds of the complete list, never amount_refunded (it also
    // counts pending refunds). A converted charge reads its own debits from Stripe (B-683-1).
    if (this.settlements && succeededCents > 0) {
      await this.settlements.applyAdjustments({
        purchase,
        charge_id: charge.id,
        refunded_cents: succeededCents,
      });
    }

    return { claimed: true, purchase_id: purchase.id };
  }

  /**
   * A full refund ends access (shared by charge.refunded and the refund status events, Sol
   * B-684-5). The ClientPurchase flip, its GuestCheckout mirror and the drop cancel commit
   * together (A276-F2-P2-3, PR-16); the status WHERE-guards make a redelivery a no-op. Money and
   * Stripe calls stay outside this transaction (P1-3). Partial refunds keep access.
   */
  private async revokeFullyRefunded(purchase: ClientPurchase): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.clientPurchase.updateMany({
        where: { id: purchase.id, status: { not: 'refunded' } },
        data: { status: 'refunded', entitlement_active: false },
      });
      if (purchase.stripe_payment_intent_id) {
        await tx.guestCheckout.updateMany({
          where: {
            stripe_payment_intent_id: purchase.stripe_payment_intent_id,
            status: { not: 'refunded' },
          },
          data: { status: 'refunded' },
        });
      }
      if (this.fanout) {
        await this.fanout.cancelPendingForPurchase(purchase.id, 'refund', tx);
      }
    });
  }

  /**
   * Round 13 (Sol B-684-1, Opus B-684-3): every refund on the charge. The event embeds at most
   * the latest ten (none on current API versions), so unless the embedded list is explicitly
   * complete and accounts for amount_refunded, it is read from Stripe to the last page. An
   * incomplete read throws RefundStateUnavailableError (the webhook fails, Stripe redelivers);
   * nothing moves.
   */
  private async completeRefunds(charge: {
    id?: string;
    amount_refunded?: number;
    refunds?: {
      data?: Array<{ id?: string; amount?: number; status?: string; reason?: string | null }>;
      has_more?: boolean;
    };
  }): Promise<Array<{ id?: string; amount?: number; status?: string; reason?: string | null }>> {
    const embedded = charge.refunds?.data ?? [];
    const live = embedded.reduce(
      (n, r) =>
        n +
        (r.status !== 'failed' && r.status !== 'canceled' && typeof r.amount === 'number'
          ? r.amount
          : 0),
      0,
    );
    const complete = charge.refunds?.has_more !== true && live >= (charge.amount_refunded ?? 0);
    if (complete || !this.settlements || !charge.id) return embedded;
    // Ids, statuses and the client's own amounts; the settlement debits are read under the lock.
    const list = await chargeRefundsFromStripe(this.stripe, charge.id, null);
    const reasons = new Map(embedded.map((r) => [r.id, r.reason ?? null]));
    return list.refunds.map((r) => ({
      id: r.id,
      amount: r.amount_cents,
      status: r.status,
      reason: reasons.get(r.id) ?? null,
    }));
  }

  private async onRefundUpdated(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const refund = event.data.object as {
      id?: string;
      charge?: string | null;
      amount?: number;
      status?: string;
      reason?: string | null;
      failure_reason?: string | null;
    };
    if (!refund?.id) return { claimed: false };
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: refund.id },
    });
    const chargeId =
      existing?.stripe_charge_id ?? (typeof refund.charge === 'string' ? refund.charge : null);
    if (this.settlements && chargeId) {
      return this.applyRefundUpdate(refund, existing, chargeId);
    }
    if (!existing) {
      // No-op: we'll see the parent charge.refunded shortly.
      return { claimed: false, reason: 'no_known_refund' };
    }
    // Hand-built wiring without the settlement service (legacy charges only).
    // B-641-6 (S-COACH-BE-4): a refund pending on charge.refunded completes
    // through THIS event (never resent): book it like charge.refunded (first
    // success time in posted_at, ledger reversal once, coach alert once).
    // B-641-7: also re-enter while the head-coach transfer is still owed.
    if (refund.status === 'succeeded' && !(existing.ledger_reversed && existing.transfer_reversed)) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: existing.purchase_id },
      });
      if (purchase) {
        const amount = typeof refund.amount === 'number' ? refund.amount : existing.amount_cents;
        const outcome = await this.upsertAndApplyRefund({
          purchase,
          stripe_refund_id: refund.id,
          stripe_charge_id: existing.stripe_charge_id,
          amount_cents: amount,
          status: 'succeeded',
          reason: existing.reason,
        });
        if (existing.failure_reason && outcome.row.status === 'succeeded') {
          // A succeeded refund carries no failure reason (B-684-12: a refund
          // the compare-and-set kept failed keeps its reason).
          await this.prisma.chargeRefund.update({
            where: { stripe_refund_id: refund.id },
            data: { failure_reason: null },
          });
        }
        if (outcome.ledger_just_reversed) {
          // Same once-per-refund downstream signals as charge.refunded. The
          // full-refund entitlement flip already ran there: Stripe's
          // amount_refunded counts pending refunds.
          const fresh = await this.prisma.clientPurchase.findUnique({
            where: { id: purchase.id },
          });
          if (fresh?.status !== 'refunded' && this.partialRefundDecisions) {
            await this.partialRefundDecisions.onPartialRefund({
              client_purchase_id: purchase.id,
              stripe_refund_id: refund.id,
            });
          }
          await this.emitRefundCoachAlert({
            purchase,
            amount_cents: amount,
            stripe_refund_id: refund.id,
            stripe_charge_id: existing.stripe_charge_id,
            reason: existing.reason,
          });
        }
        return { claimed: true, purchase_id: existing.purchase_id };
      }
    }
    // Round 19 (B-684-12): the same monotonic compare-and-set as every other refund writer.
    await this.writeRefundStatus(existing, existing.stripe_charge_id, (current) => {
      const status = nextRefundStatus(current.status, refund.status ?? current.status);
      // A refused (older) event keeps the stored failure reason with the stored status.
      const moved = status === (refund.status ?? current.status);
      return {
        status,
        failure_reason: moved ? (refund.failure_reason ?? null) : current.failure_reason,
      };
    });
    return { claimed: true, purchase_id: existing.purchase_id };
  }

  /**
   * Round 13 (Opus B-684-3): a refund's terminal status moves its money. One that becomes
   * succeeded is applied now (once, under the charge lock, idempotent on ledger_reversed) and
   * the coach is told; a pending one moves nothing. One that fails or is canceled after its
   * money was applied raises an alert and flags the settlement for review (C-684-4, decided
   * under the charge lock in upsertAndApplyRefund; nothing is re-credited automatically). A
   * refund this service has not seen yet is recorded too.
   * Round 17 (Sol B-684-5): a succeeded refund also converges the purchase. Before anything
   * moves, the charge (presentment amount) and its complete refund list are read from Stripe
   * (fail closed: the webhook fails and Stripe redelivers); when the succeeded refunds cover
   * the charge, access ends exactly as on charge.refunded, otherwise a newly applied refund
   * gets the partial-refund decision. Re-run on every succeeded delivery (idempotent).
   */
  private async applyRefundUpdate(
    refund: {
      id?: string;
      amount?: number;
      status?: string;
      reason?: string | null;
      failure_reason?: string | null;
    },
    existing: ChargeRefund | null,
    chargeId: string,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const purchase = existing
      ? await this.prisma.clientPurchase.findUnique({ where: { id: existing.purchase_id } })
      : await this.resolvePurchaseByCharge(chargeId);
    if (!purchase || !refund.id) return { claimed: false, reason: 'no_matching_purchase' };
    const status = refund.status ?? existing?.status ?? 'pending';
    const fullyRefunded = status === 'succeeded' ? await this.coversCharge(chargeId) : false;
    const outcome = await this.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: refund.id,
      stripe_charge_id: chargeId,
      amount_cents:
        typeof refund.amount === 'number' ? refund.amount : (existing?.amount_cents ?? 0),
      status,
      reason: refund.reason ?? existing?.reason ?? null,
    });
    if (refund.failure_reason !== undefined && outcome.row.status === status) {
      await this.prisma.chargeRefund.update({
        where: { stripe_refund_id: refund.id },
        data: { failure_reason: refund.failure_reason ?? null },
      });
    }
    if (outcome.row.status === 'succeeded' && outcome.row.ledger_reversed && fullyRefunded) {
      await this.revokeFullyRefunded(purchase);
    } else if (outcome.ledger_just_reversed && this.partialRefundDecisions) {
      const fresh = await this.prisma.clientPurchase.findUnique({ where: { id: purchase.id } });
      if (fresh && fresh.status !== 'refunded') {
        await this.partialRefundDecisions.onPartialRefund({
          client_purchase_id: purchase.id,
          stripe_refund_id: refund.id,
        });
      }
    }
    if (outcome.ledger_just_reversed) {
      await this.emitRefundCoachAlert({
        purchase,
        amount_cents: outcome.row.amount_cents,
        stripe_refund_id: refund.id,
        stripe_charge_id: chargeId,
        reason: outcome.row.reason ?? null,
      });
    }
    return { claimed: true, purchase_id: purchase.id };
  }

  // Round 17 (Sol B-684-5): whether the charge's succeeded refunds (complete Stripe list,
  // presentment minor units on both sides) cover the charge's own amount, so a renewal charge
  // is judged on itself. Unreadable state throws RefundStateUnavailableError before money moves.
  private async coversCharge(chargeId: string): Promise<boolean> {
    const charge = await this.stripe.retrieveCharge(chargeId).catch((err: unknown) => {
      throw new RefundStateUnavailableError(chargeId, settlementFailureCode(err));
    });
    const list = await chargeRefundsFromStripe(this.stripe, chargeId, null);
    const amount = typeof charge?.amount === 'number' ? charge.amount : 0;
    return amount > 0 && list.succeeded_client_cents >= amount;
  }

  // Idempotently create a refund row + apply ledger reversals. Safe to
  // re-run with the same payload — composite-unique on stripe_refund_id
  // + ledger.applyReversal monotonically increases reversed_cents.
  //
  // Returns { row, ledger_just_reversed } so callers can detect the
  // one-and-only delivery that transitioned ledger_reversed false →
  // true for this refund.id and use that as their COACH_ALERT
  // idempotency key (A276 P0-2 refix). Redeliveries see
  // ledger_just_reversed=false and skip downstream signalling.
  async upsertAndApplyRefund(args: {
    purchase: ClientPurchase;
    stripe_refund_id: string;
    stripe_charge_id: string;
    amount_cents: number;
    status: string;
    reason: string | null;
    note?: string | null;
    initiated_by_user_id?: string | null;
  }): Promise<{ row: ChargeRefund; ledger_just_reversed: boolean }> {
    // Round 17 (Opus B-684-8): a refund's status only moves forward. failed and canceled are
    // terminal, and succeeded never goes back to pending / requires_action, so a stale or
    // redelivered older event (or snapshot) never rewrites a newer outcome.
    // Round 19 (B-684-12): the transition is a compare-and-set on the status this writer read,
    // so a newer outcome written between the read and the write is never overwritten.
    const updateExisting = (existing: ChargeRefund) =>
      this.writeRefundStatus(existing, args.stripe_charge_id, (current) => {
        const status = nextRefundStatus(current.status, args.status);
        return {
          status,
          amount_cents: args.amount_cents,
          reason: args.reason ?? current.reason,
          note: args.note ?? current.note,
          initiated_by_user_id: args.initiated_by_user_id ?? current.initiated_by_user_id,
        };
      });
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: args.stripe_refund_id },
    });
    let row: ChargeRefund;
    if (existing) {
      row = await updateExisting(existing);
    } else {
      try {
        row = await this.prisma.chargeRefund.create({
          data: {
            purchase_id: args.purchase.id,
            stripe_refund_id: args.stripe_refund_id,
            stripe_charge_id: args.stripe_charge_id,
            amount_cents: args.amount_cents,
            status: args.status,
            reason: args.reason,
            note: args.note ?? null,
            initiated_by_user_id: args.initiated_by_user_id ?? null,
            posted_at: args.status === 'succeeded' ? new Date() : null,
          },
        });
      } catch (err) {
        // An admin refund and its charge.refunded webhook raced to insert the
        // same refund id: the loser updates the winner's row.
        const raced =
          typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
            ? await this.prisma.chargeRefund.findUnique({
                where: { stripe_refund_id: args.stripe_refund_id },
              })
            : null;
        if (!raced) throw err;
        row = await updateExisting(raced);
      }
    }

    // Round 17 (Opus B-684-8): a failed / canceled refund whose money was already applied is
    // decided under the charge lock, after this status write, so a concurrent apply either saw
    // the terminal status (and moved nothing) or finished first (and is flagged here).
    if (FAILED_REFUND_STATUSES.has(row.status) && this.settlements) {
      await this.settlements.withChargeLock(args.stripe_charge_id, () =>
        this.flagFailedAfterApply(row.id, args.stripe_charge_id),
      );
      return { row, ledger_just_reversed: false };
    }
    // Apply ledger reversals only once per refund (idempotency flag),
    // and only when the refund is actually `succeeded` — pending refunds
    // shouldn't move our books.
    if (row.status !== 'succeeded') {
      return { row, ledger_just_reversed: false };
    }
    // B-641-6: posted_at is the FIRST success time (a redelivery never moves
    // the refund to a later window). B-674-12: the database elects it
    // (posted_at IS NULL in the UPDATE), so overlapping deliveries keep one.
    if (!row.posted_at) {
      await this.prisma.chargeRefund.updateMany({
        where: { id: row.id, posted_at: null },
        data: { posted_at: new Date() },
      });
      row = (await this.prisma.chargeRefund.findUnique({ where: { id: row.id } })) ?? row;
    }
    const refundRow = row;

    // S-FEE round 3 (B-627-2): one application per Stripe refund id, and one
    // money movement at a time per charge. "Is this refund applied yet",
    // the adjustment and "mark it applied" form one critical section under
    // the charge's lock, so a duplicate delivery, two refunds of one charge
    // delivered together, or an admin refund racing its own charge.refunded
    // webhook apply each refund exactly once. The settlement path converges
    // on the cumulative refunded total (and owns its transfers' reversals).
    // A ChargeLockBusyError propagates (the webhook returns non-2xx and
    // Stripe redelivers; the lock holder applies this refund before it
    // releases, because it re-reads the charge's succeeded refunds).
    // B-641-7 (legacy charges): the flag is CLAIMED (false -> true) in one
    // transaction with the ledger reversal, so one caller reverses the books
    // and a crash rolls both back; the head-coach transfer follows outside
    // any transaction (Stripe HTTP), owed until transfer_reversed is true.
    const apply = async (): Promise<boolean> => {
      // Round 17 (Opus B-684-8): the status as it is now, under the lock.
      const fresh = await this.prisma.chargeRefund.findUnique({ where: { id: refundRow.id } });
      if (!fresh || fresh.status !== 'succeeded') return false;
      let ledgerJustReversed = false;
      if (!fresh.ledger_reversed) {
        if (await this.applySettlementRefund(args.purchase, args.stripe_charge_id)) {
          const claim = await this.prisma.chargeRefund.updateMany({
            where: { id: refundRow.id, ledger_reversed: false },
            data: { ledger_reversed: true, transfer_reversed: true },
          });
          return claim.count === 1;
        }
        ledgerJustReversed = await this.prisma.$transaction(async (tx) => {
          const claim = await tx.chargeRefund.updateMany({
            where: { id: refundRow.id, ledger_reversed: false },
            data: { ledger_reversed: true },
          });
          if (claim.count !== 1) return false;
          // B-676-1: each slice posts THIS refund's cents at its posted_at.
          await this.applyLedgerReversal(
            args.purchase.id,
            args.amount_cents,
            args.stripe_charge_id,
            tx,
            { kind: 'refund', id: refundRow.id, at: refundRow.posted_at ?? new Date() },
          );
          return true;
        });
      }
      // B-676-3: reversed with the refund, the head-coach posting takes the
      // refund's own time; a later recovery posts when it happens. C-674-12:
      // an overlapping delivery of the same success counts as reversed with it.
      const firstPass =
        ledgerJustReversed ||
        (!!refundRow.posted_at &&
          Date.now() - refundRow.posted_at.getTime() <= REFUND_FIRST_PASS_MS);
      await this.applyRefundTransferReversalOnce(
        refundRow.id,
        args.purchase.id,
        args.amount_cents,
        () => new Date(),
        firstPass ? (refundRow.posted_at ?? undefined) : undefined,
      );
      return ledgerJustReversed;
    };
    const ledgerJustReversed = this.settlements
      ? await this.settlements.withChargeLock(args.stripe_charge_id, apply)
      : await apply();
    const updated = await this.prisma.chargeRefund.findUnique({ where: { id: refundRow.id } });
    return { row: updated ?? refundRow, ledger_just_reversed: ledgerJustReversed };
  }

  /**
   * Round 19 (B-684-12, both lenses): write a refund row's status as a compare-and-set on the
   * status it was read with. The update matches only while the row still has that status; when
   * it matches nothing (Prisma P2025) because another writer changed the status in between, the
   * row is re-read and the next status is decided again from what is stored now.
   * nextRefundStatus depends only on the stored status, so a match on it is enough. Bounded:
   * after REFUND_STATUS_CAS_ATTEMPTS misses it fails closed (RefundStateUnavailableError, nothing
   * moved; the delivery fails and Stripe redelivers).
   */
  private async writeRefundStatus(
    read: ChargeRefund,
    chargeId: string,
    next: (current: ChargeRefund) => Prisma.ChargeRefundUpdateInput & { status: string },
  ): Promise<ChargeRefund> {
    let current = read;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.chargeRefund.update({
          where: { stripe_refund_id: current.stripe_refund_id, status: current.status },
          data: next(current),
        });
      } catch (err) {
        const now = await this.prisma.chargeRefund.findUnique({
          where: { stripe_refund_id: current.stripe_refund_id },
        });
        if (!now || now.status === current.status) throw err;
        if (attempt >= REFUND_STATUS_CAS_ATTEMPTS) {
          throw new RefundStateUnavailableError(chargeId, 'kind=refund_status_contended');
        }
        current = now;
      }
    }
  }

  // C-684-4 / Opus B-684-8: the payout was already reduced for a refund Stripe now reports
  // failed or canceled. Runs under the charge lock; nothing is re-credited automatically.
  private async flagFailedAfterApply(rowId: string, chargeId: string): Promise<void> {
    const fresh = await this.prisma.chargeRefund.findUnique({ where: { id: rowId } });
    if (!fresh?.ledger_reversed || !FAILED_REFUND_STATUSES.has(fresh.status)) return;
    this.logger.error(
      `SFEE_REFUND_FAILED_AFTER_APPLY alert=true charge=${chargeId} refund=${fresh.stripe_refund_id} status=${fresh.status}: the payout was already reduced for this refund; the settlement is flagged for review and nothing is re-credited automatically`,
    );
    await this.prisma.chargeSettlement.updateMany({
      where: { stripe_charge_id: chargeId },
      data: {
        reconcile_requested_at: new Date(),
        reconcile_reason: 'SFEE_REFUND_FAILED_AFTER_APPLY',
      },
    });
  }

  // B-641-7: reverse the head-coach transfer for ONE refund exactly once.
  // Every caller sends under the same refund-scoped key, so the transfer
  // reversal operation (TransferOrchestratorService.reverse: written before
  // Stripe is called, reconciled by Stripe's own list after a lost response)
  // records the transfer's reversal once; the local record then claims
  // transfer_reversed false -> true (one record, one slice posting). A Stripe
  // refusal or an unknown outcome leaves it owed for the retry sweep.
  // B-641-7 (B-COACH-5): a NEW operation is admitted only within 23 hours of
  // the first attempt (stamped before the call); past that the reversal moves
  // to owner review, alerted once. An operation already written under the
  // key is always finished (re-driven) first.
  private async applyRefundTransferReversalOnce(
    refundRowId: string,
    purchaseId: string,
    refundAmountCents: number,
    clock: () => Date,
    postedAt?: Date,
  ): Promise<RefundTransferReversalOutcome> {
    const current = await this.prisma.chargeRefund.findUnique({ where: { id: refundRowId } });
    if (!current || current.transfer_reversed) return 'already_done';
    if (current.transfer_reversal_review_at) return 'needs_review';
    const key = refundTransferReversalKey(refundRowId);
    // An operation under the key exists only after the first attempt was
    // stamped (admission writes the stamp before the operation).
    const prior = current.transfer_reversal_first_attempt_at
      ? await this.prisma.transferReversalOp.findUnique({ where: { idempotency_key: key } })
      : null;
    let send: { transfer_row_id: string; amount_cents: number };
    let unproven: ConnectTransfer | null = null;
    if (prior) {
      send = { transfer_row_id: prior.transfer_id, amount_cents: prior.amount_cents };
    } else {
      const owed = await this.owedHeadCoachReversal(purchaseId, refundAmountCents);
      if (!owed) {
        await this.markTransferReversalDone(this.prisma, refundRowId);
        return 'nothing_owed';
      }
      // B-674-13: the window is checked at the send, not at the sweep's start.
      const admission = await this.admitTransferReversalAttempt(
        refundRowId,
        clock(),
        owed.amount_cents,
      );
      if (admission.outcome !== 'admitted') return admission.outcome;
      // B-674-3 (d): every resend replays the first attempt's amount.
      send = { transfer_row_id: owed.transfer.id, amount_cents: admission.amount_cents };
      if (current.transfer_reversal_first_attempt_at) unproven = owed.transfer;
    }
    // B-641-8 / B-674-16: every attempt, a re-drive of the operation already
    // written too, is stamped first; the sweep orders by it, least recent first.
    await this.prisma.chargeRefund.updateMany({
      where: { id: refundRowId, transfer_reversed: false, transfer_reversal_review_at: null },
      data: { transfer_reversal_last_attempt_at: clock() },
    });
    try {
      const res =
        (unproven && (await this.reversalStripeHolds(unproven, { kind: 'refund', id: refundRowId }, key))) ||
        (await this.transfers.reverse({ ...send, idempotency_key: key, purpose: 'legacy' }));
      return await this.recordHeadCoachReversed(
        res,
        (tx, stripeId) => this.markTransferReversalDone(tx, refundRowId, stripeId),
        { kind: 'refund', id: refundRowId, at: postedAt ?? new Date() },
        `purchase=${purchaseId} refund=${refundRowId}`,
      );
    } catch (err) {
      // Ids and machine codes only: a Stripe message is free text.
      this.logger.warn(
        `head-coach transfer reverse pending purchase=${purchaseId} refund=${refundRowId} code=${transferReversalErrorCode(err)}`,
      );
      return 'pending';
    }
  }

  // The local half of one event's head-coach reversal, after the reversal
  // operation finished. A refused operation stays owed. A succeeded one is
  // recorded by the claim (the event row, bound to Stripe's reversal id) and,
  // only by the claimer, the head-coach slice posts the event's cents
  // (B-676-1/B-676-3) in the same transaction. The transfer's own total and
  // the slice total are the operation's (never added here).
  private async recordHeadCoachReversed(
    res: ReverseOutcome,
    claim: (tx: Prisma.TransactionClient, stripeReversalId?: string) => Promise<boolean>,
    source: LedgerReversalSource,
    ids: string,
  ): Promise<RefundTransferReversalOutcome> {
    if (res.status !== 'succeeded') {
      this.logger.warn(`head-coach transfer reverse pending ${ids} code=stripe_refused`);
      return 'pending';
    }
    const op = res.op_id
      ? await this.prisma.transferReversalOp.findUnique({ where: { id: res.op_id } })
      : null;
    const entryId = res.transfer.ledger_entry_id;
    await this.prisma.$transaction(async (tx) => {
      if (!(await claim(tx, op?.stripe_reversal_id ?? undefined))) return;
      if (op && entryId) {
        await this.ledger.postReversalSource({ entry_id: entryId, source, cents: op.amount_cents }, tx);
      }
    });
    return op ? 'reversed' : 'nothing_owed';
  }

  private markTransferReversalDone(
    db: Prisma.TransactionClient,
    refundRowId: string,
    stripeTransferReversalId?: string,
  ): Promise<boolean> {
    return db.chargeRefund
      .updateMany({
        where: { id: refundRowId, transfer_reversed: false },
        data: {
          transfer_reversed: true,
          ...(stripeTransferReversalId
            ? { transfer_reversal_stripe_id: stripeTransferReversalId }
            : {}),
        },
      })
      .then((r) => r.count === 1);
  }

  // The head-coach share of this refund still to reverse: the legacy
  // head-coach transfer's pro-rata share of the refund, capped by what is
  // left on it. Legacy only (kind head_coach_split, no settlement): an S-FEE
  // charge's transfers are reversed by ChargeSettlementService. One legacy
  // head-coach transfer exists per purchase (renewals collapse onto it).
  private async owedHeadCoachReversal(
    purchaseId: string,
    refundAmountCents: number,
  ): Promise<{ transfer: ConnectTransfer; amount_cents: number } | null> {
    const transfer = await this.prisma.connectTransfer.findFirst({
      where: {
        purchase_id: purchaseId,
        status: 'succeeded',
        kind: 'head_coach_split',
        settlement_id: null,
      },
    });
    if (!transfer) return null;
    const purchase = await this.prisma.clientPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return null;
    const amount = Math.min(
      transfer.amount_cents - transfer.reversed_amount_cents,
      Math.floor((transfer.amount_cents * refundAmountCents) / Math.max(purchase.amount_cents, 1)),
    );
    return amount > 0 ? { transfer, amount_cents: amount } : null;
  }

  // Shared retry admission (B-641-7). The first attempt is stamped BEFORE the
  // Stripe call, so a stop after the stamp counts as "may have been sent" and
  // the window is measured from no later than the real first request.
  private async admitTransferReversalAttempt(
    refundRowId: string,
    now: Date,
    amountCents: number,
  ): Promise<
    { outcome: 'admitted'; amount_cents: number } | { outcome: 'already_done' | 'needs_review' }
  > {
    await this.prisma.chargeRefund.updateMany({
      where: {
        id: refundRowId,
        transfer_reversed: false,
        transfer_reversal_review_at: null,
        transfer_reversal_first_attempt_at: null,
      },
      data: {
        transfer_reversal_first_attempt_at: now,
        transfer_reversal_amount_cents: amountCents,
      },
    });
    const row = await this.prisma.chargeRefund.findUnique({ where: { id: refundRowId } });
    if (!row || row.transfer_reversed) return { outcome: 'already_done' };
    if (row.transfer_reversal_review_at) return { outcome: 'needs_review' };
    const firstAttempt = row.transfer_reversal_first_attempt_at ?? now;
    if (now.getTime() - firstAttempt.getTime() <= REFUND_TRANSFER_RETRY_WINDOW_MS) {
      return {
        outcome: 'admitted',
        amount_cents: row.transfer_reversal_amount_cents ?? amountCents,
      };
    }
    await this.moveTransferReversalToReview(row, now);
    return { outcome: 'needs_review' };
  }

  // Claims the review transition once; only the claimer alerts, so a row is
  // reported to the operator exactly once however many callers see it.
  private async moveTransferReversalToReview(row: ChargeRefund, now: Date): Promise<boolean> {
    const claim = await this.prisma.chargeRefund.updateMany({
      where: { id: row.id, transfer_reversed: false, transfer_reversal_review_at: null },
      data: { transfer_reversal_review_at: now },
    });
    if (claim.count !== 1) return false;
    const firstAttempt = row.transfer_reversal_first_attempt_at ?? row.posted_at ?? row.created_at;
    this.logger.error(
      `head-coach transfer reversal needs review refund=${row.id} purchase=${row.purchase_id} code=${REFUND_TRANSFER_REVERSAL_REVIEW_CODE}`,
    );
    Sentry.captureMessage('head-coach transfer reversal needs operator review', {
      level: 'error',
      fingerprint: ['refund-transfer-reversal-review', row.id],
      tags: { code: REFUND_TRANSFER_REVERSAL_REVIEW_CODE },
      extra: {
        charge_refund_id: row.id,
        purchase_id: row.purchase_id,
        amount_cents: row.amount_cents,
        first_attempt_at: firstAttempt.toISOString(),
        runbook: REFUND_TRANSFER_REVERSAL_RUNBOOK,
      },
    });
    return true;
  }

  // B-641-7 recovery: books reversed, head-coach transfer still owed; retried
  // with the same refund-scoped key. B-641-8: rows past the window first move
  // to review, then the pass pages (bounded) through admissible rows only.
  async retryPendingTransferReversals(
    now: Date = new Date(),
    limit = 50,
  ): Promise<{ retried: number; reversed: number; needs_review: number; in_review: number }> {
    const owed = {
      status: 'succeeded',
      ledger_reversed: true,
      transfer_reversed: false,
      transfer_reversal_review_at: null,
    };
    const cutoff = new Date(now.getTime() - REFUND_TRANSFER_RETRY_WINDOW_MS);
    const order: Prisma.ChargeRefundOrderByWithRelationInput[] = [
      { created_at: 'asc' },
      { id: 'asc' },
    ];

    let needsReview = 0;
    for (let page = 0; page < REFUND_TRANSFER_SWEEP_MAX_PAGES; page++) {
      const expired = await this.prisma.chargeRefund.findMany({
        where: { ...owed, transfer_reversal_first_attempt_at: { lt: cutoff } },
        orderBy: order,
        take: limit,
      });
      for (const row of expired) {
        if (await this.moveTransferReversalToReview(row, now)) needsReview++;
      }
      if (expired.length < limit) break;
    }

    let retried = 0;
    let reversed = 0;
    const startedMs = Date.now();
    const sendClock = () => new Date(now.getTime() + Date.now() - startedMs);
    // B-641-8 (Sol): never-attempted rows first, then least recently tried.
    // Each touched row leaves the owed set or is stamped with `now`, so the
    // `last attempt before now` filter pages past it (no cursor).
    for (let page = 0; page < REFUND_TRANSFER_SWEEP_MAX_PAGES; page++) {
      const rows = await this.prisma.chargeRefund.findMany({
        where: {
          ...owed,
          AND: [
            {
              OR: [
                { transfer_reversal_first_attempt_at: null },
                { transfer_reversal_first_attempt_at: { gte: cutoff } },
              ],
            },
            {
              OR: [
                { transfer_reversal_last_attempt_at: null },
                { transfer_reversal_last_attempt_at: { lt: now } },
              ],
            },
          ],
        },
        orderBy: [
          { transfer_reversal_last_attempt_at: { sort: 'asc', nulls: 'first' } },
          ...order,
        ],
        take: limit,
      });
      for (const row of rows) {
        retried++;
        const outcome = await this.applyRefundTransferReversalOnce(
          row.id,
          row.purchase_id,
          row.amount_cents,
          sendClock,
        );
        if (outcome === 'reversed') reversed++;
        if (outcome === 'needs_review') needsReview++;
      }
      if (rows.length < limit) break;
    }

    // B-674-5 / B-674-11: lost chargebacks whose head-coach reversal is still
    // owed, least recently attempted first (never-attempted first). Each row
    // is claimed by stamping its attempt, so later pages, restarted runs and
    // other replicas move past it until the cooldown passes, and every owed
    // chargeback is reached within a bounded number of runs. A stamp ahead of
    // this clock (skewed replica) stays claimable.
    const retryBefore = new Date(now.getTime() - DISPUTE_TRANSFER_RETRY_COOLDOWN_MS);
    for (let page = 0; page < REFUND_TRANSFER_SWEEP_MAX_PAGES; page++) {
      const disputes = await this.prisma.chargeDispute.findMany({
        where: {
          status: 'lost',
          ...DISPUTE_TRANSFER_OWED,
          OR: [
            { transfer_reversal_last_attempt_at: null },
            { transfer_reversal_last_attempt_at: { lt: retryBefore } },
            { transfer_reversal_last_attempt_at: { gt: now } },
          ],
        },
        orderBy: [
          { transfer_reversal_last_attempt_at: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        take: limit,
      });
      for (const d of disputes) {
        const claim = await this.prisma.chargeDispute.updateMany({
          where: {
            id: d.id,
            transfer_reversal_last_attempt_at: d.transfer_reversal_last_attempt_at ?? null,
          },
          data: { transfer_reversal_last_attempt_at: now },
        });
        if (claim.count !== 1) continue; // another sweep holds it
        retried++;
        const outcome = await this.applyDisputeTransferReversalOnce(d.id, null);
        if (outcome === 'reversed') reversed++;
        const age = now.getTime() - (d.transfer_reversal_first_attempt_at ?? now).getTime();
        if (outcome === 'pending' && age > REFUND_TRANSFER_RETRY_WINDOW_MS) {
          Sentry.captureMessage('head-coach transfer reversal for a lost chargeback still owed', {
            level: 'error',
            fingerprint: ['dispute-transfer-reversal-stuck', d.id],
            tags: { code: DISPUTE_TRANSFER_REVERSAL_STUCK_CODE },
            extra: {
              charge_dispute_id: d.id,
              purchase_id: d.purchase_id,
              runbook: REFUND_TRANSFER_REVERSAL_RUNBOOK,
            },
          });
        }
      }
      if (disputes.length < limit) break;
    }

    const inReview = await this.prisma.chargeRefund.count({
      where: { transfer_reversed: false, transfer_reversal_review_at: { not: null } },
    });
    return { retried, reversed, needs_review: needsReview, in_review: inReview };
  }

  // Owner view of the review queue (oldest first).
  async listTransferReversalsInReview(limit = 50): Promise<
    Array<{
      charge_refund_id: string;
      purchase_id: string;
      stripe_refund_id: string;
      amount_cents: number;
      first_attempt_at: string | null;
      review_at: string;
    }>
  > {
    const rows = await this.prisma.chargeRefund.findMany({
      where: { transfer_reversed: false, transfer_reversal_review_at: { not: null } },
      orderBy: [{ transfer_reversal_review_at: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => ({
      charge_refund_id: r.id,
      purchase_id: r.purchase_id,
      stripe_refund_id: r.stripe_refund_id,
      amount_cents: r.amount_cents,
      first_attempt_at: r.transfer_reversal_first_attempt_at?.toISOString() ?? null,
      review_at: (r.transfer_reversal_review_at as Date).toISOString(),
    }));
  }

  // B-641-7 operator reconciliation for a row in review. Stripe is the truth:
  //   - with stripe_transfer_reversal_id: record THAT reversal (it must be on
  //     this head-coach transfer and must not name another refund);
  //   - without: record the reversal Stripe holds for this refund
  //     (metadata tgp_charge_refund_id); if Stripe holds none and every
  //     reversal on the transfer is attributed, send ONE new reversal under a
  //     review-scoped key; if unattributed reversals exist, refuse and list
  //     them unless confirm_none_in_stripe is set.
  // The local record is claimed (transfer_reversed false -> true), so two
  // owners reconciling at once record it once.
  async reconcileTransferReversal(
    chargeRefundId: string,
    args: { stripe_transfer_reversal_id?: string; confirm_none_in_stripe?: boolean } = {},
  ): Promise<{
    charge_refund_id: string;
    outcome: 'recorded_from_stripe' | 'reversed' | 'nothing_owed' | 'already_recorded';
    stripe_transfer_reversal_id: string | null;
    amount_cents: number;
  }> {
    const row = await this.prisma.chargeRefund.findUnique({ where: { id: chargeRefundId } });
    if (!row) {
      throw new NotFoundException({
        code: 'REFUND_NOT_FOUND',
        error: 'REFUND_NOT_FOUND',
        message: 'No refund with this id. Check the id in the review list.',
      });
    }
    if (row.transfer_reversed) {
      throw new ConflictException({
        code: 'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED',
        error: 'REFUND_TRANSFER_REVERSAL_ALREADY_RECORDED',
        message: "This refund's head-coach reversal is already recorded. Nothing to do.",
      });
    }
    if (!row.transfer_reversal_review_at) {
      throw new ConflictException({
        code: 'REFUND_TRANSFER_REVERSAL_NOT_IN_REVIEW',
        error: 'REFUND_TRANSFER_REVERSAL_NOT_IN_REVIEW',
        message:
          'This refund is still inside the automatic retry window. The retry sweep owns it; reconcile only rows in the review list.',
      });
    }
    // B-674-15: an operation already written for this refund (sent, review or
    // found) is finished (Stripe's list by key, never a second send) and recorded
    // first, whatever the transfer has left. A receipt another refund holds is its.
    const key = refundTransferReversalKey(row.id);
    const own = await this.prisma.transferReversalOp.findMany({
      where: {
        OR: [{ idempotency_key: key }, { idempotency_key: { startsWith: `${key}-` } }],
        status: { in: ['pending', 'succeeded'] },
      },
      orderBy: { seq: 'asc' },
    });
    for (const prior of own) {
      const receipt = prior.stripe_reversal_id;
      const holder = { transfer_reversal_stripe_id: receipt, NOT: { id: row.id } };
      if (receipt && (await this.prisma.chargeRefund.findFirst({ where: holder }))) continue;
      const res = await this.reconcileStep(() =>
        this.transfers.reverse({
          transfer_row_id: prior.transfer_id,
          amount_cents: prior.amount_cents,
          idempotency_key: prior.idempotency_key,
          purpose: 'legacy',
        }),
      );
      return this.recordReconciled(row, res, 'recorded_from_stripe');
    }
    const owed = await this.owedHeadCoachReversal(row.purchase_id, row.amount_cents);
    if (!owed) {
      await this.markTransferReversalDone(this.prisma, row.id);
      return {
        charge_refund_id: row.id,
        outcome: 'nothing_owed',
        stripe_transfer_reversal_id: null,
        amount_cents: 0,
      };
    }
    const stripeTransferId = owed.transfer.stripe_transfer_id;
    if (!stripeTransferId) {
      throw new ConflictException({
        code: 'TRANSFER_NOT_IN_STRIPE',
        error: 'TRANSFER_NOT_IN_STRIPE',
        message:
          'The head-coach transfer has no Stripe id, so there is nothing to reverse in Stripe.',
      });
    }
    const reversals = await this.listAllTransferReversals(stripeTransferId);
    let match: { id: string; amount: number } | undefined;
    if (args.stripe_transfer_reversal_id) {
      const named = reversals.find((r) => r.id === args.stripe_transfer_reversal_id);
      if (!named) {
        throw new UnprocessableEntityException({
          code: 'TRANSFER_REVERSAL_NOT_FOUND',
          error: 'TRANSFER_REVERSAL_NOT_FOUND',
          message:
            "Stripe has no reversal with this id on this refund's head-coach transfer. Check the id in the Stripe Dashboard.",
        });
      }
      const event = reversalEvent(named);
      if (event && !(event.kind === 'refund' && event.id === row.id)) {
        throw new ConflictException({
          code: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND',
          error: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND',
          message:
            'That reversal was made for a different refund or a chargeback. Pick the reversal for ' +
            'this refund, or reconcile without an id.',
        });
      }
      match = named;
    } else {
      match = reversals.find((r) => {
        const event = reversalEvent(r);
        return event?.kind === 'refund' && event.id === row.id;
      });
      if (!match) {
        const unattributed = reversals.filter((r) => !reversalEvent(r));
        if (unattributed.length > 0 && !args.confirm_none_in_stripe) {
          throw new ConflictException({
            code: 'TRANSFER_REVERSAL_UNATTRIBUTED',
            error: 'TRANSFER_REVERSAL_UNATTRIBUTED',
            message:
              "Stripe holds reversals on this transfer that name no refund. If one is this refund's, send its id as stripe_transfer_reversal_id; if none is, send confirm_none_in_stripe: true.",
            unattributed: unattributed.map((r) => ({ id: r.id, amount_cents: r.amount })),
          });
        }
      }
    }
    if (match) {
      const receipt = match;
      // B-641-10 (Sol): a receipt smaller than this refund's share does not
      // settle it. Nothing is recorded and the row stays in review.
      if (receipt.amount < owed.amount_cents) {
        throw new ConflictException({
          code: 'TRANSFER_REVERSAL_UNDERSIZED',
          error: 'TRANSFER_REVERSAL_UNDERSIZED',
          message:
            "That reversal is smaller than this refund's head-coach share, so it does not settle it. Nothing was recorded; the refund stays in review.",
          reversal_amount_cents: receipt.amount,
          owed_cents: owed.amount_cents,
        });
      }
      // B-641-9 (Sol): one Stripe reversal settles at most one refund. The id
      // is bound to this refund in the same transaction that claims it (a
      // unique column), so a second refund, or a concurrent owner request for
      // another refund, is refused instead of counting the money twice.
      const bound = await this.prisma.chargeRefund.findFirst({
        where: { transfer_reversal_stripe_id: receipt.id, NOT: { id: row.id } },
      });
      if (bound) throw transferReversalAssignedElsewhere();
      // The found reversal is recorded as a completed operation (no Stripe
      // call), added once to the recorded total (stripe_reversal_id unique).
      const res = await this.reconcileStep(() =>
        this.transfers.recordFoundReversal({
          transfer_row_id: owed.transfer.id,
          stripe_reversal_id: receipt.id,
          amount_cents: receipt.amount,
          idempotency_key: `${key}-found-${receipt.id}`,
        }),
      );
      return this.recordReconciled(row, res, 'recorded_from_stripe', receipt.id);
    }
    // Stripe holds no reversal for this refund, so one new request under a
    // review-scoped key is safe; a second owner click finishes that same
    // operation (above) instead of sending again.
    const res = await this.reconcileStep(() =>
      this.transfers.reverse({
        transfer_row_id: owed.transfer.id,
        amount_cents: owed.amount_cents,
        idempotency_key: `${key}-review`,
        purpose: 'legacy',
      }),
    );
    return this.recordReconciled(row, res, 'reversed');
  }

  // Owner reconcile: an unknown Stripe outcome is a closed 503 (nothing was
  // sent twice or recorded; retry) and a refusal a closed 422.
  private async reconcileStep(step: () => Promise<ReverseOutcome>): Promise<ReverseOutcome> {
    let res: ReverseOutcome;
    try {
      res = await step();
    } catch (err) {
      if (!(err instanceof ReversalUncertainError)) throw err;
      throw new ServiceUnavailableException({
        code: 'TRANSFER_REVERSAL_UNCERTAIN',
        error: 'TRANSFER_REVERSAL_UNCERTAIN',
        message:
          'Stripe could not confirm this reversal yet, or another reversal of this transfer is still in progress, so nothing was sent again or recorded. Retry in a few minutes.',
      });
    }
    if (res.status !== 'succeeded') {
      throw new UnprocessableEntityException({
        code: 'TRANSFER_REVERSAL_REFUSED',
        error: 'TRANSFER_REVERSAL_REFUSED',
        message:
          "Stripe refused the head-coach reversal (for example, the head coach's Stripe balance is too low). Nothing was recorded; the refund stays in review.",
      });
    }
    return res;
  }

  // Claims the local record (one owner wins) and posts the head-coach slice.
  private async recordReconciled(
    row: ChargeRefund,
    res: ReverseOutcome,
    outcome: 'recorded_from_stripe' | 'reversed',
    receiptId?: string,
  ): Promise<{
    charge_refund_id: string;
    outcome: 'recorded_from_stripe' | 'reversed' | 'nothing_owed' | 'already_recorded';
    stripe_transfer_reversal_id: string | null;
    amount_cents: number;
  }> {
    const op = res.op_id
      ? await this.prisma.transferReversalOp.findUnique({ where: { id: res.op_id } })
      : null;
    const stripeId = receiptId ?? op?.stripe_reversal_id ?? undefined;
    let claimed = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        claimed = await this.markTransferReversalDone(tx, row.id, stripeId);
        if (claimed && op && res.transfer.ledger_entry_id) {
          await this.ledger.postReversalSource(
            {
              entry_id: res.transfer.ledger_entry_id,
              source: { kind: 'refund', id: row.id, at: new Date() },
              cents: op.amount_cents,
            },
            tx,
          );
        }
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') {
        throw transferReversalAssignedElsewhere();
      }
      throw err;
    }
    return {
      charge_refund_id: row.id,
      outcome: claimed ? outcome : 'already_recorded',
      stripe_transfer_reversal_id: stripeId ?? null,
      amount_cents: op?.amount_cents ?? 0,
    };
  }

  // B-674-14: an attempt was stamped but no reversal operation exists (a stop
  // between the stamp and the operation, or a reversal sent before
  // operations existed). A new send is admitted only after Stripe's COMPLETE
  // list shows none for this event; one Stripe holds is recorded instead
  // (no send). An incomplete list throws a closed 503 code: still owed.
  private async reversalStripeHolds(
    transfer: ConnectTransfer,
    event: { kind: 'refund' | 'dispute'; id: string },
    key: string,
  ): Promise<ReverseOutcome | null> {
    if (!transfer.stripe_transfer_id) return null;
    const reversals = await this.listAllTransferReversals(transfer.stripe_transfer_id);
    const held = reversals.find((r) => {
      const e = reversalEvent(r);
      return e?.kind === event.kind && e.id === event.id;
    });
    if (!held) return null;
    return this.transfers.recordFoundReversal({
      transfer_row_id: transfer.id,
      stripe_reversal_id: held.id,
      amount_cents: held.amount,
      idempotency_key: key,
    });
  }

  private async listAllTransferReversals(
    stripeTransferId: string,
  ): Promise<Array<{ id: string; amount: number; metadata?: Record<string, string> | null }>> {
    const out: Array<{ id: string; amount: number; metadata?: Record<string, string> | null }> = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.stripe.listTransferReversals(stripeTransferId, {
        limit: 100,
        starting_after: startingAfter,
      });
      // B-674-14: complete only at has_more=false; a page that says has_more
      // but adds no new reversal is incomplete and never proves absence.
      const fresh = res.data.filter((r) => !out.some((o) => o.id === r.id));
      out.push(...fresh);
      if (res.has_more === false) return out;
      if (fresh.length === 0) {
        throw new ServiceUnavailableException({
          code: 'TRANSFER_REVERSALS_LIST_INCOMPLETE',
          error: 'TRANSFER_REVERSALS_LIST_INCOMPLETE',
          message:
            'Stripe returned an incomplete list of reversals for this transfer, so nothing was sent or recorded. Retry in a few minutes.',
        });
      }
      startingAfter = fresh[fresh.length - 1].id;
    }
    throw new ServiceUnavailableException({
      code: 'TRANSFER_REVERSALS_TOO_MANY',
      error: 'TRANSFER_REVERSALS_TOO_MANY',
      message:
        'This transfer has more than 1,000 reversals in Stripe. Reconcile it in the Stripe Dashboard and record it with stripe_transfer_reversal_id.',
    });
  }


  // A276 P0-2 (refix) — single source of truth for the post-conversion
  // refund COACH_ALERT envelope. Pulled out so both the webhook path
  // (upsertAndApplyRefund) and any future admin-initiated refund path
  // emit the same shape. Idempotency is enforced by the caller (only
  // called once per ChargeRefund.ledger_reversed transition).
  private async emitRefundCoachAlert(args: {
    purchase: ClientPurchase;
    amount_cents: number;
    stripe_refund_id: string;
    stripe_charge_id: string;
    reason: string | null;
  }): Promise<void> {
    try {
      // OR-111-1: a settlement charge's refund already has an exact-amount
      // payout notice (what the client got back, what came back from that
      // sale's payout, what is held from the next sale). Deliver it and skip
      // this generic line so the coach gets one alert, with the real numbers.
      // Delivery itself runs after the webhook commits (handle() and
      // deliverPayoutNotices, C-627-7); this only checks that one exists.
      if (this.payoutNotices && (await this.payoutNotices.hasNotices(args.stripe_charge_id))) {
        return;
      }
      // Determine whether this refund is full (purchase fully refunded)
      // or partial — affects the message body and entitlement_revoked
      // payload field. We re-read the purchase rather than relying on
      // the in-memory copy because applyLedgerReversal + the
      // fullyRefunded purchase.update may have transitioned its status.
      const fresh = await this.prisma.clientPurchase.findUnique({
        where: { id: args.purchase.id },
      });
      const isFullRefund = !!fresh && fresh.status === 'refunded' && !fresh.entitlement_active;
      const dollars = (args.amount_cents / 100).toFixed(2);
      const body = isFullRefund
        ? `Refund processed: $${dollars} returned to client.`
        : `Partial refund: $${dollars} returned to client.`;
      await this.notifications.createNotification({
        user_id: args.purchase.coach_user_id,
        kind: NotificationKind.COACH_ALERT,
        body,
        payload: {
          event: 'refund_processed',
          purchase_id: args.purchase.id,
          stripe_refund_id: args.stripe_refund_id,
          stripe_charge_id: args.stripe_charge_id,
          amount_refunded_cents: args.amount_cents,
          amount_cents: args.purchase.amount_cents,
          fully_refunded: isFullRefund,
          entitlement_revoked: isFullRefund,
          reason: args.reason,
        },
        deep_link: COACH_REFUND_DEEP_LINK,
        channel: 'inapp',
      });
    } catch (err) {
      // Coach alert is a downstream signal; the refund itself has
      // already committed. We log with PII-safe context (refund id,
      // charge id, coach id) so ops can replay the alert manually.
      this.logger.warn(
        `coach refund notification failed refund=${args.stripe_refund_id} charge=${args.stripe_charge_id} coach=${args.purchase.coach_user_id}: ${(err as Error).message}`,
      );
    }
  }

  // Reverses the destination + application_fee ledger slices
  // proportionally to the refund amount.
  // S-FEE — route a refund on a separate-charge-and-transfer charge through
  // the settlement (cumulative succeeded refunds on the charge). Returns
  // false when the charge is a legacy destination charge (or unsettled
  // legacy wiring), so the caller runs the legacy reversal path.
  private async applySettlementRefund(
    purchase: ClientPurchase,
    chargeId: string,
  ): Promise<boolean> {
    if (!this.settlements) return false;
    const refunds = await this.prisma.chargeRefund.findMany({
      where: { stripe_charge_id: chargeId, status: 'succeeded' },
      select: { amount_cents: true },
    });
    const refundedCents = refunds.reduce((n, r) => n + r.amount_cents, 0);
    const outcome = await this.settlements.applyAdjustments({
      purchase,
      charge_id: chargeId,
      refunded_cents: refundedCents,
    });
    return outcome !== 'legacy' && outcome !== 'no_settlement';
  }

  // S-FEE — dispute position change on a separate-charge-and-transfer
  // charge. Stripe debits the platform for the disputed amount and the
  // dispute fee; the coach bears both (transfer reversal, then netting).
  // Returns false for a legacy destination charge.
  private async applySettlementDispute(
    purchase: ClientPurchase,
    chargeId: string,
    balanceTransactions: Array<{ amount?: number; fee?: number }> | undefined,
    disputeId?: string | null,
    noticeEvent: 'dispute_lost' | null = null,
  ): Promise<boolean> {
    if (!this.settlements || !balanceTransactions) return false;
    const outcome = await this.settlements.applyAdjustments({
      purchase,
      charge_id: chargeId,
      dispute: disputeAmountsFrom(balanceTransactions),
      // Read the dispute's current position under the charge lock, so an
      // older event processed late cannot undo a newer outcome.
      dispute_id: disputeId ?? null,
      notice_event: noticeEvent,
    });
    return outcome !== 'legacy' && outcome !== 'no_settlement';
  }

  private async applyLedgerReversal(
    purchaseId: string,
    refundAmountCents: number,
    chargeId?: string | null,
    db: Prisma.TransactionClient = this.prisma,
    source?: LedgerReversalSource,
  ): Promise<void> {
    // Legacy rows only: per-purchase slices (stripe_charge_id may be null)
    // or the slices of THIS charge. Never touch another charge's slices.
    const entries = (await this.ledger.findByPurchase(purchaseId, db)).filter(
      (e) => !chargeId || e.stripe_charge_id == null || e.stripe_charge_id === chargeId,
    );
    const purchase = await db.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) return;
    const ratio = refundAmountCents / Math.max(purchase.amount_cents, 1);
    for (const entry of entries) {
      if (entry.kind === 'destination' || entry.kind === 'application_fee') {
        const portion = Math.min(
          entry.amount_cents - entry.reversed_cents,
          Math.floor(entry.amount_cents * ratio),
        );
        if (portion > 0) {
          await this.ledger.applyReversal(
            {
              entry_id: entry.id,
              reversed_cents: portion,
              source,
            },
            db,
          );
        }
      }
    }
  }

  // B-674-5 / B-674-10: the head-coach share of ONE lost chargeback is
  // reversed once and recorded once. (Stripe's `reverse_transfer` covers the
  // destination; the head-coach split is a separate Transfer.) The amount is
  // stamped before the first Stripe call and every attempt replays it under
  // the dispute-scoped key. The transfer reversal operation records the
  // transfer's reversal once and, after a lost response (or a key Stripe
  // forgot after 24 hours), finds Stripe's reversal by that key before it
  // ever sends again; the record then claims transfer_reversed_at in the
  // transaction that writes the slice posting. `firstPassAt`: the close time
  // when reversed with the chargeback; null on a retry (posted when it happens).
  private async applyDisputeTransferReversalOnce(
    disputeRowId: string,
    firstPassAt: Date | null,
  ): Promise<RefundTransferReversalOutcome> {
    const row = await this.prisma.chargeDispute.findUnique({ where: { id: disputeRowId } });
    if (!row || row.transfer_reversed_at) return 'already_done';
    const retry = typeof row.transfer_reversal_amount_cents === 'number';
    if (!retry && !firstPassAt) return 'already_done';
    const key = disputeTransferReversalKey(row.id);
    // An operation under the key exists only after the amount was stamped.
    const prior = retry
      ? await this.prisma.transferReversalOp.findUnique({ where: { idempotency_key: key } })
      : null;
    let send: { transfer_row_id: string; amount_cents: number };
    let unproven: ConnectTransfer | null = null;
    if (prior) {
      send = { transfer_row_id: prior.transfer_id, amount_cents: prior.amount_cents };
    } else {
      const owed = await this.owedHeadCoachReversal(row.purchase_id, row.amount_cents);
      if (!owed || !owed.transfer.stripe_transfer_id) {
        await this.markDisputeTransferReversalDone(this.prisma, row.id);
        return 'nothing_owed';
      }
      await this.prisma.chargeDispute.updateMany({
        where: { id: row.id, transfer_reversal_amount_cents: null },
        data: {
          transfer_reversal_amount_cents: owed.amount_cents,
          transfer_reversal_first_attempt_at: new Date(),
        },
      });
      const stamped = await this.prisma.chargeDispute.findUnique({ where: { id: row.id } });
      if (!stamped || stamped.transfer_reversed_at) return 'already_done';
      send = {
        transfer_row_id: owed.transfer.id,
        amount_cents: stamped.transfer_reversal_amount_cents ?? owed.amount_cents,
      };
      if (retry) unproven = owed.transfer;
    }
    try {
      const res =
        (unproven && (await this.reversalStripeHolds(unproven, { kind: 'dispute', id: row.id }, key))) ||
        (await this.transfers.reverse({ ...send, idempotency_key: key, purpose: 'legacy' }));
      return await this.recordHeadCoachReversed(
        res,
        (tx, stripeId) => this.markDisputeTransferReversalDone(tx, row.id, stripeId),
        { kind: 'dispute', id: row.id, at: firstPassAt ?? new Date() },
        `purchase=${row.purchase_id} dispute=${row.id}`,
      );
    } catch (err) {
      // Ids and machine codes only (B-674-4): a Stripe message is free text.
      this.logger.warn(
        `head-coach transfer reverse pending purchase=${row.purchase_id} dispute=${row.id} ` +
          `code=${transferReversalErrorCode(err)}`,
      );
      return 'pending';
    }
  }

  private markDisputeTransferReversalDone(
    db: Prisma.TransactionClient,
    disputeRowId: string,
    stripeId?: string,
  ): Promise<boolean> {
    return db.chargeDispute
      .updateMany({
        where: { id: disputeRowId, transfer_reversed_at: null },
        data: {
          transfer_reversed_at: new Date(),
          ...(stripeId ? { transfer_reversal_stripe_id: stripeId } : {}),
        },
      })
      .then((r) => r.count === 1);
  }


  // --- Dispute pipeline ---

  private async onDisputeOpened(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    return this.upsertDispute(event, /*initial=*/ true);
  }

  private async onDisputeUpdated(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    return this.upsertDispute(event, /*initial=*/ false);
  }

  private async onDisputeClosed(
    event: {
      data: { object: Record<string, unknown> };
    },
    _outerTx?: WebhookTx,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    // PR-16: see onChargeRefunded — _outerTx is accepted for symmetry
    // but the dispute path's entitlement flip already executes on
    // this.prisma directly (not through the outer billing tx, because
    // applyHeadCoachReversal issues Stripe HTTP). We open a small inner
    // tx for the entitlement-flip + cancel pair so the two writes
    // commit-or-rollback together.
    const dispute = event.data.object as {
      id?: string;
      charge?: string | null;
      status?: string;
      amount?: number;
      balance_transactions?: Array<{ id: string; amount?: number; fee?: number }>;
    };
    if (!dispute?.id) return { claimed: false };
    const existing = await this.prisma.chargeDispute.findUnique({
      where: { stripe_dispute_id: dispute.id },
    });
    if (!existing) return { claimed: false };
    // B-674-12: the first close is elected by the database (closed_at IS NULL
    // in the UPDATE itself), so overlapping deliveries keep one instant; any
    // other delivery writes status only and reads the elected instant back.
    // Absent fields stay as stored (no write-back from a stale snapshot).
    const fields = {
      status: dispute.status ?? undefined,
      balance_transaction_id: dispute.balance_transactions?.[0]?.id ?? undefined,
    };
    const updated = await this.prisma.chargeDispute
      .update({
        where: { stripe_dispute_id: dispute.id, closed_at: null },
        data: { ...fields, closed_at: new Date() },
      })
      .catch((err: unknown) => {
        if ((err as { code?: unknown })?.code !== 'P2025') throw err;
        return this.prisma.chargeDispute.update({
          where: { stripe_dispute_id: dispute.id },
          data: fields,
        });
      });
    // S-FEE — converge the settlement to the dispute's final position (won:
    // principal reinstated, the coach is paid back less any fee Stripe kept;
    // lost: the withdrawal stands). Entitlement handling below is unchanged.
    let settlementHandled = false;
    if (dispute.charge) {
      const disputePurchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      if (disputePurchase) {
        settlementHandled = await this.applySettlementDispute(
          disputePurchase,
          dispute.charge,
          dispute.balance_transactions,
          dispute.id,
          dispute.status === 'lost' ? 'dispute_lost' : null,
        );
      }
    }
    // On a `lost` outcome, reverse the destination + application_fee
    // ledger slices and reverse any head-coach transfer (legacy charges;
    // a settlement-backed charge was already recovered above).
    if (dispute.status === 'lost') {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      const firstPass = !updated.ledger_reversed;
      if (purchase && !settlementHandled) {
        // B-676-1: the chargeback posts its own cents per slice, once.
        const disputeSource: LedgerReversalSource = {
          kind: 'dispute',
          id: updated.id,
          at: updated.closed_at ?? new Date(),
        };
        if (firstPass) {
          await this.prisma.$transaction((tx) =>
            this.applyLedgerReversal(
              purchase.id,
              updated.amount_cents,
              dispute.charge ?? updated.stripe_charge_id,
              tx,
              disputeSource,
            ),
          );
        }
        // B-674-5: once per dispute; a redelivery retries one still owed.
        const at = firstPass ? disputeSource.at : null;
        await this.applyDisputeTransferReversalOnce(updated.id, at);
      }
      if (purchase && firstPass) {
        // PR-16 — entitlement flip + drop-cancel commit atomically.
        // The Stripe-HTTP-ridden ledger / transfer reversals above
        // intentionally run outside this tx (P1-3 anti-pattern). The
        // ChargeDispute.ledger_reversed flag gates the books and the
        // entitlement; the transfer reversal has its own once-only claim.
        await this.prisma.$transaction(async (tx) => {
          await tx.chargeDispute.update({
            where: { id: updated.id },
            data: { ledger_reversed: true },
          });
          await tx.clientPurchase.update({
            where: { id: purchase.id },
            data: { status: 'chargeback_lost', entitlement_active: false },
          });
          if (this.fanout) {
            await this.fanout.cancelPendingForPurchase(purchase.id, 'dispute', tx);
          }
        });
      }
    } else if (dispute.status === 'won') {
      // Clear the disputed flag so the purchase rejoins the normal feed.
      // C-680-19 (R-DISPUTE-PAUSE): a recurring plan whose access the dispute
      // ended stays revoked when the dispute is won; only the coach restart
      // grants access again (`paid` without access would read as not ended).
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      const pausedPlan = purchase?.billing_type === 'recurring' && !purchase.entitlement_active;
      if (purchase && purchase.status === 'disputed' && !pausedPlan) {
        await this.prisma.clientPurchase.update({
          where: { id: purchase.id },
          data: { status: 'paid' },
        });
      }
    }
    return { claimed: true, purchase_id: updated.purchase_id };
  }

  private async upsertDispute(
    event: { data: { object: Record<string, unknown> } },
    initial: boolean,
  ): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const dispute = event.data.object as {
      id?: string;
      charge?: string | null;
      status?: string;
      amount?: number;
      currency?: string;
      reason?: string;
      evidence_details?: { due_by?: number; submission_count?: number };
      balance_transactions?: Array<{ id?: string; amount?: number; fee?: number }>;
    };
    if (!dispute?.id || !dispute.charge) return { claimed: false };
    const purchase = await this.resolvePurchaseByCharge(dispute.charge);
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };
    const dueBy =
      typeof dispute.evidence_details?.due_by === 'number'
        ? new Date(dispute.evidence_details.due_by * 1000)
        : null;
    // A276 P0-2 / P1-1 (refix) — detect the first observation of this
    // dispute id so we emit the coach alert EXACTLY ONCE under Stripe
    // redelivery.
    //
    // A276-F2-P2-2 (refix) — the previous implementation read
    // `findUnique` and then called `upsert`. Two concurrent webhook
    // deliveries (e.g. `charge.dispute.created` and `charge.dispute.
    // updated` for the same dispute_id, or two replicas processing the
    // same Stripe redelivery in parallel) could BOTH observe
    // `existingDispute=null` between the read and the create, then both
    // emit COACH_ALERT — the coach gets two pings for one dispute.
    //
    // Fix: rely on the DB-level unique index on `stripe_dispute_id`
    // (see prisma/schema.prisma `ChargeDispute.stripe_dispute_id @unique`).
    // Attempt `create` first; on P2002 (unique-violation) we KNOW a
    // concurrent or prior delivery has already inserted the row, so
    // this delivery is NOT the first observation and we fall through
    // to the update branch without firing the alert. The `create`
    // success path is the one-and-only first-observation signal.
    //
    // A276-F2-P2-3 — the dispute row insert and the ClientPurchase
    // status flip to 'disputed' (when this is the first observation of
    // an `initial=true` event) MUST commit atomically. The previous
    // implementation issued both writes on `this.prisma` so a crash
    // between them could leave a ChargeDispute row without the
    // matching ClientPurchase.status='disputed' until Stripe retried.
    // We wrap the first-observation branch in a single `$transaction`.
    // On the race-loser branch (P2002) the in-tx create rolls back
    // (no orphan write) and we apply the update outside the tx.
    // Capture narrowed values for the closure (TS does not preserve
    // the early-return narrowing across the $transaction lambda).
    const disputeId: string = dispute.id;
    const chargeId: string = dispute.charge;
    let isFirstObservation: boolean;
    let row: ChargeDispute;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.chargeDispute.create({
          data: {
            purchase_id: purchase.id,
            stripe_dispute_id: disputeId,
            stripe_charge_id: chargeId,
            amount_cents: typeof dispute.amount === 'number' ? dispute.amount : 0,
            currency: dispute.currency ?? 'usd',
            status: dispute.status ?? 'needs_response',
            reason: dispute.reason ?? null,
            evidence_due_by: dueBy,
          },
        });
        if (initial) {
          // Mirror the purchase status to 'disputed' in the same tx so
          // a reader who sees the dispute row also sees the purchase
          // marked disputed. WHERE-guarded so re-deliveries are
          // no-ops (and so an already-refunded purchase isn't dragged
          // back to 'disputed' by a stale event).
          await tx.clientPurchase.updateMany({
            where: {
              id: purchase.id,
              status: { notIn: ['disputed', 'refunded'] },
            },
            data: { status: 'disputed' },
          });
        }
        return created;
      });
      isFirstObservation = true;
    } catch (err) {
      // Prisma raises P2002 on a unique-constraint violation. Anything
      // else (e.g. connection error) we propagate so Stripe retries.
      if (!err || typeof err !== 'object' || (err as { code?: string }).code !== 'P2002') {
        throw err;
      }
      // Race lost — another delivery wrote first. The in-tx create
      // rolled back automatically. Update the dispute row in-place and
      // skip the alert.
      //
      // A279-P2-A — ALSO mirror ClientPurchase.status='disputed' here
      // when `initial` is true. Out-of-order Stripe delivery
      // (`charge.dispute.updated` arriving BEFORE `charge.dispute.created`)
      // means the winning row may have been inserted by the `updated`
      // delivery (which sets `initial=false` upstream) and so never
      // mirrored the purchase status. When the `created` event later
      // hits P2002 here, `initial=true` is the only signal we have that
      // the purchase should be flipped to 'disputed'. The pre-031f57ca
      // code mirrored unconditionally after the upsert; 031f57ca moved
      // it into the create-success branch and silently lost this path.
      //
      // Wrap both writes in a single `$transaction` so a reader who
      // sees the dispute UPDATE also sees the purchase flip (same
      // atomicity guarantee the create branch already enforces).
      // The `notIn: ['disputed', 'refunded']` guard keeps the write
      // idempotent and preserves the "don't drag an already-refunded
      // purchase back to disputed" invariant.
      row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.chargeDispute.update({
          where: { stripe_dispute_id: disputeId },
          data: {
            status: dispute.status ?? 'needs_response',
            reason: dispute.reason ?? null,
            evidence_due_by: dueBy ?? undefined,
            amount_cents: typeof dispute.amount === 'number' ? dispute.amount : undefined,
          },
        });
        if (initial) {
          await tx.clientPurchase.updateMany({
            where: {
              id: purchase.id,
              status: { notIn: ['disputed', 'refunded'] },
            },
            data: { status: 'disputed' },
          });
        }
        return updated;
      });
      isFirstObservation = false;
    }

    // S-FEE — Stripe debited the platform for the disputed amount + fee
    // (dispute.balance_transactions). Recover it from the payees now, as
    // Stripe recommends on charge.dispute.created ("recover funds from the
    // connected account by reversing the transfer"). Idempotent per dispute
    // position; a legacy destination charge is left to the legacy path.
    // Round 4 (B-627-4): no adjustment failure is swallowed. Lock busy / lost,
    // an unreadable canonical dispute or an unknown reversal outcome (and any
    // other error) fail the delivery so Stripe redelivers it; the settlement
    // is also flagged for the sweeper. The coach alert below still goes out
    // first, because a redelivery is no longer the first observation.
    let adjustmentError: unknown = null;
    try {
      await this.applySettlementDispute(
        purchase,
        dispute.charge,
        dispute.balance_transactions,
        dispute.id,
      );
    } catch (err) {
      adjustmentError = err;
      const level = isRetryableMoneyError(err) ? 'warn' : 'error';
      this.logger[level](
        `dispute settlement adjustment failed dispute=${dispute.id} charge=${dispute.charge}` +
          `${level === 'error' ? ' alert=true' : ''}: ${settlementFailureCode(err)}; the delivery is retried`,
      );
    }

    // A276 P1-1 (refix) — emit COACH_ALERT on the FIRST observation of
    // this dispute id. We deliberately key on "is this row new" rather
    // than `initial` alone: a `charge.dispute.updated` arriving before
    // we've ever seen `charge.dispute.created` (because the created
    // event was dropped or arrived out of order) still needs to alert
    // the coach so they don't miss the 7-day evidence window.
    //
    // A276-F2-P2-2 — `isFirstObservation` is the row-count signal from
    // the create-or-conflict pattern above: true iff THIS process won
    // the DB-level race to insert this stripe_dispute_id. Parallel
    // deliveries see the conflict and skip the alert. The DB unique
    // index is the serialisation point.
    //
    // Notifier failures are caught; the dispute row has already
    // committed and we never roll it back on a downstream-signal failure.
    if (isFirstObservation) {
      try {
        const evidenceDueByISO = dueBy ? dueBy.toISOString() : null;
        // Trim the dispute reason the same way the guest-checkout
        // handler does (500 chars; matches the schema's VarChar).
        const safeReason = (dispute.reason ?? '').slice(0, 500) || null;
        await this.notifications.createNotification({
          user_id: purchase.coach_user_id,
          kind: NotificationKind.COACH_ALERT,
          body: 'Chargeback opened on a client purchase. Submit evidence in Stripe within 7 days.',
          payload: {
            event: 'dispute_opened',
            purchase_id: purchase.id,
            stripe_dispute_id: dispute.id,
            stripe_charge_id: dispute.charge,
            reason: safeReason,
            amount_cents: row.amount_cents,
            evidence_due_by: evidenceDueByISO,
          },
          deep_link: COACH_DISPUTE_DEEP_LINK,
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `coach dispute notification failed dispute=${dispute.id} charge=${dispute.charge} coach=${purchase.coach_user_id}: ${(err as Error).message}`,
        );
      }
    }

    if (adjustmentError) throw adjustmentError;
    return { claimed: true, purchase_id: row.purchase_id };
  }

  // --- Transfer reversed ---

  private async onTransferReversed(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const transfer = event.data.object as {
      id?: string;
      amount_reversed?: number;
      reversed?: boolean;
      metadata?: Record<string, string>;
    };
    if (!transfer?.id) return { claimed: false };
    const row = await this.prisma.connectTransfer.findFirst({
      where: { stripe_transfer_id: transfer.id },
    });
    if (!row) return { claimed: false };
    const settlement =
      row.settlement_id && this.settlements
        ? await this.prisma.chargeSettlement.findUnique({ where: { id: row.settlement_id } })
        : null;
    // Absolute sync from Stripe's cumulative amount_reversed; never lowers
    // what we already recorded (an older event can arrive late).
    const sync = async () => {
      const fresh = await this.prisma.connectTransfer.findUniqueOrThrow({ where: { id: row.id } });
      const reversed =
        typeof transfer.amount_reversed === 'number'
          ? Math.min(
              fresh.amount_cents,
              Math.max(fresh.reversed_amount_cents, transfer.amount_reversed),
            )
          : fresh.reversed_amount_cents;
      const fullyReversed = !!transfer.reversed || reversed >= fresh.amount_cents;
      await this.prisma.connectTransfer.update({
        where: { id: row.id },
        data: {
          reversed_amount_cents: reversed,
          status: fullyReversed ? 'reversed' : fresh.status,
          reversed_at: fullyReversed ? (fresh.reversed_at ?? new Date()) : fresh.reversed_at,
        },
      });
    };
    if (!row.settlement_id) {
      // B-674-3 (B-CM1-116): one writer per number. A legacy head-coach
      // transfer's reversed total is written only by its reversal operations
      // (each bound to one refund or chargeback claim, or an owner-reconciled
      // receipt). This webhook only observes: a Stripe total above the
      // recorded one is logged (ids and cents); the owed refund keeps
      // retrying under its key, or is reconciled from review.
      const stripeCents = transfer.amount_reversed;
      if (
        typeof stripeCents === 'number' &&
        Number.isInteger(stripeCents) &&
        stripeCents > row.reversed_amount_cents
      ) {
        // B-674-5: a refund or chargeback of this sale that still owes its
        // reversal records it (sweep / redelivery / review). Nothing owed means
        // Stripe moved money no event explains: alert (ids and cents only).
        const owed =
          (await this.prisma.chargeRefund.count({
            where: { purchase_id: row.purchase_id, ledger_reversed: true, transfer_reversed: false },
          })) +
          (await this.prisma.chargeDispute.count({
            where: { purchase_id: row.purchase_id, ...DISPUTE_TRANSFER_OWED },
          }));
        const code =
          owed > 0 ? 'TRANSFER_REVERSAL_NOT_YET_RECORDED' : TRANSFER_REVERSAL_UNATTRIBUTED_CODE;
        this.logger.warn(
          `transfer reversal not yet recorded transfer=${row.id} purchase=${row.purchase_id} stripe_cents=${stripeCents} recorded_cents=${row.reversed_amount_cents} code=${code}`,
        );
        if (owed === 0) {
          Sentry.captureMessage('head-coach transfer reversal not attributed', {
            level: 'error',
            fingerprint: ['transfer-reversal-unattributed', row.id],
            tags: { code },
            extra: {
              connect_transfer_id: row.id,
              purchase_id: row.purchase_id,
              stripe_reversed_cents: stripeCents,
              recorded_reversed_cents: row.reversed_amount_cents,
              runbook: REFUND_TRANSFER_REVERSAL_RUNBOOK,
            },
          });
        }
      }
      return { claimed: true, purchase_id: row.purchase_id };
    }
    if (!settlement || !this.settlements) {
      await sync();
      return { claimed: true, purchase_id: row.purchase_id };
    }
    // Round 4 (B-627-5): a settlement transfer's reversal is synced and the
    // charge re-converged under the charge's lock, so a reversal Stripe
    // applied while our receipt was lost corrects the payee's position (and
    // any recovery opened for it) without waiting for another adjustment.
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: settlement.purchase_id },
    });
    await this.settlements.withChargeLock(settlement.stripe_charge_id, async () => {
      await sync();
      if (purchase) {
        await this.settlements!.applyAdjustments({
          purchase,
          charge_id: settlement.stripe_charge_id,
        });
      }
    });
    return { claimed: true, purchase_id: row.purchase_id };
  }

  // --- Payouts ---

  private async onPayoutEvent(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string }> {
    const payout = event.data.object as {
      id?: string;
      amount?: number;
      arrival_date?: number;
      failure_message?: string | null;
      account?: string | null; // connected account id (on Connect webhook)
    };
    if (!payout?.id) return { claimed: false };
    const accountId = payout.account;
    if (!accountId) {
      // Payouts from the platform account, not a connected coach — ignore.
      return { claimed: false, reason: 'platform_payout' };
    }
    const status = (event.type.split('.').pop() ?? 'paid') as string;
    await this.payoutReadiness.recordPayoutEvent({
      stripe_account_id: accountId,
      payout_id: payout.id,
      amount_cents: typeof payout.amount === 'number' ? payout.amount : 0,
      status,
      arrival_at:
        typeof payout.arrival_date === 'number' ? new Date(payout.arrival_date * 1000) : null,
      failure_message: payout.failure_message ?? null,
    });
    return { claimed: true };
  }

  // --- Helpers ---

  // Resolve a ClientPurchase from a Stripe charge id by walking the
  // SplitLedgerEntry table (which we populate at charge time with
  // stripe_charge_id).
  private async resolvePurchaseByCharge(chargeId: string): Promise<ClientPurchase | null> {
    // S-FEE: every settled charge (incl. renewals) has a settlement row.
    const settledPurchaseId = await this.settlements?.purchaseIdForCharge(chargeId);
    if (settledPurchaseId) {
      return this.prisma.clientPurchase.findUnique({
        where: { id: settledPurchaseId },
      });
    }
    const entry = await this.prisma.splitLedgerEntry.findFirst({
      where: { stripe_charge_id: chargeId, kind: 'destination' },
    });
    if (entry) {
      return this.prisma.clientPurchase.findUnique({
        where: { id: entry.purchase_id },
      });
    }
    // Fallback — pull the PI off the Charge and match on stripe_payment_intent_id.
    try {
      const charge = await this.stripe.retrieveCharge(chargeId);
      const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (!piId) return null;
      return this.prisma.clientPurchase.findFirst({
        where: { stripe_payment_intent_id: piId },
      });
    } catch (err) {
      if (err instanceof StripeConnectApiError) {
        this.logger.warn(
          `resolvePurchaseByCharge: Stripe retrieve charge=${chargeId} failed: ${err.message}`,
        );
      }
      return null;
    }
  }

  // --- Admin entry point — POST a refund via our backend ---

  // Issues a refund against a purchase's underlying charge. Handles the
  // ledger + head-coach reversal as part of the same call so the admin
  // gets a consistent response.
  async createAdminRefund(args: {
    purchase_id: string;
    amount_cents?: number; // omit = full
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    note?: string | null;
    initiated_by_user_id: string;
  }): Promise<ChargeRefund> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: args.purchase_id },
    });
    if (!purchase) {
      throw new Error(`createAdminRefund: no purchase ${args.purchase_id}`);
    }
    // C01 — a $0 grant has no charge; refunding it is a category error.
    if (purchase.source) {
      throw new BadRequestException({
        error: 'GRANT_NOT_REFUNDABLE',
        message:
          'This entitlement is a $0 grant, not a purchase; use POST /v1/entitlements/grants/revoke',
      });
    }
    // Resolve the underlying charge id. For one_time prefer the saved PI;
    // for recurring use the most recent destination ledger slice.
    const chargeId = await this.resolveChargeIdForPurchase(purchase);
    if (!chargeId) {
      throw new Error(`createAdminRefund: no charge id for purchase ${purchase.id}`);
    }
    const idempotencyKey = `tgp-refund-${purchase.id}-${args.amount_cents ?? 'full'}-${args.initiated_by_user_id}`;
    // S-FEE: reverse_transfer / refund_application_fee only exist for
    // destination charges. A separate-charge-and-transfer charge is
    // recovered by ChargeSettlementService when the refund is applied.
    // Decided from the Stripe charge itself, so a not-yet-settled charge is
    // classified correctly too.
    const legacyDestination = this.settlements
      ? isLegacyDestinationCharge(await this.stripe.retrieveCharge(chargeId))
      : true;
    const stripe = await this.stripe.createRefund({
      charge_id: chargeId,
      amount: args.amount_cents,
      reason: args.reason,
      reverse_transfer: legacyDestination,
      refund_application_fee: legacyDestination,
      metadata: {
        tgp_purchase_id: purchase.id,
        tgp_initiated_by: args.initiated_by_user_id,
      },
      idempotencyKey,
    });
    const refundInput = {
      purchase,
      stripe_refund_id: stripe.id,
      stripe_charge_id: chargeId,
      amount_cents:
        typeof stripe.amount === 'number'
          ? stripe.amount
          : (args.amount_cents ?? purchase.amount_cents),
      status: stripe.status ?? 'pending',
      reason: args.reason ?? null,
      note: args.note ?? null,
      initiated_by_user_id: args.initiated_by_user_id,
    };
    let outcome: { row: ChargeRefund; ledger_just_reversed: boolean };
    try {
      outcome = await this.upsertAndApplyRefund(refundInput);
    } catch (err) {
      // The refund exists at Stripe and its ChargeRefund row is written; the
      // payout adjustment is applied by whoever holds the charge lock (it
      // re-reads the refunds) or by the charge.refunded webhook.
      if (!isRetryableMoneyError(err)) throw err;
      this.logger.warn(
        `admin refund recorded; payout adjustment deferred to the charge.refunded webhook refund=${stripe.id} charge=${chargeId}: ${settlementFailureCode(err)}`,
      );
      const recorded = await this.prisma.chargeRefund.findUnique({
        where: { stripe_refund_id: stripe.id },
      });
      if (!recorded) throw err;
      return recorded;
    }
    // A276 P0-2 (refix) — admin-initiated refund: re-read the purchase
    // (admin path doesn't go through the webhook's purchase.update
    // branch, so we use the row state at call time) and emit the same
    // COACH_ALERT shape. Gated on ledger_just_reversed so a re-issued
    // admin refund (same idempotency key, same amount) doesn't double-
    // notify.
    if (outcome.ledger_just_reversed) {
      const amount_cents =
        typeof stripe.amount === 'number'
          ? stripe.amount
          : (args.amount_cents ?? purchase.amount_cents);
      // Admin refund implicitly fully refunds when amount matches the
      // purchase amount. Mirror the webhook's purchase-state update so
      // emitRefundCoachAlert observes the correct status.
      if (amount_cents >= purchase.amount_cents) {
        await this.prisma.clientPurchase.update({
          where: { id: purchase.id },
          data: { status: 'refunded', entitlement_active: false },
        });
      }
      await this.emitRefundCoachAlert({
        purchase,
        amount_cents,
        stripe_refund_id: stripe.id,
        stripe_charge_id: chargeId,
        reason: args.reason ?? null,
      });
    }
    return outcome.row;
  }

  private async resolveChargeIdForPurchase(purchase: ClientPurchase): Promise<string | null> {
    if (purchase.stripe_payment_intent_id) {
      try {
        const pi = await this.stripe.retrievePaymentIntent(purchase.stripe_payment_intent_id);
        const latest = typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
        if (latest) return latest;
      } catch (err) {
        this.logger.warn(`retrievePaymentIntent failed: ${settlementFailureCode(err)}`);
      }
    }
    const latestSettled = await this.settlements?.latestChargeIdForPurchase(purchase.id);
    if (latestSettled) return latestSettled;
    const entry = await this.prisma.splitLedgerEntry.findFirst({
      where: { purchase_id: purchase.id, kind: 'destination' },
      orderBy: { posted_at: 'desc' },
    });
    return entry?.stripe_charge_id ?? null;
  }

  // Admin entry — list refunds with filters.
  async listRefunds(opts: {
    status?: string;
    purchase_id?: string;
    limit?: number;
  }): Promise<ChargeRefund[]> {
    return this.prisma.chargeRefund.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.purchase_id ? { purchase_id: opts.purchase_id } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }

  async listDisputes(opts: {
    status?: string;
    purchase_id?: string;
    limit?: number;
  }): Promise<ChargeDispute[]> {
    return this.prisma.chargeDispute.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.purchase_id ? { purchase_id: opts.purchase_id } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 50, 200),
    });
  }
}
