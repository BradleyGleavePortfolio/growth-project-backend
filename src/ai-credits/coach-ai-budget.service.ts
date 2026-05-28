import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  resolveMaxActualCents,
  resolveValueMultiplier,
  resolveBaseDisplayedCents,
} from './ai-credits.constants';
import { bankersRoundPaidToActual } from './bankers-round.util';

// CoachAIBudgetService — the single owner of the CoachAIBudget +
// CoachCreditPackPurchase tables.
//
// Public surface:
//   - getOrCreateCurrentPeriod(coachId)  — idempotent per-period init.
//   - getOrCreateCurrentPeriodTx(tx, ..) — same, inside an existing tx
//                                          (used by the Stripe webhook).
//   - recordUsage(coachId, actualCents, ...) — atomic WHERE-clause-guarded
//                                              UPDATE; returns whether the
//                                              charge stuck. Caller decides
//                                              whether to surface the
//                                              overshoot (it does NOT throw
//                                              — the Anthropic call already
//                                              completed by the time we get
//                                              here).
//   - canCharge(coachId, actualCents)   — pre-call check; returns
//                                         { allowed, budget } so the
//                                         caller can throw a 402 with the
//                                         current budget snapshot.
//   - getBudgetDto(coachId)             — the DTO for GET /coach/ai/budget.
//   - applyCreditPack(...)              — Stripe-webhook entrypoint.
//   - resolveHeadCoachId(userId)        — sub-coach -> head-coach for budget
//                                         scoping. Public so the gateway can
//                                         scope correctly.
//   - rolloverDueBudgets(now)           — used by the monthly cron.
//   - grantCredits / refundPack         — admin tooling.
//
// All money is in cents (Int). Multiplier is Decimal(6,3) at the schema
// layer; service code resolves it to Number for arithmetic and uses the
// bankersRound utility for the rounding step that materially affects
// the displayed credit.

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface BudgetSnapshot {
  id: string;
  coach_user_id: string;
  period_start: Date;
  period_end: Date;
  base_actual_cents: number;
  value_multiplier: number;
  base_displayed_cents: number;
  pack_paid_cents: number;
  pack_displayed_cents: number;
  actual_used_cents: number;
  /** Sum of base actual + actual headroom purchased via packs. */
  total_actual_available_cents: number;
}

export interface CoachAiBudgetDto {
  period_start: string;
  period_end: string;
  base_displayed_cents: number;
  pack_displayed_cents: number;
  total_displayed_cents: number;
  used_displayed_cents: number;
  remaining_displayed_cents: number;
  pct_used: number;
  base_actual_cents: number;
  /** Decimal serialised as string so JS clients don't drift via Number. */
  value_multiplier: string;
  actual_used_cents: number;
  pack_options_cents: number[];
  custom_pack_bounds_cents: { min: number; max: number };
}

