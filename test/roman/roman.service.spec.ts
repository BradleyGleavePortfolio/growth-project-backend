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
  // { not }, { startsWith }, { gte }, { gt }, { notIn }, and NOT.
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
    if ('notIn' in c && Array.isArray(c.notIn) && c.notIn.includes(actual)) return false;
    return true;
  };
  const matchSession = (where: Record<string, unknown>, r: SessionRow): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') return !matchSession(v as Record<string, unknown>, r);
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
      findMany: jest.fn(
        async ({
          where,
          take,
        }: {
          where: Record<string, unknown>;
          take?: number;
        }) => {
          const rows = sessions
            .filter((r) => matchSession(where, r))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return typeof take === 'number' ? rows.slice(0, take) : rows;
        },
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

  it('getOwnedSession throws 404 for a session the caller does not own', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await expect(
      svc.getOwnedSession({ id: 'u_b', role: 'student' }, s.id),
    ).rejects.toThrow('Roman session not found');
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
    await expect(svc.deleteSession(OTHER, s.id)).rejects.toThrow('Roman session not found');
    expect(prisma._state.messages).toHaveLength(1);
    expect(prisma.romanMessage.deleteMany).not.toHaveBeenCalled();
  });

  it('a second delete of the same session is 404', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.deleteSession(CALLER, s.id);
    await expect(svc.deleteSession(CALLER, s.id)).rejects.toThrow('Roman session not found');
  });

  it('a turn arriving after the delete (e.g. a streamed reply finishing) is refused and never stored', async () => {
    const prisma = makeFakePrisma();
    const svc = new RomanService(asPrisma(prisma), grantAllEgress());
    const s = await svc.openOrResumeSession(CALLER, 'client');
    await svc.appendMessage(CALLER, s.id, { role: 'user', content: 'question' });
    await svc.deleteSession(CALLER, s.id);
    await expect(
      svc.appendMessage(CALLER, s.id, { role: 'roman', content: 'late reply' }),
    ).rejects.toThrow('Roman session not found');
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
    ).rejects.toThrow('Roman session not found');
    await expect(svc.getOwnedSession(CALLER, s.id)).rejects.toThrow('Roman session not found');
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
