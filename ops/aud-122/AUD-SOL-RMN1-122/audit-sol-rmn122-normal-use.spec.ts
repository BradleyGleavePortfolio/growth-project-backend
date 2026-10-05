import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RomanSession } from '@prisma/client';
import { RomanService } from '../../src/roman/roman.service';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { postCheckRomanReply } from '../../src/roman/guardrails/roman-post-check';
import {
  classifySafety,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
} from '../../src/roman/guardrails/safety-router';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'audit-client', role: 'student', tier: 'free' as const };
const SESSION = fakeOf<RomanSession>({
  id: 'audit-session', user_id: CLIENT.id, surface: 'client',
  day_key: 'audit-day', message_count: 1, exclamation_used: false,
  quips_in_session: 0, subject_context_json: null, deleted_at: null,
});

let savedFlag: string | undefined;
let savedCap: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  savedCap = process.env.ROMAN_DAILY_COST_CAP_USD;
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env.ROMAN_DAILY_COST_CAP_USD = '100';
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

function setup(initialUsedCents: number) {
  const row = {
    id: 'audit-budget', coach_user_id: 'audit-coach',
    period_start: new Date('2026-10-01T00:00:00Z'),
    period_end: new Date('2099-11-01T00:00:00Z'),
    base_actual_cents: 4000, value_multiplier: new Prisma.Decimal(5),
    base_displayed_cents: 20000, pack_paid_cents: 0, pack_displayed_cents: 0,
    total_pack_actual_cents: 0, actual_used_cents: initialUsedCents,
  };
  const romanSession = { updateMany: jest.fn(async () => ({ count: 1 })) };
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'audit-reply', ...data,
    })),
    findMany: jest.fn(async () => [{ role: 'user', content: 'What should I train today?' }]),
  };
  const aiRequestAudit = {
    create: jest.fn(async () => ({ request_id: 'audit-request' })),
    aggregate: jest.fn(async () => ({ _sum: {
      prompt_token_estimate: 18000, response_token_estimate: 2000,
    } })),
    update: jest.fn(async () => ({})),
  };
  const coachAIBudget = {
    findUnique: jest.fn(async () => ({ ...row })),
    updateMany: jest.fn(async ({ where, data }: {
      where: { actual_used_cents: { lte: number } };
      data: { actual_used_cents: { increment: number } };
    }) => {
      // Honor the exact real update predicate, with no competing actor.
      if (row.actual_used_cents > where.actual_used_cents.lte) return { count: 0 };
      row.actual_used_cents += data.actual_used_cents.increment;
      return { count: 1 };
    }),
  };
  const prisma = fakeOf<ConstructorParameters<typeof CoachAIBudgetService>[0]>({
    user: { findUnique: jest.fn(async () => ({ coach_id: 'audit-coach' })) },
    teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
    coachAIBudget, romanSession, romanMessage, aiRequestAudit,
    $transaction: jest.fn(async (fn: (tx: object) => Promise<unknown>) =>
      fn({ romanSession, romanMessage })),
  });
  const client = {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: 6000 } } };
          yield { type: 'content_block_delta', delta: {
            type: 'text_delta', text: 'Keep the plan as written.',
          } };
          yield { type: 'message_delta', usage: { output_tokens: 300 } };
        },
      })),
      create: jest.fn(),
    },
  };
  const handle = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client));
  const budget = new CoachAIBudgetService(prisma);
  const usage = jest.spyOn(budget, 'recordUsage');
  const svc = new RomanService(prisma, grantAllEgress(), handle, null, null, budget);
  return { svc, row, client, usage };
}

async function turn(svc: RomanService): Promise<void> {
  for await (const _chunk of svc.streamAssistantTurn(
    CLIENT, SESSION, { userMessage: 'What should I train today?' },
  )) {
    // Consume the complete normal provider response before the next turn.
  }
}

describe('AUD-SOL-RMN1-122 changed safety predicate — ordinary insulin instruction', () => {
  it('skip insulin remains forbidden even without the possessive word', () => {
    const userMessage = 'Should I skip insulin before my workout?';
    const reply =
      `Skip insulin before training. Keep today as a lighter day and message your coach. ${ROMAN_PHYSICIAN_LINE_MEDICAL}`;
    const route = classifySafety(userMessage);
    const checked = postCheckRomanReply(reply, { routerClass: route.class, context: null });
    console.info(JSON.stringify({ probe: 'insulin-directive', route, checked }));
    expect(route.class).toBe('medical_scope');
    expect(checked.rewritten).toBe(true);
    expect(checked.text).not.toContain('Skip insulin');
  });

  it('control: the physiology sentence still passes unchanged', () => {
    const reply = 'Carbs raise insulin, but that alone does not make you gain fat.';
    expect(postCheckRomanReply(reply, { routerClass: 'normal', context: null }))
      .toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});

describe('AUD-SOL-RMN1-122 prior B-668-1 — sequential ordinary paid turns debit the pool', () => {
  it('control: a normal affordable turn debits its actual 3-cent cost', async () => {
    const { svc, row, client, usage } = setup(0);
    await turn(svc);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({
      coachId: 'audit-coach', actualCostCents: 3, capability: 'roman.chat',
    }));
    expect(row.actual_used_cents).toBe(3);
  });

  it('control: an exactly exhausted pool refuses before the provider', async () => {
    const { svc, client } = setup(4000);
    await expect(turn(svc)).rejects.toMatchObject({
      response: { code: 'COACH_AI_BUDGET_EXHAUSTED' },
    });
    expect(client.messages.stream).not.toHaveBeenCalled();
  });

  it('one cent left cannot finance two full replies without any recorded debit', async () => {
    const { svc, row, client, usage } = setup(3999);
    const outcomes: string[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        await turn(svc);
        outcomes.push('answered');
      } catch (err) {
        expect(err).toMatchObject({ response: { code: 'COACH_AI_BUDGET_EXHAUSTED' } });
        outcomes.push('pool-refused');
      }
    }
    const calls = client.messages.stream.mock.calls.length;
    const recorded = await Promise.all(usage.mock.results.map((r) => r.value));
    console.info(JSON.stringify({
      probe: 'sequential-pool-debit', outcomes, providerCalls: calls,
      beforeUsed: 3999, afterUsed: row.actual_used_cents, recorded,
    }));
    // A pre-call refusal is fine; paid replies must consume their real cost.
    expect(row.actual_used_cents - 3999).toBeGreaterThanOrEqual(calls * 3);
  });
});
