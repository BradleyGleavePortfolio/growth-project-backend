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
// Round-1 fixer changes (post-audit):
//   - P0-6: applyCreditPack / grantFreeCredits / refundPack now accept an
//     optional Prisma.TransactionClient so callers (e.g. the Stripe
//     webhook path inside BillingService.handleEvent) can thread their
//     outer transaction in. The inner $transaction is only opened when
//     no tx is supplied, matching the established
//     `getOrCreateCurrentPeriodTx` pattern.
//   - P0-1: grantFreeCredits sets is_free_grant=true. paid_cents stays 0;
//     displayed_credit_cents is the granted amount. The relaxed CHECK
//     (>= instead of =) accepts this.
//   - P1-3: period_end is the start of the NEXT calendar month, not a
//     30-day offset. See startOfNextMonth() at the bottom of the file.
//   - P1-6: recordUsage adds period_end > now to its WHERE clause so a
//     debit can never land in an already-rolled period.
//   - P1-7: resolveHeadCoachId caches the last attribution per
//     sub_coach_id and logs SUB_COACH_HEAD_REATTRIBUTED when it changes.
//   - P1-8: budget ceiling and snapshot use the stored
//     total_pack_actual_cents column instead of rounding the aggregate
//     pack_paid_cents at read time. applyCreditPack increments the
//     column by the per-pack already-rounded actual_credit_cents.

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
  /** Per-pack already-rounded actual credit, summed. P1-8. */
  total_pack_actual_cents: number;
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

