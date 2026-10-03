/**
 * Roman Phase 1 — RomanService unit tests (brief §1.7).
 *
 * Covers: session open/resume idempotency, surface routing, soft-delete,
 * message append + bookkeeping, cursor pagination, rate-limit cap selection +
 * 429 enforcement, tail-slice context assembly, and the streaming wrapper's
 * happy-path + client-disconnect (interrupted) persistence — all with an
 * in-memory fake Prisma + fake Anthropic stream (no DB, no network).
 */

import {
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/prisma.service';
import {
  RomanCaller,
  RomanService,
  dayKeyUtc,
  erasedDayKey,
} from '../../src/roman/roman.service';
import {
  ROMAN_RATE_LIMIT_FREE_PER_DAY,
  ROMAN_RATE_LIMIT_PRO_PER_DAY,
} from '../../src/roman/roman.constants';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { grantAllEgress, fakeOf } from '../ai-egress/ai-egress.fakes';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';

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

  // Prisma-faithful predicate subset the service uses: equality, null,
  // { not }, { startsWith }, { gte }, { gt }, { lt }, { notIn }, NOT and OR.
  const matchValue = (cond: unknown, actual: unknown): boolean => {
    if (cond === null) return actual === null;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (typeof cond !== 'object') return actual === cond;
    const c = cond as Record<string, unknown>;
    if ('not' in c && !(c.not === null ? actual !== null : actual !== c.not)) return false;
    if ('startsWith' in c && !(typeof actual === 'string' && actual.startsWith(String(c.startsWith))))
      return false;
    if ('gte' in c && !(actual instanceof Date && c.gte instanceof Date && actual >= c.gte))
      return false;
    if ('gt' in c && !(typeof actual === 'number' && actual > Number(c.gt))) return false;
    if ('lt' in c) {
      const lt = c.lt;
      if (lt instanceof Date) {
        if (!(actual instanceof Date && actual.getTime() < lt.getTime())) return false;
      } else if (!(typeof actual === 'string' && typeof lt === 'string' && actual < lt)) {
        return false;
      }
    }
    if ('notIn' in c && Array.isArray(c.notIn) && c.notIn.includes(actual)) return false;
    return true;
  };
  const matchSession = (where: Record<string, unknown>, r: SessionRow): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') return !matchSession(v as Record<string, unknown>, r);
      if (k === 'OR')
        return (v as Record<string, unknown>[]).some((w) => matchSession(w, r));
      return matchValue(v, (r as unknown as Record<string, unknown>)[k]);
    });
  // The real unique index roman_session_user_surface_day covers EVERY row,
  // deleted or not (prisma/schema.prisma @@unique([user_id, surface, day_key])),
  // so this fake rejects a duplicate key exactly like Postgres (Sol B-635-1).
  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`user_id`,`surface`,`day_key`)',
      { code: 'P2002', clientVersion: 'test', meta: { target: ['user_id', 'surface', 'day_key'] } },
    );
  const keyTaken = (user_id: string, surface: string, day_key: string, exceptId?: string) =>
    sessions.some(
      (r) =>
        r.id !== exceptId && r.user_id === user_id && r.surface === surface && r.day_key === day_key,
    );

  const api = {
    romanSession: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        sessions.find((r) => matchSession(where, r)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        if (keyTaken(String(data.user_id), String(data.surface), String(data.day_key))) {
          throw uniqueViolation();
        }
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
      // Applies the fields the service writes; a day_key change is checked
      // against the same unique key.
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = sessions.filter((r) => matchSession(where, r));
          for (const row of hits) {
            if (typeof data.day_key === 'string') {
              if (keyTaken(row.user_id, row.surface, data.day_key, row.id)) throw uniqueViolation();
              row.day_key = data.day_key;
            }
            if (data.deleted_at) row.deleted_at = data.deleted_at as Date;
            if ('subject_context_json' in data) row.subject_context_json = null;
            if (data.last_activity_at) row.last_activity_at = data.last_activity_at as Date;
            if (typeof data.message_count === 'number') row.message_count = data.message_count;
            else if (
              data.message_count &&
              typeof data.message_count === 'object' &&
              'increment' in (data.message_count as object)
            ) {
              row.message_count += (data.message_count as { increment: number }).increment;
            }
          }
          return { count: hits.length };
        },
      ),
      // Honours `orderBy` (one key or a list of keys, asc/desc) like Prisma;
      // id ascending when none is given.
      findMany: jest.fn(
        async ({
          where,
          take,
          orderBy,
        }: {
          where: Record<string, unknown>;
          take?: number;
          orderBy?: Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[];
        }) => {
          const keys = (Array.isArray(orderBy) ? orderBy : [orderBy ?? { id: 'asc' }]).map(
            (o) => Object.entries(o)[0],
          );
          const rows = sessions
            .filter((r) => matchSession(where, r))
            .sort((a, b) => {
              for (const [k, dir] of keys) {
                const av = new Map(Object.entries(a)).get(k);
                const bv = new Map(Object.entries(b)).get(k);
                const x = av instanceof Date ? av.getTime() : String(av);
                const y = bv instanceof Date ? bv.getTime() : String(bv);
                if (x < y) return dir === 'asc' ? -1 : 1;
                if (x > y) return dir === 'asc' ? 1 : -1;
              }
              return 0;
            });
          return typeof take === 'number' ? rows.slice(0, take) : rows;
        },
      ),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          sessions.filter((r) => matchSession(where, r)).length,
      ),
      aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = sessions.filter((r) => matchSession(where, r));
        return {
          _sum: { message_count: rows.length ? rows.reduce((n, r) => n + r.message_count, 0) : null },
          _min: {
            last_activity_at: rows.length
              ? new Date(Math.min(...rows.map((r) => r.last_activity_at.getTime())))
              : null,
          },
        };
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
      deleteMany: jest.fn(
        async ({ where }: { where: { session_id: string; user_id: string } }) => {
          const before = messages.length;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].session_id === where.session_id && messages[i].user_id === where.user_id) {
              messages.splice(i, 1);
            }
          }
          return { count: before - messages.length };
        },
      ),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          messages.filter((m) => {
            if (where.session_id && m.session_id !== where.session_id) return false;
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
    // Opt-in rollback for sequential tests: a callback that throws restores
    // both tables, as a real transaction does (off by default because the
    // concurrency tests interleave transactions).
    _tx: { rollback: false },
  };
  // Attach $transaction after `api` exists so its closure over `api` does not
  // create a circular type initializer (tsc noImplicitAny gate).
  (api as Record<string, unknown>).$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      if (!api._tx.rollback) return fn(api);
      const s0 = sessions.map((r) => ({ ...r }));
      const m0 = messages.map((m) => ({ ...m }));
      try {
        return await fn(api);
      } catch (err) {
        sessions.splice(0, sessions.length, ...s0);
        messages.splice(0, messages.length, ...m0);
        throw err;
      }
    },
  );
  return api;
}

