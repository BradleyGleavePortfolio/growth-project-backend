// test/roman/roman-send-once-pending.spec.ts
//
// SEND-ONCE-PENDING-BE: a same-key resend of a Roman turn whose first send may
// still store its reply answers ROMAN_REPLY_PENDING; every other no-reply
// resend answers ROMAN_UNAVAILABLE, byte for byte as before.
//
// Through the REAL RomanController and REAL RomanService, over an in-memory
// Prisma double that keeps the rows, so the mark's whole life is exercised: set
// in the insert, read by a resend, cleared when the first send ends. The frames
// are compared as the exact bytes the phone receives.

import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanService, romanTurnIds } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV } from '../../src/roman/roman.feature';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import {
  AiConsentRequiredException,
  AiEgressPolicyException,
} from '../../src/ai-egress/ai-consent-required.exception';
import type { AuditService } from '../../src/audit/audit.service';
import type { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import * as safetyRouter from '../../src/roman/guardrails/safety-router';
import { CopilotTurnService } from '../../src/copilot/copilot-turn';
import { CopilotService } from '../../src/copilot/copilot.service';
import { ROMAN_REPLY_PENDING_MARK, ROMAN_REPLY_PENDING_MAX_MS } from '../../src/roman/roman.constants';
import { ROMAN_SSE_FALLBACK_ERROR, ROMAN_SSE_REPLY_PENDING_ERROR } from '../../src/roman/roman-sse-error';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

/** The wire contract, as literals: a change to either is a change the phone sees. */
const WIRE_UNAVAILABLE = 'event: error\ndata: {"code":"ROMAN_UNAVAILABLE","message":"Roman is not available right now."}\n\n';
const WIRE_PENDING = 'event: error\ndata: {"code":"ROMAN_REPLY_PENDING","message":"Roman is not available right now."}\n\n';
/** Verbatim copy of mobile `RomanStreamErrorSchema` (src/api/romanApi.ts). */
const MOBILE_FRAME = z.object({ code: z.string(), message: z.string() }).strict();

/** The stored mark and the bound, as literals here so these guards also run against a server that has neither. */
const MARK = -1;
const BOUND_MS = 660_000;

const KEY = '2f1c7e52-8a6b-4c2d-9f1e-7b3a5d9e0c11';
const WORDS = 'What should I train today?';
const USER_A = { id: 'user-A', role: 'student', coach_id: 'coach-1' };
const USER_B = { id: 'user-B', role: 'student', coach_id: 'coach-2' };
const SESSION = 'sess_1';
const REQUEST_ID = 'req_pending';
const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Request-ID': REQUEST_ID,
};

type Row = Record<string, unknown> & { id: string; role: string; created_at: Date };
type Where = Record<string, unknown>;

// Object filters (`session`, `created_at: { gte }`, `copilot: { not }`) are not modelled; `in` is.
const matches = (row: Record<string, unknown>, where: Where = {}) =>
  Object.entries(where).every(([k, v]) => {
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
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'pending-double' });
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
      // hasEarlierChat's `id: { not }` read: no earlier chat in these fixtures.
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
  const audits: Array<Record<string, unknown>> = [];
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push({ ...data });
      return data;
    }),
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
    sessions,
    romanMessage,
    aiRequestAudit,
    erase(id: string) {
      const s = sessions.find((x) => x.id === id);
      if (s) s.deleted_at = new Date();
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].session_id === id) messages.splice(i, 1);
    },
  };
}

/** A point a running first send stops at until the test lets it go on. */
function hold() {
  let open!: () => void;
  let arrive!: () => void;
  const released = new Promise<void>((r) => {
    open = r;
  });
  const reached = new Promise<void>((r) => {
    arrive = r;
  });
  return {
    reached,
    open,
    wait: async () => {
      arrive();
      await released;
    },
  };
}