/** Prisma client OR an active transaction — both share the model namespace. */
type DbClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class CoachAIBudgetService {
  private readonly logger = new Logger(CoachAIBudgetService.name);

  // P1-7 — track the last-resolved head coach per sub-coach so we can
  // log when attribution swings. Process-local; on a Fly redeploy the
  // map starts empty and the first call after deploy will (correctly)
  // log nothing because there is no "previous" value to compare to.
  // Bounded growth: one entry per distinct sub-coach the process serves.
  private readonly headCoachAttributionCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the head-coach id that owns the budget for a given user.
   * Sub-coaches share their head coach's budget; if the user is not a
   * sub-coach the id is returned as-is. Head coaches with NO assignment
   * also pass through unchanged.
   *
   * P1-7: when a sub-coach's resolution lands on a DIFFERENT head coach
   * than the last cached attribution for that sub-coach, emit a
   * SUB_COACH_HEAD_REATTRIBUTED structured log. This surfaces silent
   * swings (e.g. the old assignment was archived and a new one
   * created) that would otherwise re-route the budget envelope without
   * any audit trail.
   */
  async resolveHeadCoachId(userId: string): Promise<string> {
    const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: userId, archived_at: null },
      orderBy: { created_at: 'asc' },
      select: { head_coach_id: true },
    });
    const resolved = assignment?.head_coach_id ?? userId;

    // Cache + reattribution detection — only meaningful when the user IS
    // a sub-coach (i.e. assignment was found). For head coaches the
    // resolved id == userId every time; tracking it would just bloat
    // the map.
    if (assignment) {
      const cached = this.headCoachAttributionCache.get(userId);
      if (cached && cached !== resolved) {
        this.logger.log(
          {
            event: 'SUB_COACH_HEAD_REATTRIBUTED',
            subCoachId: userId,
            oldHeadCoachId: cached,
            newHeadCoachId: resolved,
          },
          'sub-coach head-coach attribution changed',
        );
      }
      this.headCoachAttributionCache.set(userId, resolved);
    }

    return resolved;
  }

  /**
   * Idempotent: returns an existing budget row for the current period, or
   * creates one with the locked defaults.
   */
  async getOrCreateCurrentPeriod(coachId: string): Promise<BudgetSnapshot> {
    return this.getOrCreateCurrentPeriodTx(this.prisma, coachId);
  }

  /**
   * Transactional sibling — used inside the Stripe webhook's $transaction.
   */
  async getOrCreateCurrentPeriodTx(
    tx: DbClient,
    coachId: string,
  ): Promise<BudgetSnapshot> {
    const existing = await tx.coachAIBudget.findUnique({
      where: { coach_user_id: coachId },
    });
    if (existing) return this.toSnapshot(existing);

    const now = new Date();
    const periodStart = startOfCurrentMonth(now);
    const periodEnd = startOfNextMonth(periodStart);

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
   *
   * P1-6: the WHERE clause now also pins `period_end > now()` so a debit
   * can never land in an already-rolled period (which would silently
   * apply to the new period's base rather than the period the call was
   * billed against).
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
    const now = new Date();
    const result = await this.prisma.coachAIBudget.updateMany({
      where: {
        id: budget.id,
        // P1-6: refuse if the period rolled between read and write.
        period_end: { gt: now },
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
          periodEnd: budget.period_end.toISOString(),
        },
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
      pack_options_cents: [1000, 2500, 9900],
      custom_pack_bounds_cents: { min: 1000, max: 50_000 },
    };
  }

  /**
   * P2-1 — exposed publicly to match spec §1 item 5 verbatim.
   * Equivalent to `getBudgetDto(coachId).remaining_displayed_cents`.
   */
  async getRemainingDisplayed(coachId: string): Promise<number> {
    const dto = await this.getBudgetDto(coachId);
    return dto.remaining_displayed_cents;
  }

  /**
   * Apply a paid credit pack. Idempotent on stripe_checkout_session_id.
   *
   * P0-6: accepts an optional outer transaction client. When the caller
   * (StripeWebhookController → BillingService.handleEvent →
   * CoachAiCreditPackService.handleStripeEvent) wants the credit-apply
   * write to commit atomically with the dedup row, it passes its tx.
   * When called from any other path (admin tooling, recovery scripts)
   * the method opens its own $transaction.
   *
   * Preconditions: the caller MUST have already created the CCPP row in
   * 'pending' state when the checkout session was minted. If the row is
   * missing we treat the event as a stray webhook and refuse to credit.
   */
  async applyCreditPack(
    args: {
      coachId: string;
      paidCents: number;
      stripeCheckoutSessionId: string;
      stripeInvoiceId?: string | null;
      stripePaymentIntentId?: string | null;
    },
    outerTx?: Prisma.TransactionClient,
  ): Promise<{
    status: 'applied' | 'already_applied' | 'no_pending_purchase';
    purchaseId: string | null;
  }> {
    const work = async (tx: DbClient) => {
      const existing = await tx.coachCreditPackPurchase.findUnique({
        where: { stripe_checkout_session_id: args.stripeCheckoutSessionId },
      });
      if (!existing) {
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

      // P1-8: increment the stored aggregate by the per-pack rounded
      // value so the ceiling read in toSnapshot matches the sum of
      // CCPP receipts exactly.
      await tx.coachAIBudget.update({
        where: { id: budget.id },
        data: {
          pack_paid_cents: { increment: args.paidCents },
          pack_displayed_cents: { increment: args.paidCents },
          total_pack_actual_cents: { increment: actualCreditCents },
        },
      });

      const purchase = await tx.coachCreditPackPurchase.update({
        where: { stripe_checkout_session_id: args.stripeCheckoutSessionId },
        data: {
          status: 'paid',
          applied_at: new Date(),
          actual_credit_cents: actualCreditCents,
          stripe_invoice_id: args.stripeInvoiceId ?? existing.stripe_invoice_id,
          stripe_payment_intent_id:
            args.stripePaymentIntentId ?? existing.stripe_payment_intent_id,
        },
      });

      return { status: 'applied' as const, purchaseId: purchase.id };
    };

    if (outerTx) return work(outerTx);
    return this.prisma.$transaction(work);
  }

  /**
   * Owner-tooling: grant free credits.
   *
   * P0-1 fix — the CCPP row now carries is_free_grant=true. paid_cents
   * stays 0; displayed_credit_cents is the granted amount. The CHECK
   * constraint was relaxed from `=` to `>=` in the round-1 migration so
   * this insert no longer 500s in production.
   */
  async grantFreeCredits(
    args: {
      coachId: string;
      displayedCents: number;
      reason: string;
      actorOwnerId: string;
    },
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ purchaseId: string; budgetId: string }> {
    if (args.displayedCents <= 0) {
      throw new Error('grantFreeCredits: displayedCents must be > 0');
    }
    const work = async (tx: DbClient) => {
      const budget = await this.getOrCreateCurrentPeriodTx(tx, args.coachId);
      const actualCreditCents = bankersRoundPaidToActual(
        args.displayedCents,
        Number(budget.value_multiplier),
      );
      await tx.coachAIBudget.update({
        where: { id: budget.id },
        data: {
          // A free grant does NOT increment pack_paid_cents (no money
          // moved); it only adds displayed credit. The actual headroom
          // is still tracked in total_pack_actual_cents so recordUsage's
          // ceiling reflects the grant.
          pack_displayed_cents: { increment: args.displayedCents },
          total_pack_actual_cents: { increment: actualCreditCents },
        },
      });
      const purchase = await tx.coachCreditPackPurchase.create({
        data: {
          coach_user_id: args.coachId,
          budget_id: budget.id,
          paid_cents: 0,
          displayed_credit_cents: args.displayedCents,
          actual_credit_cents: actualCreditCents,
          status: 'paid',
          applied_at: new Date(),
          is_free_grant: true,
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
    };
    if (outerTx) return work(outerTx);
    return this.prisma.$transaction(work);
  }

  /**
   * Owner-tooling: refund a pack purchase. Reverses the displayed/paid
   * accumulators on the budget row (including the actual-headroom
   * column) and flips the purchase to 'refunded'. Refuses to refund a
   * purchase that is not currently 'paid' so we don't double-reverse.
   */
  async refundPack(
    args: {
      purchaseId: string;
      actorOwnerId: string;
      reason: string;
    },
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ refunded: boolean; reason?: string }> {
    const work = async (tx: DbClient) => {
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
          total_pack_actual_cents: { decrement: purchase.actual_credit_cents },
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
    };
    if (outerTx) return work(outerTx);
    return this.prisma.$transaction(work);
  }

  /**
   * Monthly rollover: for each budget whose period_end <= now, expire the
   * base (reset actual_used_cents to 0, start a fresh period) but PRESERVE
   * pack credit accumulated this period — that's money the coach paid us;
   * we don't get to take it back.
   *
   * P1-3: period_end is the start of the next calendar month, not a
   * 30-day offset. See startOfNextMonth().
   */
  async rolloverDueBudgets(now: Date = new Date()): Promise<{ rolled: number }> {
    const due = await this.prisma.coachAIBudget.findMany({
      where: { period_end: { lte: now } },
      select: { id: true },
    });
    if (due.length === 0) return { rolled: 0 };
    const periodStart = startOfCurrentMonth(now);
    const periodEnd = startOfNextMonth(periodStart);
    let rolled = 0;
    for (const row of due) {
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
          // pack_paid_cents / pack_displayed_cents / total_pack_actual_cents
          // intentionally left alone — paid credit carries over.
        },
      });
      rolled += result.count;
    }
    return { rolled };
  }

  /**
   * Convert a Prisma row into the in-process snapshot. P1-8: uses the
   * stored total_pack_actual_cents column instead of round-the-sum so
   * the ceiling matches the per-pack receipts exactly.
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
    total_pack_actual_cents: number;
  }): BudgetSnapshot {
    const multiplier = Number(row.value_multiplier);
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
      total_pack_actual_cents: row.total_pack_actual_cents,
      total_actual_available_cents:
        row.base_actual_cents + row.total_pack_actual_cents,
    };
  }
}

/** First-of-month UTC at 00:00. */
function startOfCurrentMonth(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

/** First-of-next-month UTC at 00:00. P1-3 — handles year boundary via Date(). */
function startOfNextMonth(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
}
