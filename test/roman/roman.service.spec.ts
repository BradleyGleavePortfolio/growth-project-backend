/**
 * Roman Phase 1 — RomanService unit tests (brief §1.7).
 *
 * Covers: session open/resume idempotency, surface routing, soft-delete,
 * message append + bookkeeping, cursor pagination, rate-limit cap selection +
 * 429 enforcement, tail-slice context assembly, and the streaming wrapper's
 * happy-path + client-disconnect (interrupted) persistence — all with an
 * in-memory fake Prisma + fake Anthropic stream (no DB, no network).
 */

import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma.service';
import {
  RomanCaller,
  RomanService,
  dayKeyUtc,
} from '../../src/roman/roman.service';
import {
  ROMAN_RATE_LIMIT_FREE_PER_DAY,
  ROMAN_RATE_LIMIT_PRO_PER_DAY,
} from '../../src/roman/roman.constants';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';

// ─── In-memory fake Prisma ──────────────────────────────────────────────────
interface SessionRow {
  id: string;
  user_id: string;
  surface: 'client' | 'coach';
  day_key: string;
  message_count: number;
  started_at: Date;
  last_activity_at: Date;
  quips_in_session: number;
  exclamation_used: boolean;
  subject_context_json: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
interface MessageRow {
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

function makeFakePrisma() {
  const sessions: SessionRow[] = [];
  const messages: MessageRow[] = [];
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const matchSession = (where: Record<string, unknown>, r: SessionRow) =>
    Object.entries(where).every(([k, v]) => {
      if (v === null) return (r as unknown as Record<string, unknown>)[k] === null;
      return (r as unknown as Record<string, unknown>)[k] === v;
    });

  const api = {
    romanSession: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        sessions.find((r) => matchSession(where, r)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row: SessionRow = {
          id: id('sess'),
          user_id: data.user_id as string,
          surface: data.surface as 'client' | 'coach',
          day_key: data.day_key as string,
          message_count: 0,
          started_at: now,
          last_activity_at: now,
          quips_in_session: 0,
          exclamation_used: false,
          subject_context_json: data.subject_context_json ?? null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        };
        sessions.push(row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = sessions.find((r) => r.id === where.id)!;
          if (data.deleted_at) row.deleted_at = data.deleted_at as Date;
          if (data.last_activity_at)
            row.last_activity_at = data.last_activity_at as Date;
          if (
            data.message_count &&
            typeof data.message_count === 'object' &&
            'increment' in (data.message_count as object)
          ) {
            row.message_count += (data.message_count as { increment: number })
              .increment;
          }
          return row;
        },
      ),
    },
    romanMessage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: MessageRow = {
          id: id('msg'),
          session_id: data.session_id as string,
          user_id: data.user_id as string,
          role: data.role as 'user' | 'roman',
          content: data.content as string,
          prompt_tokens: (data.prompt_tokens as number) ?? null,
          completion_tokens: (data.completion_tokens as number) ?? null,
          model_id: (data.model_id as string) ?? null,
          interrupted: (data.interrupted as boolean) ?? false,
          parent_message_id: (data.parent_message_id as string) ?? null,
          created_at: new Date(Date.now() + seq), // monotonic ordering
        };
        messages.push(row);
        return row;
      }),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
          cursor,
          skip,
        }: {
          where: { session_id: string };
          orderBy?: { created_at: 'asc' | 'desc' };
          take?: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let rows = messages.filter((m) => m.session_id === where.session_id);
          rows = rows.sort((a, b) =>
            orderBy?.created_at === 'asc'
              ? a.created_at.getTime() - b.created_at.getTime()
              : b.created_at.getTime() - a.created_at.getTime(),
          );
          if (cursor) {
            const idx = rows.findIndex((r) => r.id === cursor.id);
            if (idx >= 0) rows = rows.slice(idx + (skip ?? 0));
          }
          return typeof take === 'number' ? rows.slice(0, take) : rows;
        },
      ),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          messages.filter((m) => {
            if (where.user_id && m.user_id !== where.user_id) return false;
            if (where.role && m.role !== where.role) return false;
            if (
              where.created_at &&
              typeof where.created_at === 'object' &&
              'gte' in (where.created_at as object)
            ) {
              const gte = (where.created_at as { gte: Date }).gte;
              if (m.created_at < gte) return false;
            }
            return true;
          }).length,
      ),
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: Record<string, unknown>;
          orderBy?: { created_at: 'asc' | 'desc' };
        }) => {
          let rows = messages.filter((m) => {
            if (where.user_id && m.user_id !== where.user_id) return false;
            if (where.role && m.role !== where.role) return false;
            return true;
          });
          rows = rows.sort((a, b) =>
            orderBy?.created_at === 'asc'
              ? a.created_at.getTime() - b.created_at.getTime()
              : b.created_at.getTime() - a.created_at.getTime(),
          );
          return rows[0] ?? null;
        },
      ),
    },
    $transaction: undefined as unknown,
    _state: { sessions, messages },
  };
  // Attach $transaction after `api` exists so its closure over `api` does not
  // create a circular type initializer (tsc noImplicitAny gate).
  (api as Record<string, unknown>).$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  );
  return api;
}