function world(opts: { noProvider?: boolean; deltas?: string[]; copilot?: boolean } = {}) {
  const db = makeDb();
  const hooks: { gap: (i: number) => Promise<void> } = { gap: async () => undefined };
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 42 } } };
      let i = 0;
      for (const text of opts.deltas ?? ['Rest today, ', 'legs tomorrow.']) {
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
    opts.noProvider ? null : AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    null,
    fakeOf<AuditService>(audit),
    null,
    null,
    null,
    fakeOf<CoachAlertsService>({ createAlert }),
  );
  const counted = jest.spyOn(service, 'assertWithinRateLimit');
  const views = jest.fn(async (_c: string, rows: Array<{ id: string; copilot?: unknown }>) =>
    new Map(rows.filter((r) => r.copilot).map((r) => [r.id, { sources: [], suggestion: null }])),
  );
  const ctrl = new RomanController(
    fakeOf(service),
    fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
    opts.copilot ? fakeOf<CopilotTurnService>({ views }) : null,
  );
  const reqs: Array<{ emit: (ev: string) => void }> = [];

  function response(onWrite: (chunk: string) => void = () => undefined) {
    const writes: string[] = [];
    const res = {
      writeHead: jest.fn((_s: number, _h: Record<string, string>): void => undefined),
      setHeader: jest.fn((): void => undefined),
      flushHeaders: jest.fn(),
      write: jest.fn((c: string): boolean => {
        onWrite(c);
        writes.push(c);
        return true;
      }),
      end: jest.fn((): void => undefined),
    };
    return { res, writes };
  }

  const turnIdOf = (key: string, user = USER_A, session = SESSION) => romanTurnIds(user.id, session, key).turn;
  const replyIdOf = (key: string, user = USER_A, session = SESSION) => romanTurnIds(user.id, session, key).reply;
  const turn = (key = KEY, user = USER_A, session = SESSION) => db.messages.find((m) => m.id === turnIdOf(key, user, session));

  async function send(
    content: string,
    o: {
      key?: string | null;
      user?: typeof USER_A;
      session?: string;
      headers?: Record<string, string>;
      out?: ReturnType<typeof response>;
    } = {},
  ) {
    const key = o.key === undefined ? KEY : o.key;
    const handlers: Record<string, Array<() => void>> = {};
    const req = {
      user: o.user ?? USER_A,
      requestId: REQUEST_ID,
      headers: { ...(key ? { 'idempotency-key': key } : {}), ...(o.headers ?? {}) },
      on: (ev: string, fn: () => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      off: (ev: string, fn: () => void) => {
        handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn);
      },
      emit: (ev: string) => (handlers[ev] ?? []).forEach((h) => h()),
    };
    reqs.push(req);
    const out = o.out ?? response();
    await ctrl.sendMessage(fakeOf(req), fakeOf(out.res), o.session ?? SESSION, { content });
    return out;
  }

  /** Everything a resend must leave alone. */
  const effects = () => ({
    model: anthropic.messages.stream.mock.calls.length,
    counted: counted.mock.calls.length,
    spend: db.aiRequestAudit.create.mock.calls.length,
    alerts: createAlert.mock.calls.length,
    rows: JSON.stringify(db.messages),
    writes: db.romanMessage.updateMany.mock.calls.length,
  });

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
  function seedReply(fields: Record<string, unknown> = {}, key = KEY) {
    db.messages.push({
      id: replyIdOf(key),
      session_id: SESSION,
      user_id: USER_A.id,
      role: 'roman',
      content: 'Rest today, legs tomorrow.',
      prompt_tokens: 42,
      completion_tokens: 7,
      model_id: 'm',
      interrupted: false,
      parent_message_id: null,
      copilot: null,
      created_at: new Date(),
      ...fields,
    } as unknown as Row);
  }

  return { db, hooks, anthropic, createAlert, audit, egress, service, counted, views, ctrl, reqs, response, send, turn, effects, seedTurn, seedReply };
}

