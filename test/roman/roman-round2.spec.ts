/**
 * #651 fix round 2 (B-SCHED-ROMAN, agent 115): one regression per finding from
 * the Opus (5964857917) and Sol (5964898255) reviews at a8fa651c, plus
 * operator rulings OR-115-1 (neutral safety audit) and OR-115-2 (crisis
 * templates answer without consent; nothing reaches the provider).
 *
 * Every test here was red at a8fa651c (tests-only commit on
 * ci/B-SCHED-ROMAN-651-before) and is green with the fix. Only APIs that
 * already existed at a8fa651c are imported, so the before-run fails on
 * behaviour, not on missing exports.
 */
import 'reflect-metadata';
import { HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RomanService } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { ROMAN_MAX_OUTPUT_TOKENS } from '../../src/roman/roman.constants';
import {
  classifySafety,
  ROMAN_PHYSICIAN_LINE_INJURY,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
  ROMAN_SAFETY_TEMPLATES,
} from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  ROMAN_POST_CHECK_TEMPLATES,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { AuditService } from '../../src/audit/audit.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import type { AuthedRequest } from '../../src/auth/auth-request';
import {
  AnthropicHandle,
  type AnthropicMessagesClient,
} from '../../src/ai-egress/ai-egress.service';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
  delete process.env.ROMAN_DAILY_COST_CAP_USD;
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  delete process.env.ROMAN_DAILY_COST_CAP_USD;
  jest.restoreAllMocks();
});

// ─── doubles ────────────────────────────────────────────────────────────────

const CLIENT = { id: 'client-1', role: 'student', tier: 'free' as const };

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'sess_1',
    user_id: CLIENT.id,
    surface: 'client' as const,
    day_key: '2026-10-03',
    message_count: 1,
    started_at: new Date(),
    last_activity_at: new Date(),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...over,
  };
}

type Row = Record<string, unknown>;

/**
 * A Prisma double whose ledger behaves like Postgres for the admission path:
 * `$executeRaw` of pg_advisory_xact_lock blocks until the holder's
 * transaction ends, aggregate sums today's rows, create inserts. Every await
 * yields, so two turns started together genuinely interleave unless the lock
 * serialises them.
 */
function makePrisma(
  opts: {
    history?: Array<{ role: string; content: string }>;
    deleteAfterGeneration?: boolean;
  } = {},
) {
  const stored: Array<{ role: string; content: string; interrupted: boolean }> = [];
  const audits: Row[] = [];
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const romanMessage = {
    create: jest.fn(
      async ({ data }: { data: { role: string; content: string; interrupted: boolean } }) => {
        stored.push({ role: data.role, content: data.content, interrupted: data.interrupted });
        return { id: `msg_${stored.length}`, ...data };
      },
    ),
    findMany: jest.fn(async () =>
      [...(opts.history ?? [{ role: 'user', content: 'hello' }])]
        .reverse()
        .map((m) => ({ ...m, created_at: new Date() })),
    ),
    findFirst: jest.fn(async () => ({ content: 'hello' })),
    update: jest.fn(),
  };
  const romanSession = {
    updateMany: jest.fn(async () => ({ count: opts.deleteAfterGeneration ? 0 : 1 })),
  };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Row }) => {
      await tick();
      audits.push({ ...data });
      return data;
    }),
    aggregate: jest.fn(async () => {
      await tick();
      const sum = audits.reduce<{ in: number; out: number }>(
        (a, r) => ({
          in: a.in + Number(r.prompt_token_estimate ?? 0),
          out: a.out + Number(r.response_token_estimate ?? 0),
        }),
        { in: 0, out: 0 },
      );
      return { _sum: { prompt_token_estimate: sum.in, response_token_estimate: sum.out } };
    }),
    update: jest.fn(async ({ where, data }: { where: { request_id: string }; data: Row }) => {
      const row = audits.find((a) => a.request_id === where.request_id);
      if (row) Object.assign(row, data);
      return row;
    }),
    deleteMany: jest.fn(async ({ where }: { where: { request_id: string } }) => {
      await tick();
      const i = audits.findIndex((a) => a.request_id === where.request_id);
      if (i >= 0) audits.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    }),
    delete: jest.fn(async ({ where }: { where: { request_id: string } }) => {
      await tick();
      const i = audits.findIndex((a) => a.request_id === where.request_id);
      if (i >= 0) audits.splice(i, 1);
      return {};
    }),
  };
  // Transaction-scoped advisory lock: one holder at a time per key.
  let lockTail: Promise<void> = Promise.resolve();
  const lockCalls: string[] = [];
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    let release: () => void = () => undefined;
    let holding = false;
    const tx = {
      romanMessage,
      romanSession,
      aiRequestAudit,
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        lockCalls.push(strings.join('?'));
        const prev = lockTail;
        lockTail = new Promise<void>((r) => {
          release = r;
        });
        holding = true;
        await prev;
        return 1;
      }),
    };
    try {
      return await fn(tx);
    } finally {
      if (holding) release();
    }
  });
  const prisma = { romanMessage, romanSession, aiRequestAudit, $transaction };
  return { prisma, stored, audits, lockCalls };
}

