// test/roman/roman-model-config.spec.ts
//
// R1 — Roman model config, boot probe, /health/roman and honest failure
// (PLAN_roman_intelligence §3, §2.7, §7.3 layer 6). No network, no DB.
//
//   config     unknown / retired ids and bad effort are rejected at boot;
//              defaults are the plan's (sonnet-5-5 / sonnet-4-6 / low)
//   request    sonnet-5-5 gets thinking.between_tools + output_config.effort
//              and never temperature / thinking.disabled; sonnet-4-6 is plain
//   fallback   a 404 / not_found on the primary before any text retries the
//              fallback; model_id records the model that ANSWERED
//   failure    when both fail, or the model returns no text, the stream yields
//              an `error` chunk (SSE `event: error`) — never an empty `done`
//   health     unconfigured / ready / degraded / down state machine and the
//              /health/roman status code semantics
//   cap        the global daily USD cap serves the resting reply with no call
//   ledger     one AICallLog row per upstream call, capability roman_chat

import 'reflect-metadata';
import { RomanService } from '../../src/roman/roman.service';
import { RomanController } from '../../src/roman/roman.controller';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import {
  ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS,
  ROMAN_ADAPTIVE_PROBE_MAX_TOKENS,
  ROMAN_GLOBAL_DAILY_USD_CAP_ENV,
  ROMAN_MODEL_ALLOWLIST,
  ROMAN_MODEL_EFFORT_ENV,
  ROMAN_MODEL_FALLBACK_ENV,
  ROMAN_MODEL_PRIMARY_ENV,
  ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS,
  ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS,
  RomanModelConfigError,
  allowedRomanModelIds,
  costCentsFor,
  lookupRomanModel,
  probeRequestFor,
  requestProfileFor,
  resolveRomanModelConfig,
  turnRequestFor,
} from '../../src/roman/model/roman-model.config';
import {
  describeUpstreamError,
  isFallbackEligible,
} from '../../src/roman/model/roman-upstream-error';
import { RomanModelHealthService } from '../../src/roman/model/roman-model-health.service';
import { RomanHealthController } from '../../src/roman/model/roman-health.controller';
import {
  ROMAN_DAILY_CAP_REPLY,
  ROMAN_HISTORY_TURN_MAX_CHARS,
} from '../../src/roman/roman.constants';
import {
  asAnthropicDouble,
  asAuthedRequestDouble,
  asPrismaDouble,
  asResponseDouble,
} from './roman-test-doubles';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const ENV_KEYS = [
  FLAG,
  ROMAN_MODEL_PRIMARY_ENV,
  ROMAN_MODEL_FALLBACK_ENV,
  ROMAN_MODEL_EFFORT_ENV,
  ROMAN_GLOBAL_DAILY_USD_CAP_ENV,
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─── doubles ─────────────────────────────────────────────────────────────────

function makePrisma(opts: { spentCents?: number } = {}) {
  let seq = 0;
  const session = {
    id: 'sess_1',
    user_id: 'user-A',
    surface: 'client' as const,
    day_key: '2026-10-01',
    message_count: 0,
    started_at: new Date(),
    last_activity_at: new Date(),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null as Date | null,
  };
  const messages: Array<
    Record<string, unknown> & { created_at: Date; content: string; role: string }
  > = [];
  const callLogs: Array<Record<string, unknown>> = [];
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `msg_${++seq}`,
        ...data,
        content: data.content as string,
        role: data.role as string,
        created_at: new Date(Date.now() + messages.length),
      };
      messages.push(row);
      return row;
    }),
    findMany: jest.fn(async ({ take }: { take?: number } = {}) => {
      const sorted = [...messages].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return typeof take === 'number' ? sorted.slice(0, take) : sorted;
    }),
    count: jest.fn(async () => 0),
    findFirst: jest.fn(async () => null),
  };
  const romanSession = {
    findFirst: jest.fn(async () => session),
    update: jest.fn(async () => session),
  };
  const aICallLog = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      callLogs.push(data);
      return data;
    }),
    aggregate: jest.fn(async () => ({ _sum: { costCents: opts.spentCents ?? 0 } })),
  };
  const prisma = {
    romanSession,
    romanMessage,
    aICallLog,
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ romanMessage, romanSession }),
    ),
  };
  return { prisma, session, messages, callLogs, aICallLog };
}