function asPrisma(fake: ReturnType<typeof makeFakePrisma>): PrismaService {
  return fake as unknown as PrismaService;
}

const CALLER: RomanCaller = { id: 'u_a', role: 'student', tier: 'free' };

// C-635-2: every "not yours / gone" answer is the same coded 404.
const SESSION_NOT_FOUND = {
  status: 404,
  response: {
    code: 'ROMAN_SESSION_NOT_FOUND',
    message: 'This conversation no longer exists. Open Roman again to start a new one.',
  },
};

describe('RomanService — sessions', () => {
  it('opens a new session for (user, surface, day)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    expect(s.user_id).toBe('u_a');
    expect(s.surface).toBe('client');
    expect(s.day_key).toBe(dayKeyUtc());
  });

  it('resumes the SAME session on a second open (idempotent on day-key)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const first = await svc.openOrResumeSession(CALLER, 'client');
    const second = await svc.openOrResumeSession(CALLER, 'client');
    expect(second.id).toBe(first.id);
    expect(prisma.romanSession.create).toHaveBeenCalledTimes(1);
  });

  it('routes coach and client surfaces to distinct sessions', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const client = await svc.openOrResumeSession(CALLER, 'client');
    const coach = await svc.openOrResumeSession(CALLER, 'coach');
    expect(client.id).not.toBe(coach.id);
    expect(coach.surface).toBe('coach');
  });

  it('getOwnedSession throws the coded 404 for a session the caller does not own', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await expect(
      svc.getOwnedSession({ id: 'u_b', role: 'student' }, s.id),
    ).rejects.toMatchObject(SESSION_NOT_FOUND);
  });

  it('deleting a session hides it from resume (a fresh session opens)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.deleteSession(CALLER, s.id);
    expect(prisma._state.sessions[0].deleted_at).toBeInstanceOf(Date);
    // A subsequent open creates a fresh session (the deleted one is hidden).
    const next = await svc.openOrResumeSession(CALLER, 'client');
    expect(next.id).not.toBe(s.id);
  });
});

// Owner 2026-10-01 20:32 + OR-110-1: Roman chats are kept until the client
// deletes them or their account. A client delete must ERASE the transcript
// (box-2 copy client-ai-v4 and the privacy policy promise exactly that).
describe('RomanService — client delete erases the conversation', () => {
  const OTHER: RomanCaller = { id: 'u_b', role: 'student', tier: 'free' };

  it('hard-deletes every message of the session and clears the subject context', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client', { brief: 'private context' });
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'my knee hurts on squats' });
    await svc.appendMessage(CALLER, s.id, { role: 'roman', content: 'Let us adjust the depth.' });
    const theirs = await svc.openOrResumeSession(OTHER, 'client');
    await svc.appendMessage(OTHER, theirs.id, { role: 'user', content: 'keep me' });

    await svc.deleteSession(CALLER, s.id);

    const mine = prisma._state.messages.filter((m) => m.user_id === CALLER.id);
    expect(mine).toHaveLength(0);
    expect(JSON.stringify(prisma._state.sessions)).not.toContain('private context');
    expect(JSON.stringify(prisma._state.messages)).not.toContain('knee');
    // Tenancy: another user's conversation is untouched.
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['keep me']);
    // The erase is scoped to the caller's own session AND user_id.
    expect(prisma.romanMessage.deleteMany).toHaveBeenCalledWith({
      where: { session_id: s.id, user_id: CALLER.id },
    });
  });

  it('a non-owner cannot delete (404) and nothing is erased', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'mine' });
    await expect(svc.deleteSession(OTHER, s.id)).rejects.toMatchObject(SESSION_NOT_FOUND);
    expect(prisma._state.messages).toHaveLength(1);
    expect(prisma.romanMessage.deleteMany).not.toHaveBeenCalled();
  });

  it('a second delete of the same session is a no-op 204 (C-635-2: idempotent, nothing rewritten)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'q' });
    await svc.deleteSession(CALLER, s.id);
    const shell = { ...prisma._state.sessions[0] };
    const writes = prisma.romanSession.updateMany.mock.calls.length;
    await expect(svc.deleteSession(CALLER, s.id)).resolves.toBeUndefined();
    expect(prisma._state.sessions[0]).toEqual(shell);
    expect(prisma.romanSession.updateMany.mock.calls.length).toBe(writes);
  });

  it('a turn arriving after the delete (e.g. a streamed reply finishing) is refused and never stored', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'question' });
    await svc.deleteSession(CALLER, s.id);
    await expect(
      svc.appendMessage(CALLER, s.id, { role: 'roman', content: 'late reply' }),
    ).rejects.toMatchObject(SESSION_NOT_FOUND);
    expect(prisma._state.messages).toHaveLength(0);
    expect(prisma.romanMessage.create).toHaveBeenCalledTimes(1);
  });

  it('deleting a chat never resets the daily Roman cap', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    for (let i = 0; i < ROMAN_RATE_LIMIT_FREE_PER_DAY; i++) {
      await svc.appendMessage(CALLER, s.id, { role: 'user', content: `t${i}` });
    }
    await svc.deleteSession(CALLER, s.id);
    expect(prisma._state.messages).toHaveLength(0);
    // The shell keeps only a content-free count of the erased in-window turns.
    expect(prisma._state.sessions[0].message_count).toBe(ROMAN_RATE_LIMIT_FREE_PER_DAY);
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
    const err = await svc
      .assertWithinRateLimit(CALLER)
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    const retry = ((err as HttpException).getResponse() as { retryAfterSeconds: number })
      .retryAfterSeconds;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('erased turns stop counting once the erased session is outside the window', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    for (let i = 0; i < ROMAN_RATE_LIMIT_FREE_PER_DAY; i++) {
      await svc.appendMessage(CALLER, s.id, { role: 'user', content: `t${i}` });
    }
    await svc.deleteSession(CALLER, s.id);
    prisma._state.sessions[0].last_activity_at = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await expect(svc.assertWithinRateLimit(CALLER)).resolves.toBeUndefined();
  });
});