type StreamEvent = { type: string; message?: unknown; delta?: unknown; usage?: unknown };
type StreamStep = StreamEvent | { throw: Error } | { abort: AbortController };

function makeAnthropic(steps: StreamStep[] | Error) {
  const bodies: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = [];
  const client = {
    messages: {
      stream: jest.fn(
        (body: { system: string; messages: Array<{ role: string; content: string }> }) => {
          bodies.push(body);
          if (steps instanceof Error) throw steps;
          return {
            async *[Symbol.asyncIterator]() {
              for (const s of steps) {
                if ('throw' in s) throw s.throw;
                if ('abort' in s) {
                  s.abort.abort();
                  continue;
                }
                yield s;
              }
            },
          };
        },
      ),
      create: jest.fn(),
    },
  };
  return { client, bodies, handle: AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client)) };
}

function reply(text: string, input = 1000, output = 50): StreamStep[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: input } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', usage: { output_tokens: output } },
  ];
}

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>) {
  const out: Array<{ type: string; text?: string }> = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  try {
    return { ok: await p };
  } catch (err) {
    return { err };
  }
}

function codeOf(err: unknown): string | undefined {
  if (!(err instanceof HttpException)) return undefined;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
}

/** Persona: target 1450, remaining 670, floor 1200. */
const LEAN: PostCheckContext = {
  targets: { source: 'coach_set', calories: 1450, protein_g: 120, carbs_g: 140, fat_g: 45 },
  today: {
    kcal: 780,
    protein_g: 60,
    carbs_g: 70,
    fat_g: 25,
    meals_logged: 2,
    remaining_kcal: 670,
    remaining_protein_g: 60,
    remaining_carbs_g: 70,
    remaining_fat_g: 20,
    pct_kcal: 54,
    pct_protein: 50,
  },
  last_7_days: {
    days_logged: 5,
    avg_kcal_on_logged_days: 1100,
    avg_protein_g_on_logged_days: 110,
    days_within_10pct_kcal: 4,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
};

function bundleFor(ctx: PostCheckContext): RomanClientContextBundle {
  const context = {
    version: 'ctx-v3',
    identity: {
      first_name: 'Maya',
      timezone: 'UTC',
      local_date: '2026-10-03',
      local_time: '10:00',
    },
    targets: {
      ...ctx.targets,
      fiber_g: null,
      water_ml: null,
      meals_per_day: null,
      effective_from: null,
      notes: null,
    },
    today: { ...ctx.today, date: '2026-10-03', last_logged_at: null, entries: [] },
    last_7_days: { ...ctx.last_7_days, days: [] },
    macro_method: { summary: 'x', floor_kcal: 1200, floor_applied: false },
    coach: { has_coach: true, coach_first_name: 'Alex', guidelines: null, recent_messages: [] },
    wearables: {
      connected: false,
      providers: [],
      last_synced_at: null,
      avg_7d: { active_kcal: null },
      last_night_sleep_hours: null,
      latest_sleep: null,
      days: [],
    },
    meal_plan: null,
  };
  return fakeOf<RomanClientContextBundle>({
    context,
    rendered: '<client_data as_of="x" version="ctx-v3">{}</client_data>',
    hash: 'h'.repeat(64),
    generated_at: new Date(),
    estimated_tokens: 10,
    query_count: 1,
  });
}

function svcWith(
  prisma: ReturnType<typeof makePrisma>['prisma'],
  steps: StreamStep[] | Error,
  opts: { ctx?: PostCheckContext; audit?: { write: jest.Mock } } = {},
) {
  const a = makeAnthropic(steps);
  const clientContext = opts.ctx
    ? fakeOf<RomanClientContextService>({ getBundle: jest.fn(async () => bundleFor(opts.ctx!)) })
    : null;
  const svc = new RomanService(
    fakeOf<PrismaService>(prisma),
    grantAllEgress(),
    a.handle,
    clientContext,
    opts.audit ? fakeOf<AuditService>(opts.audit) : null,
  );
  return { svc, anthropic: a };
}

function ledger(audits: Row[]) {
  expect(audits).toHaveLength(1);
  return audits[0];
}

// ─── B-651-1: unknown usage never settles as free ───────────────────────────

describe('B-651-1 a dispatched turn whose usage is unknown keeps the conservative reservation', () => {
  it('abort after dispatch, before the first event: input = payload bound, output = max output', async () => {
    const { prisma, audits } = makePrisma();
    const ac = new AbortController();
    const { svc } = svcWith(prisma, [{ abort: ac }, ...reply('Hello.')]);
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'hello',
        signal: ac.signal,
      }),
    );
    const row = ledger(audits);
    expect(Number(row.prompt_token_estimate)).toBeGreaterThan(0);
    expect(row.response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
    expect(row.metadata).toMatchObject({ state: 'settled', outcome: 'interrupted' });
  });

  it('abort mid-stream after message_start: reported input, max output (final count never arrived)', async () => {
    const { prisma, audits } = makePrisma();
    const ac = new AbortController();
    const { svc } = svcWith(prisma, [
      { type: 'message_start', message: { usage: { input_tokens: 1800 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Protein first. ' } },
      { abort: ac },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Then carbs.' } },
    ]);
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'hello',
        signal: ac.signal,
      }),
    );
    const row = ledger(audits);
    expect(row.prompt_token_estimate).toBe(1800);
    expect(row.response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
  });

  it('transport failure after partial text: reported input, max output', async () => {
    const { prisma, audits, stored } = makePrisma();
    const { svc } = svcWith(prisma, [
      { type: 'message_start', message: { usage: { input_tokens: 1500 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Protein first.' } },
      { throw: Object.assign(new TypeError('terminated'), { code: 'UND_ERR_SOCKET' }) },
    ]);
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }));
    expect(stored.find((m) => m.role === 'roman')?.interrupted).toBe(true);
    const row = ledger(audits);
    expect(row.prompt_token_estimate).toBe(1500);
    expect(row.response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
  });

  it('transport failure before any event: both sides stay at the reservation (never zero)', async () => {
    const { prisma, audits } = makePrisma();
    const { svc } = svcWith(prisma, [
      { throw: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
    ]);
    const r = await settle(
      drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' })),
    );
    expect('err' in r).toBe(true);
    const row = ledger(audits);
    expect(Number(row.prompt_token_estimate)).toBeGreaterThan(0);
    expect(row.response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
    expect(row.metadata).toMatchObject({ outcome: 'model_error' });
  });

  it('the chat is deleted after partial generation: the session_gone settle keeps the generated cost', async () => {
    const { prisma, audits } = makePrisma({ deleteAfterGeneration: true });
    const { svc } = svcWith(prisma, [
      { type: 'message_start', message: { usage: { input_tokens: 1200 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Protein first.' } },
    ]);
    const r = await settle(
      drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' })),
    );
    expect('err' in r).toBe(true);
    const row = ledger(audits);
    expect(row.prompt_token_estimate).toBe(1200);
    expect(row.response_token_estimate).toBe(ROMAN_MAX_OUTPUT_TOKENS);
    expect(row.metadata).toMatchObject({ outcome: 'session_gone' });
  });

  it('control: a complete stream settles the exact reported usage', async () => {
    const { prisma, audits } = makePrisma();
    const { svc } = svcWith(prisma, reply('Protein first.', 1000, 50));
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }));
    const row = ledger(audits);
    expect(row.prompt_token_estimate).toBe(1000);
    expect(row.response_token_estimate).toBe(50);
  });

  it('control: the provider answered with an HTTP error before any event: known zero', async () => {
    const { prisma, audits } = makePrisma();
    const { svc } = svcWith(prisma, Object.assign(new Error('overloaded'), { status: 529 }));
    await settle(
      drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' })),
    );
    const row = ledger(audits);
    expect(row.prompt_token_estimate).toBe(0);
    expect(row.response_token_estimate).toBe(0);
  });
});

// ─── B-651-4: the reservation bounds the real payload ───────────────────────

describe('B-651-4 the reservation is an upper bound of the payload actually sent', () => {
  const longHistory = () => {
    const h: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 15; i += 1) {
      h.push({ role: 'user', content: 'u'.repeat(8000) });
      h.push({ role: 'roman', content: 'r'.repeat(8000) });
    }
    h.push({ role: 'user', content: 'what now' });
    return h;
  };

  it('Sol probe: a legal 30-turn tail of 8,000-character messages is not admitted under cap 0.1, and nothing is sent', async () => {
    process.env.ROMAN_DAILY_COST_CAP_USD = '0.1';
    const { prisma, audits } = makePrisma({ history: longHistory() });
    const { svc, anthropic } = svcWith(prisma, reply('ok', 40_000, 50));
    const r = await settle(
      drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'what now' })),
    );
    expect('err' in r && codeOf(r.err)).toBe('ROMAN_CAPACITY_REACHED');
    expect(anthropic.client.messages.stream).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('the reserved input covers every UTF-8 byte of the system prompt and every message sent', async () => {
    const { prisma, audits } = makePrisma({ history: longHistory() });
    const { svc, anthropic } = svcWith(prisma, [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fine.' } },
    ]);
    // Capture the reservation before it is settled.
    const reserved: number[] = [];
    prisma.aiRequestAudit.create.mockImplementationOnce(async ({ data }: { data: Row }) => {
      reserved.push(Number(data.prompt_token_estimate));
      audits.push({ ...data });
      return data;
    });
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'what now' }));
    const body = anthropic.bodies[0];
    const bytes =
      Buffer.byteLength(body.system, 'utf8') +
      body.messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
    expect(reserved[0]).toBeGreaterThanOrEqual(bytes);
    // The settled cost of any usage the provider can report for this payload
    // (tokens never exceed bytes) stays within the reservation.
    expect(RomanService.costUsd(bytes, ROMAN_MAX_OUTPUT_TOKENS)).toBeLessThanOrEqual(
      RomanService.costUsd(reserved[0], ROMAN_MAX_OUTPUT_TOKENS),
    );
  });

  it('cap boundary: a payload whose reservation fits exactly is admitted; one byte over is not', async () => {
    const probe = makePrisma();
    const reserved: number[] = [];
    probe.prisma.aiRequestAudit.create.mockImplementationOnce(async ({ data }: { data: Row }) => {
      reserved.push(Number(data.prompt_token_estimate));
      return data;
    });
    await drain(
      svcWith(probe.prisma, reply('Fine.')).svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'hello',
      }),
    );
    const exact = RomanService.costUsd(reserved[0], ROMAN_MAX_OUTPUT_TOKENS);

    process.env.ROMAN_DAILY_COST_CAP_USD = String(exact);
    const fits = makePrisma();
    const ok = svcWith(fits.prisma, reply('Fine.'));
    await drain(ok.svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }));
    expect(ok.anthropic.client.messages.stream).toHaveBeenCalledTimes(1);

    process.env.ROMAN_DAILY_COST_CAP_USD = String(exact - 0.000003);
    const over = makePrisma();
    const no = svcWith(over.prisma, reply('Fine.'));
    const r = await settle(
      drain(no.svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' })),
    );
    expect('err' in r && codeOf(r.err)).toBe('ROMAN_CAPACITY_REACHED');
    expect(no.anthropic.client.messages.stream).not.toHaveBeenCalled();
  });

  it('a very long history is trimmed oldest-first to the input budget; the newest turn is always sent and leads with a user turn', async () => {
    const h: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 15; i += 1) {
      h.push({ role: 'user', content: `${i} ` + 'u'.repeat(20_000) });
      h.push({ role: 'roman', content: 'r'.repeat(20_000) });
    }
    h.push({ role: 'user', content: 'the newest question' });
    const { prisma } = makePrisma({ history: h });
    const { svc, anthropic } = svcWith(prisma, reply('Fine.'));
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'the newest question' }),
    );
    const sent = anthropic.bodies[0].messages;
    expect(sent[sent.length - 1].content).toBe('the newest question');
    expect(sent[0].role).toBe('user');
    expect(sent.length).toBeLessThan(h.length);
  });
});