type StreamBehaviour =
  | { kind: 'ok'; deltas: string[]; model?: string }
  | { kind: 'throw'; err: unknown }
  | { kind: 'throw_after'; deltas: string[]; err: unknown };

/** Fake client whose Nth `messages.stream` call follows behaviours[N]. */
function makeAnthropic(behaviours: StreamBehaviour[]) {
  let call = 0;
  const stream = jest.fn((body: { model: string }) => {
    const b = behaviours[Math.min(call, behaviours.length - 1)];
    call += 1;
    return {
      async *[Symbol.asyncIterator]() {
        if (b.kind === 'throw') throw b.err;
        yield {
          type: 'message_start',
          message: {
            model: b.kind === 'ok' ? (b.model ?? body.model) : body.model,
            usage: { input_tokens: 100 },
          },
        };
        for (const text of b.deltas) {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
        }
        if (b.kind === 'throw_after') throw b.err;
        yield { type: 'message_delta', usage: { output_tokens: 20 } };
      },
    };
  });
  return { messages: { stream, create: jest.fn() } };
}

function sdkError(name: string, status: number | null, type: string | null) {
  const e = new Error('upstream body text that must never be logged') as Error & {
    status?: number;
    error?: unknown;
  };
  e.name = name;
  if (status !== null) e.status = status;
  if (type) e.error = { type: 'error', error: { type, message: 'secret' } };
  return e;
}

const CALLER = { id: 'user-A', role: 'student', tier: 'free' as const };

async function drain(service: RomanService) {
  const session = await service.getOwnedSession(CALLER, 'sess_1');
  const chunks: Array<Record<string, unknown>> = [];
  for await (const c of service.streamAssistantTurn(CALLER, session)) chunks.push({ ...c });
  return chunks;
}

// ─── config ──────────────────────────────────────────────────────────────────

