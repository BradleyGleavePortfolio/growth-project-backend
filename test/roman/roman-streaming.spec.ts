// test/roman/roman-streaming.spec.ts
//
// Roman Phase 1 SSE streaming — end-to-end through the REAL RomanController and
// REAL RomanService, with a fake Anthropic client and an in-memory Prisma
// double. This exercises the two behaviours the brief calls out explicitly
// (§1.3) that the controller-spec doubles cannot cover, because here the
// service's own stream loop runs:
//
//   1. Happy path: the Anthropic event stream (message_start → text deltas →
//      message_delta usage) is translated into `data: {…}\n\n` SSE frames, the
//      assistant turn is persisted whole with token usage, and a `done` frame
//      carries the persisted message id + interrupted=false.
//
//   2. Client-disconnect: when `req` emits 'close' mid-stream, the controller
//      aborts the AbortController, the service stops reading, and persists the
//      PARTIAL assistant text with interrupted=true. The transcript stays
//      honest about the truncated turn.
//
// We use the real service so the abort plumbing (controller AbortController →
// service `opts.signal.aborted`) is genuinely tested, not mocked away.

import 'reflect-metadata';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanService } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { egressWithGrants, fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import {
  AI_EGRESS_POLICY_CODE,
  AI_EGRESS_POLICY_MESSAGE,
  AiConsentRequiredException,
  AiEgressPolicyException,
} from '../../src/ai-egress/ai-consent-required.exception';
import { SUPPORT_EMAIL } from '../../src/public-pages/trust-pages.html';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import { ROMAN_MODEL_PHASE_1 } from '../../src/roman/anthropic-client.provider';
import {
  ROMAN_ERROR_CAPACITY_REACHED,
  ROMAN_ERROR_RATE_LIMIT,
} from '../../src/roman/roman.constants';

// ─── flag harness (streaming requires the feature ON) ─────────────────────────
const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

// ─── in-memory Prisma double ──────────────────────────────────────────────────
interface MsgRow {
  id: string;
  session_id: string;
  user_id: string;
  role: 'user' | 'roman';
  content: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model_id: string | null;
  interrupted: boolean;
  parent_message_id: string | null;
  created_at: Date;
}

function makePrisma(sessionOwner = 'user-A') {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const session = {
    id: 'sess_1',
    user_id: sessionOwner,
    surface: 'client' as const,
    day_key: '2026-06-09',
    message_count: 0,
    started_at: new Date('2026-06-09T00:00:00.000Z'),
    last_activity_at: new Date('2026-06-09T00:00:00.000Z'),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: new Date('2026-06-09T00:00:00.000Z'),
    updated_at: new Date('2026-06-09T00:00:00.000Z'),
    deleted_at: null as Date | null,
  };
  const messages: MsgRow[] = [];

  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: MsgRow = {
        id: id('msg'),
        session_id: data.session_id as string,
        user_id: data.user_id as string,
        role: data.role as 'user' | 'roman',
        content: data.content as string,
        prompt_tokens: (data.prompt_tokens as number | null) ?? null,
        completion_tokens: (data.completion_tokens as number | null) ?? null,
        model_id: (data.model_id as string | null) ?? null,
        interrupted: (data.interrupted as boolean) ?? false,
        parent_message_id: (data.parent_message_id as string | null) ?? null,
        created_at: new Date(Date.now() + messages.length),
      };
      messages.push(row);
      return row;
    }),
    findMany: jest.fn(async () =>
      [...messages].sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime(),
      ),
    ),
    count: jest.fn(async () => 0),
    findFirst: jest.fn(async () => null),
  };

  const romanSession = {
    findFirst: jest.fn(async () => (session.deleted_at ? null : session)),
    findMany: jest.fn(async () => []),
    // No erased shells in these streaming fixtures.
    aggregate: jest.fn(async () => ({
      _sum: { message_count: null },
      _min: { last_activity_at: null },
    })),
    updateMany: jest.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== session.id || where.user_id !== session.user_id || session.deleted_at) {
          return { count: 0 };
        }
        if (
          data.message_count &&
          typeof data.message_count === 'object' &&
          'increment' in (data.message_count as object)
        ) {
          session.message_count += 1;
        }
        if (data.last_activity_at) session.last_activity_at = new Date();
        return { count: 1 };
      },
    ),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (
        data.message_count &&
        typeof data.message_count === 'object' &&
        'increment' in (data.message_count as object)
      ) {
        session.message_count += 1;
      }
      if (data.last_activity_at) session.last_activity_at = new Date();
      return session;
    }),
  };

  // OR-113-2: the content-free spend ledger (reserve, then settle).
  const audits: Array<Record<string, unknown>> = [];
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push({ ...data });
      return data;
    }),
    aggregate: jest.fn(async () => ({
      _sum: { prompt_token_estimate: 0, response_token_estimate: 0 },
    })),
    update: jest.fn(
      async ({ where, data }: { where: { request_id: string }; data: Record<string, unknown> }) => {
        const row = audits.find((a) => a.request_id === where.request_id);
        if (row) Object.assign(row, data);
        return row;
      },
    ),
  };

  // B-651-5: the spend admission takes a per-day advisory lock in its tx.
  const $executeRaw = jest.fn(async () => 1);
  const prisma = {
    romanSession,
    romanMessage,
    aiRequestAudit,
    $executeRaw,
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ romanMessage, romanSession, aiRequestAudit, $executeRaw }),
    ),
  };
  return { prisma, session, messages, romanMessage, audits };
}