// ─── B-651-5: atomic admission ──────────────────────────────────────────────

describe('B-651-5 concurrent admission is atomic: never both rejected, never both admitted', () => {
  async function capForOne(): Promise<{ usd: number; input: number }> {
    const probe = makePrisma();
    const reserved: number[] = [];
    probe.prisma.aiRequestAudit.create.mockImplementationOnce(async ({ data }: { data: Row }) => {
      reserved.push(Number(data.prompt_token_estimate));
      return data;
    });
    await drain(
      svcWith(probe.prisma, reply('Fine.')).svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'hello',
      }),
    );
    return { usd: RomanService.costUsd(reserved[0], ROMAN_MAX_OUTPUT_TOKENS), input: reserved[0] };
  }

  it('Sol probe: two interleaved turns where exactly one fits: one is answered, one gets capacity copy', async () => {
    // Each turn really costs its full reservation, so the settle never frees room.
    const one = await capForOne();
    process.env.ROMAN_DAILY_COST_CAP_USD = String(one.usd * 1.5);
    const { prisma, audits } = makePrisma();
    const a = svcWith(prisma, reply('First.', one.input, ROMAN_MAX_OUTPUT_TOKENS));
    const b = svcWith(prisma, reply('Second.', one.input, ROMAN_MAX_OUTPUT_TOKENS));
    const [ra, rb] = await Promise.all([
      settle(drain(a.svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }))),
      settle(
        drain(
          b.svc.streamAssistantTurn(CLIENT, fakeOf(session({ id: 'sess_2' })), {
            userMessage: 'hello',
          }),
        ),
      ),
    ]);
    const outcomes = [ra, rb].map((r) => ('ok' in r ? 'answered' : codeOf(r.err)));
    expect(outcomes.sort()).toEqual(['ROMAN_CAPACITY_REACHED', 'answered']);
    expect(
      a.anthropic.client.messages.stream.mock.calls.length +
        b.anthropic.client.messages.stream.mock.calls.length,
    ).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it('four interleaved turns where two fit: exactly two are answered, reservations never sum above the cap', async () => {
    const one = await capForOne();
    process.env.ROMAN_DAILY_COST_CAP_USD = String(one.usd * 2.5);
    const { prisma, audits } = makePrisma();
    const runs = [0, 1, 2, 3].map((i) => {
      const s = svcWith(prisma, reply('Fine.', one.input, ROMAN_MAX_OUTPUT_TOKENS));
      return settle(
        drain(
          s.svc.streamAssistantTurn(CLIENT, fakeOf(session({ id: `sess_${i}` })), {
            userMessage: 'hello',
          }),
        ),
      );
    });
    const results = await Promise.all(runs);
    expect(results.filter((r) => 'ok' in r)).toHaveLength(2);
    expect(audits).toHaveLength(2);
  });

  it('the admission takes a per-day advisory lock inside its transaction', async () => {
    const { prisma, lockCalls } = makePrisma();
    const { svc } = svcWith(prisma, reply('Fine.'));
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }));
    expect(lockCalls.some((q) => /pg_advisory_xact_lock/.test(q))).toBe(true);
  });
});

