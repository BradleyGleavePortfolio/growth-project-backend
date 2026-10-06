// B-S-AICOST-123-1 — AI Guide (/ai/chat) draws from the coach's monthly AI
// credit pool, the same pool Roman and the coach AI tools use: the pool is
// checked before the paid provider call, and the reported usage is debited
// after it ($3 / $15 per million tokens, whole cents rounded up). Crisis and
// deterministic replies never spend; the owner and a client without a coach
// have no pool (the per-person daily token quota still applies).
import {
  AiService,
  AI_GUIDE_POOL_EMPTY_REPLY_CLIENT,
  aiGuideCostCents,
} from '../../src/ai/ai.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { AIGuardrailsService } from '../../src/ai/ai-guardrails.service';
import type { ClientAIContext } from '../../src/ai/client-ai-context.types';
import type { PrismaService } from '../../src/prisma.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import type { CoachAIStateService } from '../../src/ai/coach/coach-ai-state.service';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { COACH_AI_BUDGET_EXHAUSTED_CODE } from '../../src/ai-credits/ai-credits.constants';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

function makeContext(): ClientAIContext {
  return {
    identity: { first_name: 'Sam', age_years: 30, sex: 'female' },
    profile: {
      height_cm: 170,
      current_weight_lbs: 160,
      target_weight_lbs: 150,
      goal_type: 'fat_loss',
      activity_level: 'active',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: [],
      dietary_pattern: null,
      dietary_restrictions: [],
      workout_days_per_week: null,
      equipment_access: [],
      bio: null,
    },
    prescribed: {
      calories: 2000,
      protein_g: 150,
      carbs_g: 200,
      fat_g: 60,
      water_ml: 2500,
      meals_per_day: 4,
    },
    today: {
      date: '2026-10-05',
      calories: 900,
      protein_g: 60,
      carbs_g: 90,
      fat_g: 30,
      remaining_calories: 1100,
      remaining_protein_g: 90,
      pct_calories: 45,
    },
    recent_adherence_7d: [],
    recent_workouts: [],
    weight_trend_14d: [],
    habits: [],
    recent_check_ins: [],
    coach: {
      coach_name: 'Coach',
      has_coach: true,
      last_coach_message_excerpt: null,
      last_coach_message_at: null,
      active_guidelines_excerpt: null,
      coach_thread_summary: null,
    },
    current_meal_plan: null,
    fasting: { active_fast: null, last_fast: null },
    next_session: null,
    recent_wins: [],
    leaderboard: { opted_in: false, rank: null },
    guardrails: {
      forbid_calorie_recommendations_below: 1500,
      forbid_contradicting_macros: true,
      refer_to_coach_for_medical: true,
      forbid_extreme_dieting_language: true,
      forbid_unsafe_substances: true,
    },
    generated_at: '2026-10-05T12:00:00Z',
  };
}

interface PoolRow {
  used: number;
  total: number;
}

/** In-memory coach pools with the same canCharge / recordUsage rules. */
function makeBudget(pools: Record<string, PoolRow>, subCoachHead: Record<string, string> = {}) {
  const snapshot = (coachId: string) => {
    const p = pools[coachId];
    return { actual_used_cents: p.used, total_actual_available_cents: p.total };
  };
  const resolveHeadCoachId = jest.fn(async (id: string) => subCoachHead[id] ?? id);
  const canCharge = jest.fn(async (coachId: string, cents: number) => {
    const budget = snapshot(coachId);
    return { allowed: budget.actual_used_cents + cents <= budget.total_actual_available_cents, budget };
  });
  const recordUsage = jest.fn(
    async (args: { coachId: string; actualCostCents: number; capability: string }) => {
      const p = pools[args.coachId];
      if (p.used + args.actualCostCents > p.total) return { recorded: false, budgetId: args.coachId };
      p.used += args.actualCostCents;
      return { recorded: true, budgetId: args.coachId };
    },
  );
  return {
    budget: fakeOf<CoachAIBudgetService>({ resolveHeadCoachId, canCharge, recordUsage }),
    resolveHeadCoachId,
    canCharge,
    recordUsage,
  };
}

function makeService(opts: {
  users: Record<string, { role: string; coach_id: string | null }>;
  budget: CoachAIBudgetService;
  engineReady?: boolean;
}) {
  const ctx = makeContext();
  const renderer = new ClientAIContextService(fakeOf<PrismaService>({}));
  const ctxSvc = fakeOf<ClientAIContextService>({
    build: jest.fn().mockResolvedValue(ctx),
    buildFresh: jest.fn().mockResolvedValue(ctx),
    renderForPrompt: (c: ClientAIContext) => renderer.renderForPrompt(c),
  });
  const quotaUpsert = jest.fn().mockResolvedValue({ tokens_used: 0, request_count: 0 });
  const quotaUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = fakeOf<PrismaService>({
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => opts.users[where.id] ?? null),
    },
    userAIQuota: { upsert: quotaUpsert, updateMany: quotaUpdate },
    aiRequestAudit: { create: jest.fn().mockResolvedValue({}) },
  });
  const complete = jest.fn().mockResolvedValue({
    text: 'Keep protein near 150 g today.',
    tokensIn: 2000,
    tokensOut: 400,
  });
  const ready = opts.engineReady ?? true;
  const svc = new AiService(
    prisma,
    ctxSvc,
    new AIGuardrailsService(),
    fakeOf<AnalyticsService>({ capture: jest.fn(), identify: jest.fn() }),
    grantAllEgress(),
    fakeOf<AnthropicAdapter>({ complete }),
    fakeOf<CoachAIStateService>({ isReady: () => ready }),
    opts.budget,
  );
  return { svc, complete, quotaUpsert };
}

