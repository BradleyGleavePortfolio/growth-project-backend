/**
 * B-AIB1-125 — Coach AI v1 (workout program, meal plan, client insight) and
 * the MWB-5 live-create gateway capabilities are metered against the coach AI
 * credit pool (owner A6.4: every AI turn debits the pool).
 *
 *   - The set names all five capabilities.
 *   - A used-up pool refuses with the gateway's 402 COACH_AI_BUDGET_EXHAUSTED
 *     body BEFORE any provider call or draft write.
 *   - With headroom, the call's cost (AnthropicAdapter token pricing) is
 *     debited from the head coach's pool (a sub-coach draws on the head's).
 *   - A failed debit is logged, never thrown at the coach.
 */
import { CoachAIService } from '../../src/ai/coach/coach-ai.service';
import { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import { COACH_AI_CAPABILITIES } from '../../src/ai/coach/coach-ai.constants';
import { WorkoutProgramPrompt } from '../../src/ai/prompts/workout-program.prompt';
import { MealPlanPrompt } from '../../src/ai/prompts/meal-plan.prompt';
import { ClientInsightPrompt } from '../../src/ai/prompts/client-insight.prompt';
import { CoachAiBudgetExhaustedException } from '../../src/ai-credits/budget-exhausted.exception';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import {
  COACH_AI_BUDGET_EXHAUSTED_CODE,
  COACH_AI_METERED_CAPABILITIES,
} from '../../src/ai-credits/ai-credits.constants';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

type Method = 'generateWorkoutProgram' | 'generateMealPlan' | 'generateClientInsight';
const METHODS: Array<[Method, string]> = [
  ['generateWorkoutProgram', COACH_AI_CAPABILITIES.WORKOUT_PROGRAM],
  ['generateMealPlan', COACH_AI_CAPABILITIES.MEAL_PLAN],
  ['generateClientInsight', COACH_AI_CAPABILITIES.INSIGHT],
];

const TOKENS_IN = 120_000;
const TOKENS_OUT = 30_000;

beforeAll(() => {
  for (const p of [WorkoutProgramPrompt, MealPlanPrompt, ClientInsightPrompt]) {
    jest.spyOn(p, 'buildUser').mockReturnValue('prompt');
  }
});

function budgetDouble(opts: { used: number; available: number; recordFails?: boolean }) {
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => (id === 'sub1' ? 'head1' : id)),
    canCharge: jest.fn(async () => ({
      allowed: opts.used < opts.available,
      budget: { actual_used_cents: opts.used, total_actual_available_cents: opts.available },
    })),
    getBudgetDto: jest.fn(async () => ({
      period_end: '2026-11-01T00:00:00.000Z',
      base_displayed_cents: 12500,
      pack_displayed_cents: 0,
      used_displayed_cents: 12500,
      remaining_displayed_cents: 0,
      pack_options_cents: [1000, 2500, 9900],
      custom_pack_bounds_cents: { min: 1000, max: 50000 },
    })),
    recordUsage: jest.fn(async () => {
      if (opts.recordFails) throw new Error('db down');
      return { recorded: true, budgetId: 'b1' };
    }),
  };
  return budget;
}

function build(budget: ReturnType<typeof budgetDouble>) {
  const completeStructured = jest.fn(async () => ({
    data: { ok: true },
    tokensIn: TOKENS_IN,
    tokensOut: TOKENS_OUT,
    modelUsed: 'm',
    latencyMs: 1,
  }));
  const prisma = { aIDraft: { create: jest.fn(async () => ({ id: 'draft-1' })) } };
  const svc = new CoachAIService(
    fakeOf(prisma),
    fakeOf({ isReady: () => true }),
    fakeOf({ completeStructured }),
    fakeOf({ build: jest.fn(async () => ({ prescribed: { calories: null, protein_g: null } })) }),
    fakeOf({}),
    fakeOf({ assertCanAccessClient: jest.fn(async () => undefined) }),
    fakeOf<CoachAIBudgetService>(budget),
  );
  const call = (m: Method, coachId = 'coach1') =>
    m === 'generateWorkoutProgram'
      ? svc.generateWorkoutProgram(coachId, { clientId: 'client1', weeks: 4, daysPerWeek: 3 })
      : m === 'generateMealPlan'
        ? svc.generateMealPlan(coachId, { clientId: 'client1', days: 7 })
        : svc.generateClientInsight(coachId, { clientId: 'client1' });
  return { call, completeStructured, prisma };
}

describe('B-AIB1-125 — metered capability set', () => {
  it.each([
    'workout_program',
    'meal_plan',
    'insight',
    'draft.create_workout_plan',
    'draft.edit_workout_plan',
  ])('meters %s', (cap) => {
    expect(COACH_AI_METERED_CAPABILITIES.has(cap)).toBe(true);
  });
});

describe.each(METHODS)('CoachAIService.%s — coach AI pool', (method, capability) => {
  it('used-up pool: 402 COACH_AI_BUDGET_EXHAUSTED, no provider call, no draft', async () => {
    const budget = budgetDouble({ used: 4000, available: 4000 });
    const { call, completeStructured, prisma } = build(budget);
    const err = await call(method).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoachAiBudgetExhaustedException);
    const ex = err as CoachAiBudgetExhaustedException;
    expect(ex.getStatus()).toBe(402);
    expect(ex.getResponse()).toMatchObject({
      code: COACH_AI_BUDGET_EXHAUSTED_CODE,
      pack_options_cents: [1000, 2500, 9900],
      budget: { remaining_displayed_cents: 0 },
    });
    expect(completeStructured).not.toHaveBeenCalled();
    expect(prisma.aIDraft.create).not.toHaveBeenCalled();
    expect(budget.recordUsage).not.toHaveBeenCalled();
  });

  it("headroom: generates and debits the call's cost from the pool", async () => {
    const budget = budgetDouble({ used: 100, available: 4000 });
    const { call, completeStructured } = build(budget);
    await expect(call(method)).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(completeStructured).toHaveBeenCalledTimes(1);
    expect(budget.recordUsage).toHaveBeenCalledWith({
      coachId: 'coach1',
      actualCostCents: AnthropicAdapter.computeCostCents(TOKENS_IN, TOKENS_OUT),
      capability,
      contextId: 'client1',
    });
    expect(AnthropicAdapter.computeCostCents(TOKENS_IN, TOKENS_OUT)).toBeGreaterThan(0);
  });

  it("sub-coach: checks and debits the head coach's pool", async () => {
    const budget = budgetDouble({ used: 0, available: 4000 });
    const { call } = build(budget);
    await call(method, 'sub1');
    expect(budget.canCharge).toHaveBeenCalledWith('head1', 0);
    expect(budget.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ coachId: 'head1', capability }),
    );
  });

  it('debit failure after the call: logged, the draft is still returned', async () => {
    const budget = budgetDouble({ used: 0, available: 4000, recordFails: true });
    const { call } = build(budget);
    await expect(call(method)).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(budget.recordUsage).toHaveBeenCalledTimes(1);
  });
});