// ─── B-651-2: router negatives (training vocabulary) and positives ──────────

describe('B-651-2 ordinary rowing / swimming vocabulary is not an emergency', () => {
  it.each([
    'What should my stroke rate be on the rower?',
    'How do I improve my back stroke for swim day?',
    'My rowing stroke feels weak at the catch, any drills?',
    'Breaststroke or freestyle for a recovery swim?',
    'I fainted once last year after giving blood, can I still do cardio?',
  ])('%s -> not emergency', (msg) => {
    expect(classifySafety(msg).class).not.toBe('emergency');
  });

  it.each([
    'I think I am having a stroke',
    'My face is drooping and my speech is slurred',
    'I just fainted at the gym',
    'My friend passed out and is not waking up',
    'My throat is closing after I ate peanuts',
  ])('%s -> emergency (positive control)', (msg) => {
    expect(classifySafety(msg).class).toBe('emergency');
  });

  it('a past fainting episode is routed to medical scope with the physician line, not the 911 template', async () => {
    const { prisma, stored } = makePrisma();
    const { svc, anthropic } = svcWith(prisma, reply('Build up slowly and keep water close.'));
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'I fainted once last year after giving blood, can I still do cardio?',
      }),
    );
    expect(anthropic.client.messages.stream).toHaveBeenCalledTimes(1);
    const text = stored.find((m) => m.role === 'roman')?.content ?? '';
    expect(text).not.toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(text).toContain(ROMAN_PHYSICIAN_LINE_MEDICAL);
  });
});

