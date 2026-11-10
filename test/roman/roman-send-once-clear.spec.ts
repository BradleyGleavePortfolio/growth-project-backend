// test/roman/roman-send-once-clear.spec.ts
//
// SEND-ONCE-CLEAR-BE: a keyed Roman turn that nothing can still answer stops reading as "still being written".
//   Item 1: a clear of the mark that changes no row is logged by code (it never was).
//   Item 2: a fixed-reply turn (crisis template, eating-disorder fallback) carries its own short mark and bound.
//   Item 3: at shutdown, RomanService clears the marks of the keyed turns this process stored and cannot finish.
//
// Through the REAL RomanController and REAL RomanService over the in-memory Prisma double of
// test/roman/roman-send-once-pending.spec.ts (copied, not imported: importing a spec runs its cases). Frames are
// compared as the exact bytes the phone receives. The hook is called as `onModuleDestroy?.()`, so a guard that holds
// on a server without the hook runs there too.

import 'reflect-metadata';
import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanService, romanTurnIds } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV } from '../../src/roman/roman.feature';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import type { AuditService } from '../../src/audit/audit.service';
import type { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import * as safetyRouter from '../../src/roman/guardrails/safety-router';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RomanModule } from '../../src/roman/roman.module';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

/** The wire contract, as literals (the same bytes test/roman/roman-send-once-pending.spec.ts pins). */
const WIRE_UNAVAILABLE = 'event: error\ndata: {"code":"ROMAN_UNAVAILABLE","message":"Roman is not available right now."}\n\n';
const WIRE_PENDING = 'event: error\ndata: {"code":"ROMAN_REPLY_PENDING","message":"Roman is not available right now."}\n\n';

/** The marks, bounds and shutdown deadlines as literals, so these guards also run against a server without them. */
const MARK = -1;
const FIXED_MARK = -2;
const BOUND_MS = 660_000;
const FIXED_BOUND_MS = 120_000;
const WAIT_MS = 1_500;
const CLEAR_MS = 1_000;

const KEY = '2f1c7e52-8a6b-4c2d-9f1e-7b3a5d9e0c11';
const KEY_2 = '7d0b3c9e-1f2a-4b5c-8d6e-0a9b8c7d6e5f';
const WORDS = 'What should I train today?';
const USER_A = { id: 'user-A', role: 'student', coach_id: 'coach-1' as string | null };
const USER_B = { id: 'user-B', role: 'student', coach_id: 'coach-2' as string | null };
const SESSION = 'sess_1';
const REQUEST_ID = 'req_clear';

type Row = Record<string, unknown> & { id: string; role: string; created_at: Date };
type Where = Record<string, unknown>;

// Object filters are not modelled, except `in` and `OR` (the shutdown clear's where).
const matches = (row: Record<string, unknown>, where: Where = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Where[]).some((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return 'in' in v ? (v as { in: unknown[] }).in.includes(row[k]) : true;
    }
    return (row[k] ?? null) === (v ?? null);
  });