function asPrisma(fake: ReturnType<typeof makeFakePrisma>): PrismaService {
  return fake as unknown as PrismaService;
}

const CALLER: RomanCaller = { id: 'u_a', role: 'student', tier: 'free' };

describe('RomanService — sessions', () => {
  it('opens a new session for (user, surface, day)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    expect(s.user_id).toBe('u_a');
    expect(s.surface).toBe('client');
    expect(s.day_key).toBe(dayKeyUtc());
  });

  it('resumes the SAME session on a second open (idempotent on day-key)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const first = await svc.openOrResumeSession(CALLER, 'client');
    const second = await svc.openOrResumeSession(CALLER, 'client');
    expect(second.id).toBe(first.id);
    expect(prisma.romanSession.create).toHaveBeenCalledTimes(1);
  });

  it('routes coach and client surfaces to distinct sessions', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const client = await svc.openOrResumeSession(CALLER, 'client');
    const coach = await svc.openOrResumeSession(CALLER, 'coach');
    expect(client.id).not.toBe(coach.id);
    expect(coach.surface).toBe('coach');
  });

  it('getOwnedSession throws 404 for a session the caller does not own', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await expect(
      svc.getOwnedSession({ id: 'u_b', role: 'student' }, s.id),
    ).rejects.toThrow('Roman session not found');
  });

  it('soft-deletes a session (sets deleted_at, hides from resume)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.softDeleteSession(CALLER, s.id);
    expect(prisma._state.sessions[0].deleted_at).toBeInstanceOf(Date);
    // A subsequent open creates a fresh session (the deleted one is hidden).
    const next = await svc.openOrResumeSession(CALLER, 'client');
    expect(next.id).not.toBe(s.id);
  });
});

describe('RomanService — messages', () => {
  it('appends a turn and bumps message_count + last_activity_at', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'Hello' });
    expect(prisma._state.sessions[0].message_count).toBe(1);
    expect(prisma._state.messages).toHaveLength(1);
    expect(prisma._state.messages[0].role).toBe('user');
  });

  it('paginates messages newest-first with a cursor', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    for (let i = 0; i < 5; i++) {
      await svc.appendMessage(CALLER, s.id, {
        role: 'user',
        content: `m${i}`,
      });
    }
    const page1 = await svc.listMessages(CALLER, s.id, { limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first: m4 then m3.
    expect(page1.messages[0].content).toBe('m4');
    const page2 = await svc.listMessages(CALLER, s.id, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages[0].content).toBe('m2');
  });

  it('builds a tail-slice of context turns, oldest-first', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'first' });
    await svc.appendMessage(CALLER, s.id, { role: 'roman', content: 'reply' });
    const turns = await svc.buildContextTurns(s.id);
    expect(turns[0]).toEqual({ role: 'user', content: 'first' });
    expect(turns[1]).toEqual({ role: 'assistant', content: 'reply' });
  });
});

