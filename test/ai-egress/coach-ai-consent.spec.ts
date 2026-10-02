/**
 * R2b — box-2 consent on the Coach AI surfaces and the declared
 * no-client-data exemptions.
 *
 *   CoachAIService (workout program, meal plan, insight): the client is the
 *     data subject; ownership 404 comes before any consent read.
 *   WeeklyInsightCron: clients without a grant are skipped quietly.
 *   CoachAIStateService: the boot probe sends a fixed "ping" (health_probe).
 *   FirstWinService / AiRoadmapService: proofs that no client data flows.
 *
 * The send-time recheck inside AnthropicAdapter is covered in
 * test/ai/anthropic-adapter.spec.ts; here the adapter double performs the
 * same gate call the real one does, so grant / no grant / revoked / ledger
 * error are observable per surface.
 */
import {
  AnthropicHandle,
  PerplexityHandle,
  type AnthropicMessagesClient,
  type PerplexityChatClient,
} from '../../src/ai-egress/ai-egress.service';
import { CoachAIService } from '../../src/ai/coach/coach-ai.service';
import { WeeklyInsightCron } from '../../src/ai/coach/weekly-insight.cron';
import { CoachAIStateService } from '../../src/ai/coach/coach-ai-state.service';
import { WorkoutProgramPrompt } from '../../src/ai/prompts/workout-program.prompt';
import { MealPlanPrompt } from '../../src/ai/prompts/meal-plan.prompt';
import { ClientInsightPrompt } from '../../src/ai/prompts/client-insight.prompt';
import { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { FirstWinService } from '../../src/first-win/first-win.service';
import { AiRoadmapService } from '../../src/diagnostic/ai-roadmap.service';
import { DiagnosticService } from '../../src/diagnostic/diagnostic.service';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import type { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { clientDataSubject } from '../../src/ai-egress/ai-egress.types';
import { egressWithGrants, fakeOf, FakeConsentReader } from './ai-egress.fakes';

type Method = 'generateWorkoutProgram' | 'generateMealPlan' | 'generateClientInsight';
const METHODS: Array<[Method, string]> = [
  ['generateWorkoutProgram', 'coach_ai.workout_program'],
  ['generateMealPlan', 'coach_ai.meal_plan'],
  ['generateClientInsight', 'coach_ai.insight'],
];

beforeAll(() => {
  for (const p of [WorkoutProgramPrompt, MealPlanPrompt, ClientInsightPrompt]) {
    jest.spyOn(p, 'buildUser').mockReturnValue('prompt');
  }
});

function buildCoachAi(granted: string[]) {
  const { egress, reader } = egressWithGrants(granted);
  // Mirrors AnthropicAdapter.completeStructured: the gate runs before send.
  const completeStructured = jest.fn(async (_p: unknown, _v: unknown, opts: any) => {
    await egress.assertMaySend(opts.dataSubject, 'anthropic', opts.surface);
    return { data: { ok: true }, tokensIn: 1, tokensOut: 1, modelUsed: 'm', latencyMs: 1 };
  });
  const prisma = { aIDraft: { create: jest.fn(async () => ({ id: 'draft-1' })) } };
  const workouts = {
    assertCanAccessClient: jest.fn(async (coachId: string, clientId: string) => {
      if (!(coachId === 'coach1' && clientId === 'client1')) throw new Error('no access');
    }),
  };
  const svc = new CoachAIService(
    fakeOf(prisma),
    fakeOf({ isReady: () => true }),
    fakeOf({ completeStructured }),
    // No prescribed macros: the meal-plan tolerance check returns early.
    fakeOf({ build: jest.fn(async () => ({ prescribed: { calories: null, protein_g: null } })) }),
    fakeOf({}),
    fakeOf(workouts),
  );
  const call = (m: Method, clientId = 'client1') =>
    m === 'generateWorkoutProgram'
      ? svc.generateWorkoutProgram('coach1', { clientId, weeks: 4, daysPerWeek: 3 })
      : m === 'generateMealPlan'
        ? svc.generateMealPlan('coach1', { clientId, days: 7 })
        : svc.generateClientInsight('coach1', { clientId });
  return { call, completeStructured, reader };
}

describe.each(METHODS)('CoachAIService.%s — R2b', (method, surface) => {
  it('grant: generated, client is the data subject', async () => {
    const { call, completeStructured } = buildCoachAi(['client1']);
    await call(method);
    const opts = completeStructured.mock.calls[0][2];
    expect(opts.dataSubject).toEqual(clientDataSubject('client1', 'coach'));
    expect(opts.surface).toBe(surface);
  });

  it('no grant: 403 ai_consent_required', async () => {
    const { call } = buildCoachAi([]);
    await expect(call(method)).rejects.toBeInstanceOf(AiConsentRequiredException);
  });

  it('revoked: the next request is refused', async () => {
    const { call, reader } = buildCoachAi(['client1']);
    await call(method);
    reader.revoke('client1');
    await expect(call(method)).rejects.toBeInstanceOf(AiConsentRequiredException);
  });

  it('ledger error: fails closed', async () => {
    const { call, reader } = buildCoachAi(['client1']);
    reader.failWith = new Error('db down');
    await expect(call(method)).rejects.toBeInstanceOf(AiConsentRequiredException);
  });

  it("another coach's client: 404 before any consent read", async () => {
    const { call, reader, completeStructured } = buildCoachAi(['client2']);
    await expect(call(method, 'client2')).rejects.toThrow('Client not found');
    expect(reader.calls).toHaveLength(0);
    expect(completeStructured).not.toHaveBeenCalled();
  });
});

describe('WeeklyInsightCron — R2b', () => {
  const ORIGINAL = process.env.CRON_COACH_AI_INSIGHT;
  beforeEach(() => {
    process.env.CRON_COACH_AI_INSIGHT = 'on';
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_COACH_AI_INSIGHT;
    else process.env.CRON_COACH_AI_INSIGHT = ORIGINAL;
  });

  function build(
    reader: FakeConsentReader,
    egress: AiEgressService,
    generate: jest.Mock = jest.fn(async () => ({})),
  ) {
    const svc = {
      listActiveCoachIds: jest.fn(async () => ['coach1']),
      listActiveClientsForCoach: jest.fn(async () => ['a', 'b', 'c']),
      generateClientInsight: generate,
    };
    const cron = new WeeklyInsightCron(
      fakeOf(svc),
      fakeOf({ isReady: () => true }),
      fakeOf({ shouldSkipCoach: jest.fn(async () => false) }),
      egress,
    );
    return { cron, generate };
  }

  it('grant / no grant: only consenting clients get an insight', async () => {
    const { egress, reader } = egressWithGrants(['a', 'c']);
    const { cron, generate } = build(reader, egress);
    await cron.runWeekly();
    expect(
      generate.mock.calls.map((c: unknown[]) => (c[1] as { clientId: string }).clientId),
    ).toEqual(['a', 'c']);
  });

  it('revoked mid-run: the refusal is skipped quietly and the run continues', async () => {
    const { egress, reader } = egressWithGrants(['a', 'b', 'c']);
    const generate = jest.fn(async (_coach: string, input: { clientId: string }) => {
      if (input.clientId === 'b') throw new AiConsentRequiredException('coach');
      return {};
    });
    const { cron } = build(reader, egress, generate);
    await expect(cron.runWeekly()).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('ledger error: nobody is processed (fail closed)', async () => {
    const { egress, reader } = egressWithGrants(['a', 'b', 'c']);
    reader.failWith = new Error('db down');
    const { cron, generate } = build(reader, egress);
    await cron.runWeekly();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('CoachAIStateService probe — health_probe exemption (no client data)', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('sends only the fixed "ping" and never reads the ledger', async () => {
    process.env.NODE_ENV = 'production';
    const { egress, reader } = egressWithGrants([]);
    const create = jest.fn(async () => ({ content: [] }));
    const state = new CoachAIStateService(
      fakeOf({ get: () => 'sk-test' }),
      egress,
      AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>({ messages: { create } })),
    );
    await state.onApplicationBootstrap();
    expect(state.isReady()).toBe(true);
    expect(create.mock.calls[0]).toEqual([
      { model: expect.any(String), max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] },
      { maxRetries: 0 },
    ]);
    expect(reader.calls).toHaveLength(0);
  });
});

describe('AnthropicProviderAdapter (gateway) — R2b', () => {
  it('hands the gateway-derived data subject to the egress-gated adapter', async () => {
    const complete = jest.fn(async (_prompt: unknown, _opts: unknown) => ({
      text: 'ok',
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: 'm',
      latencyMs: 1,
    }));
    const adapter = new AnthropicProviderAdapter(
      fakeOf({ complete }),
      fakeOf({ isReady: () => true }),
    );
    const subject = clientDataSubject('client-1', 'coach');
    await adapter.complete({
      capability: 'client_chat',
      dataSubject: subject,
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'u' }],
      requestId: 'r1',
    });
    expect(complete.mock.calls[0][1]).toMatchObject({
      dataSubject: subject,
      surface: 'gateway',
      clientId: 'client-1',
    });
  });
});

describe('No-client-data exemptions (proof)', () => {
  it('first-win: the prompt is one of four fixed strings; no id, name or value is sent', async () => {
    const prev = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'pk-test';
    const { egress } = egressWithGrants([]);
    const create = jest.fn(async () => ({
      choices: [{ message: { content: 'A fixed two sentence reply here.' } }],
    }));
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn(async () => ({ first_win_completed_at: null })),
        update: jest.fn(async () => ({})),
      },
    };
    const svc = new FirstWinService(fakeOf(prisma), egress);
    svc['_perplexity'] = PerplexityHandle.bind(
      fakeOf<PerplexityChatClient>({ chat: { completions: { create } } }),
    );
    svc['_perplexityInitialized'] = true;
    for (const win of [
      'logged_first_weight',
      'set_first_goal',
      'first_checkin',
      'first_meal',
    ] as const) {
      await svc.complete('user-secret-id-123', win);
    }
    if (prev === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = prev;
    const sent = JSON.stringify(create.mock.calls);
    expect(sent).not.toContain('user-secret-id-123');
    const userTurns = create.mock.calls.map(
      (c: unknown[]) => (c[0] as { messages: Array<{ content: string }> }).messages[1].content,
    );
    expect(new Set(userTurns).size).toBe(4);
    for (const t of userTurns)
      expect(t).toMatch(/^The client has just [a-z0-9 -]+\. Write the 2-sentence message\.$/);
  });

  it('diagnostic roadmap: the prompt carries no email, name, age or source', () => {
    const diag = new DiagnosticService(fakeOf({}), fakeOf({}));
    const answers = Array.from({ length: 40 }, (_, i) => ({ question_id: i + 1, answer: 3 }));
    const { scores, buckets } = diag.computeScores(answers);
    const { egress } = egressWithGrants([]);
    const roadmap = new AiRoadmapService(fakeOf({}), egress);
    const prompt = roadmap.buildUserPrompt(
      {
        email: 'prospect@example.test',
        name: 'Prospect Person',
        age: 41,
        source: 'lead_magnet',
        answers,
      },
      scores,
      buckets,
    );
    for (const pii of ['prospect@example.test', 'Prospect Person', 'lead_magnet', '41 years']) {
      expect(prompt).not.toContain(pii);
    }
  });
});