type World = ReturnType<typeof world>;
const COPILOT_ENV = 'FEATURE_CLIENT_PATH_COPILOT';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV, COPILOT_ENV];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env[FEATURE_ROMAN_CRISIS_ALERT_ENV] = 'true';
  process.env[COPILOT_ENV] = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

const routeAs = (cls: 'self_harm' | 'eating_disorder_risk') =>
  jest.spyOn(safetyRouter, 'classifySafety').mockReturnValue({ class: cls, matched: 'x', short_circuit: cls === 'self_harm' });

/** Starts a first send and returns once it is parked mid-answer. */
const running: Array<[string, { copilot?: boolean; headers?: Record<string, string> }, (w: World, wait: () => Promise<void>) => void]> = [
  ['a normal turn', {}, (w, wait) => { w.hooks.gap = async (i) => { if (i === 0) await wait(); }; }],
  ['a turn with the Copilot header', { copilot: true, headers: { 'x-roman-copilot': '1' } }, (w, wait) => { w.hooks.gap = async (i) => { if (i === 0) await wait(); }; }],
  ['a fixed crisis reply', {}, (w, wait) => {
    routeAs('self_harm');
    w.createAlert.mockImplementationOnce(async () => { await wait(); return { id: 'alert-1' }; });
  }],
  ['an eating-disorder fallback', {}, (w, wait) => {
    routeAs('eating_disorder_risk');
    jest.spyOn(w.egress, 'assertMaySend').mockRejectedValue(new AiConsentRequiredException('client'));
    w.createAlert.mockImplementationOnce(async () => { await wait(); return { id: 'alert-1' }; });
  }],
];

describe('case 1: the first send is still being written', () => {
  it.each(running)('%s: the resend gets exactly the pending frame and touches nothing', async (_name, o, park) => {
    const w = world({ copilot: o.copilot });
    const h = hold();
    park(w, h.wait);
    const first = w.send(WORDS, { headers: o.headers });
    await h.reached;
    expect(w.turn()?.completion_tokens).toBe(MARK);

    const before = w.effects();
    const again = await w.send(WORDS, { headers: o.headers });
    expect(again.writes).toEqual([WIRE_PENDING]);
    expect(again.res.writeHead).toHaveBeenCalledWith(200, STREAM_HEADERS);
    expect(again.res.end).toHaveBeenCalledTimes(1);
    expect(w.effects()).toEqual(before);

    h.open();
    const done = await first;
    expect(done.writes.at(-1)).toContain('"type":"done"');
    expect(w.turn()?.completion_tokens).toBeNull();
    expect((await w.send(WORDS, { headers: o.headers })).writes).toEqual(done.writes);
  });

  it('a marked turn just under the bound still answers pending', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK, created_at: new Date(Date.now() - BOUND_MS + 5_000) });
    expect((await w.send(WORDS)).writes).toEqual([WIRE_PENDING]);
  });

  it('the pending frame passes the mobile strict schema with exactly code and message', () => {
    const parsed = MOBILE_FRAME.safeParse(JSON.parse(WIRE_PENDING.split('data: ')[1]));
    expect(parsed.success).toBe(true);
    expect(JSON.parse(WIRE_PENDING.split('data: ')[1]).message).toBe(JSON.parse(WIRE_UNAVAILABLE.split('data: ')[1]).message);
  });
});

describe('case 2: a first send that lost the keyed lock', () => {
  it('answers the pending frame and gives back what it counted', async () => {
    const w = world();
    const h = hold();
    w.hooks.gap = async (i) => { if (i === 0) await h.wait(); };
    const first = w.send(WORDS);
    await h.reached;

    const debit = { clientId: USER_A.id, kind: 'messages', day: '2026-11-09' };
    jest.spyOn(w.service, 'findKeyedTurn').mockResolvedValueOnce(null);
    w.counted.mockResolvedValueOnce(debit as never);
    const gaveBack = jest.spyOn(w.service, 'giveBackTurn').mockResolvedValue(undefined);
    const lost = await w.send(WORDS);

    expect(lost.writes).toEqual([WIRE_PENDING]);
    expect(gaveBack).toHaveBeenCalledWith(debit);
    expect(w.turn()?.completion_tokens).toBe(MARK);
    h.open();
    await first;
  });
});