describe('AI Guide draws from the coach monthly AI credit pool (B-S-AICOST-123-1)', () => {
  it('a client whose coach pool is used up gets the credits reply: no provider call, no quota, no debit', async () => {
    const pools = { 'coach-1': { used: 4000, total: 4000 } };
    const b = makeBudget(pools);
    const { svc, complete, quotaUpsert } = makeService({
      users: { 'client-1': { role: 'student', coach_id: 'coach-1' } },
      budget: b.budget,
    });

    const result = await svc.chat('client-1', 'What should dinner look like tonight?', []);

    expect(complete).not.toHaveBeenCalled();
    expect(quotaUpsert).not.toHaveBeenCalled();
    expect(b.recordUsage).not.toHaveBeenCalled();
    expect(result.reply).toBe(AI_GUIDE_POOL_EMPTY_REPLY_CLIENT);
    expect(result.code).toBe(COACH_AI_BUDGET_EXHAUSTED_CODE);
    expect(result.degraded).toBe(false);
    // Client copy: no coach credit figures, no first person, no exclamation.
    expect(result.reply).not.toMatch(/\$|\d|\bI\b|\bme\b|\bmy\b|!/);
    expect(pools['coach-1'].used).toBe(4000);
  });

  it('a pool smaller than one whole answer is treated as used up', async () => {
    const b = makeBudget({ 'coach-1': { used: 3999, total: 4000 } });
    const { svc, complete } = makeService({
      users: { 'client-1': { role: 'student', coach_id: 'coach-1' } },
      budget: b.budget,
    });

    const result = await svc.chat('client-1', 'Is a rest day fine after leg day?', []);

    expect(complete).not.toHaveBeenCalled();
    expect(result.code).toBe(COACH_AI_BUDGET_EXHAUSTED_CODE);
  });

  it("a paid answer debits its actual cost, rounded up, from the head coach's pool", async () => {
    const pools = { 'head-1': { used: 100, total: 4000 } };
    const b = makeBudget(pools, { 'sub-1': 'head-1' });
    const { svc, complete } = makeService({
      users: { 'client-1': { role: 'student', coach_id: 'sub-1' } },
      budget: b.budget,
    });

    const result = await svc.chat('client-1', 'How much protein at lunch?', []);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.model_used).toBe('anthropic');
    expect(result.code).toBeUndefined();
    // 2,000 in + 400 out at $2 / $10 = $0.008 -> 1 cent (rounded up).
    expect(aiGuideCostCents(2000, 400)).toBe(1);
    expect(b.recordUsage).toHaveBeenCalledTimes(1);
    expect(b.recordUsage.mock.calls[0][0]).toMatchObject({ coachId: 'head-1', actualCostCents: 1 });
    expect(pools['head-1'].used).toBe(101);
  });

  it('a crisis message gets the safety reply and never touches the pool', async () => {
    const b = makeBudget({ 'coach-1': { used: 4000, total: 4000 } });
    const { svc, complete } = makeService({
      users: { 'client-1': { role: 'student', coach_id: 'coach-1' } },
      budget: b.budget,
    });

    const result = await svc.chat('client-1', 'I want to kill myself', []);

    expect(result.model_used).toBe('safety');
    expect(result.reply).toContain('988');
    expect(complete).not.toHaveBeenCalled();
    expect(b.canCharge).not.toHaveBeenCalled();
    expect(b.recordUsage).not.toHaveBeenCalled();
  });

  it('the deterministic responder (engine not ready) spends nothing from the pool', async () => {
    const b = makeBudget({ 'coach-1': { used: 4000, total: 4000 } });
    const { svc } = makeService({
      users: { 'client-1': { role: 'student', coach_id: 'coach-1' } },
      budget: b.budget,
      engineReady: false,
    });

    const result = await svc.chat('client-1', 'Meal ideas for today', []);

    expect(result.model_used).toBe('fallback');
    expect(b.canCharge).not.toHaveBeenCalled();
    expect(b.recordUsage).not.toHaveBeenCalled();
  });

  it('the owner and a client without a coach have no pool: answered, nothing debited', async () => {
    const b = makeBudget({});
    const { svc, complete } = makeService({
      users: {
        owner: { role: 'owner', coach_id: null },
        'solo-client': { role: 'student', coach_id: null },
      },
      budget: b.budget,
    });

    const ownerReply = await svc.chat('owner', 'Training notes for today', []);
    const soloReply = await svc.chat('solo-client', 'Training notes for today', []);

    expect(ownerReply.model_used).toBe('anthropic');
    expect(soloReply.model_used).toBe('anthropic');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(b.canCharge).not.toHaveBeenCalled();
    expect(b.recordUsage).not.toHaveBeenCalled();
  });
});
