import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { AuditService } from '../audit/audit.service';
import { FirstPaymentEmitter } from './emitters/first-payment.emitter';

// R81 (PR-395 follow-up, F8) — stable audit-event action for the once-ever
// first-payment emit. Free-form action string (matches AuditService's
// documented naming convention `<domain>.<event_past_tense>`); intentionally
// distinct from the billing.* invoice actions so it can be queried in
// isolation as the financial-celebration trail.
const AUDIT_FIRST_PAYMENT_EMITTED = 'notification.first_payment_emitted';

// Prisma's unique-constraint violation code. The DIRECT INSERT below relies on
// it: a duplicate (webhook retry / second payment / concurrent first payments)
// raises P2002, which we treat as "already emitted" rather than an error.
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Input for {@link CoachFirstPaymentService.tryEmitFirstPayment}.
 *
 * Every field is SERVER-TRUSTED: the caller (CheckoutWebhookHandlerService)
 * sources them from the persisted ClientPurchase row, never from the Stripe
 * webhook body. This is the 50-Failures #5 (IDOR) guard — a forged webhook
 * payload can never cause a notification to be attributed to the wrong coach
 * or carry an attacker-controlled amount.
 */
export interface TryEmitFirstPaymentInput {
  /**
   * The coach who received the payment (ClientPurchase.coach_user_id).
   *
   * R81 (PR-395 follow-up, F6) — Stripe Connect / sub-coach attribution: this
   * is the SELLING coach, i.e. whoever's package produced the sale
   * (`coach_user_id` on the persisted purchase). When a sub-coach sells under a
   * head coach's Connect account, the first-payment celebration is
   * deliberately attributed to that selling sub-coach — it is THEIR first
   * client payment that we are celebrating, not the head coach's. The
   * head-coach revenue split is a separate ledger concern handled downstream
   * (split-ledger / head_coach_split) and does not change who receives this
   * once-ever notification.
   */
  coachId: string;
  /** Amount in cents (ClientPurchase.amount_cents). */
  amount: number;
  /** ISO currency code (ClientPurchase.currency). */
  currency: string;
  /** The buying client's user id (ClientPurchase.client_user_id). */
  clientId: string;
  /**
   * Optional correlation id (e.g. the Stripe event id) for the F8 audit entry.
   * Server-trusted / non-PII; threaded purely for traceability across the
   * webhook → emit seam. Absent in unit tests that drive the service directly.
   */
  correlationId?: string;
}

/**
 * CoachFirstPaymentService — Roman P4 (Option C) exactly-once primitive.
 *
 * Public surface is a single method, {@link tryEmitFirstPayment}, called inside
 * the SAME $transaction that records the ClientPurchase (50-Failures #44 —
 * multi-step writes share one transaction so the ledger row and the purchase
 * commit-or-roll-back together).
 *
 * The exactly-once guarantee is enforced by the DB: a DIRECT INSERT into
 * CoachFirstPaymentNotification (coachId @unique). There is NO pre-SELECT /
 * check-then-act (50-Failures #28 race, #29 idempotency) — the unique
 * constraint IS the race protection. A duplicate (Stripe webhook retry, a
 * second payment for the same coach, or two concurrent first payments racing)
 * raises Prisma P2002, which we swallow as "already emitted" with a structured
 * log (50-Failures #36 — no silent swallow). Any OTHER error rethrows so the
 * outer transaction rolls back and Stripe redelivers.
 */
@Injectable()
export class CoachFirstPaymentService {
  private readonly logger = new Logger(CoachFirstPaymentService.name);

  constructor(
    private readonly emitter: FirstPaymentEmitter,
    // R81 (PR-395 follow-up, F8) — AuditService is @Global; @Optional so the
    // thin unit specs that construct the service without DI keep working (the
    // audit write becomes a no-op when absent, exactly like sibling services).
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Attempt to record + emit the coach's first-ever payment notification.
   *
   * Idempotent by construction: the first call for a given coachId inserts the
   * ledger row and emits the notification; every subsequent call no-ops on the
   * unique-constraint violation. Implemented in the C3 commit.
   *
   * @param tx     the ambient transaction client (shared with the purchase write).
   * @param input  server-trusted { coachId, amount, currency, clientId }.
   */
  async tryEmitFirstPayment(
    tx: Prisma.TransactionClient,
    input: TryEmitFirstPaymentInput,
  ): Promise<void> {
    const { coachId, amount, currency, clientId } = input;

    try {
      // DIRECT INSERT — no pre-SELECT / check-then-act. The
      // CoachFirstPaymentNotification(coachId @unique) constraint is the
      // exactly-once guarantee and the race protection (50-Failures #28, #29).
      // This runs on the AMBIENT `tx` so the ledger row commits-or-rolls-back
      // together with the ClientPurchase write (50-Failures #44).
      await tx.coachFirstPaymentNotification.create({
        data: { coachId, amount, currency, clientId },
      });
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === PRISMA_UNIQUE_VIOLATION
      ) {
        // Already fired for this coach (webhook retry, a later payment, or a
        // concurrent first payment that lost the unique-constraint race). This
        // is the expected idempotent no-op — NOT a silent swallow: we log it
        // structured so it is observable (50-Failures #36). No PII / secrets in
        // the log — only the event name and coachId (50-Failures #12, #34).
        this.logger.log({ event: 'first_payment_already_emitted', coachId });
        return;
      }
      // Any OTHER error is a real failure: rethrow so the outer transaction
      // rolls back (the purchase row too) and Stripe redelivers the webhook.
      throw err;
    }

    // The INSERT won the unique constraint — this is the coach's first-ever
    // payment. R81 (PR-395 follow-up, F8): write the audit-log entry BEFORE the
    // emit (after the P2002 no-op gate has passed) so the once-ever financial
    // celebration is recorded. No PII: ids + amount/currency + correlation id
    // only. The write is best-effort by AuditService contract (it swallows its
    // own errors and never throws), so it cannot break the purchase tx.
    await this.audit?.write({
      action: AUDIT_FIRST_PAYMENT_EMITTED,
      actorId: coachId,
      targetUserId: clientId,
      targetType: 'coach_first_payment_notification',
      tenantCoachId: coachId,
      metadata: {
        event: 'first_payment_emitted',
        coach_id: coachId,
        client_id: clientId,
        amount,
        currency,
        correlation_id: input.correlationId ?? null,
      },
    });

    // Enqueue the notification via the existing notifications module. Because
    // this only runs on the winning INSERT, the notification is enqueued
    // exactly once, forever. The ambient `tx` is threaded through so the
    // notification rows ride the SAME transaction as the ledger row + purchase
    // (R81 F1/F2 — commit-or-roll-back together; no escape to an autocommit
    // client that would survive an outer rollback and re-fire on Stripe retry).
    await this.emitter.emit(coachId, { amount, currency, clientId }, tx);

    this.logger.log({ event: 'first_payment_emitted', coachId });
  }
}