describe('cases 3 and 6: a first send that ended with no reply', () => {
  const failing = (w: World) => {
    w.anthropic.messages.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('provider down');
      },
    }));
  };
  const refuse = (msg = 'refused') => new ServiceUnavailableException({ code: 'ROMAN_UNAVAILABLE', message: msg });
  const members: Array<[string, { noProvider?: boolean }, (w: World) => void]> = [
    ['switched off (:1011)', {}, () => { process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'false'; }],
    ['no provider (:1048)', { noProvider: true }, () => undefined],
    ['egress refused before the call (:1056)', {}, (w) => {
      jest.spyOn(w.egress, 'assertMaySend').mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new AiConsentRequiredException('client'));
    }],
    ['coach pool (:1061)', {}, (w) => {
      jest.spyOn(w.service, 'assertCoachPoolOpen').mockResolvedValueOnce(null).mockRejectedValueOnce(refuse());
    }],
    ['the spend reservation (:1113)', {}, (w) => {
      jest.spyOn(w.service as never as { reserveDailySpend: () => Promise<never> }, 'reserveDailySpend').mockRejectedValue(refuse());
    }],
    ['egress refused mid-call (:1198)', {}, (w) => {
      jest.spyOn(w.egress, 'anthropicMessagesStream').mockRejectedValue(new AiEgressPolicyException());
    }],
    ['the model failed with no text (:1242)', {}, failing],
    ['the reply could not be stored (:1298)', {}, (w) => {
      const real = w.db.romanMessage.create.getMockImplementation()!;
      w.db.romanMessage.create.mockImplementation(async (a) => {
        if (a.data.role === 'roman') throw new Error('write failed');
        return real(a);
      });
    }],
    ['a tools turn whose loop threw (:1159, into :1197)', {}, (w) => {
      jest.spyOn(w.service as never as { toolLoopFor: () => unknown }, 'toolLoopFor').mockReturnValue({
        run: async () => { throw new Error('tools down'); },
        settled: () => ({ input: 0, output: 0, kind: 'none_sent' }),
        ledger: () => ({}),
        input: 0,
        output: 0,
      });
    }],
    ['any other read that throws (:1108)', {}, (w) => {
      jest.spyOn(w.service, 'buildContextTurns').mockRejectedValue(new Error('read failed'));
    }],
    ['the fixed fallback could not be stored (:1433)', {}, (w) => {
      routeAs('eating_disorder_risk');
      jest.spyOn(w.egress, 'assertMaySend').mockRejectedValue(new AiConsentRequiredException('client'));
      const real = w.db.romanMessage.create.getMockImplementation()!;
      w.db.romanMessage.create.mockImplementation(async (a) => {
        if (a.data.role === 'roman') throw new Error('write failed');
        return real(a);
      });
    }],
  ];

  it.each(members)('%s: its own frame goes out with the mark cleared, and a resend gets ROMAN_UNAVAILABLE', async (_name, o, arrange) => {
    const w = world(o);
    arrange(w);
    const markAtFrame: unknown[] = [];
    const out = w.response((c) => {
      if (c.startsWith('event: error')) markAtFrame.push(w.turn()?.completion_tokens);
    });
    await w.send(WORDS, { out });

    expect(out.writes.filter((c) => c.startsWith('event: error'))).toHaveLength(1);
    expect(markAtFrame).toEqual([null]);
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expect(w.db.messages.filter((m) => m.role === 'roman')).toHaveLength(0);

    const before = w.effects();
    expect((await w.send(WORDS)).writes).toEqual([WIRE_UNAVAILABLE]);
    expect(w.effects()).toEqual(before);
  });
});

