// test/roman/r11-tool-loop.spec.ts
//
// R11-T2B: the budgeted tool loop inside a Roman client turn (behind
// FEATURE_ROMAN_TOOLS). Fake toolbox + stub Anthropic client; no network, no DB.

import { HttpException } from '@nestjs/common';
import { RomanService } from '../../src/roman/roman.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import {
  type AiEgressService,
  AnthropicHandle,
  type AnthropicMessagesClient,
} from '../../src/ai-egress/ai-egress.service';
import { isAiEgressRefusal } from '../../src/ai-egress/ai-consent-required.exception';
import { egressWithGrants, fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { _resetRomanContextListeners } from '../../src/roman/context/roman-context-invalidation';
import {
  ROMAN_MODEL_PHASE_1,
  ROMAN_TURN_THINKING,
} from '../../src/roman/anthropic-client.provider';
import { ROMAN_MAX_OUTPUT_TOKENS } from '../../src/roman/roman.constants';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import type { RomanToolbox, RomanToolResult } from '../../src/roman/tools/roman-tool.types';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  NOW,
  LOCAL_TODAY_PT,
  P1,
} from './fixtures/roman-personas';

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> };
const STUDENT = { id: P1, role: 'student' };
const text = (t: string) => ({ type: 'text', text: t });
const DAY = { date: '2026-09-29' };
const use = (id: string) => ({ type: 'tool_use', id, name: 'food_day', input: DAY });
/** One provider response; every call reports 100k input and 1k output tokens. */
const reply = (content: unknown[], stop: string) => ({
  ...{ id: 'msg', type: 'message', role: 'assistant', model: ROMAN_MODEL_PHASE_1, content },
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 100_000, output_tokens: 1_000 },
});

function fakeToolbox(result: Partial<RomanToolResult> = {}, onRun: () => void = () => {}) {
  const run = jest.fn(async () => {
    onRun();
    return { ok: true, content: 'FOOD-DAY-ROWS', rows: 3, truncated: false, ...result };
  });
  const toolbox: RomanToolbox = {
    definitions: () => [
      {
        name: 'food_day',
        description: 'One day of the client food log.',
        input_schema: {
          type: 'object',
          properties: { date: { type: 'string' } },
          required: ['date'],
        },
      },
    ],
    run,
  };
  return { toolbox, run };
}

function fakeBudget(remainingCents = 100_000) {
  return {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
    canCharge: jest.fn(async () => ({
      allowed: true,
      budget: { actual_used_cents: 0, total_actual_available_cents: remainingCents },
    })),
    recordUsage: jest.fn(async () => ({ recorded: true, budgetId: 'b1' })),
  };
}

function setup(opts: {
  replies?: unknown[];
  toolbox?: RomanToolbox | null;
  egress?: AiEgressService;
  budget?: ReturnType<typeof fakeBudget>;
}) {
  const db = makePersonaDb();
  const creates: Body[] = [];
  const streams: Body[] = [];
  const replies = opts.replies ?? [];
  const reserved: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      create: jest.fn(async (body: Body) => {
        creates.push(structuredClone(body));
        reserved.push({ ...db.raw.aiRequestAudits[0] });
        return replies[Math.min(creates.length, replies.length) - 1];
      }),
      stream: jest.fn((body: Body) => {
        streams.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streamed.' } };
            yield { type: 'message_delta', usage: { output_tokens: 2 } };
          },
        };
      }),
    },
  };
  const budget = opts.budget ?? fakeBudget();
  const svc = new RomanService(
    fakeOf(db.prisma),
    opts.egress ?? grantAllEgress(),
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client)),
    new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource()),
    null,
    fakeOf<CoachAIBudgetService>(budget),
    null,
    opts.toolbox === undefined ? fakeToolbox().toolbox : opts.toolbox,
  );
  const session = {
    id: 'sess_1',
    user_id: P1,
    surface: 'client' as const,
    day_key: LOCAL_TODAY_PT,
    message_count: 0,
    started_at: NOW,
    last_activity_at: NOW,
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
  const turn = async () => {
    const out: Array<{ type: string; text?: string }> = [];
    const gen = svc.streamAssistantTurn(STUDENT, session, { userMessage: 'What did I eat?' });
    for await (const c of gen) out.push(c);
    return out;
  };
  const ledger = () => db.raw.aiRequestAudits[0] as Record<string, unknown>;
  const saved = () => db.raw.romanMessages.filter((m) => m.role === 'roman');
  return { db, svc, creates, streams, reserved, budget, turn, ledger, saved };
}