function makeDb() {
  let seq = 0;
  const messages: Row[] = [];
  const sessions = [
    { id: SESSION, user_id: USER_A.id },
    { id: 'sess_2', user_id: USER_A.id },
    { id: 'sess_B', user_id: USER_B.id },
  ].map((s) => ({
    ...s,
    surface: 'client' as const,
    day_key: '2026-11-09',
    message_count: 0,
    started_at: new Date('2026-11-09T00:00:00.000Z'),
    last_activity_at: new Date('2026-11-09T00:00:00.000Z'),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    deleted_at: null as Date | null,
  }));
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.id && messages.some((m) => m.id === data.id)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'clear-double' });
      }
      const row = {
        prompt_tokens: null,
        completion_tokens: null,
        model_id: null,
        interrupted: false,
        parent_message_id: null,
        copilot: null,
        ...data,
        id: (data.id as string | undefined) ?? `cuid_${++seq}`,
        created_at: new Date(Date.now() + ++seq),
      } as unknown as Row;
      messages.push(row);
      return { ...row };
    }),
    findFirst: jest.fn(async ({ where }: { where?: Where } = {}) => {
      const hit = messages.find((m) => matches(m, where));
      return hit ? { ...hit } : null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: { where?: Where; orderBy?: unknown; take?: number } = {}) => {
      const hits = messages.filter((m) => matches(m, where)).map((m) => ({ ...m }));
      const first = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as { created_at?: 'asc' | 'desc' } | undefined;
      if (first?.created_at) {
        hits.sort((a, b) => (a.created_at.getTime() - b.created_at.getTime()) * (first.created_at === 'desc' ? -1 : 1));
      }
      return take === undefined ? hits : hits.slice(0, take);
    }),
    count: jest.fn(async ({ where }: { where?: Where } = {}) => messages.filter((m) => matches(m, where)).length),
    updateMany: jest.fn(async ({ where, data }: { where?: Where; data: Record<string, unknown> }) => {
      const hits = messages.filter((m) => matches(m, where));
      for (const m of hits) Object.assign(m, data);
      return { count: hits.length };
    }),
  };
  const romanSession = {
    findFirst: jest.fn(async ({ where }: { where: Where }) => {
      if (typeof where.id !== 'string') return null;
      return sessions.find((s) => matches(s, where)) ?? null;
    }),
    findMany: jest.fn(async () => []),
    aggregate: jest.fn(async () => ({ _sum: { message_count: null }, _min: { last_activity_at: null } })),
    updateMany: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const hits = sessions.filter((s) => matches(s, where));
      for (const s of hits) if (data.message_count) s.message_count += 1;
      return { count: hits.length };
    }),
  };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  };
  const prisma: Record<string, unknown> = {
    romanMessage,
    romanSession,
    aiRequestAudit,
    user: { findUnique: jest.fn(async () => ({ coach_id: USER_A.coach_id })) },
    aiActionDraft: { findMany: jest.fn(async () => []) },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (): Promise<unknown[]> => [{}]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return {
    prisma,
    messages,
    romanMessage,
    erase(id: string) {
      const s = sessions.find((x) => x.id === id);
      if (s) s.deleted_at = new Date();
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].session_id === id) messages.splice(i, 1);
    },
  };
}
type Db = ReturnType<typeof makeDb>;

/** A point a running first send stops at until the test lets it go on. */
function hold() {
  let open!: () => void;
  let arrive!: () => void;
  const released = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (arrive = r));
  return { reached, open, wait: async () => { arrive(); await released; } };
}

/** One server process: its own RomanService (and so its own open turns) over a database it may share. */
function world(db: Db = makeDb()) {
  const hooks: { gap: (i: number) => Promise<void> } = { gap: async () => undefined };
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 42 } } };
      let i = 0;
      for (const text of ['Rest today, ', 'legs tomorrow.']) {
        await hooks.gap(i++);
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      }
      yield { type: 'message_delta', usage: { output_tokens: 7 } };
    },
  };
  const anthropic = { messages: { stream: jest.fn((_b: unknown, _o?: unknown): unknown => stream) } };
  const createAlert = jest.fn(async (_a: unknown): Promise<unknown> => ({ id: 'alert-1' }));
  const audit = { write: jest.fn(async (_i: Record<string, unknown>) => undefined) };
  const egress = grantAllEgress();
  const service = new RomanService(
    fakeOf(db.prisma),
    egress,
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    null,
    fakeOf<AuditService>(audit),
    null,
    null,
    null,
    fakeOf<CoachAlertsService>({ createAlert }),
  );
  const ctrl = new RomanController(fakeOf(service), fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }), null);
  const warn = jest.spyOn((service as never as { logger: { warn: (m: string) => void } }).logger, 'warn');
  const lines = (prefix: string) => warn.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith(prefix));
  /** The shutdown hook, where the server has one. */
  const shutdown = () => (service as Partial<OnModuleDestroy>).onModuleDestroy?.();

  function response() {
    const writes: string[] = [];
    const res = {
      writeHead: jest.fn((_s: number, _h: Record<string, string>): void => undefined),
      setHeader: jest.fn((): void => undefined),
      flushHeaders: jest.fn(),
      write: jest.fn((c: string): boolean => {
        writes.push(c);
        return true;
      }),
      end: jest.fn((): void => undefined),
    };
    return { res, writes };
  }

  const turnIdOf = (key: string, user = USER_A, session = SESSION) => romanTurnIds(user.id, session, key).turn;
  const turn = (key = KEY, user = USER_A, session = SESSION) => db.messages.find((m) => m.id === turnIdOf(key, user, session));

  async function send(content: string, o: { key?: string | null; user?: typeof USER_A; session?: string } = {}) {
    const key = o.key === undefined ? KEY : o.key;
    const handlers: Record<string, Array<() => void>> = {};
    const req = {
      user: o.user ?? USER_A,
      requestId: REQUEST_ID,
      headers: key ? { 'idempotency-key': key } : {},
      on: (ev: string, fn: () => void) => { (handlers[ev] ??= []).push(fn); },
      off: (ev: string, fn: () => void) => { handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn); },
    };
    const out = response();
    await ctrl.sendMessage(fakeOf(req), fakeOf(out.res), o.session ?? SESSION, { content });
    return out;
  }

  function seedTurn(fields: Record<string, unknown> = {}, key = KEY) {
    db.messages.push({
      id: turnIdOf(key),
      session_id: SESSION,
      user_id: USER_A.id,
      role: 'user',
      content: WORDS,
      prompt_tokens: null,
      completion_tokens: null,
      model_id: null,
      interrupted: false,
      parent_message_id: null,
      copilot: null,
      created_at: new Date(),
      ...fields,
    } as unknown as Row);
  }

  return { db, hooks, anthropic, createAlert, egress, service, warn, lines, shutdown, send, turn, seedTurn };
}
type World = ReturnType<typeof world>;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV];
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const routeAs = (cls: 'self_harm' | 'eating_disorder_risk') =>
  jest.spyOn(safetyRouter, 'classifySafety').mockReturnValue({ class: cls, matched: 'x', short_circuit: cls === 'self_harm' });