// ─── B-651-3: treat / dose / negated starvation are ordinary coaching ───────

describe('B-651-3 ordinary treat / dose / negated starvation language survives', () => {
  it.each([
    'Yes, a small treat fits tonight.',
    'A Friday treat meal is fine inside your plan.',
    'Try a small dose of cardio.',
    'You are not starving yourself by eating at your target.',
  ])('%s is unchanged', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.text).toBe(text);
    expect(r.rewritten).toBe(false);
  });

  it.each([
    'Take 400 mg of ibuprofen before you train.',
    'You should treat the tendinitis with a cortisone shot.',
    'Starve yourself until Friday.',
  ])('%s is still removed (positive control)', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toContain(text);
  });
});

// ─── B-651-6: below-floor daily directives never ship ───────────────────────

describe('B-651-6 a daily intake directive below the floor never ships', () => {
  it.each([
    'Aim for 300 kcal per day.',
    'Eat 900 kcal per day.',
    'Aim for \uFF19\uFF10\uFF10 kcal per day.',
  ])('full turn: %s is replaced by the floor template', async (text) => {
    const { prisma, stored } = makePrisma();
    const { svc } = svcWith(prisma, reply(text), { ctx: LEAN });
    const chunks = await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'how much should I eat' }),
    );
    const shipped = stored.find((m) => m.role === 'roman')?.content ?? '';
    expect(shipped).not.toContain(text);
    expect(JSON.stringify(chunks)).not.toMatch(
      /300 kcal per day|900 kcal per day|\uFF19\uFF10\uFF10/,
    );
    // Replaced by the deterministic target restatement (never a sub-floor number).
    expect(shipped).toContain('Your daily target is 1,450 kcal');
  });

  it('control: a snack-sized amount is unchanged', () => {
    const text = 'Try about 300 kcal for your next snack.';
    expect(postCheckRomanReply(text, { routerClass: 'normal', context: LEAN }).text).toBe(text);
  });
});