describe('case 4: a stored reply always wins', () => {
  it('reply stored and mark cleared: the first send\'s frames, unchanged', async () => {
    const w = world();
    const first = await w.send(WORDS);
    expect(w.turn()?.completion_tokens).toBeNull();
    const again = await w.send(WORDS);
    expect(again.writes).toEqual(first.writes);
    expect(again.writes.join('')).toContain('Rest today, legs tomorrow.');
  });

  it('reply stored and mark still set (a crash or a failed clear between the two): the reply, never pending', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK });
    w.seedReply();
    const again = await w.send(WORDS);
    expect(again.writes.join('')).not.toContain('ROMAN_REPLY_PENDING');
    expect(again.writes.join('')).toContain('"type":"done"');
    expect(again.writes.join('')).toContain('Rest today, legs tomorrow.');
  });
});

describe('case 5: a mark outlives no one', () => {
  it('mark set, no reply, older than the bound: ROMAN_UNAVAILABLE', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK, created_at: new Date(Date.now() - BOUND_MS - 1_000) });
    expect((await w.send(WORDS)).writes).toEqual([WIRE_UNAVAILABLE]);
  });
});

describe('case 7: a cut the server sees stores a reply', () => {
  it.each([
    ['partial', 1, 'Rest today, '],
    ['empty', 0, ''],
  ] as const)('%s reply: a resend gets it with interrupted, not pending', async (_name, closeAt, stored) => {
    const w = world();
    w.hooks.gap = async (i) => {
      if (i === closeAt) {
        w.reqs[0].emit('close');
        await Promise.resolve();
      }
    };
    await w.send(WORDS);
    expect(w.db.messages.find((m) => m.role === 'roman')).toMatchObject({ content: stored, interrupted: true });
    expect(w.turn()?.completion_tokens).toBeNull();

    const again = (await w.send(WORDS)).writes.join('');
    expect(again).toContain('"interrupted":true');
    expect(again).not.toContain('event: error');
  });
});

describe('case 8: other words under the key while pending', () => {
  it('409 before the stream opens', async () => {
    const w = world();
    const h = hold();
    w.hooks.gap = async (i) => { if (i === 0) await h.wait(); };
    const first = w.send(WORDS);
    await h.reached;

    const out = w.response();
    await expect(w.send('Something else', { out })).rejects.toBeInstanceOf(ConflictException);
    expect(out.res.writeHead).not.toHaveBeenCalled();
    expect(out.writes).toEqual([]);
    h.open();
    await first;
  });
});

describe('case 9: no Idempotency-Key', () => {
  it('no mark, a cuid row, no extra query', async () => {
    const w = world();
    const out = await w.send(WORDS, { key: null });
    expect(out.writes.at(-1)).toContain('"type":"done"');
    const stored = w.db.romanMessage.create.mock.calls[0][0].data;
    expect(stored).not.toHaveProperty('id');
    expect(stored.completion_tokens).toBeNull();
    expect(w.db.messages[0].id).toMatch(/^cuid_/);
    expect(w.db.romanMessage.findFirst).not.toHaveBeenCalled();
    expect(w.db.romanMessage.updateMany).not.toHaveBeenCalled();
  });
});

describe('case 10: a keyed turn stored before this deploy', () => {
  it('no mark, no reply: ROMAN_UNAVAILABLE', async () => {
    const w = world();
    w.seedTurn();
    expect((await w.send(WORDS)).writes).toEqual([WIRE_UNAVAILABLE]);
  });
});

describe('case 11: a crisis or eating-disorder keyed turn', () => {
  it.each(running.slice(2))('%s: a resend while it runs sends no second alert, and the mark ends', async (_name, _o, park) => {
    const w = world();
    const h = hold();
    park(w, h.wait);
    const first = w.send(WORDS);
    await h.reached;
    await w.send(WORDS);
    expect(w.createAlert).toHaveBeenCalledTimes(1);
    h.open();
    await first;
    expect(w.turn()?.completion_tokens).toBeNull();
    await w.send(WORDS);
    expect(w.createAlert).toHaveBeenCalledTimes(1);
    expect(w.audit.write).toHaveBeenCalledTimes(1);
  });
});