describe('R1 model config', () => {
  it('defaults to the plan models and low effort', () => {
    const c = resolveRomanModelConfig({});
    expect(c.primary.id).toBe('claude-sonnet-5-5');
    expect(c.fallback.id).toBe('claude-sonnet-4-6');
    expect(c.effort).toBe('low');
    expect(c.globalDailyUsdCap).toBe(25);
  });

  it('rejects the RETIRED model Roman used to be pinned to, with a clear message', () => {
    expect(() =>
      resolveRomanModelConfig({ [ROMAN_MODEL_PRIMARY_ENV]: 'claude-3-7-sonnet-20250219' }),
    ).toThrow(/RETIRED/);
    expect(() =>
      resolveRomanModelConfig({ [ROMAN_MODEL_FALLBACK_ENV]: 'claude-haiku-4-5-20251001' }),
    ).toThrow(RomanModelConfigError);
  });

  it('rejects an unknown id, a bad effort and a bad cap', () => {
    expect(() => resolveRomanModelConfig({ [ROMAN_MODEL_PRIMARY_ENV]: 'gpt-9' })).toThrow(
      /not an allowed/,
    );
    expect(() => resolveRomanModelConfig({ [ROMAN_MODEL_EFFORT_ENV]: 'max' })).toThrow(
      /ROMAN_MODEL_EFFORT/,
    );
    expect(() => resolveRomanModelConfig({ [ROMAN_GLOBAL_DAILY_USD_CAP_ENV]: 'lots' })).toThrow(
      /CAP/,
    );
  });

  it('constructing the health service with a retired id fails boot loudly', () => {
    expect(
      () =>
        new RomanModelHealthService(null, {
          [ROMAN_MODEL_PRIMARY_ENV]: 'claude-3-7-sonnet-20250219',
        }),
    ).toThrow(RomanModelConfigError);
  });

  it('gives sonnet-5-5 the between_tools + effort profile and sonnet-4-6 the plain request', () => {
    const c = resolveRomanModelConfig({});
    expect(requestProfileFor(c.primary, 'low')).toEqual({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' },
    });
    expect(requestProfileFor(c.fallback, 'low')).toEqual({});
  });

  // Sol audit of #598, finding B1: Opus 5.5 is always-adaptive. It must never
  // receive the Sonnet-only `between_tools` profile, and its budgets must be
  // thinking-inclusive.
  it('gives opus-5-5 an ADAPTIVE thinking profile (never between_tools) with thinking-inclusive budgets', () => {
    const opus = lookupRomanModel('claude-opus-5-5')!;
    expect(opus.family).toBe('opus_5_5');
    expect(requestProfileFor(opus, 'medium')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    expect(opus.maxOutputTokens).toBe(ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS);
    expect(opus.probeMaxTokens).toBe(ROMAN_ADAPTIVE_PROBE_MAX_TOKENS);
    expect(opus.maxOutputTokens).toBeGreaterThan(ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS);
    expect(opus.probeMaxTokens).toBeGreaterThan(ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS);
    // Opus accepted as primary or fallback resolves to the adaptive family.
    const c = resolveRomanModelConfig({
      [ROMAN_MODEL_PRIMARY_ENV]: 'claude-opus-5-5',
      [ROMAN_MODEL_FALLBACK_ENV]: 'claude-sonnet-5-5',
    });
    expect(c.primary.family).toBe('opus_5_5');
    expect(turnRequestFor(c.primary, c.effort).thinking).toEqual({ type: 'adaptive' });
  });

  // B1 fix acceptance: probe AND turn payloads for EVERY allowed model match
  // that model's documented contract.
  const EXPECTED_CONTRACT: Record<
    string,
    { thinking: unknown; effort: boolean; turnMax: number; probeMax: number }
  > = {
    'claude-sonnet-5-5': {
      thinking: { type: 'between_tools' },
      effort: true,
      turnMax: ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS,
      probeMax: ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS,
    },
    'claude-opus-5-5': {
      thinking: { type: 'adaptive' },
      effort: true,
      turnMax: ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS,
      probeMax: ROMAN_ADAPTIVE_PROBE_MAX_TOKENS,
    },
    'claude-sonnet-4-6': {
      thinking: undefined,
      effort: false,
      turnMax: ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS,
      probeMax: ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS,
    },
  };

  it.each(allowedRomanModelIds())(
    'probe and turn payloads for %s match the documented contract',
    (id) => {
      expect(EXPECTED_CONTRACT).toHaveProperty(id); // every allowed model has a pinned contract
      const want = EXPECTED_CONTRACT[id];
      const profile = lookupRomanModel(id)!;
      for (const body of [turnRequestFor(profile, 'low'), probeRequestFor(profile, 'low')]) {
        expect(body.model).toBe(id);
        if (want.thinking === undefined) expect(body).not.toHaveProperty('thinking');
        else expect(body.thinking).toEqual(want.thinking);
        if (want.effort) expect(body.output_config).toEqual({ effort: 'low' });
        else expect(body).not.toHaveProperty('output_config');
        // Fields Anthropic 400s on for the 5.x families are never present.
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('top_p');
        expect(body).not.toHaveProperty('top_k');
        expect(JSON.stringify(body)).not.toContain('"disabled"');
        // between_tools is Sonnet-only; adaptive is Opus-only.
        if (profile.family === 'opus_5_5')
          expect(JSON.stringify(body)).not.toContain('between_tools');
        if (profile.family === 'sonnet_5_5') expect(JSON.stringify(body)).not.toContain('adaptive');
      }
      expect(turnRequestFor(profile, 'low').max_tokens).toBe(want.turnMax);
      expect(probeRequestFor(profile, 'low').max_tokens).toBe(want.probeMax);
    },
  );

  it('every allowed model has a contract pinned in this spec (no untested family)', () => {
    expect(Object.keys(EXPECTED_CONTRACT).sort()).toEqual(allowedRomanModelIds().sort());
  });

  // Sol audit of #598, finding C1: inherited Object.prototype names must not
  // pass the allow-list.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype'])(
    'rejects the inherited property name %s as an unknown model at boot',
    (name) => {
      expect(lookupRomanModel(name)).toBeNull();
      expect(() => resolveRomanModelConfig({ [ROMAN_MODEL_PRIMARY_ENV]: name })).toThrow(
        /not an allowed Roman model/,
      );
      expect(() => resolveRomanModelConfig({ [ROMAN_MODEL_FALLBACK_ENV]: name })).toThrow(
        RomanModelConfigError,
      );
      expect(() => new RomanModelHealthService(null, { [ROMAN_MODEL_PRIMARY_ENV]: name })).toThrow(
        RomanModelConfigError,
      );
    },
  );

  it('the allow-list has no prototype and only lists real model ids', () => {
    expect(Object.getPrototypeOf(ROMAN_MODEL_ALLOWLIST)).toBeNull();
    expect(allowedRomanModelIds()).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
    ]);
    expect(Object.isFrozen(ROMAN_MODEL_ALLOWLIST)).toBe(true);
  });

  it('prices calls from the model card in whole cents, rounded up', () => {
    const c = resolveRomanModelConfig({});
    // 5,000 in @ $2/MTok = $0.01; 250 out @ $10/MTok = $0.0025 → $0.0125 → 2 cents
    expect(costCentsFor(c.primary, 5000, 250)).toBe(2);
    expect(costCentsFor(c.fallback, 0, 0)).toBe(0);
  });
});

