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
import { PayoutReadinessService } from '../connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../connect/fees/transfer-orchestrator.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { NotificationsService } from '../notifications/notifications.service';
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
// Stripe keeps idempotency keys for 24 hours; retry well inside that.
export const REFUND_TRANSFER_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
// B-641-8: pages per sweep run (x limit rows), so one run is bounded.
export const REFUND_TRANSFER_SWEEP_MAX_PAGES = 20;
// Operator alert (Sentry tag) and runbook for a reversal still owed past the
// window. Machine code only; no free text reaches Sentry.
export const REFUND_TRANSFER_REVERSAL_REVIEW_CODE = 'REFUND_TRANSFER_REVERSAL_REVIEW';
export const REFUND_TRANSFER_REVERSAL_RUNBOOK = 'docs/runbooks/refund-transfer-reversal-review.md';
export type RefundTransferReversalOutcome =
  'reversed' | 'nothing_owed' | 'already_done' | 'pending' | 'needs_review';

// Machine code of a failed reversal attempt for logs (never the message).
function transferReversalErrorCode(err: unknown): string {
  if (err instanceof StripeConnectApiError) {
    return `stripe_${err.httpStatus}_${err.stripeCode ?? 'none'}`;
  }
  return err instanceof Error ? err.name : 'unknown';
}

