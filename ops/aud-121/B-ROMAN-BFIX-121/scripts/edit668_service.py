import sys
root=sys.argv[1]
def load(p): return open(root+'/'+p).read()
def save(p,s): open(root+'/'+p,'w').write(s)
def rep(s,old,new,cnt=1):
    assert s.count(old)==cnt, (old[:80], s.count(old))
    return s.replace(old,new)
p='src/roman/roman.service.ts'; s=load(p)
s=rep(s,"""  ROMAN_PRICE_PER_MTOK,
  romanFailureMessage,
  romanRateLimitMessage,
} from './roman.constants';
""","""  ROMAN_PRICE_PER_MTOK,
  ROMAN_COACH_POOL_EMPTY_MESSAGE,
  ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH,
  romanAudienceOf,
  romanFailureMessage,
  romanRateLimitMessage,
} from './roman.constants';
import { CoachAIBudgetService } from '../ai-credits/coach-ai-budget.service';
import { CoachAiBudgetExhaustedException } from '../ai-credits/budget-exhausted.exception';
import { COACH_AI_BUDGET_EXHAUSTED_CODE } from '../ai-credits/ai-credits.constants';
""")
s=rep(s,"""    @Optional()
    private readonly audit: AuditService | null = null,
  ) {}
""","""    @Optional()
    private readonly audit: AuditService | null = null,
    // B-668-1: the coach's monthly AI credit pool (src/ai-credits, @Global
    // AiCreditsModule, so Nest always provides it). Every paid turn is
    // checked against it before the provider call and debited after it.
    @Optional()
    private readonly budget: CoachAIBudgetService | null = null,
  ) {}
""")
s=rep(s,"""    const grounded = session.surface === 'client' && caller.role === 'student';
    const reservation = await this.reserveDailySpend(caller);
""","""    const grounded = session.surface === 'client' && caller.role === 'student';
    // B-668-1: the coach pool is re-checked here (the controller checked it
    // before storing the turn) and refuses before any spend is reserved.
    const poolCoachId = await this.assertCoachPoolOpen(caller);
    const reservation = await this.reserveDailySpend(caller);
    // Every settle path that spent tokens also debits the coach pool.
    const settle = async (
      inputTokens: number,
      outputTokens: number,
      metadata: Record<string, string | number | boolean | string[] | null>,
    ): Promise<void> => {
      await this.settleSpend(reservation, inputTokens, outputTokens, metadata);
      await this.debitCoachPool(poolCoachId, inputTokens, outputTokens, reservation);
    };
""")
s=rep(s,"""        await this.settleSpend(reservation, 0, 0, { outcome: 'refused' });
        throw err;""","""        await settle(0, 0, { outcome: 'refused' });
        throw err;""")
s=rep(s,"""      await this.settleSpend(reservation, promptTokens ?? 0, completionTokens ?? 0, {
        outcome: 'model_error',
      });""","""      await settle(promptTokens ?? 0, completionTokens ?? 0, {
        outcome: 'model_error',
      });""")
s=rep(s,"""      await this.settleSpend(reservation, promptTokens ?? 0, completionTokens ?? 0, {
        outcome: err instanceof NotFoundException ? 'session_gone' : 'persist_failed',""","""      await settle(promptTokens ?? 0, completionTokens ?? 0, {
        outcome: err instanceof NotFoundException ? 'session_gone' : 'persist_failed',""")
s=rep(s,"""    await this.settleSpend(reservation, promptTokens ?? 0, completionTokens ?? 0, {
      outcome: interrupted ? 'interrupted' : 'ok',""","""    await settle(promptTokens ?? 0, completionTokens ?? 0, {
      outcome: interrupted ? 'interrupted' : 'ok',""")