// ─── fake Anthropic client ────────────────────────────────────────────────────
// `messages.stream(...)` returns an async-iterable of SDK-shaped events. We
// emit message_start (input usage), a series of text deltas, then a
// message_delta (output usage). `gap()` lets a test interleave the client
// 'close' between deltas to drive the disconnect path.
function makeAnthropic(deltas: string[], gap: () => Promise<void> = async () => {}) {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 42 } } };
      for (const text of deltas) {
        await gap();
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        };
      }
      yield { type: 'message_delta', usage: { output_tokens: 7 } };
    },
  };
  return {
    messages: {
      stream: jest.fn(
        (_body: unknown, _options?: { signal?: AbortSignal }) => stream,
      ),
    },
  };
}

// ─── fake express Request/Response ────────────────────────────────────────────
function makeReq(user = { id: 'user-A', role: 'student' }) {
  const handlers: Record<string, Array<() => void>> = {};
  const req = {
    user,
    on: jest.fn((ev: string, fn: () => void) => {
      (handlers[ev] ??= []).push(fn);
    }),
    off: jest.fn((ev: string, fn: () => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn);
    }),
    emit: (ev: string) => (handlers[ev] ?? []).forEach((h) => h()),
  };
  return req;
}

function makeRes() {
  const writes: string[] = [];
  let ended = false;
  const res = {
    writeHead: jest.fn((): void => {}),
    setHeader: jest.fn((): void => {}),
    flushHeaders: jest.fn(),
    write: jest.fn((c: string): boolean => {
      writes.push(c);
      return true;
    }),
    end: jest.fn((): void => {
      ended = true;
    }),
  };
  return { res, writes, isEnded: () => ended };
}

function parseFrames(writes: string[]) {
  return writes
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      return {
        event: eventLine ? eventLine.slice('event: '.length) : 'message',
        data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null,
      };
    });
}

const FREE = { id: 'user-A', role: 'student', tier: 'free' as const };