describe('case 12: the Copilot header on a stored reply', () => {
  it('the done path as before: the reply with its facts, never pending', async () => {
    const w = world({ copilot: true });
    w.seedTurn();
    w.seedReply({ copilot: { question_id: null, sources: [], suggestion_id: null } });
    const again = (await w.send(WORDS, { headers: { 'x-roman-copilot': '1' } })).writes.join('');
    expect(again).toContain('"copilot":{"sources":[],"suggestion":null}');
    expect(again).not.toContain('event: error');
  });
});

describe('case 13: the mark is invisible', () => {
  const COPILOT_REPLY = { question_id: 'x', sources: [], suggestion_id: null };
  function conversation(mark: number | null) {
    const w = world();
    const at = new Date('2026-11-09T12:00:00.000Z');
    w.seedTurn({ id: 'q-1', content: 'A question', completion_tokens: mark, created_at: at });
    w.seedReply({ id: 'r-1', content: 'An answer', created_at: new Date(at.getTime() + 1), copilot: { ...COPILOT_REPLY, question_id: 'q-1' } });
    return w;
  }
  const req = fakeOf<never>({ user: USER_A, headers: {} });

  it.each<[string, (w: World) => Promise<unknown>]>([
    ['GET messages', (w) => w.ctrl.listMessages(req, SESSION, {})],
    ['the context turns', (w) => w.service.buildContextTurns(SESSION)],
    ['Copilot views', (w) => new CopilotTurnService(fakeOf(w.db.prisma), fakeOf({}), w.egress).views(USER_A.id, w.db.messages)],
    ['Copilot questions', (w) => new CopilotService(fakeOf(w.db.prisma), w.egress).questions(USER_A)],
  ])('%s: the same output with the mark set and not set', async (_name, read) => {
    const set = JSON.stringify(await read(conversation(MARK)));
    expect(set).toEqual(JSON.stringify(await read(conversation(null))));
    expect(set).not.toContain('completion_tokens');
  });

  it('roman.service.ts is the only source file naming the token columns, and the export selects neither', () => {
    const root = join(__dirname, '../../src');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
      });
    const naming = walk(root).filter((p) => /\b(prompt_tokens|completion_tokens)\b/.test(readFileSync(p, 'utf8')));
    expect(naming.map((p) => relative(root, p).split('\\').join('/'))).toEqual(['roman/roman.service.ts']);
    const exported = /ROMAN_MESSAGE_EXPORT_SELECT[^{]*\{([^}]*)\}/.exec(readFileSync(join(root, 'data-export/data-export.service.ts'), 'utf8'));
    expect(exported?.[1]).toContain('content: true');
    expect(exported?.[1]).not.toMatch(/tokens/);
  });
});

describe('case 14: the same key from anyone else', () => {
  it.each([
    ['another client, their own chat', USER_B, 'sess_B'],
    ['the same client, another chat', USER_A, 'sess_2'],
  ] as const)('%s: gets nothing of this turn and cannot clear its mark', async (_name, user, session) => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK });
    const own = await w.send(WORDS, { user, session });
    expect(own.writes.join('')).not.toContain('ROMAN_REPLY_PENDING');
    expect(own.writes.at(-1)).toContain('"type":"done"');
    expect(w.turn()?.completion_tokens).toBe(MARK);
    expect(w.turn(KEY, user, session)?.id).not.toBe(w.turn()?.id);
    expect(romanTurnIds(user.id, session, KEY)).not.toEqual(romanTurnIds(USER_A.id, SESSION, KEY));
  });
});

describe('case 15: the chat is deleted while Roman answers', () => {
  it('the clear is a no-op: no throw, no row brought back, the frame as before', async () => {
    const w = world();
    w.hooks.gap = async (i) => { if (i === 0) w.db.erase(SESSION); };
    const out = await w.send(WORDS);
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0]).toContain('"code":"ROMAN_SESSION_NOT_FOUND"');
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expect(w.db.messages).toHaveLength(0);
  });
});