/** Each kind of keyed first send, parked mid-answer; `fixed` = its reply is fixed text decided before any model call. */
const kinds: Array<[string, { fixed: boolean; user?: typeof USER_A }, (w: World, wait: () => Promise<void>) => void]> = [
  ['a normal turn', { fixed: false }, (w, wait) => { w.hooks.gap = async (i) => { if (i === 0) await wait(); }; }],
  ['a crisis turn (fixed reply, controller :159)', { fixed: true }, (w, wait) => {
    routeAs('self_harm');
    w.createAlert.mockImplementationOnce(async () => { await wait(); return { id: 'alert-1' }; });
  }],
  ['an eating-disorder fallback chosen for no coach (:173)', { fixed: true, user: { ...USER_A, coach_id: null } }, (w, wait) => {
    routeAs('eating_disorder_risk');
    w.createAlert.mockImplementationOnce(async () => { await wait(); return { id: 'alert-1' }; });
  }],
  ['an eating-disorder fallback chosen for a refused check (:205)', { fixed: true }, (w, wait) => {
    routeAs('eating_disorder_risk');
    jest.spyOn(w.egress, 'assertMaySend').mockRejectedValue(new AiConsentRequiredException('client'));
    w.createAlert.mockImplementationOnce(async () => { await wait(); return { id: 'alert-1' }; });
  }],
  ['an eating-disorder-risk turn that reached the model', { fixed: false }, (w, wait) => {
    routeAs('eating_disorder_risk');
    w.hooks.gap = async (i) => { if (i === 0) await wait(); };
  }],
];

/** Parks a first send; the returned promise is the first send (never released = the process died there). */
async function park(w: World, arrange: (w: World, wait: () => Promise<void>) => void, user = USER_A) {
  const h = hold();
  arrange(w, h.wait);
  const first = w.send(WORDS, { user });
  await h.reached;
  return { first, open: h.open };
}

/** Fake timers for the hook's own deadlines only (the clock, microtasks and setImmediate stay real). */
const fakeTimers = () => jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate', 'queueMicrotask', 'performance'] });

/** Runs the shutdown hook to its end under fake timers, advancing the clock no further than its own deadlines. */
async function shutDown(w: World) {
  fakeTimers();
  let ended = false;
  const hook = Promise.resolve(w.shutdown()).then(() => { ended = true; });
  await jest.advanceTimersByTimeAsync(WAIT_MS);
  if (!ended) await jest.advanceTimersByTimeAsync(CLEAR_MS);
  expect(ended).toBe(true);
  await hook;
  jest.useRealTimers();
}

// ─── Item 1 ───────────────────────────────────────────────────────────────────