// ─── B-651-7: facts validate only their own field family ────────────────────

describe('B-651-7 a remaining / logged / average number never validates a false target', () => {
  it.each([
    ['Your daily target is 670 kcal.', 'remaining'],
    ['Your daily target is 780 kcal.', 'logged today'],
    ['Your daily target is 1100 kcal.', '7-day average'],
    ['Your protein target is 60 g.', 'remaining protein'],
  ])('%s (equals the %s value) is corrected', (text) => {
    const r = postCheckRomanReply(text, { routerClass: 'normal', context: LEAN });
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toContain(text);
  });

  it('full turn: the false target is never stored or emitted', async () => {
    const { prisma, stored } = makePrisma();
    const { svc } = svcWith(prisma, reply('Your daily target is 670 kcal.'), { ctx: LEAN });
    const chunks = await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'what is my target' }),
    );
    expect(stored.find((m) => m.role === 'roman')?.content).not.toContain('target is 670');
    expect(JSON.stringify(chunks)).not.toContain('target is 670');
  });

  it.each([
    'You have 670 kcal remaining today.',
    'You have logged 780 kcal today.',
    'Your daily target is 1450 kcal.',
    'You averaged 1100 kcal on the days you logged.',
  ])('control: the true fact %s is unchanged', (text) => {
    expect(postCheckRomanReply(text, { routerClass: 'normal', context: LEAN }).text).toBe(text);
  });
});

// ─── B-651-8: medical enforcement runs on the final composed reply ──────────

describe('B-651-8 an earlier rewrite never skips the injury / medical safe action', () => {
  it('Sol probe: "My knee hurts when I squat." + a sub-floor reply keeps the stop action and the physician line', async () => {
    const { prisma, stored } = makePrisma();
    const { svc } = svcWith(prisma, reply('Eat only 900 calories a day.'), { ctx: LEAN });
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'My knee hurts when I squat.',
      }),
    );
    const text = stored.find((m) => m.role === 'roman')?.content ?? '';
    expect(text).not.toContain('900 calories');
    expect(text).toContain(ROMAN_PHYSICIAN_LINE_INJURY);
    expect(text).toMatch(/stop/i);
  });

  it.each([
    [
      'injury_pain' as const,
      'Take 400 mg of ibuprofen and push through.',
      ROMAN_PHYSICIAN_LINE_INJURY,
    ],
    ['medical_scope' as const, 'Your daily target is 670 kcal.', ROMAN_PHYSICIAN_LINE_MEDICAL],
  ])('%s + rewrite (%s) still carries the physician line', (routerClass, text, line) => {
    const r = postCheckRomanReply(text, { routerClass, context: LEAN });
    expect(r.text).toContain(line);
  });
});