describe('R1 upstream error classification', () => {
  it('describes SDK errors without their message text', () => {
    const d = describeUpstreamError(sdkError('NotFoundError', 404, 'not_found_error'));
    expect(d).toEqual({
      name: 'NotFoundError',
      status: 404,
      type: 'not_found_error',
      aborted: false,
    });
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('falls back on 404 / 529 / 5xx / connection errors but not on 400 / 401 / 429', () => {
    expect(
      isFallbackEligible(describeUpstreamError(sdkError('NotFoundError', 404, 'not_found_error'))),
    ).toBe(true);
    expect(
      isFallbackEligible(describeUpstreamError(sdkError('APIError', 529, 'overloaded_error'))),
    ).toBe(true);
    expect(
      isFallbackEligible(describeUpstreamError(sdkError('InternalServerError', 500, 'api_error'))),
    ).toBe(true);
    expect(
      isFallbackEligible(describeUpstreamError(sdkError('APIConnectionError', null, null))),
    ).toBe(true);
    expect(
      isFallbackEligible(
        describeUpstreamError(sdkError('BadRequestError', 400, 'invalid_request_error')),
      ),
    ).toBe(false);
    expect(
      isFallbackEligible(
        describeUpstreamError(sdkError('AuthenticationError', 401, 'authentication_error')),
      ),
    ).toBe(false);
    expect(
      isFallbackEligible(
        describeUpstreamError(sdkError('RateLimitError', 429, 'rate_limit_error')),
      ),
    ).toBe(false);
  });
});

// ─── request shape + fallback + model_id ─────────────────────────────────────

describe('R1 request shape and fallback', () => {
  it('sends sonnet-5-5 with between_tools + effort and no temperature / thinking.disabled', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['Hello.'] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    await drain(service);

    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    const body = anthropic.messages.stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('sends opus-5-5 turns with thinking.adaptive and a thinking-inclusive max_tokens (B1)', async () => {
    process.env[ROMAN_MODEL_PRIMARY_ENV] = 'claude-opus-5-5';
    process.env[ROMAN_MODEL_EFFORT_ENV] = 'medium';
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['Good evening.'] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    await drain(service);

    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    const body = anthropic.messages.stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(JSON.stringify(body)).not.toContain('between_tools');
    expect(body).not.toHaveProperty('temperature');
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant?.model_id).toBe('claude-opus-5-5');
  });

  it('reads the model from env and sends the plain request for sonnet-4-6', async () => {
    process.env[ROMAN_MODEL_PRIMARY_ENV] = 'claude-sonnet-4-6';
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['Hello.'] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    await drain(service);
    const body = anthropic.messages.stream.mock.calls[0][0] as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  it('falls back to sonnet-4-6 on a primary 404 and records the ANSWERING model', async () => {
    const { prisma, messages, callLogs } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
      { kind: 'ok', deltas: ['From ', 'fallback.'] },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);

    expect(anthropic.messages.stream).toHaveBeenCalledTimes(2);
    expect((anthropic.messages.stream.mock.calls[0][0] as { model: string }).model).toBe(
      'claude-sonnet-5-5',
    );
    expect((anthropic.messages.stream.mock.calls[1][0] as { model: string }).model).toBe(
      'claude-sonnet-4-6',
    );
    const done = chunks.find((c) => c.type === 'done');
    expect(done?.text).toBe('From fallback.');
    expect(done?.modelId).toBe('claude-sonnet-4-6');
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant?.model_id).toBe('claude-sonnet-4-6');
    expect(assistant?.interrupted).toBe(false);
    // One ledger row per upstream call: the failed primary and the fallback.
    expect(callLogs).toHaveLength(2);
    expect(callLogs[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      success: false,
      capability: 'roman_chat',
    });
    expect(String(callLogs[0].errorMessage)).not.toContain('secret');
    expect(callLogs[1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      success: true,
      clientId: 'user-A',
    });
  });

  it('records model_id from the response `message.model`, not the requested id', async () => {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'ok', deltas: ['Hi.'], model: 'claude-sonnet-5-5-20260901' },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    await drain(service);
    expect(messages.find((m) => m.role === 'roman')?.model_id).toBe('claude-sonnet-5-5-20260901');
  });

  it('does NOT fall back on a 400 (the fallback would fail the same way)', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'throw', err: sdkError('BadRequestError', 400, 'invalid_request_error') },
      { kind: 'ok', deltas: ['never'] },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    expect(chunks.find((c) => c.type === 'error')).toBeDefined();
  });

  it('does NOT fall back once text has already streamed', async () => {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic([
      {
        kind: 'throw_after',
        deltas: ['Partial '],
        err: sdkError('InternalServerError', 500, 'api_error'),
      },
      { kind: 'ok', deltas: ['never'] },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    const error = chunks.find((c) => c.type === 'error');
    expect(error?.code).toBe('ROMAN_UNAVAILABLE');
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant?.content).toBe('Partial ');
    expect(assistant?.interrupted).toBe(true);
  });
});