describe('case 1: a clear that changes no row is logged by code', () => {
  it('the clear resolves { count: 0 } with the turn still marked: one line, session id, no text; frames and end as today', async () => {
    const control = world();
    const expected = (await control.send(WORDS)).writes;

    const w = world();
    w.db.romanMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await w.send(WORDS);
    expect(out.writes).toEqual(expected);
    expect(out.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream' }));
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expect(w.turn()?.completion_tokens).toBe(MARK);
    expect(w.lines('roman.reply_pending_clear')).toEqual(['roman.reply_pending_clear_noop session=sess_1']);
    expect(w.warn.mock.calls.join(' ')).not.toContain(WORDS);
  });

  it('error path: its one error frame, the stream ends, the same one line', async () => {
    const w = world();
    jest.spyOn(w.service, 'buildContextTurns').mockRejectedValue(new Error('read failed'));
    w.db.romanMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await w.send(WORDS);
    expect(out.writes.filter((c) => c.startsWith('event: error'))).toHaveLength(1);
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expect(w.lines('roman.reply_pending_clear')).toEqual(['roman.reply_pending_clear_noop session=sess_1']);
  });

  it('a chat deleted while Roman answers clears no row either, and says so the same way (the PLAN\'s choice: no re-read)', async () => {
    const w = world();
    w.hooks.gap = async (i) => { if (i === 0) w.db.erase(SESSION); };
    await w.send(WORDS);
    expect(w.lines('roman.reply_pending_clear')).toEqual(['roman.reply_pending_clear_noop session=sess_1']);
  });
});

describe('case 2: the clear throws', () => {
  it('logged once by code, as today, and no noop line', async () => {
    const w = world();
    w.db.romanMessage.updateMany.mockRejectedValueOnce(new Error('db down'));
    const out = await w.send(WORDS);
    expect(out.writes[out.writes.length - 1]).toContain('"type":"done"');
    const lines = w.lines('roman.reply_pending_clear');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^roman\.reply_pending_clear_failed session=sess_1: /);
    expect(lines[0]).not.toContain('db down');
  });
});

describe('case 3: the chat is deleted while Roman answers', () => {
  it('no throw, no row brought back, the frame as today, no failed-clear line', async () => {
    const w = world();
    w.hooks.gap = async (i) => { if (i === 0) w.db.erase(SESSION); };
    const out = await w.send(WORDS);
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0]).toContain('"code":"ROMAN_SESSION_NOT_FOUND"');
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expect(w.db.messages).toHaveLength(0);
    expect(w.lines('roman.reply_pending_clear_failed')).toEqual([]);
  });
});

// ─── Item 2 ───────────────────────────────────────────────────────────────────

describe('cases 4 and 5: a fixed-reply turn whose process died after the insert', () => {
  it.each(kinds.filter(([, o]) => o.fixed))('%s: pending inside the short bound, ROMAN_UNAVAILABLE past it', async (_name, o, arrange) => {
    const w = world();
    await park(w, arrange, o.user);
    expect(w.turn()?.completion_tokens).toBe(FIXED_MARK);
    expect(w.db.messages.filter((m) => m.role === 'roman')).toHaveLength(0);

    (w.turn() as Row).created_at = new Date(Date.now() - FIXED_BOUND_MS + 5_000);
    expect((await w.send(WORDS, { user: o.user })).writes).toEqual([WIRE_PENDING]);
    (w.turn() as Row).created_at = new Date(Date.now() - FIXED_BOUND_MS - 1_000);
    expect((await w.send(WORDS, { user: o.user })).writes).toEqual([WIRE_UNAVAILABLE]);
    expect(w.createAlert).toHaveBeenCalledTimes(1);
  });
});

describe('case 6: a turn that reaches the model keeps the 660 s mark', () => {
  it.each(kinds.filter(([, o]) => !o.fixed))('%s: the long mark, still pending past the short bound and just under 660 s', async (_name, o, arrange) => {
    const w = world();
    const { first, open } = await park(w, arrange, o.user);
    expect(w.turn()?.completion_tokens).toBe(MARK);
    (w.turn() as Row).created_at = new Date(Date.now() - FIXED_BOUND_MS - 1_000);
    expect((await w.send(WORDS)).writes).toEqual([WIRE_PENDING]);
    (w.turn() as Row).created_at = new Date(Date.now() - BOUND_MS + 5_000);
    expect((await w.send(WORDS)).writes).toEqual([WIRE_PENDING]);
    open();
    await first;
  });
});

describe('case 7: turns that finish', () => {
  it('a normal turn: its reply on a resend, the mark cleared', async () => {
    const w = world();
    const first = await w.send(WORDS);
    expect(w.turn()?.completion_tokens).toBeNull();
    expect((await w.send(WORDS)).writes).toEqual(first.writes);
  });

  it('a crisis turn that finishes: its reply, one alert, the mark cleared', async () => {
    const w = world();
    routeAs('self_harm');
    const first = await w.send(WORDS);
    expect(first.writes[first.writes.length - 1]).toContain('"type":"done"');
    expect(w.turn()?.completion_tokens).toBeNull();
    expect((await w.send(WORDS)).writes).toEqual(first.writes);
    expect(w.createAlert).toHaveBeenCalledTimes(1);
  });
});

