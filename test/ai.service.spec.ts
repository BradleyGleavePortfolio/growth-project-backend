// Module-level OpenAI mock. The ai.service file constructs a Perplexity
// client at import time, so we have to replace `openai` before importing
// the service. The mock exposes a settable `__nextResponse` so individual
// tests can choose the model output (or throw) without re-importing.
const mockCreate = jest.fn();
jest.mock('openai', () => {
  const ctor = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  return { __esModule: true, default: ctor };
});

import { AiService } from '../src/ai/ai.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { AIGuardrailsService } from '../src/ai/ai-guardrails.service';
import { ClientAIContext } from '../src/ai/client-ai-context.types';

function makeContext(): ClientAIContext {
  return {
    identity: { first_name: 'Brad', age_years: 33, sex: 'male' },
    profile: {
      height_cm: 183,
      current_weight_lbs: 192,
      target_weight_lbs: 178,
      goal_type: 'fat_loss',
      activity_level: 'active',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: ['cottage cheese'],
      dietary_pattern: null,
      dietary_restrictions: [],
      workout_days_per_week: null,
      equipment_access: [],
      bio: null,
    },
    prescribed: {
      calories: 2400,
      protein_g: 200,
      carbs_g: 240,
      fat_g: 70,
      water_ml: 2950,
      meals_per_day: 4,
    },
    today: {
      date: '2026-04-27',
      calories: 800,
      protein_g: 60,
      carbs_g: 100,
      fat_g: 25,
      remaining_calories: 1600,
      remaining_protein_g: 140,
      pct_calories: 33,
    },
    recent_adherence_7d: [],
    recent_workouts: [],
    weight_trend_14d: [],
    habits: [],
    recent_check_ins: [],
    coach: {
      coach_name: 'Sasha',
      has_coach: true,
      last_coach_message_excerpt: 'Stay strict on dinner carbs.',
      last_coach_message_at: '2026-04-26T18:00:00Z',
      active_guidelines_excerpt: null,
      coach_thread_summary: null,
    },
    current_meal_plan: null,
    guardrails: {
      forbid_calorie_recommendations_below: 1500,
      forbid_contradicting_macros: true,
      refer_to_coach_for_medical: true,
      forbid_extreme_dieting_language: true,
      forbid_unsafe_substances: true,
    },
    generated_at: '2026-04-27T12:00:00Z',
  };
}

function makeService() {
  // Build the ai.service with a context service stub returning a known
  // context. We don't go through PrismaService here because we want the
  // tests to focus on chat orchestration (prompt assembly, fallback,
  // guardrail wiring) rather than the DB.
  const ctx = makeContext();
  const ctxSvc = {
    build: jest.fn().mockResolvedValue(ctx),
    buildFresh: jest.fn().mockResolvedValue(ctx),
    renderForPrompt: new ClientAIContextService({} as any).renderForPrompt.bind({
      // need to satisfy `this` for renderForPrompt — use a minimal stand-in.
    }) as any,
  };
  // Compose the real renderForPrompt by binding to a fresh instance.
  ctxSvc.renderForPrompt = (c: ClientAIContext) =>
    new ClientAIContextService({} as any).renderForPrompt(c);
  const guardrails = new AIGuardrailsService();
  const prisma = {} as any;
  const analyticsStub = { capture: jest.fn(), identify: jest.fn() } as any;
  return { svc: new AiService(prisma, ctxSvc as any, guardrails, analyticsStub), ctxSvc };
}

describe('AiService.chat', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('uses the typed context to build the system prompt', async () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Eat 200g protein and stay on your calorie target.' } }],
    });
    const { svc } = makeService();
    const result = await svc.chat('u1', 'how am I doing today', []);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    const system = args.messages[0].content as string;
    expect(args.messages[0].role).toBe('system');
    // Prompt must include APP_PRESCRIBED targets and coach last-message marker.
    expect(system).toContain('APP_PRESCRIBED');
    expect(system).toContain('calories=2400');
    expect(system).toContain('Stay strict on dinner carbs');
    // Reply round-trips and surfaces context generation timestamp.
    expect(result.reply).toContain('200g protein');
    expect(result.context_generated_at).toBe('2026-04-27T12:00:00Z');
    expect(result.model_used).toBe('perplexity');
  });

  it('falls back gracefully when no API key is configured', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const { svc } = makeService();
    const result = await svc.chat('u1', 'how am I doing today', []);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.model_used).toBe('fallback');
    // Fallback still uses real prescribed targets from context.
    expect(result.reply).toMatch(/2400/);
  });

  it('falls back when the provider throws', async () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    mockCreate.mockRejectedValue(new Error('upstream 500'));
    const { svc } = makeService();
    const result = await svc.chat('u1', 'macro plan please', []);
    expect(result.model_used).toBe('fallback');
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('runs guardrails on the model reply and reports what was applied', async () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Try 1100 calories and eat 100g protein daily.' } }],
    });
    const { svc } = makeService();
    const result = await svc.chat('u1', 'help me cut', []);
    expect(result.guardrails_applied).toEqual(
      expect.arrayContaining(['calorie-floor', 'macro-correction']),
    );
    expect(result.reply).toContain('safety floor');
    expect(result.reply).toContain('200g protein');
  });

  it('prepends a coach-referral when the user asks a medical question', async () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Take an anti-inflammatory.' } }],
    });
    const { svc } = makeService();
    const result = await svc.chat('u1', 'I think I have an injury in my shoulder', []);
    expect(result.guardrails_applied).toContain('refer-to-coach');
    expect(result.reply).toContain('Sasha');
  });

  it('does not pass conversation_history beyond the last 10 turns', async () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });
    const { svc } = makeService();
    const big = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    await svc.chat('u1', 'final', big);
    const args = mockCreate.mock.calls[0][0];
    // 1 system + 10 history + 1 final = 12
    expect(args.messages.length).toBe(12);
  });
});