const TOOLS = 'FEATURE_ROMAN_TOOLS';
const env: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [TOOLS, FEATURE_ROMAN_CHAT_ENABLED_ENV]) env[k] = process.env[k];
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env[TOOLS] = 'true';
  _resetRomanContextListeners();
  // Only Date is faked: the tool timeouts and the stream use real timers.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });
});
afterEach(() => {
  jest.useRealTimers();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('R11-T2B tool loop in the Roman turn', () => {
  it('flag off, or no toolbox: one streaming call with no tools field, as today', async () => {
    delete process.env[TOOLS];
    const off = setup({});
    expect((await off.turn()).map((c) => c.type)).toEqual(['delta', 'done']);
    process.env[TOOLS] = 'true';
    const none = setup({ toolbox: null });
    await none.turn();
    for (const t of [off, none]) {
      expect(t.creates).toHaveLength(0);
      expect(t.streams).toHaveLength(1);
      expect(Object.keys(t.streams[0])).not.toContain('tools');
      expect(Object.keys(t.ledger().metadata as object)).not.toContain('tools');
    }
  });

  it('tool_use then text: runs for the session caller; one reply saved; delta + done', async () => {
    const { toolbox, run } = fakeToolbox();
    const answer = 'Your log looks steady.';
    const t = setup({
      toolbox,
      replies: [
        reply([text('Checking.'), use('t1')], 'tool_use'),
        reply([text(answer)], 'end_turn'),
      ],
    });
    const chunks = await t.turn();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([STUDENT, 'food_day', DAY, { now: NOW }]);
    expect(t.streams).toHaveLength(0);
    expect(t.creates).toHaveLength(2);
    expect(t.creates[0]).toMatchObject({ model: ROMAN_MODEL_PHASE_1, thinking: ROMAN_TURN_THINKING });
    expect(t.creates[0].tools).toEqual([expect.objectContaining({ name: 'food_day' })]);
    expect(t.creates[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: [text('Checking.'), use('t1')] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FOOD-DAY-ROWS' }],
      },
    ]);
    expect(chunks).toEqual([
      { type: 'delta', text: answer },
      expect.objectContaining({ type: 'done', text: answer }),
    ]);
    expect(t.saved()).toHaveLength(1);
  });

  it('max_rounds then a tool_choice none call; <= 6 runs; summed settle, one debit', async () => {
    const { toolbox, run } = fakeToolbox();
    const three = reply([use('a'), use('b'), use('c')], 'tool_use');
    const replies = [three, three, three, reply([text('Done.')], 'end_turn')];
    const t = setup({ toolbox, replies });
    await t.turn();
    expect(t.creates).toHaveLength(4);
    const choices = t.creates.map((c) => c.tool_choice);
    expect(choices).toEqual([undefined, undefined, undefined, { type: 'none' }]);
    expect(run).toHaveBeenCalledTimes(6);
    const sent = t.creates[3].messages;
    const lastResults = sent[sent.length - 1].content as Array<Record<string, unknown>>;
    expect(lastResults.map((r) => r.is_error)).toEqual([true, true, true]);
    // Reserved before the first send: every call of the turn, at its bound.
    const reserved = t.reserved[0];
    expect(reserved).toMatchObject({ response_token_estimate: 4 * ROMAN_MAX_OUTPUT_TOKENS });
    expect(reserved.prompt_token_estimate).toBeGreaterThan(4 * 6 * 12_000);
    expect(reserved.metadata).toEqual({ state: 'reserved' });
    expect(t.ledger()).toMatchObject({
      prompt_token_estimate: 400_000,
      response_token_estimate: 4_000,
      metadata: { state: 'settled', outcome: 'ok', tools: true, tool_rounds: 3, tool_calls: 9 },
    });
    expect(t.ledger().metadata).toMatchObject({ tool_errors: 3, tool_names: ['food_day'] });
    // 400k in x $2 + 4k out x $10 per MTok = $0.84, debited once.
    expect(t.budget.recordUsage).toHaveBeenCalledTimes(1);
    expect(t.budget.recordUsage.mock.calls[0]).toEqual([
      expect.objectContaining({ actualCostCents: 84, capability: 'roman.chat' }),
    ]);
  });

  it('the coach-pool pre-check refuses a tools turn below the tools worst case', async () => {
    const worst = RomanService.worstCaseTurnCents();
    const t = setup({ budget: fakeBudget(2 * worst) });
    const err = await t.svc.assertCoachPoolOpen(STUDENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    delete process.env[TOOLS];
    await expect(t.svc.assertCoachPoolOpen(STUDENT)).resolves.toBeTruthy();
  });

  it('a past-day kcal number a tool returned survives the post-check', async () => {
    const claim = 'Yesterday you logged 3141 kcal.';
    const replies = [reply([use('t1')], 'tool_use'), reply([text(claim)], 'end_turn')];
    const facts = { intake_past_kcal: [3141] };
    const cited = setup({ replies, toolbox: fakeToolbox({ facts }).toolbox });
    expect((await cited.turn())[1]).toMatchObject({ type: 'done', text: claim });
    const control = setup({ replies, toolbox: fakeToolbox().toolbox });
    const rewritten = await control.turn();
    expect(rewritten[rewritten.length - 1].text).not.toContain('3141');
  });

  it('a consent refusal mid-loop settles the answered call, saves nothing and throws', async () => {
    const { egress, reader } = egressWithGrants([P1]);
    const { toolbox } = fakeToolbox({}, () => reader.revoke(P1));
    const replies = [reply([use('t1')], 'tool_use'), reply([text('x')], 'end_turn')];
    const t = setup({ egress, toolbox, replies });
    const err = await t.turn().catch((e: unknown) => e);
    expect(isAiEgressRefusal(err)).toBe(true);
    expect(t.creates).toHaveLength(1);
    expect(t.ledger()).toMatchObject({
      prompt_token_estimate: 100_000,
      response_token_estimate: 1_000,
      metadata: { outcome: 'refused', usage: 'final', tools: true, tool_rounds: 1 },
    });
    expect(t.saved()).toHaveLength(0);
  });
});