@Injectable()
export class CoachAIBudgetService {
  private readonly logger = new Logger(CoachAIBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the head-coach id that owns the budget for a given user.
   * Sub-coaches share their head coach's budget; if the user is not a
   * sub-coach the id is returned as-is. Head coaches with NO assignment
   * also pass through unchanged.
   */
  async resolveHeadCoachId(userId: string): Promise<string> {
    // If user is a sub-coach (i.e. appears on the sub side of a non-archived
    // TeamSubCoachAssignment), resolve to their head coach. The cap allows
    // a sub-coach under at most 2 head coaches; the budget envelope follows
    // the FIRST assignment that has the lowest created_at (deterministic).
    const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: userId, archived_at: null },
      orderBy: { created_at: 'asc' },
      select: { head_coach_id: true },
    });
    return assignment?.head_coach_id ?? userId;
  }

  /**
   * Idempotent: returns an existing budget row for the current period, or
   * creates one with the locked defaults. Runs outside any user-supplied
   * transaction so concurrent first-call coaches don't serialise.
   */
  async getOrCreateCurrentPeriod(coachId: string): Promise<BudgetSnapshot> {
    return this.getOrCreateCurrentPeriodTx(this.prisma, coachId);
  }

  /**
   * Transactional sibling — used inside the Stripe webhook's $transaction.
   */
  async getOrCreateCurrentPeriodTx(
    tx: Prisma.TransactionClient | PrismaService,
    coachId: string,
  ): Promise<BudgetSnapshot> {
    const existing = await tx.coachAIBudget.findUnique({
      where: { coach_user_id: coachId },
    });
    if (existing) return this.toSnapshot(existing);

    const now = new Date();
    const periodStart = startOfCurrentPeriod(now);
    const periodEnd = new Date(periodStart.getTime() + PERIOD_MS);

    // Upsert handles the concurrent-first-call race: if two callers reach
    // findUnique → null → create within the same tick, the @unique on
    // coach_user_id makes one of the inserts fail and the upsert retries
    // by reading the winner's row.
    const row = await tx.coachAIBudget.upsert({
      where: { coach_user_id: coachId },
      create: {
        coach_user_id: coachId,
        period_start: periodStart,
        period_end: periodEnd,
        base_actual_cents: resolveMaxActualCents(),
        value_multiplier: new Prisma.Decimal(resolveValueMultiplier()),
        base_displayed_cents: resolveBaseDisplayedCents(),
      },
      update: {},
    });
    return this.toSnapshot(row);
  }

  /**
   * Pre-call gate. Returns the current snapshot and an `allowed` flag so the
   * caller can render the structured 402 with `pack_options` without an
   * extra round-trip.
   */
  async canCharge(
    coachId: string,
    actualCostCents: number,
  ): Promise<{ allowed: boolean; budget: BudgetSnapshot }> {
    const budget = await this.getOrCreateCurrentPeriod(coachId);
    const allowed =
      budget.actual_used_cents + actualCostCents <=
      budget.total_actual_available_cents;
    return { allowed, budget };
  }

  /**
   * Atomic post-call usage write. Uses the WHERE-clause guard from PR #293's
   * materialiser claim — the row is updated only if `actual_used_cents` is
   * still low enough to absorb the charge. `count === 0` means the race
   * was lost; we log the overshoot but do NOT throw to the caller (their
   * Anthropic call already returned).
   */
  async recordUsage(args: {
    coachId: string;
    actualCostCents: number;
    capability: string;
    contextId?: string | null;
  }): Promise<{ recorded: boolean; budgetId: string }> {
    if (args.actualCostCents < 0) {
      throw new Error(`recordUsage: actualCostCents must be >= 0, got ${args.actualCostCents}`);
    }
    const budget = await this.getOrCreateCurrentPeriod(args.coachId);
    const ceilingCents = budget.total_actual_available_cents;
    // Race-safe atomic update: only succeed if the current used + this
    // charge stay within the ceiling. PR #293 pattern.
    const result = await this.prisma.coachAIBudget.updateMany({
      where: {
        id: budget.id,
        actual_used_cents: { lte: ceilingCents - args.actualCostCents },
      },
      data: {
        actual_used_cents: { increment: args.actualCostCents },
      },
    });
    if (result.count === 0) {
      this.logger.warn(
        {
          event: 'COACH_AI_BUDGET_RACE_OVERSHOOT',
          coachId: args.coachId,
          capability: args.capability,
          contextId: args.contextId ?? null,
          actualCostCents: args.actualCostCents,
          ceilingCents,
          actualUsedCents: budget.actual_used_cents,
        },
        // structured-logging note: passing the object as the first arg is
        // the Nest/Pino convention used elsewhere in this codebase.
        'budget race overshoot — charge could not be absorbed',
      );
      return { recorded: false, budgetId: budget.id };
    }
    return { recorded: true, budgetId: budget.id };
  }

  /**
   * Compute the DTO the mobile client polls. Read-only.
   */
  async getBudgetDto(coachId: string): Promise<CoachAiBudgetDto> {
    const budget = await this.getOrCreateCurrentPeriod(coachId);
    const usedDisplayed = Math.round(
      budget.actual_used_cents * budget.value_multiplier,
    );
    const totalDisplayed =
      budget.base_displayed_cents + budget.pack_displayed_cents;
    const remainingDisplayed = Math.max(0, totalDisplayed - usedDisplayed);
    // pct_used is rendered to one decimal for UI thresholds (60 / 80 / 95 / 100).
    const pctUsed =
      totalDisplayed === 0
        ? 0
        : Math.min(100, Math.round((usedDisplayed / totalDisplayed) * 1000) / 10);
    return {
      period_start: budget.period_start.toISOString(),
      period_end: budget.period_end.toISOString(),
      base_displayed_cents: budget.base_displayed_cents,
      pack_displayed_cents: budget.pack_displayed_cents,
      total_displayed_cents: totalDisplayed,
      used_displayed_cents: usedDisplayed,
      remaining_displayed_cents: remainingDisplayed,
      pct_used: pctUsed,
      base_actual_cents: budget.base_actual_cents,
      value_multiplier: budget.value_multiplier.toFixed(3),
      actual_used_cents: budget.actual_used_cents,
      // Locked pack tiers. The mobile client renders three buttons + Custom.
      pack_options_cents: [1000, 2500, 9900],
      custom_pack_bounds_cents: { min: 1000, max: 50_000 },
    };
  }

  /**
   * Apply a paid credit pack. Idempotent on stripe_checkout_session_id.
   * Runs in a single $transaction so the budget update and the purchase
   * row update commit or rollback together.
   *
   * Preconditions: the caller (StripeWebhookController) MUST have already
   * created the CoachCreditPackPurchase row in 'pending' state when the
   * checkout session was minted. If the row is missing we treat the event
   * as a stray webhook and refuse to credit (safer than auto-creating —
   * we'd have no audit trail of who minted the session).
   */
  async applyCreditPack(args: {
    coachId: string;
    paidCents: number;
    stripeCheckoutSessionId: string;
    stripeInvoiceId?: string | null;
    stripePaymentIntentId?: string | null;
  }): Promise<{
    status: 'applied' | 'already_applied' | 'no_pending_purchase';
    purchaseId: string | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.coachCreditPackPurchase.findUnique({
        where: { stripe_checkout_session_id: args.stripeCheckoutSessionId },
      });
      if (!existing) {
        // A webhook arriving for a session we never minted is suspicious
        // but not necessarily malicious (Stripe re-sends old events on
        // endpoint reconfigure). Log and ignore rather than crediting.
        this.logger.warn(
          {
            event: 'COACH_AI_PACK_WEBHOOK_NO_PENDING_ROW',
            coachId: args.coachId,
            stripeCheckoutSessionId: args.stripeCheckoutSessionId,
          },
          'pack webhook arrived without matching pending purchase row',
        );
        return { status: 'no_pending_purchase' as const, purchaseId: null };
      }
      if (existing.status === 'paid') {
        // Already credited. Stripe retries the webhook until we 2xx; this
        // path is the explicit idempotency guard.
        return {
          status: 'already_applied' as const,
          purchaseId: existing.id,
        };
      }

      const budget = await this.getOrCreateCurrentPeriodTx(tx, args.coachId);
      const multiplier = Number(budget.value_multiplier);
      const actualCreditCents = bankersRoundPaidToActual(
        args.paidCents,
        multiplier,
      );

      await tx.coachAIBudget.update({
        where: { id: budget.id },
        data: {
          pack_paid_cents: { increment: args.paidCents },
          pack_displayed_cents: { increment: args.paidCents },
        },
      });

      const purchase = await tx.coachCreditPackPurchase.update({
        where: { stripe_checkout_session_id: args.stripeCheckoutSessionId },
        data: {
          status: 'paid',
          applied_at: new Date(),
          actual_credit_cents: actualCreditCents,
          // We may not have known these IDs at session-mint time — back-fill.
          stripe_invoice_id: args.stripeInvoiceId ?? existing.stripe_invoice_id,
          stripe_payment_intent_id:
            args.stripePaymentIntentId ?? existing.stripe_payment_intent_id,
        },
      });

      return { status: 'applied' as const, purchaseId: purchase.id };
    });
  }

  /**
   * Owner-tooling: grant free credits (e.g. customer-success goodwill).
   * Goes through the same pack-purchase row machinery so the audit trail
   * is uniform, but stripe_checkout_session_id is null (free grants are
   * not Stripe-backed). paid_cents = 0; displayed_credit_cents = the
   * displayed amount the owner is granting.
   */
  async grantFreeCredits(args: {
    coachId: string;
    displayedCents: number;
    reason: string;
    actorOwnerId: string;
  }): Promise<{ purchaseId: string; budgetId: string }> {
    if (args.displayedCents <= 0) {
      throw new Error('grantFreeCredits: displayedCents must be > 0');
    }
    return this.prisma.$transaction(async (tx) => {
      const budget = await this.getOrCreateCurrentPeriodTx(tx, args.coachId);
      await tx.coachAIBudget.update({
        where: { id: budget.id },
        data: {
          pack_paid_cents: { increment: args.displayedCents },
          pack_displayed_cents: { increment: args.displayedCents },
        },
      });
      const purchase = await tx.coachCreditPackPurchase.create({
        data: {
          coach_user_id: args.coachId,
          budget_id: budget.id,
          // No Stripe session because this is a free grant. paid_cents = 0
          // so the row is distinguishable from a real purchase in reports.
          paid_cents: 0,
          displayed_credit_cents: args.displayedCents,
          actual_credit_cents: bankersRoundPaidToActual(
            args.displayedCents,
            Number(budget.value_multiplier),
          ),
          status: 'paid',
          applied_at: new Date(),
        },
      });
      this.logger.log(
        {
          event: 'COACH_AI_FREE_GRANT',
          coachId: args.coachId,
          displayedCents: args.displayedCents,
          actorOwnerId: args.actorOwnerId,
          reason: args.reason,
          purchaseId: purchase.id,
        },
        'free credit grant',
      );
      return { purchaseId: purchase.id, budgetId: budget.id };
    });
  }

  /**
   * Owner-tooling: refund a pack purchase. Reverses the displayed/paid
   * accumulators on the budget row and flips the purchase to 'refunded'.
   * Refuses to refund a purchase that is not currently 'paid' so we don't
   * double-reverse.
   */
  async refundPack(args: {
    purchaseId: string;
    actorOwnerId: string;
    reason: string;
  }): Promise<{ refunded: boolean; reason?: string }> {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.coachCreditPackPurchase.findUnique({
        where: { id: args.purchaseId },
      });
      if (!purchase) return { refunded: false, reason: 'not_found' };
      if (purchase.status !== 'paid') {
        return { refunded: false, reason: `status_${purchase.status}` };
      }
      await tx.coachAIBudget.update({
        where: { id: purchase.budget_id },
        data: {
          pack_paid_cents: { decrement: purchase.paid_cents },
          pack_displayed_cents: { decrement: purchase.displayed_credit_cents },
        },
      });
      await tx.coachCreditPackPurchase.update({
        where: { id: purchase.id },
        data: { status: 'refunded', refunded_at: new Date() },
      });
      this.logger.log(
        {
          event: 'COACH_AI_PACK_REFUND',
          purchaseId: purchase.id,
          coachId: purchase.coach_user_id,
          paidCents: purchase.paid_cents,
          actorOwnerId: args.actorOwnerId,
          reason: args.reason,
        },
        'pack refund',
      );
      return { refunded: true };
    });
  }

  /**
   * Monthly rollover: for each budget whose period_end <= now, expire the
   * base (reset actual_used_cents to 0, start a fresh period) but PRESERVE
   * pack credit accumulated this period — that's money the coach paid us;
   * we don't get to take it back. Audit doc said "Expire" for base — i.e.
   * unused base does not carry over.
   *
   * Wait — re-reading the spec: "Test T5: Monthly rollover expires base,
   * preserves packs". The interpretation is:
   *   - actual_used_cents → 0
   *   - base_* stays at the standard locked values (4000 / 12500)
   *   - pack_paid_cents / pack_displayed_cents survive the rollover
   *
   * This matches the operator's intent: a coach who bought $25 of credit
   * on day 28 of last month should walk into next month with $25 of pack
   * credit still available, on top of a fresh $125 base allowance.
   */
  async rolloverDueBudgets(now: Date = new Date()): Promise<{ rolled: number }> {
    const due = await this.prisma.coachAIBudget.findMany({
      where: { period_end: { lte: now } },
      select: { id: true },
    });
    if (due.length === 0) return { rolled: 0 };
    const periodStart = startOfCurrentPeriod(now);
    const periodEnd = new Date(periodStart.getTime() + PERIOD_MS);
    let rolled = 0;
    for (const row of due) {
      // One UPDATE per row so a concurrent recordUsage on a still-running
      // period (e.g. a budget whose end is in the past by minutes) gets
      // ordered cleanly via Postgres row-level locking.
      const result = await this.prisma.coachAIBudget.updateMany({
        where: { id: row.id, period_end: { lte: now } },
        data: {
          period_start: periodStart,
          period_end: periodEnd,
          actual_used_cents: 0,
          last_rollover_at: now,
          base_actual_cents: resolveMaxActualCents(),
          value_multiplier: new Prisma.Decimal(resolveValueMultiplier()),
          base_displayed_cents: resolveBaseDisplayedCents(),
          // pack_paid_cents / pack_displayed_cents intentionally left alone.
        },
      });
      rolled += result.count;
    }
    return { rolled };
  }

  /**
   * Convert a Prisma row into the in-process snapshot, normalising the
   * Decimal multiplier to Number and pre-computing the total available.
   */
  private toSnapshot(row: {
    id: string;
    coach_user_id: string;
    period_start: Date;
    period_end: Date;
    base_actual_cents: number;
    value_multiplier: Prisma.Decimal;
    base_displayed_cents: number;
    pack_paid_cents: number;
    pack_displayed_cents: number;
    actual_used_cents: number;
  }): BudgetSnapshot {
    const multiplier = Number(row.value_multiplier);
    // Pack money buys actual headroom at the same multiplier as the base
    // subsidy. paid_cents / multiplier == actual cents bought.
    const packActualCents = bankersRoundPaidToActual(row.pack_paid_cents, multiplier);
    return {
      id: row.id,
      coach_user_id: row.coach_user_id,
      period_start: row.period_start,
      period_end: row.period_end,
      base_actual_cents: row.base_actual_cents,
      value_multiplier: multiplier,
      base_displayed_cents: row.base_displayed_cents,
      pack_paid_cents: row.pack_paid_cents,
      pack_displayed_cents: row.pack_displayed_cents,
      actual_used_cents: row.actual_used_cents,
      total_actual_available_cents: row.base_actual_cents + packActualCents,
    };
  }
}

/**
 * Start-of-period helper. Calendar-month boundary in UTC. Kept module-
 * private so the service is the only owner of period bookkeeping.
 */
function startOfCurrentPeriod(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
