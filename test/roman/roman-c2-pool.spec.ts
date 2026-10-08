/**
 * B-668-1 turn-path tests (ruled into #669 by B-ROMAN-BFIX-121; written by
 * B-RMNC2-122, agent 122) with a real CoachAIBudgetService over a stateful
 * pool row: an interrupted reply still debits the pool, a sub-coach's client
 * debits the head coach, a used-up pool refuses before the ledger or the
 * provider with copy that carries no credit figures, and a crisis turn is
 * still answered with a used-up pool.
 */
import 'reflect-metadata';
import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RomanSession } from '@prisma/client';
import { RomanService } from '../../src/roman/roman.service';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import {
  ROMAN_COACH_POOL_EMPTY_MESSAGE,
  ROMAN_MAX_OUTPUT_TOKENS,
} from '../../src/roman/roman.constants';
import { ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'c2-client', role: 'student', tier: 'free' as const };
const SESSION = fakeOf<RomanSession>({
  id: 'c2-session', user_id: CLIENT.id, surface: 'client',
  day_key: 'c2-day', message_count: 1, exclamation_used: false,
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

interface SetupOpts {
  usedCents: number;
  clientCoachId?: string;
  headCoachId?: string | null;
  abortAfterFirstDelta?: AbortController;
}

function setup(o: SetupOpts) {
  const clientCoachId = o.clientCoachId ?? 'c2-coach';
  const poolOwner = o.headCoachId ?? clientCoachId;
  const row = {
    id: 'c2-budget', coach_user_id: poolOwner,
    period_start: new Date('2026-10-01T00:00:00Z'),
    period_end: new Date('2099-11-01T00:00:00Z'),
    base_actual_cents: 4000, value_multiplier: new Prisma.Decimal(5),
    base_displayed_cents: 20000, pack_paid_cents: 0, pack_displayed_cents: 0,
    total_pack_actual_cents: 0, actual_used_cents: o.usedCents,
    actual_used_micro_cents: BigInt(o.usedCents) * BigInt(1_000_000),
  };
  const romanSession = { updateMany: jest.fn(async () => ({ count: 1 })) };
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'c2-reply', ...data,
    })),
    findMany: jest.fn(async () => [{ role: 'user', content: 'What should I train today?' }]),
  };
  const aiRequestAudit = {
    create: jest.fn(async () => ({ request_id: 'c2-request' })),
    aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
    update: jest.fn(async () => ({})),
  };
  const coachAIBudget = {
    findUnique: jest.fn(async ({ where }: { where: { coach_user_id?: string } }) =>
      where.coach_user_id === undefined || where.coach_user_id === poolOwner ? { ...row } : null),
    // CREDIT-METER-130: the debit is pinned to the usage it read and sets both totals.
    updateMany: jest.fn(async ({ where, data }: {
      where: { coach_user_id?: string; actual_used_cents: number; actual_used_micro_cents: bigint };
      data: { actual_used_cents: number; actual_used_micro_cents: bigint };
    }) => {
      if (where.coach_user_id !== undefined && where.coach_user_id !== poolOwner) return { count: 0 };
      if (row.actual_used_cents !== where.actual_used_cents) return { count: 0 };
      if (row.actual_used_micro_cents !== where.actual_used_micro_cents) return { count: 0 };
      row.actual_used_cents = data.actual_used_cents;
      row.actual_used_micro_cents = data.actual_used_micro_cents;
      return { count: 1 };
    }),
  };
  const executeRaw = jest.fn(async () => 1);
  const prisma = fakeOf<ConstructorParameters<typeof CoachAIBudgetService>[0]>({
    user: { findUnique: jest.fn(async () => ({ coach_id: clientCoachId })) },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async () => (o.headCoachId ? { head_coach_id: o.headCoachId } : null)),
    },
    coachAIBudget, romanSession, romanMessage, aiRequestAudit,
    $transaction: jest.fn(async (fn: (tx: object) => Promise<unknown>) =>
      fn({ romanSession, romanMessage, aiRequestAudit, $executeRaw: executeRaw })),
  });
  const abort = o.abortAfterFirstDelta;
  const client = {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: 6000 } } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Keep the plan ' } };
          abort?.abort();
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'as written.' } };
          yield { type: 'message_delta', usage: { output_tokens: 300 } };
        },
      })),
      create: jest.fn(),
    },
  };
  const handle = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client));
  const budget = new CoachAIBudgetService(prisma);
  const usage = jest.spyOn(budget, 'recordUsage');
  const canCharge = jest.spyOn(budget, 'canCharge');
  const svc = new RomanService(prisma, grantAllEgress(), handle, null, null, budget);
  return { svc, row, client, usage, canCharge, aiRequestAudit, executeRaw };
}