// A276 P0-2 + P1-1 (refix) — deep-link routes for coach in-app alerts.
// Mirrors the guest-checkout path; mobile deep-link routing config owns
// the surface that these tgp:// URIs hit.
const COACH_REFUND_DEEP_LINK = 'tgp://coach/billing/refunds';
const COACH_DISPUTE_DEEP_LINK = 'tgp://coach/billing/disputes';

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
  async handle(event: {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  }, tx?: WebhookTx): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    switch (event.type) {
      case 'charge.refunded':
        return this.onChargeRefunded(event, tx);
      case 'charge.refund.updated':
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

  private async onChargeRefunded(event: {
    data: { object: Record<string, unknown> };
  }, _outerTx?: WebhookTx): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
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
      refunds?: { data?: Array<{ id?: string; amount?: number; status?: string; reason?: string | null }> };
    };
    if (!charge?.id) return { claimed: false, reason: 'no_charge_id' };
    const purchase = await this.resolvePurchaseByCharge(charge.id);
    if (!purchase) return { claimed: false, reason: 'no_matching_purchase' };

    // A276 P0-2 (refix) — track per-refund-id transitions so we emit
    // exactly one COACH_ALERT per refund.id even under Stripe redelivery.
    // upsertAndApplyRefund returns { ledger_just_reversed: boolean } so
    // we know which refund ids transitioned this delivery; redeliveries
    // see ledger_reversed already true and skip.
    const refunds = charge.refunds?.data ?? [];
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
    const totalAmount =
      typeof charge.amount === 'number' ? charge.amount : purchase.amount_cents;
    const refundedCents =
      typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
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
    if (fullyRefunded) {
      // A276-F2-P2-3 — the ClientPurchase status flip and the
      // GuestCheckout lockstep mirror MUST commit atomically. The
      // previous implementation issued both writes on `this.prisma`,
      // so a crash between the two could leave ClientPurchase='refunded'
      // / GuestCheckout='converted' until the Stripe retry converged
      // via the WHERE guards. The WHERE-guards still keep both writes
      // idempotent under Stripe redelivery; the transaction adds the
      // crash-safety the audit flagged as missing.
      //
      // We deliberately do NOT include the upstream ledger reversals
      // or the Stripe-side transfer reversal in this transaction
      // because those involve Stripe HTTP calls (transfers.reverse)
      // — the exact in-tx HTTP anti-pattern P1-3 / P2-1 eliminate.
      // The ledger writes have already committed on `this.prisma`
      // above and the WHERE-guards make every step idempotent on
      // Stripe retry.
      await this.prisma.$transaction(async (tx) => {
        // WHERE-guard on status keeps this idempotent under Stripe
        // redelivery (the second delivery sees status already 'refunded'
        // and the updateMany returns count=0 as a no-op).
        await tx.clientPurchase.updateMany({
          where: { id: purchase.id, status: { not: 'refunded' } },
          data: { status: 'refunded', entitlement_active: false },
        });

        // A276 P1-2 (refix) — keep the originating GuestCheckout row in
        // lockstep. After conversion the row's status is 'converted'; a
        // refund of the underlying charge must flip it to 'refunded' so
        // admin reports that filter `GuestCheckout WHERE status='refunded'`
        // surface the transaction. updateMany with a status guard makes
        // this idempotent under Stripe redelivery and a no-op when no
        // GuestCheckout exists (direct ClientPurchase paths). We never
        // re-stamp refunded_at here — the GuestCheckout-path handler
        // (handleChargeRefunded) owns that field's audit trail; in the
        // post-conversion case it stays null, which correctly reflects
        // "never refunded through the guest path".
        if (purchase.stripe_payment_intent_id) {
          await tx.guestCheckout.updateMany({
            where: {
              stripe_payment_intent_id: purchase.stripe_payment_intent_id,
              status: { not: 'refunded' },
            },
            data: { status: 'refunded' },
          });
        }

        // PR-16 — full-refund branch: cancel every not-yet-fired drop
        // for this purchase. Runs in the SAME inner $transaction as the
        // ClientPurchase.status='refunded' / entitlement_active=false
        // flip so revoke + drop-cancel commit-or-rollback together. The
        // WHERE clause inside cancelPendingForPurchase filters
        // status IN ('pending','due') so a Stripe redelivery (which hits
        // count=0 on the WHERE-guarded updateMany above) is a true
        // no-op for drops too.
        //
        // Partial refunds: the brief mandates we match the entitlement
        // rule. Per existing code (lines ~152-156), partial refund keeps
        // entitlement_active=true (`fullyRefunded` gate is total>=cents).
        // So drops are ONLY canceled when the refund is full. Partial
        // refund = client keeps the access they paid net-of-credit for,
        // and continues receiving dripped content. Documented.
        if (this.fanout) {
          await this.fanout.cancelPendingForPurchase(
            purchase.id,
            'refund',
            tx,
          );
        }
      });
    }

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

    return { claimed: true, purchase_id: purchase.id };
  }

  private async onRefundUpdated(event: {
    data: { object: Record<string, unknown> };
  }): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
    const refund = event.data.object as {
      id?: string;
      charge?: string | null;
      amount?: number;
      status?: string;
      failure_reason?: string | null;
    };
    if (!refund?.id) return { claimed: false };
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: refund.id },
    });
    if (!existing) {
      // No-op: we'll see the parent charge.refunded shortly.
      return { claimed: false, reason: 'no_known_refund' };
    }
    // B-641-6 (S-COACH-BE-4): a refund that was pending when charge.refunded
    // arrived completes through THIS event (Stripe does not resend
    // charge.refunded). Book it exactly like a succeeded refund on
    // charge.refunded: stamp the first success time (posted_at, which the
    // coach Money page and tax export window by), apply the ledger reversal
    // once, and alert the coach once. Without this the refund kept
    // posted_at = null (booked at request time) and never reversed the ledger.
    // B-641-7: also re-enter when the books are reversed but the head-coach
    // transfer is still owed; the claims inside make re-entry harmless.
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
        if (existing.failure_reason) {
          // A succeeded refund carries no failure reason.
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
    await this.prisma.chargeRefund.update({
      where: { stripe_refund_id: refund.id },
      data: {
        status: refund.status ?? existing.status,
        failure_reason: refund.failure_reason ?? null,
      },
    });
    return { claimed: true, purchase_id: existing.purchase_id };
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
    const existing = await this.prisma.chargeRefund.findUnique({
      where: { stripe_refund_id: args.stripe_refund_id },
    });
    const row = existing
      ? await this.prisma.chargeRefund.update({
          where: { stripe_refund_id: args.stripe_refund_id },
          data: {
            status: args.status,
            amount_cents: args.amount_cents,
            reason: args.reason ?? existing.reason,
            note: args.note ?? existing.note,
            initiated_by_user_id:
              args.initiated_by_user_id ?? existing.initiated_by_user_id,
            // B-641-6 (S-COACH-3): posted_at is the FIRST time the refund
            // succeeded. A Stripe redelivery days later must not move the
            // refund into a later Money window or tax export.
            posted_at:
              args.status === 'succeeded'
                ? existing.posted_at ?? new Date()
                : existing.posted_at,
          },
        })
      : await this.prisma.chargeRefund.create({
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

    // Apply ledger reversals only once per refund, and only when the refund
    // is actually `succeeded` — pending refunds shouldn't move our books.
    if (args.status !== 'succeeded') {
      return { row, ledger_just_reversed: false };
    }

    // B-641-7: three paths can complete one refund (charge.refunded,
    // charge.refund.updated, the admin refund) and they can overlap. The
    // flag is CLAIMED, not read: the false -> true update and the local
    // ledger reversal commit in one transaction, so exactly one caller
    // reverses the books (a concurrent claimer waits on the row lock and then
    // matches nothing) and a crash rolls both back for the redelivery.
    const ledgerJustReversed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.chargeRefund.updateMany({
        where: { id: row.id, ledger_reversed: false },
        data: { ledger_reversed: true },
      });
      if (claim.count !== 1) return false;
      await this.applyLedgerReversal(args.purchase.id, args.amount_cents, tx);
      return true;
    });

    // The head-coach transfer is Stripe HTTP, so it runs outside any
    // transaction. transfer_reversed = false after the ledger claim is the
    // durable "still owed" state; retryPendingTransferReversals picks it up.
    await this.applyRefundTransferReversalOnce(row.id, args.purchase.id, args.amount_cents);

    const updated = await this.prisma.chargeRefund.findUnique({ where: { id: row.id } });
    return { row: updated ?? row, ledger_just_reversed: ledgerJustReversed };
  }

  // B-641-7: reverse the head-coach transfer for ONE refund exactly once.
  // Every attempt for this refund (racing webhooks, the admin path, the
  // retry sweep) sends the same refund-scoped Stripe idempotency key with
  // the same amount, so Stripe makes one reversal; the local record is gated
  // by claiming transfer_reversed false -> true in the same transaction, so
  // it is written once. A Stripe failure leaves transfer_reversed = false
  // (nothing recorded) for the retry sweep instead of marking it done.
  //
  // B-641-7 (narrowed, B-COACH-5): Stripe forgets a key 24 hours after its
  // first request, so a resend after that could make a SECOND reversal. The
  // retry admission therefore lives HERE, on the one shared path, for every
  // caller: the first attempt is stamped before Stripe sees the key, a resend
  // is admitted only while that stamp is inside the 23-hour window, and a
  // reversal still owed past it moves to operator review (alerted once,
  // reconciled by an owner) instead of being sent again.
  private async applyRefundTransferReversalOnce(
    refundRowId: string,
    purchaseId: string,
    refundAmountCents: number,
    now: Date = new Date(),
  ): Promise<RefundTransferReversalOutcome> {
    const current = await this.prisma.chargeRefund.findUnique({ where: { id: refundRowId } });
    if (!current || current.transfer_reversed) return 'already_done';
    if (current.transfer_reversal_review_at) return 'needs_review';
    const owed = await this.owedHeadCoachReversal(purchaseId, refundAmountCents);
    if (!owed) {
      await this.markTransferReversalDone(this.prisma, refundRowId);
      return 'nothing_owed';
    }
    const admission = await this.admitTransferReversalAttempt(refundRowId, now);
    if (admission !== 'admitted') return admission;
    try {
      await this.transfers.reverse({
        transfer_row_id: owed.transfer.id,
        amount_cents: owed.amount_cents,
        idempotency_key: refundTransferReversalKey(refundRowId),
        metadata: { tgp_charge_refund_id: refundRowId },
        claim: (tx) => this.markTransferReversalDone(tx, refundRowId),
      });
      return 'reversed';
    } catch (err) {
      // Ids and machine codes only: a Stripe message is free text.
      this.logger.warn(
        `head-coach transfer reverse pending purchase=${purchaseId} refund=${refundRowId} code=${transferReversalErrorCode(err)}`,
      );
      return 'pending';
    }
  }

  private markTransferReversalDone(
    db: Prisma.TransactionClient,
    refundRowId: string,
  ): Promise<boolean> {
    return db.chargeRefund
      .updateMany({
        where: { id: refundRowId, transfer_reversed: false },
        data: { transfer_reversed: true },
      })
      .then((r) => r.count === 1);
  }

  // The head-coach share of this refund still to reverse: the transfer's
  // pro-rata share of the refund, capped by what is left on the transfer.
  private async owedHeadCoachReversal(
    purchaseId: string,
    refundAmountCents: number,
  ): Promise<{ transfer: ConnectTransfer; amount_cents: number } | null> {
    const transfer = await this.prisma.connectTransfer.findFirst({
      where: { purchase_id: purchaseId, status: 'succeeded' },
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
  ): Promise<'admitted' | 'already_done' | 'needs_review'> {
    await this.prisma.chargeRefund.updateMany({
      where: {
        id: refundRowId,
        transfer_reversed: false,
        transfer_reversal_review_at: null,
        transfer_reversal_first_attempt_at: null,
      },
      data: { transfer_reversal_first_attempt_at: now },
    });
    const row = await this.prisma.chargeRefund.findUnique({ where: { id: refundRowId } });
    if (!row || row.transfer_reversed) return 'already_done';
    if (row.transfer_reversal_review_at) return 'needs_review';
    const firstAttempt = row.transfer_reversal_first_attempt_at ?? now;
    if (now.getTime() - firstAttempt.getTime() <= REFUND_TRANSFER_RETRY_WINDOW_MS) {
      return 'admitted';
    }
    await this.moveTransferReversalToReview(row, now);
    return 'needs_review';
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

  // B-641-7 recovery: a succeeded refund whose books are reversed but whose
  // head-coach transfer is not (Stripe failed, or the process stopped between
  // Stripe and the local record). Retried with the same refund-scoped key.
  //
  // B-641-8 (B-COACH-5): rows past the window first LEAVE the retry set (each
  // moves to review and alerts once), so they can never occupy a retry batch;
  // the retry pass then selects only admissible rows and pages through all of
  // them (bounded per run), so fresh refunds are reached behind any backlog.
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
    // Keyset paging on (created_at, id), not a Prisma cursor: a reversed row
    // leaves the owed set, so a cursor on it points outside the filter (the
    // page came back empty here, and with skip: 1 Postgres would drop a real
    // row). Rows that fail stay owed but sit behind the key, so one run never
    // retries the same row twice.
    let after: { created_at: Date; id: string } | null = null;
    for (let page = 0; page < REFUND_TRANSFER_SWEEP_MAX_PAGES; page++) {
      const keyset: Prisma.ChargeRefundWhereInput[] = after
        ? [
            {
              OR: [
                { created_at: { gt: after.created_at } },
                { created_at: after.created_at, id: { gt: after.id } },
              ],
            },
          ]
        : [];
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
            ...keyset,
          ],
        },
        orderBy: order,
        take: limit,
      });
      for (const row of rows) {
        retried++;
        const outcome = await this.applyRefundTransferReversalOnce(
          row.id,
          row.purchase_id,
          row.amount_cents,
          now,
        );
        if (outcome === 'reversed') reversed++;
        if (outcome === 'needs_review') needsReview++;
      }
      if (rows.length < limit) break;
      const last: { created_at: Date; id: string } = rows[rows.length - 1];
      after = { created_at: last.created_at, id: last.id };
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
      const owner = named.metadata?.tgp_charge_refund_id;
      if (owner && owner !== row.id) {
        throw new ConflictException({
          code: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND',
          error: 'TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND',
          message:
            'That reversal was made for a different refund. Pick the reversal for this refund, or reconcile without an id.',
        });
      }
      match = named;
    } else {
      match = reversals.find((r) => r.metadata?.tgp_charge_refund_id === row.id);
      if (!match) {
        const unattributed = reversals.filter((r) => !r.metadata?.tgp_charge_refund_id);
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
    // Only the caller whose claim wins reports the record as its own.
    let claimed = false;
    const claim = async (tx: Prisma.TransactionClient) => {
      claimed = await this.markTransferReversalDone(tx, row.id);
      return claimed;
    };
    if (match) {
      const amount = Math.min(match.amount, owed.amount_cents);
      await this.transfers.recordReconciledReversal({
        transfer_row_id: owed.transfer.id,
        amount_cents: amount,
        claim,
      });
      return {
        charge_refund_id: row.id,
        outcome: claimed ? 'recorded_from_stripe' : 'already_recorded',
        stripe_transfer_reversal_id: match.id,
        amount_cents: amount,
      };
    }
    // Stripe holds no reversal for this refund and the original key has
    // expired, so one new request under a review-scoped key is safe; a second
    // owner click inside 24 hours reuses that key.
    await this.transfers.reverse({
      transfer_row_id: owed.transfer.id,
      amount_cents: owed.amount_cents,
      idempotency_key: `${refundTransferReversalKey(row.id)}-review`,
      metadata: { tgp_charge_refund_id: row.id },
      claim,
    });
    return {
      charge_refund_id: row.id,
      outcome: claimed ? 'reversed' : 'already_recorded',
      stripe_transfer_reversal_id: null,
      amount_cents: owed.amount_cents,
    };
  }

  private async listAllTransferReversals(
    stripeTransferId: string,
  ): Promise<Array<{ id: string; amount: number; metadata?: Record<string, string> | null }>> {
    const out: Array<{ id: string; amount: number; metadata?: Record<string, string> | null }> = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.stripe.listTransferReversals({
        transfer_id: stripeTransferId,
        limit: 100,
        starting_after: startingAfter,
      });
      out.push(...res.data);
      if (!res.has_more || res.data.length === 0) return out;
      startingAfter = res.data[res.data.length - 1].id;
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
      // Determine whether this refund is full (purchase fully refunded)
      // or partial — affects the message body and entitlement_revoked
      // payload field. We re-read the purchase rather than relying on
      // the in-memory copy because applyLedgerReversal + the
      // fullyRefunded purchase.update may have transitioned its status.
      const fresh = await this.prisma.clientPurchase.findUnique({
        where: { id: args.purchase.id },
      });
      const isFullRefund =
        !!fresh && fresh.status === 'refunded' && !fresh.entitlement_active;
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
  private async applyLedgerReversal(
    purchaseId: string,
    refundAmountCents: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const entries = await this.ledger.findByPurchase(purchaseId, db);
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
            },
            db,
          );
        }
      }
    }
  }

  // Reverse the matching head-coach transfer (if any) proportionally.
  // The Stripe `reverse_transfer=true` flag we set on createRefund means
  // Stripe will automatically reverse the destination's portion, but the
  // head-coach split was a SEPARATE Transfer we minted, so Stripe doesn't
  // know about it — we have to reverse that explicitly.
  private async applyHeadCoachReversal(
    purchaseId: string,
    refundAmountCents: number,
  ): Promise<void> {
    const transfer = await this.prisma.connectTransfer.findFirst({
      where: { purchase_id: purchaseId, status: 'succeeded' },
    });
    if (!transfer) return;
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase) return;
    const ratio = refundAmountCents / Math.max(purchase.amount_cents, 1);
    const amount = Math.min(
      transfer.amount_cents - transfer.reversed_amount_cents,
      Math.floor(transfer.amount_cents * ratio),
    );
    if (amount <= 0) return;
    try {
      await this.transfers.reverse({
        transfer_row_id: transfer.id,
        amount_cents: amount,
      });
    } catch (err) {
      this.logger.warn(
        `head-coach transfer reverse failed purchase=${purchaseId}: ${(err as Error).message}`,
      );
    }
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

  private async onDisputeClosed(event: {
    data: { object: Record<string, unknown> };
  }, _outerTx?: WebhookTx): Promise<{ claimed: boolean; reason?: string; purchase_id?: string }> {
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
      balance_transactions?: Array<{ id: string }>;
    };
    if (!dispute?.id) return { claimed: false };
    const existing = await this.prisma.chargeDispute.findUnique({
      where: { stripe_dispute_id: dispute.id },
    });
    if (!existing) return { claimed: false };
    const updated = await this.prisma.chargeDispute.update({
      where: { stripe_dispute_id: dispute.id },
      data: {
        status: dispute.status ?? existing.status,
        closed_at: new Date(),
        balance_transaction_id:
          dispute.balance_transactions?.[0]?.id ?? existing.balance_transaction_id,
      },
    });
    // On a `lost` outcome, reverse the destination + application_fee
    // ledger slices and reverse any head-coach transfer.
    if (dispute.status === 'lost' && !updated.ledger_reversed) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      if (purchase) {
        await this.applyLedgerReversal(purchase.id, updated.amount_cents);
        await this.applyHeadCoachReversal(purchase.id, updated.amount_cents);
        // PR-16 — entitlement flip + drop-cancel commit atomically.
        // The Stripe-HTTP-ridden ledger / transfer reversals above
        // intentionally run outside this tx (P1-3 anti-pattern). The
        // ChargeDispute.ledger_reversed flag is the idempotency gate
        // for the WHOLE block, so a redelivery short-circuits before
        // re-entering this branch.
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
            await this.fanout.cancelPendingForPurchase(
              purchase.id,
              'dispute',
              tx,
            );
          }
        });
      }
    } else if (dispute.status === 'won') {
      // Clear the disputed flag so the purchase rejoins the normal feed.
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: updated.purchase_id },
      });
      if (purchase && purchase.status === 'disputed') {
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
            amount_cents:
              typeof dispute.amount === 'number' ? dispute.amount : 0,
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
      if (
        !err ||
        typeof err !== 'object' ||
        (err as { code?: string }).code !== 'P2002'
      ) {
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
            amount_cents:
              typeof dispute.amount === 'number' ? dispute.amount : undefined,
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
    const fullyReversed = !!transfer.reversed;
    await this.prisma.connectTransfer.update({
      where: { id: row.id },
      data: {
        reversed_amount_cents:
          typeof transfer.amount_reversed === 'number'
            ? transfer.amount_reversed
            : row.reversed_amount_cents,
        status: fullyReversed ? 'reversed' : row.status,
        reversed_at: fullyReversed ? new Date() : row.reversed_at,
      },
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
        typeof payout.arrival_date === 'number'
          ? new Date(payout.arrival_date * 1000)
          : null,
      failure_message: payout.failure_message ?? null,
    });
    return { claimed: true };
  }

  // --- Helpers ---

  // Resolve a ClientPurchase from a Stripe charge id by walking the
  // SplitLedgerEntry table (which we populate at charge time with
  // stripe_charge_id).
  private async resolvePurchaseByCharge(
    chargeId: string,
  ): Promise<ClientPurchase | null> {
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
      const piId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
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
        message: 'This entitlement is a $0 grant, not a purchase; use POST /v1/entitlements/grants/revoke',
      });
    }
    // Resolve the underlying charge id. For one_time prefer the saved PI;
    // for recurring use the most recent destination ledger slice.
    const chargeId = await this.resolveChargeIdForPurchase(purchase);
    if (!chargeId) {
      throw new Error(
        `createAdminRefund: no charge id for purchase ${purchase.id}`,
      );
    }
    const idempotencyKey = `tgp-refund-${purchase.id}-${args.amount_cents ?? 'full'}-${args.initiated_by_user_id}`;
    const stripe = await this.stripe.createRefund({
      charge_id: chargeId,
      amount: args.amount_cents,
      reason: args.reason,
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: {
        tgp_purchase_id: purchase.id,
        tgp_initiated_by: args.initiated_by_user_id,
      },
      idempotencyKey,
    });
    const outcome = await this.upsertAndApplyRefund({
      purchase,
      stripe_refund_id: stripe.id,
      stripe_charge_id: chargeId,
      amount_cents: typeof stripe.amount === 'number' ? stripe.amount : args.amount_cents ?? purchase.amount_cents,
      status: stripe.status ?? 'pending',
      reason: args.reason ?? null,
      note: args.note ?? null,
      initiated_by_user_id: args.initiated_by_user_id,
    });
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
          : args.amount_cents ?? purchase.amount_cents;
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

  private async resolveChargeIdForPurchase(
    purchase: ClientPurchase,
  ): Promise<string | null> {
    if (purchase.stripe_payment_intent_id) {
      try {
        const pi = await this.stripe.retrievePaymentIntent(
          purchase.stripe_payment_intent_id,
        );
        const latest =
          typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
        if (latest) return latest;
      } catch (err) {
        this.logger.warn(
          `retrievePaymentIntent failed: ${(err as Error).message}`,
        );
      }
    }
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