// Sol B-635-1 (REQUEST CHANGES @ 0a32b4fe): the unique key
// (user_id, surface, day_key) covers deleted rows too, so the tombstone used to
// block a fresh session until UTC midnight (P2002). The fake above enforces
// that key like Postgres; test/roman/roman-session-erase.live.spec.ts proves
// the same sequences on a real database.
describe('RomanService — same-day fresh session after a delete (B-635-1)', () => {
  const OTHER: RomanCaller = { id: 'u_b', role: 'student', tier: 'free' };

  it('the fake enforces the real unique key across deleted rows (negative control)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    // A tombstone that still held the day key would make this create fail.
    prisma._state.sessions[0].deleted_at = new Date();
    await expect(
      prisma.romanSession.create({
        data: { user_id: CALLER.id, surface: 'client', day_key: s.day_key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('open -> append -> delete -> open gives a fresh, empty session that takes turns', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client', { brief: 'old context' });
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'first chat' });
    await svc.deleteSession(CALLER, s.id);

    const tomb = prisma._state.sessions.find((r) => r.id === s.id)!;
    expect(tomb.day_key).toBe(erasedDayKey(s.id));
    expect(tomb.subject_context_json).toBeNull();

    const next = await svc.openOrResumeSession(CALLER, 'client');
    expect(next.id).not.toBe(s.id);
    expect(next.day_key).toBe(dayKeyUtc());
    expect(next.deleted_at).toBeNull();
    expect(next.subject_context_json).toBeNull();
    expect(await svc.listMessages(CALLER, next.id, {})).toMatchObject({ messages: [] });
    await svc.appendMessage(CALLER, next.id, { role: 'user', content: 'second chat' });
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['second chat']);
    // Resume still works on the fresh session.
    expect((await svc.openOrResumeSession(CALLER, 'client')).id).toBe(next.id);
  });

  it('the old deleted session stays deleted: a late append to it is refused (404)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.deleteSession(CALLER, s.id);
    const next = await svc.openOrResumeSession(CALLER, 'client');
    await expect(
      svc.appendMessage(CALLER, s.id, { role: 'roman', content: 'late reply' }),
    ).rejects.toMatchObject(SESSION_NOT_FOUND);
    await expect(svc.getOwnedSession(CALLER, s.id)).rejects.toMatchObject(SESSION_NOT_FOUND);
    expect(prisma._state.messages).toHaveLength(0);
    expect((await svc.openOrResumeSession(CALLER, 'client')).id).toBe(next.id);
  });

  it('concurrent opens after a delete converge on ONE fresh session', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.deleteSession(CALLER, s.id);
    const opened = await Promise.all([
      svc.openOrResumeSession(CALLER, 'client'),
      svc.openOrResumeSession(CALLER, 'client'),
      svc.openOrResumeSession(CALLER, 'client'),
    ]);
    expect(new Set(opened.map((o) => o.id)).size).toBe(1);
    expect(opened[0].id).not.toBe(s.id);
    const live = prisma._state.sessions.filter((r) => r.deleted_at === null);
    expect(live).toHaveLength(1);
  });

  it('delete + reopen (three chats in one day) never resets the daily cap', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const perChat = Math.ceil(ROMAN_RATE_LIMIT_FREE_PER_DAY / 3);
    for (let chat = 0; chat < 3; chat++) {
      const s = await svc.openOrResumeSession(CALLER, 'client');
      for (let i = 0; i < perChat; i++) {
        await svc.appendMessage(CALLER, s.id, { role: 'user', content: `c${chat}t${i}` });
      }
      await svc.deleteSession(CALLER, s.id);
    }
    const fresh = await svc.openOrResumeSession(CALLER, 'client');
    expect(prisma._state.messages).toHaveLength(0);
    expect(fresh.message_count).toBe(0);
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
  });

  it("another user's same-day session is untouched by my delete and reopen", async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const theirs = await svc.openOrResumeSession(OTHER, 'client');
    await svc.appendMessage(OTHER, theirs.id, { role: 'user', content: 'theirs' });
    const mine = await svc.openOrResumeSession(CALLER, 'client');
    await svc.deleteSession(CALLER, mine.id);
    await svc.openOrResumeSession(CALLER, 'client');
    expect(prisma._state.sessions.find((r) => r.id === theirs.id)).toMatchObject({
      day_key: dayKeyUtc(),
      deleted_at: null,
    });
    expect((await svc.openOrResumeSession(OTHER, 'client')).id).toBe(theirs.id);
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['theirs']);
  });
});

