import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { FirstPaymentEmitter } from './emitters/first-payment.emitter';

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
  /** The coach who received the payment (ClientPurchase.coach_user_id). */
  coachId: string;
  /** Amount in cents (ClientPurchase.amount_cents). */
  amount: number;
  /** ISO currency code (ClientPurchase.currency). */
  currency: string;
  /** The buying client's user id (ClientPurchase.client_user_id). */
  clientId: string;
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

  constructor(private readonly emitter: FirstPaymentEmitter) {}

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
    // Implemented in C3.
    void tx;
    void input;
    void this.emitter;
    void this.logger;
  }
}