// ─── honest failure ──────────────────────────────────────────────────────────

describe('R1 honest failure — never a blank reply', () => {
  it('yields an `error` chunk (not an empty `done`) when both models fail', async () => {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);

    expect(chunks.find((c) => c.type === 'done')).toBeUndefined();
    const error = chunks.find((c) => c.type === 'error');
    expect(error).toMatchObject({ code: 'ROMAN_UNAVAILABLE', messageId: expect.any(String) });
    expect(typeof error?.message).toBe('string');
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.content).toBe('');
  });

  it('yields ROMAN_EMPTY_REPLY when the model answers with no text', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: [] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);
    expect(chunks.find((c) => c.type === 'done')).toBeUndefined();
    expect(chunks.find((c) => c.type === 'error')?.code).toBe('ROMAN_EMPTY_REPLY');
  });

  it('the controller writes a structured SSE `event: error` frame and ends the response', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
      { kind: 'throw', err: sdkError('APIError', 529, 'overloaded_error') },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const ctrl = new RomanController(
      service,
      asPrismaDouble({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
    );
    const writes: string[] = [];
    const res = {
      writeHead: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((c: string) => writes.push(c)),
      end: jest.fn(),
      setHeader: jest.fn(),
    };
    const req = { user: CALLER, on: jest.fn(), off: jest.fn() };
    await ctrl.sendMessage(asAuthedRequestDouble(req), asResponseDouble(res), 'sess_1', {
      content: 'hello',
    });

    const joined = writes.join('');
    expect(joined).toContain('event: error\n');
    const frame = JSON.parse(joined.split('event: error\ndata: ')[1].split('\n\n')[0]);
    expect(frame).toMatchObject({ type: 'error', code: 'ROMAN_UNAVAILABLE' });
    expect(joined).not.toContain('"type":"done"');
    expect(joined).not.toContain('secret');
    expect(res.end).toHaveBeenCalled();
  });

  it('scrubs upstream text from the warning log (class/status/type only)', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
      { kind: 'throw', err: sdkError('NotFoundError', 404, 'not_found_error') },
    ]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const internals: { logger: { warn: (m: string) => void } } = Object(service);
    const warn = jest.spyOn(internals.logger, 'warn');
    await drain(service);
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain('secret');
      expect(String(call[0])).not.toContain('upstream body');
      expect(String(call[0])).toMatch(/class=NotFoundError status=404 type=not_found_error/);
    }
  });

  it('refuses with 503 ROMAN_UNAVAILABLE when the health service says down', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['x'] }]);
    const health = new RomanModelHealthService(asAnthropicDouble(anthropic), {});
    const internals: { status: { status: string } } = Object(health);
    internals.status.status = 'down';
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic), health);
    const session = await service.getOwnedSession(CALLER, 'sess_1');
    await expect(service.streamAssistantTurn(CALLER, session).next()).rejects.toMatchObject({
      response: { code: 'ROMAN_UNAVAILABLE' },
    });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });
});