describe('RomanService — rate limiting', () => {
  it('selects the free vs pro cap by tier', () => {
    const svc = new RomanService(asPrisma(makeFakePrisma()));
    expect(svc.rateLimitCapFor({ id: 'x', role: 'student', tier: 'free' })).toBe(
      ROMAN_RATE_LIMIT_FREE_PER_DAY,
    );
    expect(svc.rateLimitCapFor({ id: 'x', role: 'coach', tier: 'pro' })).toBe(
      ROMAN_RATE_LIMIT_PRO_PER_DAY,
    );
  });

  it('throws a structured 429 once the cap is exhausted', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    for (let i = 0; i < ROMAN_RATE_LIMIT_FREE_PER_DAY; i++) {
      await svc.appendMessage(CALLER, s.id, { role: 'user', content: `t${i}` });
    }
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('exempts the owner from the rate limit', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma));
    await expect(
      svc.assertWithinRateLimit({ id: 'u_owner', role: 'owner' }),
    ).resolves.toBeUndefined();
  });
});

// ─── Streaming wrapper ──────────────────────────────────────────────────────
function makeFakeStream(deltas: string[]) {
  return {
    messages: {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'message_start',
            message: { usage: { input_tokens: 11 } },
          };
          for (const d of deltas) {
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: d },
            };
          }
          yield { type: 'message_delta', usage: { output_tokens: 7 } };
        },
      }),
    },
  };
}

describe('RomanService — streaming', () => {
  const OLD = process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  beforeEach(() => {
    process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
    else process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = OLD;
  });

  it('streams deltas then persists the full assistant turn on completion', async () => {
    const prisma = makeFakePrisma();
    const fake = makeFakeStream(['Good ', 'day.']);
    const svc = new RomanService(asPrisma(prisma), fake as never);
    const s = await svc.openOrResumeSession(CALLER, 'client');

    const chunks: string[] = [];
    let doneInterrupted: boolean | undefined;
    for await (const c of svc.streamAssistantTurn(CALLER, s)) {
      if (c.type === 'delta') chunks.push(c.text!);
      if (c.type === 'done') doneInterrupted = c.interrupted;
    }
    expect(chunks.join('')).toBe('Good day.');
    expect(doneInterrupted).toBe(false);
    const stored = prisma._state.messages.find((m) => m.role === 'roman');
    expect(stored?.content).toBe('Good day.');
    expect(stored?.completion_tokens).toBe(7);
    expect(stored?.prompt_tokens).toBe(11);
    expect(stored?.interrupted).toBe(false);
  });

  it('persists a partial turn with interrupted=true on client disconnect', async () => {
    const prisma = makeFakePrisma();
    const fake = makeFakeStream(['Part', 'ial', ' text']);
    const svc = new RomanService(asPrisma(prisma), fake as never);
    const s = await svc.openOrResumeSession(CALLER, 'client');

    const abort = new AbortController();
    let interrupted: boolean | undefined;
    let count = 0;
    for await (const c of svc.streamAssistantTurn(CALLER, s, {
      signal: abort.signal,
    })) {
      if (c.type === 'delta') {
        count++;
        if (count === 1) abort.abort(); // disconnect after first delta
      }
      if (c.type === 'done') interrupted = c.interrupted;
    }
    expect(interrupted).toBe(true);
    const stored = prisma._state.messages.find((m) => m.role === 'roman');
    expect(stored?.interrupted).toBe(true);
  });

  it('refuses to call the model when the feature flag is OFF', async () => {
    process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'false';
    const prisma = makeFakePrisma();
    const fake = makeFakeStream(['x']);
    const svc = new RomanService(asPrisma(prisma), fake as never);
    const s = await svc.openOrResumeSession(CALLER, 'client');
    const gen = svc.streamAssistantTurn(CALLER, s);
    await expect(gen.next()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('surfaces ROMAN_UNAVAILABLE when no Anthropic client is configured', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), null);
    const s = await svc.openOrResumeSession(CALLER, 'client');
    const gen = svc.streamAssistantTurn(CALLER, s);
    await expect(gen.next()).rejects.toMatchObject({
      response: { code: 'ROMAN_UNAVAILABLE' },
    });
  });
});