// Sol C-635-1: rows soft-deleted before #635 (or by an old machine during a
// rolling deploy) kept their transcript and subject context under a tombstone
// that still holds a calendar day_key.
describe('RomanService — pre-upgrade soft-deleted sessions are erased (C-635-1)', () => {
  const OTHER: RomanCaller = { id: 'u_b', role: 'student', tier: 'free' };

  function seedLegacyTombstone(
    prisma: ReturnType<typeof makeFakePrisma>,
    userId: string,
    dayKey: string,
    turns: { user: number; roman: number },
  ): string {
    const sid = `legacy_${userId}_${dayKey}`;
    const now = new Date();
    prisma._state.sessions.push({
      id: sid,
      user_id: userId,
      surface: 'client',
      day_key: dayKey,
      message_count: turns.user + turns.roman,
      started_at: now,
      last_activity_at: now,
      quips_in_session: 0,
      exclamation_used: false,
      subject_context_json: { brief: 'legacy private context' },
      created_at: now,
      updated_at: now,
      deleted_at: now,
    });
    let n = 0;
    const push = (role: 'user' | 'roman', content: string) =>
      prisma._state.messages.push({
        id: `${sid}_m${++n}`,
        session_id: sid,
        user_id: userId,
        role,
        content,
        prompt_tokens: null,
        completion_tokens: null,
        model_id: null,
        interrupted: false,
        parent_message_id: null,
        created_at: now,
      });
    for (let i = 0; i < turns.user; i++) push('user', `legacy question ${i}`);
    for (let i = 0; i < turns.roman; i++) push('roman', `legacy reply ${i}`);
    return sid;
  }

  it("open erases a legacy tombstone holding today's key, then opens a fresh session", async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const legacy = seedLegacyTombstone(prisma, CALLER.id, dayKeyUtc(), { user: 2, roman: 1 });

    const s = await svc.openOrResumeSession(CALLER, 'client');
    expect(s.id).not.toBe(legacy);
    expect(s.day_key).toBe(dayKeyUtc());
    const tomb = prisma._state.sessions.find((r) => r.id === legacy)!;
    expect(tomb).toMatchObject({
      day_key: erasedDayKey(legacy),
      subject_context_json: null,
      message_count: 2,
    });
    expect(tomb.deleted_at).toBeInstanceOf(Date);
    expect(JSON.stringify(prisma._state)).not.toContain('legacy question');
    expect(JSON.stringify(prisma._state)).not.toContain('legacy reply');
    expect(JSON.stringify(prisma._state)).not.toContain('legacy private context');
    expect(prisma._state.messages).toHaveLength(0);
  });

  it('the legacy erase keeps the cap: 50 legacy turns today still block a new turn', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedLegacyTombstone(prisma, CALLER.id, dayKeyUtc(), {
      user: ROMAN_RATE_LIMIT_FREE_PER_DAY,
      roman: 3,
    });
    await svc.openOrResumeSession(CALLER, 'client');
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
  });

  it('an unerased legacy tombstone is counted once (its messages), not twice', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    // Old code stored the total turn count (user + roman) in message_count.
    seedLegacyTombstone(prisma, CALLER.id, '2000-01-01', { user: 30, roman: 30 });
    prisma._state.sessions[0].day_key = 'legacy-yesterday';
    await expect(svc.assertWithinRateLimit(CALLER)).resolves.toBeUndefined();
  });

  it('the sweep erases every legacy tombstone, is idempotent, and leaves live chats and erased shells alone', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const a = seedLegacyTombstone(prisma, CALLER.id, '2026-09-28', { user: 1, roman: 1 });
    const b = seedLegacyTombstone(prisma, CALLER.id, '2026-09-29', { user: 2, roman: 2 });
    const c = seedLegacyTombstone(prisma, OTHER.id, '2026-09-29', { user: 1, roman: 0 });
    const live = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, live.id, { role: 'user', content: 'keep this live chat' });
    const gone = await svc.openOrResumeSession(OTHER, 'coach');
    await svc.deleteSession(OTHER, gone.id);
    const shellBefore = { ...prisma._state.sessions.find((r) => r.id === gone.id)! };

    await expect(svc.eraseUnerasedDeletedSessions({ batch: 2 })).resolves.toBe(3);
    for (const sid of [a, b, c]) {
      expect(prisma._state.sessions.find((r) => r.id === sid)).toMatchObject({
        day_key: erasedDayKey(sid),
        subject_context_json: null,
      });
    }
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['keep this live chat']);
    expect(prisma._state.sessions.find((r) => r.id === live.id)).toMatchObject({
      deleted_at: null,
      day_key: dayKeyUtc(),
    });
    expect(prisma._state.sessions.find((r) => r.id === gone.id)).toEqual(shellBefore);
    await expect(svc.eraseUnerasedDeletedSessions()).resolves.toBe(0);
  });

  it('a row that fails to erase is logged and skipped; the rest still erase', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const bad = seedLegacyTombstone(prisma, CALLER.id, '2026-09-27', { user: 1, roman: 0 });
    const ok = seedLegacyTombstone(prisma, CALLER.id, '2026-09-28', { user: 1, roman: 0 });
    const real = prisma.romanMessage.count.getMockImplementation()!;
    prisma.romanMessage.count.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.session_id === bad) throw new Error('db hiccup');
      return real(args);
    });
    await expect(svc.eraseUnerasedDeletedSessions({ batch: 1 })).resolves.toBe(1);
    expect(prisma._state.sessions.find((r) => r.id === ok)!.day_key).toBe(erasedDayKey(ok));
  });
});