// ─── B-651-9: no exclamation marks ship ─────────────────────────────────────

describe('B-651-9 no shipped reply carries an exclamation mark', () => {
  it('a fresh session (allowance unspent) still ships none', async () => {
    const { prisma, stored } = makePrisma();
    const { svc } = svcWith(prisma, reply('Nice work! Keep the plan as written.'));
    const chunks = await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hit my protein' }),
    );
    expect(stored.find((m) => m.role === 'roman')?.content).toBe(
      'Nice work. Keep the plan as written.',
    );
    expect(JSON.stringify(chunks)).not.toContain('!');
  });

  it('the system prompt offers no per-session exclamation', async () => {
    const { prisma } = makePrisma();
    const { svc, anthropic } = svcWith(prisma, reply('Fine.'));
    await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: 'hello' }));
    expect(anthropic.bodies[0].system).not.toMatch(/may spend the single per-session exclamation/i);
    expect(anthropic.bodies[0].system).not.toMatch(/a single exclamation per session/i);
  });
});

// ─── B-651-10: coded context-view failures ──────────────────────────────────

describe('B-651-10 GET /roman/context/me failures are coded with specific copy', () => {
  function runFilter(err: unknown) {
    const res = { statusCode: 0, body: null as unknown };
    const response = {
      status: (s: number) => {
        res.statusCode = s;
        return { json: (b: unknown) => (res.body = b) };
      },
    };
    const request = {
      method: 'GET',
      url: '/roman/context/me',
      route: { path: '/roman/context/me' },
      requestId: 'req-1',
    };
    const host = fakeOf<ArgumentsHost>({
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    });
    new HttpExceptionFilter().catch(err, host);
    return res;
  }

  async function call(err: unknown) {
    const ctx = fakeOf<RomanClientContextService>({
      buildFresh: jest.fn(async () => {
        throw err;
      }),
    });
    const ctl = new RomanContextController(ctx);
    const r = await settle(
      ctl.me(fakeOf<AuthedRequest>({ user: { id: CLIENT.id, role: 'student' } })),
    );
    expect('err' in r).toBe(true);
    return runFilter('err' in r ? r.err : null);
  }

  it('Sol probe: Prisma P2024 (pool timeout) is a coded 503 with a retry path, never a generic 500', async () => {
    const p2024 = new Prisma.PrismaClientKnownRequestError(
      'Timed out fetching a new connection from the pool. canary-query-text',
      { code: 'P2024', clientVersion: '6.19.3' },
    );
    const res = await call(p2024);
    expect(res.statusCode).toBe(503);
    const body = res.body as { code?: string; message?: string };
    expect(body.code).toBe('ROMAN_CONTEXT_UNAVAILABLE');
    expect(body.message).toMatch(/could not load/);
    expect(body.message).toMatch(/Try again in a moment/);
    expect(body.message).not.toMatch(
      /!|\bwe\b|\bus\b|\bour\b|something went wrong|internal server error/i,
    );
    expect(JSON.stringify(res.body)).not.toContain('canary');
  });

  it('an unexpected failure is a coded 500 with the support path and the reference id', async () => {
    const res = await call(new RangeError('canary detail'));
    expect(res.statusCode).toBe(500);
    const body = res.body as { code?: string; message?: string; request_id?: string };
    expect(body.code).toBe('ROMAN_CONTEXT_FAILED');
    expect(body.message).toMatch(/contact support/);
    expect(body.message).not.toMatch(/!|\bwe\b|\bus\b|\bour\b|something went wrong/i);
    expect(body.request_id).toBe('req-1');
    expect(JSON.stringify(res.body)).not.toContain('canary');
  });
});

// ─── OR-115-1 / C-651-5: neutral safety audit, no health words in ledger/logs