describe('Roman SSE streaming — happy path', () => {
  it('translates Anthropic deltas into SSE frames and persists the full turn', async () => {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic(['Push ', 'harder', '.']);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));

    const session = await service.getOwnedSession(FREE, 'sess_1');
    const frames: unknown[] = [];
    for await (const chunk of service.streamAssistantTurn(FREE, session)) {
      frames.push(chunk);
    }

    const deltas = (frames as Array<{ type: string; text?: string }>).filter(
      (f) => f.type === 'delta',
    );
    // A-R4-4: the reply is buffered, post-checked, then emitted ONCE.
    expect(deltas.map((d) => d.text)).toEqual(['Push harder.']);

    const done = (frames as Array<{ type: string; interrupted?: boolean; messageId?: string }>).find(
      (f) => f.type === 'done',
    );
    expect(done).toBeDefined();
    expect(done?.interrupted).toBe(false);
    expect(done?.messageId).toBeTruthy();

    // Persisted assistant turn: full text + token usage from the SDK events.
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe('Push harder.');
    expect(assistant?.interrupted).toBe(false);
    expect(assistant?.prompt_tokens).toBe(42);
    expect(assistant?.completion_tokens).toBe(7);
    // OR-113-2: the retired claude-3-7-sonnet-20250219 id was replaced.
    expect(assistant?.model_id).toBe(ROMAN_MODEL_PHASE_1);
  });

  it('writes correctly-framed SSE through the controller (data: …\\n\\n + done)', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic(['Let', "'s go"]);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));
    const ctrl = new RomanController(
      service as never,
      { coachSubscription: { findUnique: jest.fn(async () => null) } } as never,
    );
    const req = makeReq();
    const { res, writes, isEnded } = makeRes();

    await ctrl.sendMessage(req as never, res as never, 'sess_1', {
      content: 'hello',
    });

    const frames = parseFrames(writes);
    const deltaTexts = frames
      .filter((f) => f.event === 'message' && f.data?.type === 'delta')
      .map((f) => f.data.text);
    expect(deltaTexts).toEqual(["Let's go"]);
    const done = frames.find((f) => f.data?.type === 'done');
    expect(done?.data.interrupted).toBe(false);
    expect(isEnded()).toBe(true);
  });
});

describe('Roman SSE streaming — client disconnect', () => {
  it('persists the PARTIAL assistant turn with interrupted=true when the client disconnects', async () => {
    const { prisma, messages } = makePrisma();

    // Drive a disconnect after the first delta: the 2nd `gap()` call fires the
    // req 'close' event, which aborts the controller's AbortController.
    const req = makeReq();
    let gapCalls = 0;
    const gap = async () => {
      gapCalls += 1;
      if (gapCalls === 2) {
        // Second delta about to be read — signal client close first.
        req.emit('close');
        // Yield so the abort propagates before the next delta is consumed.
        await Promise.resolve();
      }
    };
    const anthropic = makeAnthropic(['First ', 'second ', 'third'], gap);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));
    const ctrl = new RomanController(
      service as never,
      { coachSubscription: { findUnique: jest.fn(async () => null) } } as never,
    );
    const { res, writes, isEnded } = makeRes();

    await ctrl.sendMessage(req as never, res as never, 'sess_1', {
      content: 'go',
    });

    // The persisted assistant turn is the PARTIAL text and marked interrupted.
    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant).toBeDefined();
    expect(assistant?.interrupted).toBe(true);
    // Only the first delta was consumed before the abort took effect.
    expect(assistant?.content).toBe('First ');

    const frames = parseFrames(writes);
    const done = frames.find((f) => f.data?.type === 'done');
    expect(done?.data.interrupted).toBe(true);
    expect(isEnded()).toBe(true);
  });

  it('forwards an AbortSignal to the Anthropic SDK and aborts it on client disconnect', async () => {
    const { prisma } = makePrisma();

    const req = makeReq();
    let gapCalls = 0;
    const gap = async () => {
      gapCalls += 1;
      if (gapCalls === 2) {
        req.emit('close'); // client disconnects mid-stream
        await Promise.resolve();
      }
    };
    const anthropic = makeAnthropic(['First ', 'second ', 'third'], gap);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));
    const ctrl = new RomanController(
      service as never,
      { coachSubscription: { findUnique: jest.fn(async () => null) } } as never,
    );
    const { res } = makeRes();

    await ctrl.sendMessage(req as never, res as never, 'sess_1', {
      content: 'go',
    });

    // The SDK stream call must have received a signal (second-arg options) so
    // the upstream provider request can be cancelled (brief §7).
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    const options = anthropic.messages.stream.mock.calls[0][1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    // After the client disconnected, that upstream signal must be aborted so
    // Anthropic stops generating — no orphaned stream.
    expect(options?.signal?.aborted).toBe(true);
  });

  it('aborts the upstream signal even on a clean completion (no leak)', async () => {
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic(['done ', 'now']);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));

    const session = await service.getOwnedSession(FREE, 'sess_1');
    for await (const _chunk of service.streamAssistantTurn(FREE, session)) {
      // drain to completion
    }

    const options = anthropic.messages.stream.mock.calls[0][1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(true);
  });

  it('aborting before any token still records an honest interrupted turn', async () => {
    const { prisma, messages } = makePrisma();
    const req = makeReq();
    const gap = async () => {
      // Abort before the FIRST delta is consumed.
      req.emit('close');
      await Promise.resolve();
    };
    const anthropic = makeAnthropic(['never-seen'], gap);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));
    const ctrl = new RomanController(
      service as never,
      { coachSubscription: { findUnique: jest.fn(async () => null) } } as never,
    );
    const { res } = makeRes();

    await ctrl.sendMessage(req as never, res as never, 'sess_1', { content: 'x' });

    const assistant = messages.find((m) => m.role === 'roman');
    expect(assistant).toBeDefined();
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.content).toBe(''); // empty partial — no tokens streamed
  });
});