// ─── B-635-2 / C-635-2 / C-635-3 / B-635-3 (fix round 2) ───────────────────

/** Seed a session row directly (any day, either surface, live or deleted). */
function seedSession(
  prisma: ReturnType<typeof makeFakePrisma>,
  opts: {
    id: string;
    userId: string;
    surface?: 'client' | 'coach';
    dayKey: string;
    startedAt: Date;
    deletedAt?: Date | null;
    userTurns?: string[];
    romanTurns?: string[];
    context?: unknown;
  },
): string {
  const at = opts.startedAt;
  prisma._state.sessions.push({
    id: opts.id,
    user_id: opts.userId,
    surface: opts.surface ?? 'client',
    day_key: opts.dayKey,
    message_count: (opts.userTurns?.length ?? 0) + (opts.romanTurns?.length ?? 0),
    started_at: at,
    last_activity_at: at,
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: opts.context ?? null,
    created_at: at,
    updated_at: at,
    deleted_at: opts.deletedAt ?? null,
  });
  let n = 0;
  const push = (role: 'user' | 'roman', content: string) =>
    prisma._state.messages.push({
      id: `${opts.id}_m${++n}`,
      session_id: opts.id,
      user_id: opts.userId,
      role,
      content,
      prompt_tokens: null,
      completion_tokens: null,
      model_id: null,
      interrupted: false,
      parent_message_id: null,
      // Recent, so the erased user turns stay inside the cap window.
      created_at: new Date(),
    });
  for (const c of opts.userTurns ?? []) push('user', c);
  for (const c of opts.romanTurns ?? []) push('roman', c);
  return opts.id;
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);