describe('OR-115-1 the safety audit row is neutral and its reason is restricted-read', () => {
  it.each([
    ['I am having chest pain right now', 'call_911'],
    ['I want to kill myself', 'call_988'],
  ])(
    '%s -> action roman.safety_route, reason %s, no provider call, no consent needed (OR-115-2)',
    async (msg, reason) => {
      const { prisma, audits } = makePrisma();
      const audit = { write: jest.fn(async (_row: Record<string, unknown>) => undefined) };
      const { svc, anthropic } = svcWith(prisma, reply('never'), { audit });
      await drain(svc.streamAssistantTurn(CLIENT, fakeOf(session()), { userMessage: msg }));
      expect(anthropic.client.messages.stream).not.toHaveBeenCalled();
      expect(audits).toHaveLength(0);
      const row = audit.write.mock.calls[0]?.[0] ?? {};
      expect(row).toMatchObject({
        action: 'roman.safety_route',
        metadata: { route_reason: reason },
      });
      expect(String(row.action)).not.toMatch(/emergency|self_harm|crisis|suicid/);
    },
  );

  it('the owner audit list never returns the restricted reason metadata', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 'a1',
        action: 'roman.safety_route',
        metadata: { route_reason: 'call_988' },
        created_at: new Date(),
      },
      { id: 'a2', action: 'auth.login', metadata: { method: 'password' }, created_at: new Date() },
    ]);
    const svc = new AuditService(fakeOf<PrismaService>({ auditLog: { findMany } }));
    const rows = await svc.list({ limit: 10 });
    expect(rows.find((r) => r.id === 'a1')?.metadata).toBeNull();
    expect(rows.find((r) => r.id === 'a2')?.metadata).toEqual({ method: 'password' });
  });

  it('the spend ledger and the turn log line carry no router class and no guardrail names', async () => {
    const warn = jest.spyOn(Logger.prototype, 'log');
    const { prisma, audits } = makePrisma();
    const { svc } = svcWith(prisma, reply('Take 400 mg of ibuprofen and push through.'));
    await drain(
      svc.streamAssistantTurn(CLIENT, fakeOf(session()), {
        userMessage: 'my knee hurts when I squat',
      }),
    );
    const meta = JSON.stringify(ledger(audits).metadata);
    expect(meta).not.toMatch(/router_class|injury|medical|guardrails_applied|ibuprofen|diagnos/);
    const lines = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toMatch(/router=|guardrails_applied|injury_pain|medical_scope|diagnosis/);
  });
});

// ─── C-651-4: bounded memo ──────────────────────────────────────────────────

describe('C-651-4 the context memo does not keep expired bundles or per-user fences forever', () => {
  function svcFor() {
    const svc = new RomanClientContextService(
      fakeOf<PrismaService>({}),
      fakeOf({ summarize: jest.fn(async () => null) }),
    );
    jest.spyOn(svc, 'buildFresh').mockImplementation(async () => bundleFor(LEAN));
    return svc;
  }
  const sizeOf = (svc: RomanClientContextService, field: string) =>
    (Reflect.get(svc, field) as Map<string, unknown>).size;

  it('an expired entry is evicted on the next build, for any user', async () => {
    const svc = svcFor();
    const t0 = new Date('2026-10-03T10:00:00Z');
    for (let i = 0; i < 20; i += 1) await svc.getBundle({ id: `u${i}`, role: 'student' }, t0);
    expect(sizeOf(svc, 'memo')).toBe(20);
    await svc.getBundle({ id: 'later', role: 'student' }, new Date(t0.getTime() + 60_000));
    expect(sizeOf(svc, 'memo')).toBe(1);
  });

  it('invalidating users with no build in flight leaves no generation entry behind', async () => {
    const svc = svcFor();
    for (let i = 0; i < 50; i += 1) svc.invalidateForUser(`u${i}`);
    expect(sizeOf(svc, 'generation')).toBe(0);
  });

  it('control: a write during an in-flight build still keeps the stale bundle out of the memo', async () => {
    const svc = new RomanClientContextService(
      fakeOf<PrismaService>({}),
      fakeOf({ summarize: jest.fn(async () => null) }),
    );
    let release: () => void = () => undefined;
    jest.spyOn(svc, 'buildFresh').mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(bundleFor(LEAN));
        }),
    );
    const t0 = new Date('2026-10-03T10:00:00Z');
    const p = svc.getBundle({ id: 'u1', role: 'student' }, t0);
    await new Promise((r) => setImmediate(r));
    svc.invalidateForUser('u1');
    release();
    await p;
    expect(sizeOf(svc, 'memo')).toBe(0);
    expect(sizeOf(svc, 'generation')).toBe(0);
  });
});