async function drain(
  svc: RomanService,
  userMessage: string,
  signal?: AbortSignal,
): Promise<Array<{ type: string; text?: string; interrupted?: boolean }>> {
  const out: Array<{ type: string; text?: string; interrupted?: boolean }> = [];
  for await (const chunk of svc.streamAssistantTurn(CLIENT, SESSION, { userMessage, signal })) {
    out.push(chunk as { type: string; text?: string; interrupted?: boolean });
  }
  return out;
}

describe('B-668-1 coach pool on the live turn (#669)', () => {
  it('an interrupted reply still debits the pool at the reserved worst case', async () => {
    const abort = new AbortController();
    const t = setup({ usedCents: 0, abortAfterFirstDelta: abort });
    const out = await drain(t.svc, 'What should I train today?', abort.signal);
    expect(out.find((c) => c.type === 'done')?.interrupted).toBe(true);
    expect(t.executeRaw).toHaveBeenCalledTimes(1);
    // CREDIT-METER-130: the exact cost; the whole-cent figure is its ceiling.
    const cents = RomanService.costUsd(6000, ROMAN_MAX_OUTPUT_TOKENS) * 100;
    expect(t.usage).toHaveBeenCalledTimes(1);
    expect(t.usage.mock.calls[0][0]).toEqual(
      expect.objectContaining({ coachId: 'c2-coach', actualCostCents: cents, capability: 'roman.chat' }),
    );
    expect(t.row.actual_used_cents).toBe(Math.ceil(cents));
  });

  it("a sub-coach's client debits the head coach's pool", async () => {
    const t = setup({ usedCents: 0, clientCoachId: 'c2-sub-coach', headCoachId: 'c2-head-coach' });
    await drain(t.svc, 'What should I train today?');
    expect(t.usage).toHaveBeenCalledTimes(1);
    expect(t.usage.mock.calls[0][0]).toEqual(expect.objectContaining({ coachId: 'c2-head-coach' }));
    expect(t.row.actual_used_cents).toBeGreaterThan(0);
  });

  it('a used-up pool refuses with 402 before the ledger and the provider; client copy has no credit figures', async () => {
    const t = setup({ usedCents: 4000 });
    let err: unknown;
    try {
      await drain(t.svc, 'What should I train today?');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    const body = (err as HttpException).getResponse() as Record<string, unknown>;
    expect(body).toEqual({ code: 'COACH_AI_BUDGET_EXHAUSTED', message: ROMAN_COACH_POOL_EMPTY_MESSAGE });
    expect(JSON.stringify(body)).not.toMatch(/\d/);
    expect(t.client.messages.stream).not.toHaveBeenCalled();
    expect(t.aiRequestAudit.create).not.toHaveBeenCalled();
    expect(t.usage).not.toHaveBeenCalled();
  });

  it('a crisis message is still answered with a used-up pool, with no pool read and no provider call', async () => {
    const t = setup({ usedCents: 4000 });
    const out = await drain(t.svc, 'I want to kill myself');
    expect(out.find((c) => c.type === 'done')?.text).toBe(ROMAN_SAFETY_TEMPLATES.self_harm);
    expect(t.client.messages.stream).not.toHaveBeenCalled();
    expect(t.canCharge).not.toHaveBeenCalled();
    expect(t.usage).not.toHaveBeenCalled();
  });
});