// ─── daily cap + history cap ─────────────────────────────────────────────────

describe('R1 cost controls', () => {
  it('serves the resting reply with ZERO model calls once the daily cap is reached', async () => {
    process.env[ROMAN_GLOBAL_DAILY_USD_CAP_ENV] = '1';
    const { prisma, messages } = makePrisma({ spentCents: 100 });
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['never'] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    const chunks = await drain(service);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.type === 'done')?.text).toBe(ROMAN_DAILY_CAP_REPLY);
    expect(messages.find((m) => m.role === 'roman')?.model_id).toBeNull();
  });

  it('keeps answering while under the cap', async () => {
    process.env[ROMAN_GLOBAL_DAILY_USD_CAP_ENV] = '1';
    const { prisma } = makePrisma({ spentCents: 99 });
    const anthropic = makeAnthropic([{ kind: 'ok', deltas: ['Yes.'] }]);
    const service = new RomanService(asPrismaDouble(prisma), asAnthropicDouble(anthropic));
    await drain(service);
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
  });

  it('clamps prior turns and trims oldest-first to the history token budget', async () => {
    const { prisma } = makePrisma();
    const service = new RomanService(asPrismaDouble(prisma), null);
    const big = 'x'.repeat(10_000);
    // 20 prior turns of 10k chars each would be 200k chars; the budget is 24k.
    for (let i = 0; i < 20; i++) {
      await prisma.romanMessage.create({
        data: {
          session_id: 'sess_1',
          user_id: 'user-A',
          role: i % 2 === 0 ? 'user' : 'roman',
          content: big,
        },
      });
    }
    await prisma.romanMessage.create({
      data: { session_id: 'sess_1', user_id: 'user-A', role: 'user', content: 'newest question' },
    });
    const turns = await service.buildContextTurns('sess_1');
    const total = turns.reduce((n, t) => n + t.content.length, 0);
    expect(total).toBeLessThanOrEqual(6000 * 4);
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: 'newest question' });
    expect(turns[0].role).toBe('user');
    for (const t of turns.slice(0, -1))
      expect(t.content.length).toBeLessThanOrEqual(ROMAN_HISTORY_TURN_MAX_CHARS);
  });
});

// ─── health service + /health/roman ──────────────────────────────────────────

function makeProbeClient(results: Record<string, boolean>) {
  return {
    messages: {
      create: jest.fn(async ({ model }: { model: string }) => {
        if (results[model]) return { id: 'msg', model };
        throw sdkError('NotFoundError', 404, 'not_found_error');
      }),
      stream: jest.fn(),
    },
  };
}