describe('Roman SSE streaming — defence in depth', () => {
  it('the service refuses to stream while the feature flag is OFF', async () => {
    delete process.env[FLAG];
    const { prisma } = makePrisma();
    const anthropic = makeAnthropic(['hi']);
    const service = new RomanService(prisma as never, grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)));
    const session = await service.getOwnedSession(FREE, 'sess_1').catch(() => null);
    // getOwnedSession does not gate on the flag (the guard does), so it returns
    // the session; the stream itself must refuse.
    expect(session).toBeTruthy();
    const gen = service.streamAssistantTurn(FREE, session as never);
    await expect(gen.next()).rejects.toMatchObject({
      response: { code: 'ROMAN_UNAVAILABLE' },
    });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it('surfaces ROMAN_UNAVAILABLE when no Anthropic client is configured', async () => {
    const { prisma } = makePrisma();
    const service = new RomanService(prisma as never, grantAllEgress(), null);
    const session = await service.getOwnedSession(FREE, 'sess_1');
    const gen = service.streamAssistantTurn(FREE, session);
    await expect(gen.next()).rejects.toMatchObject({
      response: { code: 'ROMAN_UNAVAILABLE' },
    });
  });
});

describe('Roman — R2b box-2 consent', () => {
  function setup(granted: string[]) {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic(['Hi', '.']);
    const { egress, reader } = egressWithGrants(granted);
    const service = new RomanService(
      fakeOf(prisma),
      egress,
      AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    );
    const ctrl = new RomanController(
      fakeOf(service),
      fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
    );
    return { service, ctrl, messages, anthropic, reader };
  }

  it('grant: the client chat streams', async () => {
    const { ctrl, anthropic } = setup(['user-A']);
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content: 'hello' });
    expect(anthropic.messages.stream).toHaveBeenCalledTimes(1);
    expect(parseFrames(writes).some((f) => f.data?.type === 'done')).toBe(true);
  });

  it('no grant: 403 ai_consent_required before the turn is stored or the stream opens', async () => {
    const { ctrl, anthropic, messages } = setup([]);
    const { res } = makeRes();
    const before = messages.length;
    const err = await ctrl
      .sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content: 'hello' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect((err as AiConsentRequiredException).getResponse()).toEqual({
      code: 'ai_consent_required',
      message: "You haven't allowed AI help yet. You can turn it on in Settings > Privacy.",
    });
    expect(messages.length).toBe(before);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it('revoked after the pre-check: the stream is refused at send, no Roman turn is stored', async () => {
    const { service, anthropic, messages, reader } = setup(['user-A']);
    const session = await service.getOwnedSession(FREE, 'sess_1');
    reader.revoke('user-A');
    const consume = async () => {
      for await (const _chunk of service.streamAssistantTurn(FREE, session)) {
        // drain
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(messages.some((m) => m.role === 'roman')).toBe(false);
  });

  it('revoked mid-request through the controller: a structured error event, not a generic one', async () => {
    const { ctrl, service, reader } = setup(['user-A']);
    const pre = service.assertMayUseAi.bind(service);
    jest.spyOn(service, 'assertMayUseAi').mockImplementation(async (caller) => {
      await pre(caller);
      reader.revoke('user-A');
    });
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content: 'hello' });
    const error = parseFrames(writes).find((f) => f.event === 'error');
    expect(error?.data).toMatchObject({ code: 'ai_consent_required' });
  });

  it('B-626-1/B-626-2: a policy refusal mid-stream is a specific {code, message} frame; the reference is the X-Request-ID header', async () => {
    const { ctrl, service } = setup(['user-A']);
    jest.spyOn(service, 'streamAssistantTurn').mockImplementation(async function* () {
      yield* [];
      throw new AiEgressPolicyException();
    });
    const { res, writes } = makeRes();
    const req = Object.assign(makeReq(), { requestId: 'req_7f3a' });
    await ctrl.sendMessage(fakeOf(req), fakeOf(res), 'sess_1', { content: 'hello' });
    const error = parseFrames(writes).find((f) => f.event === 'error');
    expect(error?.data).toEqual({
      code: AI_EGRESS_POLICY_CODE,
      message: AI_EGRESS_POLICY_MESSAGE,
    });
    expect(error?.data.message).toContain(SUPPORT_EMAIL);
    expect(error?.data.message).not.toContain('Settings');
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'X-Request-ID': 'req_7f3a', 'Content-Type': 'text/event-stream' }),
    );
  });

  it('ledger error: fails closed', async () => {
    const { ctrl, anthropic, reader } = setup(['user-A']);
    reader.failWith = new Error('db down');
    const { res } = makeRes();
    await expect(
      ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content: 'hello' }),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it('coach caller: own scope, no client consent read', async () => {
    const { service, reader } = setup([]);
    await expect(service.assertMayUseAi({ id: 'coach-1', role: 'coach', tier: 'free' })).resolves.toBeUndefined();
    expect(reader.calls).toHaveLength(0);
  });
});