describe('RomanService — the client can find and delete ANY chat, not only today\'s (B-635-2)', () => {
  const OTHER: RomanCaller = { id: 'u_b', role: 'student', tier: 'free' };

  function seedHistory(prisma: ReturnType<typeof makeFakePrisma>) {
    const old = seedSession(prisma, {
      id: 's_old',
      userId: CALLER.id,
      dayKey: '2026-09-20',
      startedAt: daysAgo(12),
      userTurns: ['old question about my knee'],
      romanTurns: ['old reply'],
      context: { brief: 'old private context' },
    });
    const yesterday = seedSession(prisma, {
      id: 's_yday',
      userId: CALLER.id,
      dayKey: '2026-10-01',
      startedAt: daysAgo(1),
      userTurns: ['yesterday question'],
    });
    const coachSurface = seedSession(prisma, {
      id: 's_coach',
      userId: CALLER.id,
      surface: 'coach',
      dayKey: '2026-09-30',
      startedAt: daysAgo(2),
      userTurns: ['coach-surface question'],
    });
    const theirs = seedSession(prisma, {
      id: 's_theirs',
      userId: OTHER.id,
      dayKey: '2026-10-01',
      startedAt: daysAgo(1),
      userTurns: ['another client keeps this'],
    });
    return { old, yesterday, coachSurface, theirs };
  }

  it('listSessions returns only the caller\'s live chats, newest first, across days and surfaces', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);
    const today = await svc.openOrResumeSession(CALLER, 'client');
    const gone = seedSession(prisma, {
      id: 's_gone',
      userId: CALLER.id,
      dayKey: 'erased:s_gone',
      startedAt: daysAgo(3),
      deletedAt: daysAgo(3),
    });

    const page = await svc.listSessions(CALLER, {});
    expect(page.sessions.map((s) => s.id)).toEqual([today.id, h.yesterday, h.coachSurface, h.old]);
    expect(page.sessions.map((s) => s.id)).not.toContain(h.theirs);
    expect(page.sessions.map((s) => s.id)).not.toContain(gone);
    expect(page.nextCursor).toBeNull();

    const clientOnly = await svc.listSessions(CALLER, { surface: 'client' });
    expect(clientOnly.sessions.map((s) => s.id)).toEqual([today.id, h.yesterday, h.old]);
  });

  it('listSessions pages with the caller\'s own cursor, and a chat deleted between pages does not break it', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);

    const first = await svc.listSessions(CALLER, { limit: 2 });
    expect(first.sessions.map((s) => s.id)).toEqual([h.yesterday, h.coachSurface]);
    expect(first.nextCursor).toBe(h.coachSurface);

    // The anchor chat is deleted before the next page is asked for.
    await svc.deleteSession(CALLER, h.coachSurface);
    const second = await svc.listSessions(CALLER, { limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((s) => s.id)).toEqual([h.old]);
    expect(second.nextCursor).toBeNull();
  });

  it('listSessions refuses a cursor that is not one of the caller\'s sessions (400, no foreign lookup leak)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);
    for (const cursor of [h.theirs, 'no-such-session']) {
      await expect(svc.listSessions(CALLER, { cursor })).rejects.toMatchObject({
        status: 400,
        response: { code: 'ROMAN_CURSOR_INVALID' },
      });
    }
  });

  it('listSessions returns metadata only and clamps the page size', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedHistory(prisma);
    const page = await svc.listSessions(CALLER, { limit: 1 });
    expect(page.sessions).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('question');
    expect((await svc.listSessions(CALLER, { limit: 0 })).sessions).toHaveLength(1);
  });

  it('deleteSession erases a PRIOR-DAY chat found through the list (messages, context, day key)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);
    const listed = (await svc.listSessions(CALLER, {})).sessions.find((s) => s.id === h.old)!;

    await svc.deleteSession(CALLER, listed.id);

    const row = prisma._state.sessions.find((r) => r.id === h.old)!;
    expect(row).toMatchObject({ day_key: erasedDayKey(h.old), subject_context_json: null });
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(prisma._state.messages.some((m) => m.session_id === h.old)).toBe(false);
    expect(JSON.stringify(prisma._state)).not.toContain('old question about my knee');
    expect(JSON.stringify(prisma._state)).not.toContain('old private context');
    expect((await svc.listSessions(CALLER, {})).sessions.map((s) => s.id)).not.toContain(h.old);
  });

  it('deleteAllSessions erases every chat of the caller (prior days, today, both surfaces) and nobody else\'s', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);
    const today = await svc.openOrResumeSession(CALLER, 'client', { brief: 'today context' });
    await svc.appendMessage(CALLER, today.id, { role: 'user', content: 'today question' });

    await expect(svc.deleteAllSessions(CALLER)).resolves.toBe(4);

    for (const sid of [h.old, h.yesterday, h.coachSurface, today.id]) {
      const row = prisma._state.sessions.find((r) => r.id === sid)!;
      expect(row).toMatchObject({ day_key: erasedDayKey(sid), subject_context_json: null });
      expect(row.deleted_at).toBeInstanceOf(Date);
    }
    const mine = prisma._state.messages.filter((m) => m.user_id === CALLER.id);
    expect(mine).toHaveLength(0);
    // Tenancy: the other client's chat is untouched.
    expect(prisma._state.sessions.find((r) => r.id === h.theirs)).toMatchObject({
      deleted_at: null,
      day_key: '2026-10-01',
    });
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['another client keeps this']);
    expect((await svc.listSessions(CALLER, {})).sessions).toHaveLength(0);
    // Every write was scoped to the caller.
    for (const [args] of prisma.romanSession.updateMany.mock.calls) {
      expect(args.where.user_id).toBe(CALLER.id);
    }
  });

  it('deleteAllSessions also erases the caller\'s own pre-#635 tombstones that still hold content', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedSession(prisma, {
      id: 's_legacy',
      userId: CALLER.id,
      dayKey: '2026-09-25',
      startedAt: daysAgo(7),
      deletedAt: daysAgo(6),
      userTurns: ['legacy question'],
      context: { brief: 'legacy context' },
    });
    await expect(svc.deleteAllSessions(CALLER)).resolves.toBe(1);
    expect(prisma._state.sessions[0].day_key).toBe(erasedDayKey('s_legacy'));
    expect(JSON.stringify(prisma._state)).not.toContain('legacy question');
    expect(JSON.stringify(prisma._state)).not.toContain('legacy context');
    expect(prisma._state.messages).toHaveLength(0);
  });

  it('deleteAllSessions is idempotent: with nothing left it resolves 0 and writes nothing', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedHistory(prisma);
    await svc.deleteAllSessions(CALLER);
    const writes = prisma.romanSession.updateMany.mock.calls.length;
    await expect(svc.deleteAllSessions(CALLER)).resolves.toBe(0);
    await expect(svc.deleteAllSessions({ id: 'u_nobody', role: 'student' })).resolves.toBe(0);
    expect(prisma.romanSession.updateMany.mock.calls.length).toBe(writes);
  });

  it('deleteAllSessions never resets the daily cap', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedSession(prisma, {
      id: 's_busy_yday',
      userId: CALLER.id,
      dayKey: '2026-10-01',
      startedAt: new Date(Date.now() - 60_000),
      userTurns: Array.from({ length: ROMAN_RATE_LIMIT_FREE_PER_DAY - 1 }, (_, i) => `y${i}`),
    });
    const today = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, today.id, { role: 'user', content: 'one more' });
    await svc.deleteAllSessions(CALLER);
    expect(prisma._state.messages).toHaveLength(0);
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
  });

  it('a failure part-way is a coded 503; chats already erased stay erased, the rest stay untouched, a retry finishes', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const h = seedHistory(prisma);
    prisma._tx.rollback = true;
    const canary = 'PRIVATE_ORM_ARGS_CANARY';
    const realDelete = prisma.romanMessage.deleteMany.getMockImplementation()!;
    prisma.romanMessage.deleteMany.mockImplementationOnce(realDelete).mockImplementationOnce(() => {
      throw new Prisma.PrismaClientKnownRequestError(`Timed out ${canary}`, {
        code: 'P2024',
        clientVersion: 'test',
      });
    });
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(svc.deleteAllSessions(CALLER)).rejects.toMatchObject({
        status: 503,
        response: { code: 'ROMAN_ERASE_INCOMPLETE' },
      });
      expect(JSON.stringify(errors.mock.calls)).not.toContain(canary);
      expect(JSON.stringify(errors.mock.calls)).toContain('P2024');
    } finally {
      errors.mockRestore();
    }
    // Ids sort s_coach < s_old < s_yday: the first was erased, the second
    // failed and rolled back (still live, content intact), the third untouched.
    expect(prisma._state.sessions.find((r) => r.id === h.coachSurface)!.day_key).toBe(
      erasedDayKey(h.coachSurface),
    );
    expect(prisma._state.sessions.find((r) => r.id === h.old)).toMatchObject({
      deleted_at: null,
      day_key: '2026-09-20',
    });
    expect(prisma._state.messages.some((m) => m.session_id === h.old)).toBe(true);
    expect(prisma._state.messages.some((m) => m.session_id === h.yesterday)).toBe(true);

    await expect(svc.deleteAllSessions(CALLER)).resolves.toBeGreaterThanOrEqual(1);
    expect(prisma._state.messages.filter((m) => m.user_id === CALLER.id)).toHaveLength(0);
  });

  it('when the per-request bound is hit with chats left, it is a coded 503 and a retry finishes', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedHistory(prisma);
    await expect(svc.deleteAllSessions(CALLER, { batch: 1, maxBatches: 2 })).rejects.toMatchObject({
      status: 503,
      response: { code: 'ROMAN_ERASE_INCOMPLETE' },
    });
    expect(prisma._state.messages.filter((m) => m.user_id === CALLER.id)).toHaveLength(1);
    await expect(svc.deleteAllSessions(CALLER, { batch: 1, maxBatches: 2 })).resolves.toBe(1);
    expect(prisma._state.messages.filter((m) => m.user_id === CALLER.id)).toHaveLength(0);
  });
});

