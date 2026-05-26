import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { DunningCase, DunningCaseState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { DunningNotifier } from './dunning.notifier';

// r50 Dunning v1 — state-machine + side-effect entry points.
//
// State transitions (allowed):
//   active             -> retry_1_scheduled
//   retry_1_scheduled  -> retry_2_scheduled            (retry_1 fail)
//   retry_2_scheduled  -> retry_3_scheduled            (retry_2 fail)
//   *                  -> recovered                    (invoice.payment_succeeded)
//   retry_3_scheduled  -> churned                      (retry_3 fail)
//   active             -> churned                      (subscription.deleted)
//   retry_1_scheduled  -> churned                      (subscription.deleted)
//   retry_2_scheduled  -> churned                      (subscription.deleted)
//   retry_3_scheduled  -> churned                      (subscription.deleted)
//   recovered          -> active   (reopen on a NEW invoice.payment_failed)
//   churned            -> active   (reopen on a NEW invoice.payment_failed)
//
// Anything else throws ConflictException. The webhook handlers swallow
// those as no-ops (Stripe re-delivery) so the dispatcher does not
// 500 and re-fire.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * ONE_DAY_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/** Cadence between successive retries — exposed for tests. */
export const RETRY_OFFSETS = {
  /** First retry: 1 day after past_due fires. */
  retry1FromNow: ONE_DAY_MS,
  /** Second retry: 3 days after first retry. */
  retry2FromRetry1: THREE_DAYS_MS,
  /** Third retry: 7 days after second retry. */
  retry3FromRetry2: SEVEN_DAYS_MS,
} as const;

/** Allowed transition table. */
const ALLOWED_TRANSITIONS: Record<DunningCaseState, readonly DunningCaseState[]> = {
  active: ['retry_1_scheduled', 'recovered', 'churned'],
  retry_1_scheduled: ['retry_2_scheduled', 'recovered', 'churned'],
  retry_2_scheduled: ['retry_3_scheduled', 'recovered', 'churned'],
  retry_3_scheduled: ['recovered', 'churned'],
  recovered: ['active'],
  churned: ['active'],
};

export function isTransitionAllowed(
  from: DunningCaseState,
  to: DunningCaseState,
): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface OpenCaseInput {
  coachId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  stripeInvoiceId: string | null;
  amountCents: number;
  currency: string;
  failureReason: string | null;
  failureCode: string | null;
  /** Stripe event id that triggered the open — used for idempotency. */
  openedByEventId: string;
}

@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifier?: DunningNotifier,
  ) {}

  /**
   * Idempotent open / re-open on invoice.payment_failed → past_due.
   *
   * Three cases:
   *   1. No row for this subscription   → CREATE active + schedule retry_1.
   *   2. Closed row exists (recovered / churned) → REOPEN as active
   *      + clear terminal stamps + reset retries + reschedule retry_1.
   *   3. Open row exists                → no-op (later failures on the
   *      same case roll through retry_N transitions, not re-opens).
   *
   * The unique constraint on stripe_subscription_id + the opened_by_event_id
   * idempotency check prevent duplicate creates from a Stripe re-delivery.
   *
   * Returns the canonical (post-write) DunningCase row.
   */
  async openOrReopenCase(input: OpenCaseInput): Promise<DunningCase> {
    const existing = await this.prisma.dunningCase.findUnique({
      where: { stripe_subscription_id: input.stripeSubscriptionId },
    });
    const retry1At = new Date(Date.now() + RETRY_OFFSETS.retry1FromNow);

    // Already opened by this exact webhook delivery → return existing.
    if (existing && existing.opened_by_event_id === input.openedByEventId) {
      return existing;
    }

    // Open case mid-cycle: keep state but record latest reason / event id
    // so the operator dashboard can correlate.
    if (
      existing &&
      existing.state !== 'recovered' &&
      existing.state !== 'churned'
    ) {
      return this.prisma.dunningCase.update({
        where: { id: existing.id },
        data: {
          stripe_invoice_id: input.stripeInvoiceId ?? existing.stripe_invoice_id,
          failure_reason: input.failureReason ?? existing.failure_reason,
          failure_code: input.failureCode ?? existing.failure_code,
          opened_by_event_id: input.openedByEventId,
        },
      });
    }

    // Re-open after a previous close: same row, fresh schedule.
    if (existing) {
      return this.prisma.dunningCase.update({
        where: { id: existing.id },
        data: {
          state: 'retry_1_scheduled',
          amount_cents: input.amountCents,
          currency: input.currency,
          failure_reason: input.failureReason,
          failure_code: input.failureCode,
          stripe_invoice_id: input.stripeInvoiceId,
          stripe_customer_id: input.stripeCustomerId ?? existing.stripe_customer_id,
          retry_1_at: retry1At,
          retry_2_at: null,
          retry_3_at: null,
          recovered_at: null,
          churned_at: null,
          opened_by_event_id: input.openedByEventId,
        },
      });
    }

    // Fresh case: insert + schedule retry_1.
    return this.prisma.dunningCase.create({
      data: {
        coach_id: input.coachId,
        stripe_subscription_id: input.stripeSubscriptionId,
        stripe_customer_id: input.stripeCustomerId,
        stripe_invoice_id: input.stripeInvoiceId,
        state: 'retry_1_scheduled',
        amount_cents: input.amountCents,
        currency: input.currency,
        failure_reason: input.failureReason,
        failure_code: input.failureCode,
        retry_1_at: retry1At,
        opened_by_event_id: input.openedByEventId,
      },
    });
  }

  /**
   * Worker called after invoking Stripe /invoices/:id/pay for a retry slot
   * and observing failure. Advances the case to the next state + schedules
   * the next retry timestamp (or transitions to churned after retry_3).
   *
   * Returns the new state. Throws ConflictException if called against a
   * case that is not in a retry_N_scheduled state.
   */
  async recordRetryFailure(
    caseId: string,
    retryNumber: 1 | 2 | 3,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<DunningCase> {
    const c = await db.dunningCase.findUnique({ where: { id: caseId } });
    if (!c) {
      throw new ConflictException({ error: 'DUNNING_CASE_NOT_FOUND', caseId });
    }
    const expectedState = `retry_${retryNumber}_scheduled` as DunningCaseState;
    if (c.state !== expectedState) {
      // Already advanced (concurrent webhook?) — no-op.
      return c;
    }
    if (retryNumber === 1) {
      const retry2At = new Date(Date.now() + RETRY_OFFSETS.retry2FromRetry1);
      this.assertTransition(c.state, 'retry_2_scheduled');
      return db.dunningCase.update({
        where: { id: c.id },
        data: { state: 'retry_2_scheduled', retry_2_at: retry2At },
      });
    }
    if (retryNumber === 2) {
      const retry3At = new Date(Date.now() + RETRY_OFFSETS.retry3FromRetry2);
      this.assertTransition(c.state, 'retry_3_scheduled');
      return db.dunningCase.update({
        where: { id: c.id },
        data: { state: 'retry_3_scheduled', retry_3_at: retry3At },
      });
    }
    // retry_3 — terminal.
    this.assertTransition(c.state, 'churned');
    const updated = await db.dunningCase.update({
      where: { id: c.id },
      data: { state: 'churned', churned_at: new Date() },
    });
    if (this.notifier) {
      await this.notifier.churned(updated).catch((err) =>
        this.logger.error(
          `dunning churned notify failed for ${updated.id}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        ),
      );
    }
    return updated;
  }

  /**
   * Webhook → invoice.payment_succeeded. Closes any OPEN case for the
   * subscription with state='recovered'. No-op when no open case exists
   * (the success may just be a fresh charge that was never in dunning).
   *
   * Returns the closed case, or null if no open case was found.
   */
  async recordRecovery(
    stripeSubscriptionId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<DunningCase | null> {
    const c = await db.dunningCase.findUnique({
      where: { stripe_subscription_id: stripeSubscriptionId },
    });
    if (!c) return null;
    if (c.state === 'recovered' || c.state === 'churned') {
      // Idempotent — Stripe re-delivery after we already closed.
      return c;
    }
    this.assertTransition(c.state, 'recovered');
    const updated = await db.dunningCase.update({
      where: { id: c.id },
      data: { state: 'recovered', recovered_at: new Date() },
    });
    if (this.notifier) {
      await this.notifier.recovered(updated).catch((err) =>
        this.logger.error(
          `dunning recovery notify failed for ${updated.id}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        ),
      );
    }
    return updated;
  }

  /**
   * Webhook → customer.subscription.deleted. Closes any OPEN case for the
   * subscription with state='churned' (terminal). No-op when no open case.
   */
  async recordChurn(
    stripeSubscriptionId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<DunningCase | null> {
    const c = await db.dunningCase.findUnique({
      where: { stripe_subscription_id: stripeSubscriptionId },
    });
    if (!c) return null;
    if (c.state === 'recovered' || c.state === 'churned') {
      return c;
    }
    this.assertTransition(c.state, 'churned');
    const updated = await db.dunningCase.update({
      where: { id: c.id },
      data: { state: 'churned', churned_at: new Date() },
    });
    if (this.notifier) {
      await this.notifier.churned(updated).catch((err) =>
        this.logger.error(
          `dunning churn notify failed for ${updated.id}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        ),
      );
    }
    return updated;
  }

  /** Coach-facing: returns the OPEN case for a coach, or null. */
  async getActiveCaseForCoach(coachId: string): Promise<DunningCase | null> {
    return this.prisma.dunningCase.findFirst({
      where: {
        coach_id: coachId,
        state: { in: ['active', 'retry_1_scheduled', 'retry_2_scheduled', 'retry_3_scheduled'] },
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  /**
   * Worker scan — returns all cases with a retry timestamp due by `now`.
   * Bounded batch size keeps the worker friendly to the DB during a
   * backlog; the cron simply runs again next minute.
   */
  async findDueRetries(now: Date, limit = 25): Promise<DunningCase[]> {
    return this.prisma.dunningCase.findMany({
      where: {
        OR: [
          { state: 'retry_1_scheduled', retry_1_at: { lte: now } },
          { state: 'retry_2_scheduled', retry_2_at: { lte: now } },
          { state: 'retry_3_scheduled', retry_3_at: { lte: now } },
        ],
      },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
  }

  private assertTransition(from: DunningCaseState, to: DunningCaseState): void {
    if (!isTransitionAllowed(from, to)) {
      throw new ConflictException({
        error: 'DUNNING_ILLEGAL_TRANSITION',
        from,
        to,
      });
    }
  }
}