// FIX ROUND 1 (S-B1, #651) FR1-651-4: the SafetyRouter's 911 / 988 templates
// cost nothing (no model call, no spend), so a crisis message is answered even
// when the caller has used every Roman turn or the daily spend cap is reached.
describe('Roman — crisis messages are never blocked by the turn limit or the spend cap', () => {
  function setup() {
    const made = makePrisma();
    const anthropic = makeAnthropic(['Hi', '.']);
    const service = new RomanService(
      fakeOf(made.prisma),
      grantAllEgress(),
      AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    );
    const ctrl = new RomanController(
      fakeOf(service),
      fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
    );
    return { ...made, anthropic, ctrl };
  }
  afterEach(() => {
    delete process.env.ROMAN_DAILY_COST_CAP_USD;
  });

  it('daily cap reached: a self-harm message still gets the 988 template; an ordinary one gets the coded 503', async () => {
    process.env.ROMAN_DAILY_COST_CAP_USD = '0';
    const { ctrl, anthropic, messages } = setup();
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', {
      content: 'I don\u2019t want to be here anymore',
    });
    const done = parseFrames(writes).find((f) => f.data?.type === 'done');
    expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.self_harm);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);

    const second = makeRes();
    const err = await ctrl
      .sendMessage(fakeOf(makeReq()), fakeOf(second.res), 'sess_1', { content: 'hello' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ response: { code: ROMAN_ERROR_CAPACITY_REACHED } });
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it.each([
    'I want to take all my pills',
    "I'm going to take all of my meds tonight",
    'I am gonna take a bunch of pills',
    'I want to take a whole bottle of Tylenol',
    "I'm going to OD",
    'I am gonna OD',
    'I want to OD',
  ])('daily cap reached: "%s" gets the 988 template, no model call (B-AIG4-123)', async (content) => {
    process.env.ROMAN_DAILY_COST_CAP_USD = '0';
    const { ctrl, anthropic, messages } = setup();
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content });
    const done = parseFrames(writes).find((f) => f.data?.type === 'done');
    expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.self_harm);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);
  });

  it.each([
    ['Possible overdose, what do I do?', 'emergency'],
    ['my teammate is overdosing, what do I do', 'emergency'],
    ['I cut myself again', 'self_harm'],
  ] as const)(
    'daily cap reached: "%s" gets the %s template, no model call (B-ROMAN911-123 FIX ROUND 1)',
    async (content, cls) => {
      process.env.ROMAN_DAILY_COST_CAP_USD = '0';
      const { ctrl, anthropic, messages } = setup();
      const { res, writes } = makeRes();
      await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content });
      const done = parseFrames(writes).find((f) => f.data?.type === 'done');
      expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES[cls]);
      expect(anthropic.messages.stream).not.toHaveBeenCalled();
      expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);
    },
  );

  it('turn limit used up: an emergency message still gets the 911 template; an ordinary one gets the 429', async () => {
    const { ctrl, anthropic, romanMessage } = setup();
    romanMessage.count.mockResolvedValue(10_000);
    romanMessage.findFirst.mockResolvedValue(null);
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', {
      content: 'I have crushing chest pain right now',
    });
    const done = parseFrames(writes).find((f) => f.data?.type === 'done');
    expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();

    const second = makeRes();
    const err = await ctrl
      .sendMessage(fakeOf(makeReq()), fakeOf(second.res), 'sess_1', { content: 'hello' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ response: { code: ROMAN_ERROR_RATE_LIMIT } });
  });
});