describe('RomanService — coded, idempotent session answers (C-635-2)', () => {
  it('deleting the caller\'s own pre-#635 tombstone by id erases it now (204)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedSession(prisma, {
      id: 's_legacy',
      userId: CALLER.id,
      dayKey: '2026-09-25',
      startedAt: daysAgo(7),
      deletedAt: daysAgo(6),
      userTurns: ['legacy question'],
    });
    await expect(svc.deleteSession(CALLER, 's_legacy')).resolves.toBeUndefined();
    expect(prisma._state.sessions[0].day_key).toBe(erasedDayKey('s_legacy'));
    expect(prisma._state.messages).toHaveLength(0);
  });

  it('an unknown id and another user\'s id get the same coded 404', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const theirs = await svc.openOrResumeSession({ id: 'u_b', role: 'student' }, 'client');
    for (const id of [theirs.id, 'no-such-session']) {
      await expect(svc.deleteSession(CALLER, id)).rejects.toMatchObject(SESSION_NOT_FOUND);
      await expect(svc.listMessages(CALLER, id, {})).rejects.toMatchObject(SESSION_NOT_FOUND);
      await expect(
        svc.appendMessage(CALLER, id, { role: 'user', content: 'x' }),
      ).rejects.toMatchObject(SESSION_NOT_FOUND);
    }
  });

  it('a delete that loses a race to a concurrent change re-reads once and finishes', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'q' });
    // An old machine soft-deletes the row (pre-#635 behaviour) between this
    // request's read and its erase.
    const realFindFirst = prisma.romanSession.findFirst.getMockImplementation()!;
    prisma.romanSession.findFirst.mockImplementationOnce(async (args) => {
      const row = await realFindFirst(args);
      prisma._state.sessions[0].deleted_at = new Date();
      return row ? { ...row, deleted_at: null } : row;
    });
    await expect(svc.deleteSession(CALLER, s.id)).resolves.toBeUndefined();
    expect(prisma._state.sessions[0].day_key).toBe(erasedDayKey(s.id));
    expect(prisma._state.messages).toHaveLength(0);
  });
});