describe('case 8: a turn stored before this deploy', () => {
  it.each<[string, number | null, number, string]>([
    ['-1, young', MARK, BOUND_MS - 5_000, WIRE_PENDING],
    ['-1, past the short bound', MARK, FIXED_BOUND_MS + 1_000, WIRE_PENDING],
    ['-1, past 660 s', MARK, BOUND_MS + 1_000, WIRE_UNAVAILABLE],
    ['no mark', null, 1_000, WIRE_UNAVAILABLE],
  ])('%s: read exactly as today', async (_name, mark, age, wire) => {
    const w = world();
    w.seedTurn({ completion_tokens: mark, created_at: new Date(Date.now() - age) });
    expect((await w.send(WORDS)).writes).toEqual([wire]);
  });
});

// ─── Item 3 ───────────────────────────────────────────────────────────────────

describe('case 9: a keyed turn still running at the hook\'s deadline', () => {
  it.each(kinds)('%s: the hook clears its mark; a resend gets ROMAN_UNAVAILABLE', async (_name, o, arrange) => {
    const w = world();
    await park(w, arrange, o.user);
    await shutDown(w);
    expect(w.turn()?.completion_tokens).toBeNull();
    expect((await w.send(WORDS, { user: o.user })).writes).toEqual([WIRE_UNAVAILABLE]);
  });
});