// FIX ROUND 1 (S-B1, #651) FR1-651-7: the PR's design answers the 911 / 988
// templates before the box-2 gate (no model, no client data leaves the app;
// CONSENT_D2_CONTRACT gates only data sent to the AI processor). The
// controller gate ran first and answered a crisis message from a client
// without box 2 with a 403 consent error instead of the crisis line.
describe('Roman — a crisis message is answered without box 2; nothing else is', () => {
  function setup(granted: string[], withModel = true) {
    const { prisma, messages } = makePrisma();
    const anthropic = makeAnthropic(['Hi', '.']);
    const { egress } = egressWithGrants(granted);
    const service = new RomanService(
      fakeOf(prisma),
      egress,
      withModel ? AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)) : undefined,
    );
    const ctrl = new RomanController(
      fakeOf(service),
      fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
    );
    return { ctrl, messages, anthropic };
  }

  it('no grant + self-harm message: the 988 template, zero model calls; an ordinary message is still 403', async () => {
    const { ctrl, anthropic, messages } = setup([]);
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', {
      content: 'I want to kill myself',
    });
    const done = parseFrames(writes).find((f) => f.data?.type === 'done');
    expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.self_harm);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);

    const second = makeRes();
    const err = await ctrl
      .sendMessage(fakeOf(makeReq()), fakeOf(second.res), 'sess_1', { content: 'hello' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(messages).toHaveLength(2);
  });

  it.each(['I think I am going into anaphylactic shock', 'I took a whole bottle of pills'])(
    'A-666-1 (Opus) no grant + acute emergency without the trigger word (%s): the 911 template, zero model calls',
    async (content) => {
      const { ctrl, anthropic, messages } = setup([]);
      const { res, writes } = makeRes();
      await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content });
      const done = parseFrames(writes).find((f) => f.data?.type === 'done');
      expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
      expect(anthropic.messages.stream).not.toHaveBeenCalled();
      expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);
    },
  );

  it('no AI provider configured: an emergency message still gets the 911 template', async () => {
    const { ctrl, messages } = setup(['user-A'], false);
    const { res, writes } = makeRes();
    await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', {
      content: 'I have crushing chest pain right now',
    });
    const done = parseFrames(writes).find((f) => f.data?.type === 'done');
    expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);
  });
});
