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

import {
  AiService,
  DAILY_TOKEN_QUOTA,
  MAX_TOKENS_PER_CALL,
  AI_DAILY_QUOTA_EXCEEDED,
} from '../src/ai/ai.service';
import { HttpException, HttpStatus } from '@nestjs/common';
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
    generated_at: '2026-04-27T12:00:00Z',
  };
}

// In-memory UserAIQuota ledger keyed by `${user_id}|${quota_date ISO}` so the
// quota tests can exercise reserve/reconcile + day rollover without a DB. The
// updateMany honours the atomic guard (where tokens_used <= threshold) and the
// increment/decrement ops, mirroring Prisma's semantics closely enough to test
// the race-safe reservation path.
function makeQuotaStub() {
  const rows = new Map<string, { user_id: string; quota_date: string; tokens_used: number; request_count: number }>();
  const keyOf = (user_id: string, quota_date: Date | string) =>
    `${user_id}|${quota_date instanceof Date ? quota_date.toISOString() : quota_date}`;
  const userAIQuota = {
    upsert: jest.fn(async ({ where, create }: any) => {
      const { user_id, quota_date } = where.UserAIQuota_user_id_quota_date_key;
      const k = keyOf(user_id, quota_date);
      if (!rows.has(k)) {
        rows.set(k, {
          user_id,
          quota_date: quota_date instanceof Date ? quota_date.toISOString() : quota_date,
          tokens_used: create.tokens_used ?? 0,
          request_count: create.request_count ?? 0,
        });
      }
      return rows.get(k);
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const k = keyOf(where.user_id, where.quota_date);
      const row = rows.get(k);
      if (!row) return { count: 0 };
      // Apply the atomic guard on tokens_used (lte / gte) if present.
      const guard = where.tokens_used;
      if (guard) {
        if (guard.lte !== undefined && !(row.tokens_used <= guard.lte)) return { count: 0 };
        if (guard.gte !== undefined && !(row.tokens_used >= guard.gte)) return { count: 0 };
      }
      if (data.tokens_used?.increment !== undefined) row.tokens_used += data.tokens_used.increment;
      if (data.tokens_used?.decrement !== undefined) row.tokens_used -= data.tokens_used.decrement;
      if (data.request_count?.increment !== undefined) row.request_count += data.request_count.increment;
      return { count: 1 };
    }),
  };
  return { rows, keyOf, userAIQuota, aiRequestAudit: { create: jest.fn().mockResolvedValue({}) } };
}

function makeService(prismaOverride?: any) {
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
  const quota = makeQuotaStub();
  const prisma = (prismaOverride ?? quota) as any;
  const analyticsStub = { capture: jest.fn(), identify: jest.fn() } as any;
  return { svc: new AiService(prisma, ctxSvc as any, guardrails, analyticsStub), ctxSvc, quota: prisma };
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
    const big = Array.from({ length: 25 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }));
    await svc.chat('u1', 'final', big);
    const args = mockCreate.mock.calls[0][0];
    // 1 system + 10 history + 1 final = 12
    expect(args.messages.length).toBe(12);
  });
});