describe('RomanService — the erase is verified, never assumed (C-635-3)', () => {
  // Under a role that row-level security stops from deleting (RomanMessage has
  // no DELETE policy for non-service roles), DELETE removes zero rows without
  // an error. This double does exactly that.
  function deleteRemovesNothing(prisma: ReturnType<typeof makeFakePrisma>) {
    prisma.romanMessage.deleteMany.mockImplementation(async () => ({ count: 0 }));
  }

  it('a delete whose message delete removed nothing is a coded 503, not a silent 204', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'still here' });
    prisma._tx.rollback = true;
    deleteRemovesNothing(prisma);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(svc.deleteSession(CALLER, s.id)).rejects.toMatchObject({
        status: 503,
        response: {
          code: 'ROMAN_ERASE_INCOMPLETE',
          message:
            'Roman could not finish deleting this conversation, so it was not changed. Try deleting it again in a moment.',
        },
      });
    } finally {
      errors.mockRestore();
    }
    // Rolled back: the chat is still live and whole, so the client is never
    // told it is gone while it is not.
    expect(prisma._state.sessions[0]).toMatchObject({ deleted_at: null, day_key: dayKeyUtc() });
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['still here']);
  });

  it('an open whose legacy day-key holder cannot be erased answers ROMAN_UNAVAILABLE, not a delete message', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedSession(prisma, {
      id: 's_legacy_today',
      userId: CALLER.id,
      dayKey: dayKeyUtc(),
      startedAt: new Date(),
      deletedAt: new Date(),
      userTurns: ['legacy today'],
    });
    prisma._tx.rollback = true;
    deleteRemovesNothing(prisma);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(svc.openOrResumeSession(CALLER, 'client')).rejects.toMatchObject({
        status: 503,
        response: { code: 'ROMAN_UNAVAILABLE' },
      });
    } finally {
      errors.mockRestore();
    }
    expect(prisma._state.messages.map((m) => m.content)).toEqual(['legacy today']);
  });

  it('delete-all and the sweep treat it the same way (never counted as erased)', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    seedSession(prisma, {
      id: 's_live',
      userId: CALLER.id,
      dayKey: '2026-10-01',
      startedAt: daysAgo(1),
      userTurns: ['q'],
    });
    seedSession(prisma, {
      id: 's_legacy',
      userId: CALLER.id,
      dayKey: '2026-09-25',
      startedAt: daysAgo(7),
      deletedAt: daysAgo(6),
      userTurns: ['legacy'],
    });
    prisma._tx.rollback = true;
    deleteRemovesNothing(prisma);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(svc.deleteAllSessions(CALLER)).rejects.toMatchObject({
        response: { code: 'ROMAN_ERASE_INCOMPLETE' },
      });
      const run = await svc.runUnerasedErasure();
      expect(run.erased).toBe(0);
      expect(run.failed).toBe(1);
      await expect(svc.countUnerasedDeletedSessions()).resolves.toBe(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('RomanService — erasure failures are sanitized and reported (B-635-3)', () => {
  const canary = 'AUDIT_PRIVATE_ORM_QUERY_CANARY';

  it('a failed row is counted, its sanitized diagnostic returned, healthy rows still erase, no raw ORM text is logged', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const bad = seedSession(prisma, {
      id: 's_a_bad',
      userId: CALLER.id,
      dayKey: '2026-09-24',
      startedAt: daysAgo(8),
      deletedAt: daysAgo(8),
      userTurns: ['bad'],
    });
    const ok = seedSession(prisma, {
      id: 's_b_ok',
      userId: CALLER.id,
      dayKey: '2026-09-25',
      startedAt: daysAgo(7),
      deletedAt: daysAgo(7),
      userTurns: ['ok'],
    });
    prisma._tx.rollback = true;
    const realCount = prisma.romanMessage.count.getMockImplementation()!;
    prisma.romanMessage.count.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.session_id === bad) {
        throw new Prisma.PrismaClientKnownRequestError(`Database query failed ${canary}`, {
          code: 'P2024',
          clientVersion: 'test',
        });
      }
      return realCount(args);
    });
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const run = await svc.runUnerasedErasure();
      expect(run).toEqual({
        erased: 1,
        failed: 1,
        firstFailure: 'DatabaseRequestError: Database request failed (P2024)',
        boundHit: false,
      });
      expect(errors).toHaveBeenCalled();
      expect(JSON.stringify(errors.mock.calls)).not.toContain(canary);
    } finally {
      errors.mockRestore();
    }
    expect(prisma._state.sessions.find((r) => r.id === ok)!.day_key).toBe(erasedDayKey(ok));
    await expect(svc.countUnerasedDeletedSessions()).resolves.toBe(1);
  });

  it('reports boundHit when the run stops at its batch bound with rows still waiting', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    for (let i = 0; i < 3; i++) {
      seedSession(prisma, {
        id: `s_l${i}`,
        userId: CALLER.id,
        dayKey: `2026-09-2${i}`,
        startedAt: daysAgo(10 + i),
        deletedAt: daysAgo(10),
        userTurns: ['x'],
      });
    }
    const run = await svc.runUnerasedErasure({ batch: 1, maxBatches: 2 });
    expect(run).toMatchObject({ erased: 2, failed: 0, boundHit: true });
    await expect(svc.countUnerasedDeletedSessions()).resolves.toBe(1);
    await expect(svc.eraseUnerasedDeletedSessions()).resolves.toBe(1);
    await expect(svc.countUnerasedDeletedSessions()).resolves.toBe(0);
  });
});

describe('RomanService — messages', () => {
  it('appends a turn and bumps message_count + last_activity_at', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'Hello' });
    expect(prisma._state.sessions[0].message_count).toBe(1);
    expect(prisma._state.messages).toHaveLength(1);
    expect(prisma._state.messages[0].role).toBe('user');
  });

  it('paginates messages newest-first with a cursor', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
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
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
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
    const svc = new RomanService(asPrisma(makeFakePrisma()), grantAllEgress());
    expect(svc.rateLimitCapFor({ id: 'x', role: 'student', tier: 'free' })).toBe(
      ROMAN_RATE_LIMIT_FREE_PER_DAY,
    );
    expect(svc.rateLimitCapFor({ id: 'x', role: 'coach', tier: 'pro' })).toBe(
      ROMAN_RATE_LIMIT_PRO_PER_DAY,
    );
  });

  it('throws a structured 429 once the cap is exhausted', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    for (let i = 0; i < ROMAN_RATE_LIMIT_FREE_PER_DAY; i++) {
      await svc.appendMessage(CALLER, s.id, { role: 'user', content: `t${i}` });
    }
    await expect(svc.assertWithinRateLimit(CALLER)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
    // Must be HTTP 429 Too Many Requests — not 403 — so clients honour retry
    // semantics (brief §3).
    const err = await svc
      .assertWithinRateLimit(CALLER)
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('exempts the owner from the rate limit', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
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
    const svc = new RomanService(asPrisma(prisma), grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(fake)));
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
    const svc = new RomanService(asPrisma(prisma), grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(fake)));
    const s = await svc.openOrResumeSession(CALLER, 'client');

    const abort = new AbortController();
    let interrupted: boolean | undefined;
    let count = 0;
    // R4: `streamAssistantTurn` buffers the whole reply (one delta after the
    // stream ends), so "abort after the first delta" is exercised on the raw
    // model stream, which is where the disconnect handling lives.
    for await (const c of svc.streamModelTurn(CALLER, s, {
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
    const svc = new RomanService(asPrisma(prisma), grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(fake)));
    const s = await svc.openOrResumeSession(CALLER, 'client');
    const gen = svc.streamAssistantTurn(CALLER, s);
    await expect(gen.next()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('surfaces ROMAN_UNAVAILABLE when no Anthropic client is configured', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress(), null);
    const s = await svc.openOrResumeSession(CALLER, 'client');
    const gen = svc.streamAssistantTurn(CALLER, s);
    await expect(gen.next()).rejects.toMatchObject({
      response: { code: 'ROMAN_UNAVAILABLE' },
    });
  });
});