s=rep(s,"""  // ─── helpers ─────────────────────────────────────────────────────────────

  private isUniqueViolation(""","""  // ─── Coach AI credit pool (B-668-1, owner 11:40-11:41) ──────────────────

  /**
   * Whose monthly pool pays for this caller's turns: a client's coach (a
   * sub-coach's client draws on the head coach), a coach's own (a
   * sub-coach's head coach). The owner and a client without a coach have no
   * pool; the per-client turn limit and the daily spend ceiling still apply.
   * Same attribution as the AI gateway (resolveBudgetCoachId).
   */
  private async poolCoachIdFor(
    budget: CoachAIBudgetService,
    caller: RomanCaller,
  ): Promise<string | null> {
    if (caller.role === 'owner') return null;
    if (caller.role === 'coach') return budget.resolveHeadCoachId(caller.id);
    const user = await this.prisma.user.findUnique({
      where: { id: caller.id },
      select: { coach_id: true },
    });
    return user?.coach_id ? budget.resolveHeadCoachId(user.coach_id) : null;
  }

  /**
   * B-668-1: refuse a paid turn when the coach's monthly pool is used up:
   * 402 COACH_AI_BUDGET_EXHAUSTED with copy written for the caller (a client
   * never sees the coach's credit figures; a coach also gets the pack
   * options). Runs in the controller before the user turn is stored and
   * again in the turn before any spend is reserved. A pool that cannot be
   * read fails closed (coded 503, no provider call). Returns the pool's
   * coach id for the debit, or null when the caller has no pool.
   */
  async assertCoachPoolOpen(caller: RomanCaller): Promise<string | null> {
    const budget = this.budget;
    if (!budget) return null;
    let coachId: string | null;
    let exhausted = false;
    try {
      coachId = await this.poolCoachIdFor(budget, caller);
      if (!coachId) return null;
      // Same gate as the AI gateway: refuse once the pool is at or over its ceiling.
      const pre = await budget.canCharge(coachId, 0);
      exhausted = pre.budget.actual_used_cents >= pre.budget.total_actual_available_cents;
    } catch (err) {
      this.logger.error(`roman.coach_pool_failed: ${romanErrorTag(err)}`);
      Sentry.captureException(romanSanitizedError('roman.coach_pool_failed', err), {
        tags: { feature: 'roman', op: 'roman.pool' },
      });
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: romanFailureMessage('capacity_unknown', caller.role),
      });
    }
    if (!exhausted) return coachId;
    this.logger.warn(`roman.coach_pool_empty role=${caller.role}`);
    if (romanAudienceOf(caller.role) === 'client') {
      throw new HttpException(
        { code: COACH_AI_BUDGET_EXHAUSTED_CODE, message: ROMAN_COACH_POOL_EMPTY_MESSAGE },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const dto = await budget.getBudgetDto(coachId);
    throw new CoachAiBudgetExhaustedException({
      code: COACH_AI_BUDGET_EXHAUSTED_CODE,
      message: ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH,
      pack_options_cents: dto.pack_options_cents,
      custom_pack_bounds_cents: dto.custom_pack_bounds_cents,
      budget: {
        period_end: dto.period_end,
        base_displayed_cents: dto.base_displayed_cents,
        pack_displayed_cents: dto.pack_displayed_cents,
        used_displayed_cents: dto.used_displayed_cents,
        remaining_displayed_cents: dto.remaining_displayed_cents,
      },
    });
  }

  /**
   * B-668-1: debit the turn's actual cost (the same tokens the ledger
   * settles) from the coach pool, in whole cents rounded up. The provider
   * call already happened, so a failed debit is logged and reported, never
   * thrown at the client.
   */
  private async debitCoachPool(
    coachId: string | null,
    inputTokens: number,
    outputTokens: number,
    requestId: string,
  ): Promise<void> {
    if (!coachId || !this.budget) return;
    const cents = Math.ceil(RomanService.costUsd(inputTokens, outputTokens) * 100);
    if (cents <= 0) return;
    try {
      await this.budget.recordUsage({
        coachId,
        actualCostCents: cents,
        capability: ROMAN_LEDGER_CAPABILITY,
        contextId: requestId,
      });
    } catch (err) {
      this.logger.error(`roman.coach_pool_debit_failed: ${romanErrorTag(err)}`);
      Sentry.captureException(romanSanitizedError('roman.coach_pool_debit_failed', err), {
        tags: { feature: 'roman', op: 'roman.pool' },
      });
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private isUniqueViolation(""")
s=rep(s,"""/**
 * The typed facts the post-check may compare against, from the SAME bundle
 * the model saw (B-R8-2). Extra kcal facts: today's food entries, wearable
 * active energy and the meal-plan slot numbers.
 */
export function postCheckContextOf(ctx: RomanClientContext): PostCheckContext {
  const extra: number[] = [
    ...ctx.today.entries.map((e) => e.kcal),
    ...ctx.wearables.days.map((d) => d.active_kcal).filter((n): n is number => n !== null),
    ...(ctx.wearables.avg_7d.active_kcal !== null ? [ctx.wearables.avg_7d.active_kcal] : []),
    ...(ctx.meal_plan?.items ?? []).flatMap((item) =>
      [...item.matchAll(/(\\d{2,5}) kcal/g)].map((m) => Number(m[1])),
    ),
    ...ctx.last_7_days.days.map((d) => d.kcal),
  ];
  return {
    targets: ctx.targets,
    today: ctx.today,
    last_7_days: ctx.last_7_days,
    macro_method: { floor_kcal: ctx.macro_method.floor_kcal },
    coach: { has_coach: ctx.coach.has_coach, coach_first_name: ctx.coach.coach_first_name },
    extra_kcal_facts: extra,
  };
}""","""/**
 * The typed facts the post-check may compare against, from the SAME bundle
 * the model saw (B-R8-2). B-668-3: the extra kcal facts keep their family,
 * day and source (today's entries, earlier days' intake, burned today,
 * burned on earlier days and the 7-day average, meal-plan slots), so one kind
 * of number never validates a claim about another.
 */
export function postCheckContextOf(ctx: RomanClientContext): PostCheckContext {
  const today = ctx.today.date;
  const burned = (days: RomanClientContext['wearables']['days']) =>
    days.map((d) => d.active_kcal).filter((n): n is number => n !== null);
  return {
    targets: ctx.targets,
    today: ctx.today,
    last_7_days: ctx.last_7_days,
    macro_method: { floor_kcal: ctx.macro_method.floor_kcal },
    coach: { has_coach: ctx.coach.has_coach, coach_first_name: ctx.coach.coach_first_name },
    kcal_facts: {
      intake_entries_today: ctx.today.entries.map((e) => e.kcal),
      intake_past_days: ctx.last_7_days.days.filter((d) => d.date !== today).map((d) => d.kcal),
      burned_today: burned(ctx.wearables.days.filter((d) => d.date === today)),
      burned_past: [
        ...burned(ctx.wearables.days.filter((d) => d.date !== today)),
        ...(ctx.wearables.avg_7d.active_kcal !== null ? [ctx.wearables.avg_7d.active_kcal] : []),
      ],
      meal_plan: (ctx.meal_plan?.items ?? []).flatMap((item) =>
        [...item.matchAll(/(\\d{2,5}) kcal/g)].map((m) => Number(m[1])),
      ),
    },
  };
}""")
save(p,s)
print('service ok')
