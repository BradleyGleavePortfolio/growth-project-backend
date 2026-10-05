import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { RomanService, postCheckContextOf } from '../../src/roman/roman.service';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import {
  AnthropicHandle, type AnthropicMessagesClient,
} from '../../src/ai-egress/ai-egress.service';
import {
  postCheckRomanReply,
} from '../../src/roman/guardrails/roman-post-check';
import { ROMAN_MAX_OUTPUT_TOKENS } from '../../src/roman/roman.constants';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import { egressWithGrants, fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'audit-client', role: 'student', tier: 'free' as const };
const SESSION = {
  id: 'audit-session', user_id: CLIENT.id, surface: 'client' as const,
  day_key: '2026-10-05', message_count: 1,
  started_at: new Date(), last_activity_at: new Date(),
  quips_in_session: 0, exclamation_used: false, subject_context_json: null,
  created_at: new Date(), updated_at: new Date(), deleted_at: null,
};
let savedFlag: string | undefined;
let savedCap: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  savedCap = process.env.ROMAN_DAILY_COST_CAP_USD;
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env.ROMAN_DAILY_COST_CAP_USD = '25';
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  else process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = savedFlag;
  if (savedCap === undefined) delete process.env.ROMAN_DAILY_COST_CAP_USD;
  else process.env.ROMAN_DAILY_COST_CAP_USD = savedCap;
  jest.restoreAllMocks();
});

function db() {
  const audits: Array<Record<string, unknown>> = [];
  const stored: Array<Record<string, unknown>> = [];
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `msg-${stored.length + 1}`, ...data };
      stored.push(row);
      return row;
    }),
    findMany: jest.fn(async () => [{ role: 'user', content: 'hello', created_at: new Date() }]),
    findFirst: jest.fn(async () => ({ content: 'hello', created_at: new Date() })),
    count: jest.fn(async () => 0),
  };
  const romanSession = {
    updateMany: jest.fn(async () => ({ count: 1 })),
    aggregate: jest.fn(async () => ({
      _sum: { message_count: 0 }, _min: { last_activity_at: null },
    })),
  };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push({ ...data });
      return data;
    }),
    aggregate: jest.fn(async () => ({
      _sum: {
        prompt_token_estimate: audits.reduce((sum, row) => sum + Number(row.prompt_token_estimate), 0),
        response_token_estimate: audits.reduce((sum, row) => sum + Number(row.response_token_estimate), 0),
      },
    })),
    update: jest.fn(async ({ where, data }: {
      where: { request_id: string }; data: Record<string, unknown>;
    }) => {
      const row = audits.find((item) => item.request_id === where.request_id);
      if (row) Object.assign(row, data);
      return row;
    }),
  };
  const prisma = {
    romanMessage, romanSession, aiRequestAudit,
    user: { findUnique: jest.fn(async () => ({ id: CLIENT.id, role: 'student', coach_id: 'audit-coach' })) },
    coachAIBudget: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $transaction: jest.fn(async (fn: (tx: object) => Promise<unknown>) => fn({
      romanMessage, romanSession, aiRequestAudit,
    })),
  };
  return { prisma, stored, audits };
}

function anthropic(options: { partial?: boolean; promptTokens?: number } = {}) {
  const client = {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: options.promptTokens ?? 1000 } } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Keep the plan as written.' } };
          if (options.partial) throw new Error('synthetic transport interruption');
          yield { type: 'message_delta', usage: { output_tokens: 50 } };
        },
      })),
      create: jest.fn(),
    },
  };
  return { client, handle: AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client)) };
}
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const output: unknown[] = [];
  for await (const chunk of gen) output.push(chunk);
  return output;
}

function contextWithExtraFacts(): RomanClientContext {
  return fakeOf<RomanClientContext>({
    targets: { source: 'coach_set', calories: 2000, protein_g: 120, carbs_g: 140, fat_g: 45 },
    today: {
      kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25, meals_logged: 2,
      remaining_kcal: 1220, remaining_protein_g: 60, remaining_carbs_g: 70,
      remaining_fat_g: 20, pct_kcal: 39, pct_protein: 50,
      entries: [{ kcal: 200 }],
    },
    last_7_days: {
      days_logged: 5, avg_kcal_on_logged_days: 1900,
      avg_protein_g_on_logged_days: 110, days_within_10pct_kcal: 4,
      days: [{ date: '2026-10-04', kcal: 1850 }],
    },
    macro_method: { floor_kcal: 1200 },
    coach: { has_coach: true, coach_first_name: 'Alex' },
    wearables: { days: [{ date: '2026-10-05', active_kcal: 2500 }], avg_7d: { active_kcal: 2400 } },
    meal_plan: null,
  });
}