describe('a failed clear changes nothing the phone sees', () => {
  const logged = (w: World) => jest.spyOn((w.service as never as { logger: { warn: (m: string) => void } }).logger, 'warn');
  const expectLoggedByCode = (warn: jest.SpyInstance) => {
    const line = warn.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('roman.reply_pending_clear_failed'));
    expect(line).toMatch(/^roman\.reply_pending_clear_failed session=sess_1: /);
    expect(line).not.toContain('db down');
  };

  it('done path: the same frames, the stream ends, the failure logged by code', async () => {
    const w = world();
    const warn = logged(w);
    w.db.romanMessage.updateMany.mockRejectedValue(new Error('db down'));
    const out = await w.send(WORDS);
    expect(out.writes).toHaveLength(2);
    expect(out.writes[1]).toContain('"type":"done"');
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expectLoggedByCode(warn);
  });

  it('error path: its one error frame, the stream ends, the failure logged by code', async () => {
    const w = world();
    const warn = logged(w);
    jest.spyOn(w.service, 'buildContextTurns').mockRejectedValue(new Error('read failed'));
    w.db.romanMessage.updateMany.mockRejectedValue(new Error('db down'));
    const out = await w.send(WORDS);
    expect(out.writes.filter((c) => c.startsWith('event: error'))).toHaveLength(1);
    expect(out.res.end).toHaveBeenCalledTimes(1);
    expectLoggedByCode(warn);
  });
});

describe('the mark itself', () => {
  it('the stored mark and the bound are the values these guards pin', () => {
    expect(ROMAN_REPLY_PENDING_MARK).toBe(MARK);
    expect(ROMAN_REPLY_PENDING_MAX_MS).toBe(BOUND_MS);
    expect(ROMAN_SSE_REPLY_PENDING_ERROR).toEqual({ code: 'ROMAN_REPLY_PENDING', message: ROMAN_SSE_FALLBACK_ERROR.message });
  });

  it('is written in the same insert as the keyed turn', async () => {
    const w = world();
    await w.send(WORDS);
    expect(w.db.romanMessage.create.mock.calls[0][0].data).toMatchObject({ role: 'user', completion_tokens: MARK });
    expect(w.db.romanMessage.create.mock.calls[1][0].data).toMatchObject({ role: 'roman', completion_tokens: 7 });
  });

  it('the reply row is written first and the mark cleared after, once', async () => {
    const w = world();
    await w.send(WORDS);
    expect(w.db.romanMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(w.db.romanMessage.create.mock.invocationCallOrder[1]).toBeLessThan(w.db.romanMessage.updateMany.mock.invocationCallOrder[0]);
  });

  it('the clear is scoped to the caller, the chat, the turn and its role', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK });
    const turnId = romanTurnIds(USER_A.id, SESSION, KEY).turn;
    await w.service.clearReplyPending({ id: USER_B.id, role: 'student' }, SESSION, turnId);
    await w.service.clearReplyPending({ id: USER_A.id, role: 'student' }, 'sess_2', turnId);
    expect(w.turn()?.completion_tokens).toBe(MARK);
    expect(w.db.romanMessage.updateMany.mock.calls[0][0].where).toEqual({ id: turnId, session_id: SESSION, user_id: USER_B.id, role: 'user' });
    await w.service.clearReplyPending({ id: USER_A.id, role: 'student' }, SESSION, turnId);
    expect(w.turn()?.completion_tokens).toBeNull();
  });

  it('a turn that vanished between the lost race\'s two reads answers as today, not pending', async () => {
    const w = world();
    w.seedTurn({ completion_tokens: MARK });
    jest.spyOn(w.service, 'findKeyedTurn').mockResolvedValue(null);
    expect((await w.send(WORDS)).writes).toEqual([WIRE_UNAVAILABLE]);
  });
});