describe('case 10: a turn that ends during the wait', () => {
  it('its own reply and clear; the hook writes nothing for it and returns before its deadline', async () => {
    const w = world();
    const { first, open } = await park(w, kinds[0][2]);
    fakeTimers();
    let ended = false;
    const hook = Promise.resolve(w.shutdown()).then(() => { ended = true; });
    await jest.advanceTimersByTimeAsync(WAIT_MS / 3);
    open();
    const done = await first;
    await hook;
    expect(ended).toBe(true);
    expect(w.db.romanMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(w.db.romanMessage.updateMany.mock.calls[0][0].where).toEqual({ id: romanTurnIds(USER_A.id, SESSION, KEY).turn, session_id: SESSION, user_id: USER_A.id, role: 'user' });
    expect((await w.send(WORDS)).writes).toEqual(done.writes);
  });
});

describe('case 11: two machines on one database', () => {
  it('one shuts down; the other\'s live mark is untouched', async () => {
    const db = makeDb();
    const one = world(db);
    const two = world(db);
    await park(one, kinds[0][2]);
    const h = hold();
    two.hooks.gap = async (i) => { if (i === 0) await h.wait(); };
    const other = two.send(WORDS, { key: KEY_2 });
    await h.reached;

    await shutDown(one);
    expect(two.turn(KEY_2)?.completion_tokens).toBe(MARK);
    expect((await two.send(WORDS, { key: KEY_2 })).writes).toEqual([WIRE_PENDING]);
    h.open();
    await other;
  });
});

describe('case 12: a turn the hook cleared stores its reply before the kill', () => {
  it('the reply wins on a resend; its own clear matches its row again and logs nothing', async () => {
    const w = world();
    const { first, open } = await park(w, kinds[0][2]);
    await shutDown(w);
    open();
    const done = await first;
    expect(done.writes[done.writes.length - 1]).toContain('"type":"done"');
    expect((await w.send(WORDS)).writes).toEqual(done.writes);
    expect(w.lines('roman.reply_pending')).toEqual([]);
  });
});

describe('case 13: the hook\'s write fails', () => {
  it.each<[string, (w: World) => void, RegExp]>([
    ['it throws', (w) => w.db.romanMessage.updateMany.mockRejectedValueOnce(new Error('db down')), /^roman\.reply_pending_shutdown_clear_failed turns=1: /],
    ['it changes no row', (w) => w.db.romanMessage.updateMany.mockResolvedValueOnce({ count: 0 }), /^roman\.reply_pending_shutdown_clear_noop turns=1 cleared=0$/],
    ['it never answers', (w) => w.db.romanMessage.updateMany.mockReturnValueOnce(new Promise(() => undefined) as never), /^roman\.reply_pending_shutdown_clear_timeout turns=1$/],
  ])('%s: logged by code, the hook returns inside its deadline and never throws', async (_name, arrange, line) => {
    const w = world();
    await park(w, kinds[0][2]);
    arrange(w);
    await shutDown(w);
    const lines = w.lines('roman.reply_pending_shutdown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(line);
    expect(lines[0]).not.toContain('db down');
  });
});

describe('case 14: no keyed turn in flight', () => {
  it('no query at shutdown, and no wait', async () => {
    const w = world();
    await w.send(WORDS);
    await w.send(WORDS, { key: null });
    const writes = w.db.romanMessage.updateMany.mock.calls.length;
    fakeTimers();
    await w.shutdown();
    expect(w.db.romanMessage.updateMany).toHaveBeenCalledTimes(writes);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('case 15: the hook\'s where', () => {
  it('names each turn by id, chat, member, role and its own mark; another member\'s or chat\'s turn under the same key is untouched', async () => {
    const w = world();
    const theirs = romanTurnIds(USER_B.id, 'sess_B', KEY).turn;
    const otherChat = romanTurnIds(USER_A.id, 'sess_2', KEY).turn;
    for (const [id, user, session] of [[theirs, USER_B.id, 'sess_B'], [otherChat, USER_A.id, 'sess_2']]) {
      w.db.messages.push({ id, session_id: session, user_id: user, role: 'user', content: WORDS, completion_tokens: MARK, created_at: new Date() } as Row);
    }
    await park(w, kinds[0][2]);
    await shutDown(w);
    const hookWrite = w.db.romanMessage.updateMany.mock.calls[w.db.romanMessage.updateMany.mock.calls.length - 1][0];
    expect(hookWrite).toEqual({
      where: { OR: [{ id: romanTurnIds(USER_A.id, SESSION, KEY).turn, session_id: SESSION, user_id: USER_A.id, role: 'user', completion_tokens: MARK }] },
      data: { completion_tokens: null },
    });
    expect(w.db.messages.find((m) => m.id === theirs)?.completion_tokens).toBe(MARK);
    expect(w.db.messages.find((m) => m.id === otherChat)?.completion_tokens).toBe(MARK);
    expect(w.turn()?.completion_tokens).toBeNull();
  });

  it('a first send that lost the keyed lock adds nothing for the hook to clear', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK });
    jest.spyOn(w.service, 'findKeyedTurn').mockResolvedValueOnce(null);
    await w.send(WORDS);
    const writes = w.db.romanMessage.updateMany.mock.calls.length;
    await w.shutdown();
    expect(w.db.romanMessage.updateMany).toHaveBeenCalledTimes(writes);
    expect(w.turn()?.completion_tokens).toBe(MARK);
  });
});

describe('case 16: a fixed-reply turn at shutdown', () => {
  it('cleared by the hook with its own (short) mark in the where', async () => {
    const w = world();
    await park(w, kinds[1][2]);
    await shutDown(w);
    const hookWrite = w.db.romanMessage.updateMany.mock.calls[w.db.romanMessage.updateMany.mock.calls.length - 1][0];
    expect((hookWrite.where as { OR: Array<Record<string, unknown>> }).OR[0].completion_tokens).toBe(FIXED_MARK);
    expect(w.turn()?.completion_tokens).toBeNull();
    expect((await w.send(WORDS)).writes).toEqual([WIRE_UNAVAILABLE]);
  });
  // With no hook (a crash), its short bound ends it: cases 4 and 5.
});

// ─── Where the hook runs in Nest's close ─────────────────────────────────────

describe('the hook runs before PrismaService\'s $disconnect', () => {
  it('Nest runs a plain module\'s onModuleDestroy before a @Global module\'s; PrismaModule is global, RomanModule is not', async () => {
    const order: string[] = [];
    @Injectable()
    class Db implements OnModuleDestroy { onModuleDestroy() { order.push('global $disconnect'); } }
    @Global() @Module({ providers: [Db], exports: [Db] })
    class GlobalDb {}
    @Injectable()
    class Turns implements OnModuleDestroy { onModuleDestroy() { order.push('plain hook'); } }
    @Module({ providers: [Turns] })
    class Plain {}
    const app = await Test.createTestingModule({ imports: [GlobalDb, Plain] }).compile();
    await app.init();
    await app.close();
    expect(order).toEqual(['plain hook', 'global $disconnect']);
    expect(Reflect.getMetadata('__module:global__', PrismaModule)).toBe(true);
    expect(Reflect.getMetadata('__module:global__', RomanModule)).toBeUndefined();
  });
});
