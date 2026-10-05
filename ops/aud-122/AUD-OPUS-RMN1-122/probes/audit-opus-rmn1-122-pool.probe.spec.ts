/**
 * AUD-OPUS-RMN1-122 probe (lens only, never merge): B-668-1 coach AI pool
 * check + debit on the live Roman turn at the integrated stack. Harness
 * adapted from ops/aud-121/AUD-OPUS-RB-121/probes/audit-opus-rb121.probe.spec.ts.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { RomanService } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
  delete process.env.ROMAN_DAILY_COST_CAP_USD;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

const CLIENT = { id: 'client-1', role: 'student', tier: 'free' as const };

function session(userId = CLIENT.id) {
  return {
    id: 'sess_1', user_id: userId, surface: 'client' as const, day_key: '2026-10-05', message_count: 1,
    started_at: new Date(), last_activity_at: new Date(), quips_in_session: 0, exclamation_used: false,
    subject_context_json: null, created_at: new Date(), updated_at: new Date(), deleted_at: null,
  };
}

function makePrisma() {
  const stored: Array<{ role: string; content: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: { role: string; content: string } }) => {
      stored.push({ role: data.role, content: data.content });
      return { id: `msg_${stored.length}`, ...data };
    }),
    findMany: jest.fn(async () => [{ role: 'user', content: 'hello', created_at: new Date() }]),
    findFirst: jest.fn(async () => ({ content: 'hello' })),
    update: jest.fn(),
  };
  const romanSession = { updateMany: jest.fn(async () => ({ count: 1 })) };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return data; }),
    aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
    update: jest.fn(async ({ where, data }: { where: { request_id: string }; data: Record<string, unknown> }) => {
      const row = audits.find((a) => a.request_id === where.request_id);
      if (row) Object.assign(row, data);
      return row;
    }),
  };
  const user = { findUnique: jest.fn(async () => ({ coach_id: 'coach-1' })) };
  const prisma = {
    romanMessage, romanSession, aiRequestAudit, user,
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({ romanMessage, romanSession })),
  };
  return { prisma, stored, audits };
}

function makeAnthropic(text: string) {
  const client = {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: 1000 } } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
          yield { type: 'message_delta', usage: { output_tokens: 50 } };
        },
      })),
      create: jest.fn(),
    },
  };
  return { client, handle: AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client)) };
}

function makeBudget(usedCents: number, totalCents: number) {
  return {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
    canCharge: jest.fn(async () => ({
      budget: { actual_used_cents: usedCents, total_actual_available_cents: totalCents },
    })),
    recordUsage: jest.fn(async () => undefined),
    getBudgetDto: jest.fn(async () => ({})),
  };
}

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>) {
  const out: Array<{ type: string; text?: string }> = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('AUD-OPUS-RMN1-122 B-668-1 pool check + debit', () => {
  it('open pool: one provider call, one debit to the client coach pool', async () => {
    const { prisma } = makePrisma();
    const a = makeAnthropic('Keep the plan as written today.');
    const budget = makeBudget(100, 2000);
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), a.handle, null, null, fakeOf(budget));
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'What should I eat for lunch?' }));
    // eslint-disable-next-line no-console
    console.log(`POOL open: stream=${a.client.messages.stream.mock.calls.length} canCharge=${JSON.stringify(budget.canCharge.mock.calls)} recordUsage=${JSON.stringify(budget.recordUsage.mock.calls)}`);
    expect(a.client.messages.stream).toHaveBeenCalledTimes(1);
    expect(budget.recordUsage).toHaveBeenCalledTimes(1);
    expect(budget.recordUsage.mock.calls[0]).toEqual([
      expect.objectContaining({ coachId: 'coach-1', capability: 'roman.chat', actualCostCents: 1 }),
    ]);
  });

  it('exhausted pool: 402 COACH_AI_BUDGET_EXHAUSTED before any provider call, no debit', async () => {
    const { prisma } = makePrisma();
    const a = makeAnthropic('x');
    const budget = makeBudget(2000, 2000);
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), a.handle, null, null, fakeOf(budget));
    let err: unknown;
    try { await svc.assertCoachPoolOpen(CLIENT); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    expect((err as HttpException).getResponse()).toEqual(expect.objectContaining({ code: 'COACH_AI_BUDGET_EXHAUSTED' }));
    let err2: unknown;
    try {
      await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'What should I eat for lunch?' }));
    } catch (e) { err2 = e; }
    expect((err2 as HttpException).getStatus()).toBe(402);
    expect(a.client.messages.stream).not.toHaveBeenCalled();
    expect(budget.recordUsage).not.toHaveBeenCalled();
    const body = JSON.stringify((err as HttpException).getResponse());
    // eslint-disable-next-line no-console
    console.log(`POOL exhausted client body: ${body}`);
    expect(body).not.toMatch(/cents|\$\d/);
  });

  it('crisis turn with an exhausted pool still gets the 988 template, no pool call', async () => {
    const { prisma } = makePrisma();
    const a = makeAnthropic('x');
    const budget = makeBudget(2000, 2000);
    const svc = new RomanService(fakeOf(prisma), grantAllEgress(), a.handle, null, null, fakeOf(budget));
    const out = await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'I want to kill myself' }));
    expect(out.find((c) => c.type === 'done')?.text).toBe(ROMAN_SAFETY_TEMPLATES.self_harm);
    expect(a.client.messages.stream).not.toHaveBeenCalled();
    expect(budget.canCharge).not.toHaveBeenCalled();
  });
});