describe('R1 RomanModelHealthService', () => {
  it('is unconfigured without a client and reports it', async () => {
    const h = new RomanModelHealthService(null, {});
    await h.onApplicationBootstrap();
    expect(h.getStatus().status).toBe('unconfigured');
    expect(h.isDown()).toBe(true);
  });

  it('skips the network in NODE_ENV=test and reports ready', async () => {
    const client = makeProbeClient({});
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.onApplicationBootstrap();
    expect(h.getStatus().status).toBe('ready');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('probes both models with 4 tokens and the per-model request profile', async () => {
    const client = makeProbeClient({ 'claude-sonnet-5-5': true, 'claude-sonnet-4-6': true });
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.probe();
    expect(h.getStatus()).toMatchObject({ status: 'ready', primary_ok: true, fallback_ok: true });
    const bodies = client.messages.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const primary = bodies.find((b) => b.model === 'claude-sonnet-5-5')!;
    const fallback = bodies.find((b) => b.model === 'claude-sonnet-4-6')!;
    expect(primary.max_tokens).toBe(4);
    expect(primary.thinking).toEqual({ type: 'between_tools' });
    expect(fallback).not.toHaveProperty('thinking');
    expect(fallback.max_tokens).toBe(4);
    expect(h.preferredOrder().map((p) => p.id)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-4-6']);
  });

  it('probes opus-5-5 with the ADAPTIVE profile and a thinking-inclusive budget (B1)', async () => {
    const client = makeProbeClient({ 'claude-opus-5-5': true, 'claude-sonnet-5-5': true });
    const h = new RomanModelHealthService(asAnthropicDouble(client), {
      [ROMAN_MODEL_PRIMARY_ENV]: 'claude-opus-5-5',
      [ROMAN_MODEL_FALLBACK_ENV]: 'claude-sonnet-5-5',
    });
    await h.probe();
    expect(h.getStatus()).toMatchObject({ status: 'ready', primary_model: 'claude-opus-5-5' });
    const bodies = client.messages.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const opus = bodies.find((b) => b.model === 'claude-opus-5-5')!;
    const sonnet = bodies.find((b) => b.model === 'claude-sonnet-5-5')!;
    expect(opus.thinking).toEqual({ type: 'adaptive' });
    expect(opus.output_config).toEqual({ effort: 'low' });
    expect(opus.max_tokens).toBe(ROMAN_ADAPTIVE_PROBE_MAX_TOKENS);
    expect(JSON.stringify(opus)).not.toContain('between_tools');
    expect(sonnet.thinking).toEqual({ type: 'between_tools' });
    expect(sonnet.max_tokens).toBe(ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS);
  });

  it('is degraded when only the fallback answers, and routes straight to it', async () => {
    const client = makeProbeClient({ 'claude-sonnet-4-6': true });
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.probe();
    expect(h.getStatus().status).toBe('degraded');
    expect(h.isDown()).toBe(false);
    expect(h.preferredOrder().map((p) => p.id)).toEqual(['claude-sonnet-4-6']);
  });

  it('is down when neither answers', async () => {
    const client = makeProbeClient({});
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.probe();
    expect(h.getStatus()).toMatchObject({ status: 'down', primary_ok: false, fallback_ok: false });
    expect(h.isDown()).toBe(true);
  });

  it('/health/roman is 503 when down and the flag is ON, 200 when the flag is OFF', async () => {
    const client = makeProbeClient({});
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.probe();
    const ctrl = new RomanHealthController(h);

    const res1 = { status: jest.fn() };
    const body1 = ctrl.roman(asResponseDouble(res1));
    expect(res1.status).toHaveBeenCalledWith(503);
    expect(body1).toMatchObject({
      status: 'down',
      enabled: true,
      primary_model: 'claude-sonnet-5-5',
    });
    expect(JSON.stringify(body1)).not.toContain('secret');

    delete process.env[FLAG];
    const res2 = { status: jest.fn() };
    const body2 = ctrl.roman(asResponseDouble(res2));
    expect(res2.status).not.toHaveBeenCalled();
    expect(body2.enabled).toBe(false);
  });

  it('/health/roman is 200 with the model ids when ready', async () => {
    const client = makeProbeClient({ 'claude-sonnet-5-5': true, 'claude-sonnet-4-6': true });
    const h = new RomanModelHealthService(asAnthropicDouble(client), {});
    await h.probe();
    const res = { status: jest.fn() };
    const body = new RomanHealthController(h).roman(asResponseDouble(res));
    expect(res.status).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      status: 'ready',
      primary_model: 'claude-sonnet-5-5',
      fallback_model: 'claude-sonnet-4-6',
      probed_at: expect.any(String),
    });
  });
});

describe('R1 DI wiring', () => {
  it('RomanModelHealthService resolves through Nest DI with no client bound (unconfigured)', async () => {
    const { Test } = await import('@nestjs/testing');
    const moduleRef = await Test.createTestingModule({
      providers: [RomanModelHealthService],
    }).compile();
    const h = moduleRef.get(RomanModelHealthService);
    expect(h.getStatus().status).toBe('unconfigured');
    expect(h.config.primary.id).toBe('claude-sonnet-5-5');
    await moduleRef.close();
  });
});