describe('AUD-SOL-RB-121 day-1 coach pool and client quota', () => {
  it('a successful paid Roman turn debits CoachAIBudget through recordUsage', async () => {
    const meter = jest.spyOn(CoachAIBudgetService.prototype, 'recordUsage').mockResolvedValue({
      recorded: true, budgetId: 'audit-budget',
    });
    const { prisma, audits } = db();
    const provider = anthropic();
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), provider.handle);
    await drain(svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'hello' }));
    console.info(JSON.stringify({
      probe: 'coach_pool_debit', providerCalls: provider.client.messages.stream.mock.calls.length,
      recordUsageCalls: meter.mock.calls.length, ledger: audits,
    }));
    expect(provider.client.messages.stream).toHaveBeenCalledTimes(1);
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({
      coachId: 'audit-coach', capability: 'roman.chat',
    }));
  });

  it('an empty coach pool blocks the provider with its distinct budget code', async () => {
    const gate = jest.spyOn(CoachAIBudgetService.prototype, 'canCharge').mockResolvedValue({
      allowed: false, budget: fakeOf({}),
    });
    const { prisma } = db();
    const provider = anthropic();
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), provider.handle);
    const result = await drain(svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'hello' }))
      .then(() => ({ fulfilled: true, code: null }))
      .catch((err: { response?: { code?: string } }) => ({ fulfilled: false, code: err.response?.code }));
    console.info(JSON.stringify({
      probe: 'empty_coach_pool', result, gateCalls: gate.mock.calls.length,
      providerCalls: provider.client.messages.stream.mock.calls.length,
    }));
    expect(result).toMatchObject({ fulfilled: false, code: 'COACH_AI_BUDGET_EXHAUSTED' });
    expect(provider.client.messages.stream).not.toHaveBeenCalled();
  });

  it('per-client daily exhaustion carries the day-1 daily-quota code', async () => {
    const { prisma } = db();
    prisma.romanMessage.count.mockResolvedValue(50);
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), null);
    const result = await svc.assertWithinRateLimit(CLIENT)
      .then(() => ({ rejected: false, code: null }))
      .catch((err: { response: { code: string; retryAfterSeconds: number } }) => ({
        rejected: true, code: err.response.code, retryAfterSeconds: err.response.retryAfterSeconds,
      }));
    console.info(JSON.stringify({ probe: 'client_daily_cap_code', result }));
    expect(result.rejected).toBe(true);
    expect(['ROMAN_CAPACITY_REACHED', 'AI_DAILY_QUOTA_EXCEEDED']).toContain(result.code);
  });
});

describe('AUD-SOL-RB-121 converter retains semantic field/date provenance', () => {
  it.each([
    'You have logged 2500 kcal today.',
    'You have logged 1850 kcal today.',
    'You burned 200 kcal today.',
  ])('an unrelated same-unit fact cannot validate: %s', (reply) => {
    const actual = postCheckRomanReply(reply, {
      routerClass: 'normal', context: postCheckContextOf(contextWithExtraFacts()),
    });
    console.info(JSON.stringify({ probe: 'pooled_extra_fact', reply, actual }));
    expect(actual.rewritten).toBe(true);
    expect(actual.guardrails_applied).toContain('ungrounded_number');
  });
});

describe('AUD-SOL-RB-121 independently replay disclosed C2-owned defects', () => {
  it('unknown completion usage after paid partial output retains its reservation', async () => {
    const { prisma, audits } = db();
    const provider = anthropic({ partial: true });
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), provider.handle);
    await drain(svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'hello' }));
    console.info(JSON.stringify({ probe: 'C2_unknown_usage', ledger: audits }));
    expect(audits[0].response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
  });

  it('crisis turn with no consent/provider writes only the neutral restricted-reason action', async () => {
    const { prisma, audits } = db();
    const { egress } = egressWithGrants([]);
    const audit = { write: jest.fn(async (_input: object) => undefined) };
    const svc = new RomanService(fakeOf(prisma), egress, null, null, fakeOf(audit));
    const output = await drain(svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'I cannot breathe.' }));
    console.info(JSON.stringify({
      probe: 'C2_neutral_crisis_action', audit: audit.write.mock.calls, ledger: audits,
    }));
    expect(output).toHaveLength(2);
    expect(audits).toHaveLength(0);
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'roman.safety_route', metadata: { route_reason: 'call_911' },
    }));
  });

  it('unaffordable concurrent reservation admits exactly one affordable turn', async () => {
    process.env.ROMAN_DAILY_COST_CAP_USD = '0.1';
    const { prisma } = db();
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), null);
    const result = await Promise.allSettled([
      svc.reserveDailySpend(CLIENT), svc.reserveDailySpend(CLIENT),
    ]);
    console.info(JSON.stringify({ probe: 'C2_atomic_admission', statuses: result.map((item) => item.status) }));
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  });

  it('reservation bounds the exact payload rather than a fixed average estimate', async () => {
    const { prisma, audits } = db();
    prisma.romanMessage.findMany.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'roman',
      content: 'x'.repeat(8000), created_at: new Date(),
    })));
    const provider = anthropic({ promptTokens: 40000 });
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), provider.handle);
    const reserves: number[] = [];
    const original = prisma.aiRequestAudit.create.getMockImplementation()!;
    prisma.aiRequestAudit.create.mockImplementation(async (args) => {
      reserves.push(Number(args.data.prompt_token_estimate));
      return original(args);
    });
    await drain(svc.streamAssistantTurn(CLIENT, SESSION, { userMessage: 'hello' }));
    console.info(JSON.stringify({ probe: 'C2_payload_bound', reserves, ledger: audits }));
    expect(reserves[0]).toBeGreaterThanOrEqual(40000);
  });
});