describe('AiService.chat daily token quota (A1)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.PERPLEXITY_API_KEY = 'test-key';
  });

  it('under cap: the call proceeds and the daily counter increments', async () => {
    // Provider reports actual usage so we reconcile the reservation down.
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'On track. Hit your 200g protein.' } }],
      usage: { total_tokens: 250 },
    });
    const { svc, quota } = makeService();
    const result = await svc.chat('u1', 'how am I doing today', []);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.model_used).toBe('perplexity');
    // One ledger row, reconciled to the provider's actual 250 tokens, 1 request.
    const rows = [...quota.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_used).toBe(250);
    expect(rows[0].request_count).toBe(1);
  });

  it('at cap: rejects with 429 AI_DAILY_QUOTA_EXCEEDED and never calls the model', async () => {
    const { svc, quota } = makeService();
    // Seed today's row at the cap so any new reservation must be rejected.
    const today = (svc as any).getQuotaDate() as Date;
    quota.rows.set(quota.keyOf('u1', today), {
      user_id: 'u1',
      quota_date: today.toISOString(),
      tokens_used: DAILY_TOKEN_QUOTA,
      request_count: 99,
    });
    await expect(svc.chat('u1', 'how am I doing today', [])).rejects.toMatchObject({
      response: { error: AI_DAILY_QUOTA_EXCEEDED },
    });
    // Confirm it is a 429 HttpException and the model was never invoked.
    let status: number | undefined;
    try {
      await svc.chat('u1', 'again', []);
    } catch (e) {
      if (e instanceof HttpException) status = e.getStatus();
    }
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('day rollover: a new quota_date gets a fresh budget row', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 300 },
    });
    const { svc, quota } = makeService();
    const day1 = new Date(Date.UTC(2026, 3, 27));
    const day2 = new Date(Date.UTC(2026, 3, 28));
    const spy = jest.spyOn(svc as any, 'getQuotaDate');
    spy.mockReturnValue(day1);
    await svc.chat('u1', 'day one', []);
    spy.mockReturnValue(day2);
    await svc.chat('u1', 'day two', []);
    // Two distinct rows — the rollover started a fresh budget.
    expect(quota.rows.size).toBe(2);
    expect(quota.rows.get(quota.keyOf('u1', day1))!.tokens_used).toBe(300);
    expect(quota.rows.get(quota.keyOf('u1', day2))!.tokens_used).toBe(300);
  });

  it('concurrent same-user requests never exceed the cap', async () => {
    // A successful provider reply with NO usage reported => each call holds its
    // full conservative reservation (estimated input + MAX_TOKENS_PER_CALL), so
    // the cap is the limiting factor on how many can proceed. The per-call
    // reservation now accounts for TOTAL tokens (P1-a), so we derive the
    // expected capacity from the observed reservation size rather than the old
    // output-only MAX_TOKENS_PER_CALL.
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });

    // Measure the per-call reservation empirically: one isolated call on a
    // fresh service leaves exactly one reservation on the ledger (no usage =>
    // no reconcile/refund).
    const probe = makeService();
    await probe.svc.chat('u1', 'concurrent', []);
    const perCallReservation = [...probe.quota.rows.values()][0].tokens_used;
    expect(perCallReservation).toBeGreaterThan(MAX_TOKENS_PER_CALL); // total > output-only
    const capacity = Math.floor(DAILY_TOKEN_QUOTA / perCallReservation);
    // Reset the shared module-level mock so the probe's call does not count
    // toward the concurrent-run invocation assertion below.
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });

    const { svc, quota } = makeService();
    const attempts = capacity + 10; // oversubscribe
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => svc.chat('u1', 'concurrent', [])),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(capacity);
    expect(rejected).toBe(attempts - capacity);
    // Final ledger never exceeds the cap, and the model ran exactly `ok` times.
    const row = [...quota.rows.values()][0];
    expect(row.tokens_used).toBeLessThanOrEqual(DAILY_TOKEN_QUOTA);
    expect(row.tokens_used).toBe(capacity * perCallReservation);
    expect(mockCreate).toHaveBeenCalledTimes(capacity);
  });

  // P1-a — the daily cap must bound TOTAL tokens (prompt + completion), not
  // just the 600-token output ceiling. A provider that reports a large TOTAL
  // usage (input + output) must be charged that full total against the daily
  // ledger so subsequent calls are correctly gated and the cap cannot be
  // overshot by under-counting input tokens.
  it('total-token accounting: charges the full provider TOTAL (input+output), not just output', async () => {
    // Provider reports a total far larger than MAX_TOKENS_PER_CALL (600) — i.e.
    // the input side dominated. The ledger must reflect the true 1500 total.
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 1500 },
    });
    const { svc, quota } = makeService();
    await svc.chat('u1', 'how am I doing today', []);
    const row = [...quota.rows.values()][0];
    // The persisted daily usage equals the true TOTAL tokens, which exceeds the
    // old output-only MAX_TOKENS_PER_CALL — proving total-token accounting.
    expect(row.tokens_used).toBe(1500);
    expect(row.tokens_used).toBeGreaterThan(MAX_TOKENS_PER_CALL);
  });

  // P1-a — a large reported TOTAL is bounded by the daily cap: once the ledger
  // reflects true total usage, a subsequent call that would push past the cap
  // is rejected with 429. This prevents the 12000 cap from being overshot by
  // many high-total calls.
  it('total-token accounting: high-total calls are gated by the daily cap', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 4000 },
    });
    const { svc, quota } = makeService();
    // Three 4000-total calls = 12000 exactly => at cap. The 4th must be 429.
    await svc.chat('u1', 'one', []);
    await svc.chat('u1', 'two', []);
    await svc.chat('u1', 'three', []);
    const row = [...quota.rows.values()][0];
    expect(row.tokens_used).toBe(DAILY_TOKEN_QUOTA); // 12000, bounded
    await expect(svc.chat('u1', 'four', [])).rejects.toMatchObject({
      response: { error: AI_DAILY_QUOTA_EXCEEDED },
    });
  });

  // P1-b — when the provider call FAILS after the reservation, the reserved
  // quota must be released (refunded) so a failed call does not permanently
  // consume budget. The provider throws, the service falls back to the
  // deterministic responder (no billable tokens), and the finally path refunds
  // the entire reservation back to zero.
  it('failed provider call refunds the full reservation (no quota leak)', async () => {
    mockCreate.mockRejectedValue(new Error('upstream 500'));
    const { svc, quota } = makeService();
    const result = await svc.chat('u1', 'how am I doing today', []);
    // Fell back, but the daily ledger is fully refunded — nothing leaked.
    expect(result.model_used).toBe('fallback');
    const row = [...quota.rows.values()][0];
    expect(row.tokens_used).toBe(0);
    // request_count is intentionally NOT decremented (it counts attempts);
    // only the reserved TOKENS are refunded.
    expect(row.request_count).toBe(1);
  });

  // P1-b — repeated failures never erode the daily budget: after many failed
  // calls the ledger is still zero, so a legitimate (successful) call still has
  // its full budget available.
  it('repeated failed calls never erode the daily budget', async () => {
    mockCreate.mockRejectedValue(new Error('upstream 500'));
    const { svc, quota } = makeService();
    for (let i = 0; i < 5; i++) {
      await svc.chat('u1', 'fail please', []);
    }
    const row = [...quota.rows.values()][0];
    expect(row.tokens_used).toBe(0);
  });

  // P2 — a request that crosses midnight must reconcile against the SAME day
  // bucket it reserved against. We make getQuotaDate return day1 at reservation
  // time and day2 at the (would-be) reconcile time. The reconcile must still
  // land on day1 (the captured key), so day1's row reflects the reconciled
  // actual and day2 is never touched.
  it('midnight cross: reconciles against the reservation day, not the reconcile-time day', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 250 },
    });
    const { svc, quota } = makeService();
    const day1 = new Date(Date.UTC(2026, 3, 27));
    const day2 = new Date(Date.UTC(2026, 3, 28));
    const spy = jest.spyOn(svc as any, 'getQuotaDate');
    // First call (reservation) sees day1; any later getQuotaDate would see day2.
    spy.mockReturnValueOnce(day1).mockReturnValue(day2);
    await svc.chat('u1', 'crosses midnight', []);
    // The reconcile used the CAPTURED day1 key, so day1 holds the reconciled
    // actual (250) and day2 was never created/charged.
    const day1Row = quota.rows.get(quota.keyOf('u1', day1));
    expect(day1Row).toBeDefined();
    expect(day1Row!.tokens_used).toBe(250);
    expect(quota.rows.get(quota.keyOf('u1', day2))).toBeUndefined();
  });
});
