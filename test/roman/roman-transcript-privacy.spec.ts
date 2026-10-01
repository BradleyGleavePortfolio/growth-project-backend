// test/roman/roman-transcript-privacy.spec.ts
//
// Owner ruling 2026-09-30 17:42 PDT — Roman transcripts are stored server-side,
// visible ONLY to the client who wrote them (and to developers with direct DB
// access). No coach, sub-coach, admin or owner API surface returns transcript
// content. Retention: 180 days then auto-delete; the client can delete any time.
//
// Proves:
//   1. Coach-, sub-coach- and platform-owner-scoped callers cannot read, append
//      to, or delete another user's Roman session through RomanService (the
//      only reader), and every transcript query is pinned to user_id = caller.
//   2. No module outside src/roman touches the Roman transcript tables, and
//      inside src/roman only roman.service.ts queries them (static scan).
//   3. The RLS SELECT policies on both tables reference no coach_id / team
//      relationship — owner-self (plus platform-owner DB role) only.
//   4. RomanRetentionService hard-deletes sessions idle for 180+ days and
//      purges client-deleted sessions, leaving live ones untouched.

import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import {
  ROMAN_TRANSCRIPT_RETENTION_DAYS,
  RomanRetentionService,
} from '../../src/roman/roman-retention.service';
import type { PrismaService } from '../../src/prisma.service';

// ─── typed escape hatch (R0-sanctioned form) ─────────────────────────────────
function asPrismaDouble<T extends object>(mock: T): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — only the romanSession/romanMessage delegates under test are stubbed.
  return mock;
}

const STUDENT: RomanCaller = { id: 'u_student', role: 'student' };
const HEAD_COACH: RomanCaller = { id: 'u_head_coach', role: 'coach' };
const SUB_COACH: RomanCaller = { id: 'u_sub_coach', role: 'coach' }; // assigned via TeamSubCoachAssignment
const PLATFORM_OWNER: RomanCaller = { id: 'u_owner', role: 'owner' };

type Row = Record<string, unknown>;

function makePrisma() {
  const sessions: Row[] = [
    {
      id: 'sess_student',
      user_id: STUDENT.id,
      surface: 'client',
      day_key: '2026-09-30',
      deleted_at: null,
      coach_id: HEAD_COACH.id, // not a real column; present to prove the filter ignores it
    },
  ];
  const messages: Row[] = [
    { id: 'm1', session_id: 'sess_student', user_id: STUDENT.id, role: 'user', content: 'TRANSCRIPT-CANARY my knee hurts', created_at: new Date() },
  ];
  const wheres: Array<{ table: string; where: Row }> = [];
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) =>
      v === null ? row[k] === null || row[k] === undefined : row[k] === v,
    );
  const prisma = {
    romanSession: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        wheres.push({ table: 'romanSession', where });
        return sessions.find((s) => match(s, where)) ?? null;
      }),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    romanMessage: {
      findMany: jest.fn(async ({ where }: { where: Row }) => {
        wheres.push({ table: 'romanMessage', where });
        return messages.filter((m) => match(m, where));
      }),
    },
  };
  return { prisma, wheres, messages };
}

describe('Roman transcripts — owner-self only (ruling 17:42)', () => {
  it.each([
    ['head coach of the client', HEAD_COACH],
    ['sub-coach assigned to the client', SUB_COACH],
    ['platform owner via the API', PLATFORM_OWNER],
  ])('%s cannot read, list, or delete the client\u2019s session (404, no transcript rows)', async (_label, caller) => {
    const { prisma, wheres } = makePrisma();
    const svc = new RomanService(asPrismaDouble(prisma), null);
    await expect(svc.getOwnedSession(caller, 'sess_student')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.listMessages(caller, 'sess_student', {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.softDeleteSession(caller, 'sess_student')).rejects.toBeInstanceOf(NotFoundException);
    // every session lookup was pinned to the CALLER's id, never to a coach relationship
    expect(wheres.filter((w) => w.table === 'romanSession').length).toBeGreaterThan(0);
    for (const w of wheres.filter((w) => w.table === 'romanSession')) {
      expect(w.where).toMatchObject({ id: 'sess_student', user_id: caller.id, deleted_at: null });
      expect(Object.keys(w.where).sort()).toEqual(['deleted_at', 'id', 'user_id']);
    }
    // and no message row was ever fetched
    expect(wheres.filter((w) => w.table === 'romanMessage')).toHaveLength(0);
    expect(prisma.romanMessage.findMany).not.toHaveBeenCalled();
  });

  it('the client reads their own transcript', async () => {
    const { prisma } = makePrisma();
    const svc = new RomanService(asPrismaDouble(prisma), null);
    const page = await svc.listMessages(STUDENT, 'sess_student', {});
    expect(JSON.stringify(page)).toContain('TRANSCRIPT-CANARY');
  });
});

// ─── static scan: no other reader ────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('Roman transcripts — no coach/admin reader exists in the codebase', () => {
  const SRC = join(__dirname, '..', '..', 'src');
  const TRANSCRIPT_DELEGATES = /\bromanMessage\.(findMany|findFirst|findUnique|aggregate|groupBy|count)\b|\bromanSession\.(findMany|findFirst|findUnique)\b/;

  it('only src/roman/roman.service.ts queries RomanMessage / RomanSession', () => {
    const readers = walk(SRC).filter((f) => TRANSCRIPT_DELEGATES.test(readFileSync(f, 'utf8')));
    const rel = readers.map((f) => f.slice(SRC.length + 1).split('\\').join('/')).sort();
    expect(rel).toEqual(['roman/roman-retention.service.ts', 'roman/roman.service.ts']);
    // the retention service selects bookkeeping columns only — never content
    const retention = readFileSync(join(SRC, 'roman', 'roman-retention.service.ts'), 'utf8');
    expect(retention).not.toMatch(/romanMessage\.find/);
    expect(retention).toMatch(/select: \{ id: true, deleted_at: true, last_activity_at: true \}/);
  });

  it('no coach, team, admin or sub-coach module references the Roman transcript models at all', () => {
    const outside = walk(SRC).filter(
      (f) => !f.includes(`${join('src', 'roman')}`) && /RomanMessage|RomanSession|romanMessage|romanSession/.test(readFileSync(f, 'utf8')),
    );
    expect(outside.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('RomanController exposes only owner-self routes under /roman (no :userId / :clientId transcript route)', () => {
    const controller = readFileSync(join(SRC, 'roman', 'roman.controller.ts'), 'utf8');
    const routes = [...controller.matchAll(/@(Get|Post|Delete|Patch|Put)\(([^)]*)\)/g)].map((m) => m[2]);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r).not.toMatch(/userId|clientId|coach|admin/i);
  });

  it('RLS SELECT policies on both tables are owner-self only (no coach / team predicate)', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '20261216000000_add_roman_chat', 'migration.sql'),
      'utf8',
    );
    for (const name of ['p_romansession_select', 'p_romanmessage_select']) {
      const line = sql.split('\n').find((l) => l.startsWith(`CREATE POLICY "${name}"`));
      expect(line).toBeDefined();
      expect(line).toMatch(/"user_id" = app\.current_user_id\(\)/);
      expect(line).not.toMatch(/coach|team|sub_coach|is_coach_of/i);
    }
  });
});

// ─── retention ───────────────────────────────────────────────────────────────

describe('RomanRetentionService — 180-day auto-delete + client delete is real erasure', () => {
  const NOW = new Date('2026-09-30T04:11:00.000Z');
  const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  function makeRetentionPrisma(rows: Row[]) {
    const deleted: string[] = [];
    const prisma = {
      romanSession: {
        findMany: jest.fn(async ({ where, take }: { where: { OR: Row[] }; take: number }) => {
          const cutoff = (where.OR[0] as { last_activity_at: { lt: Date } }).last_activity_at.lt;
          return rows
            .filter((r) => !deleted.includes(r.id as string))
            .filter((r) => (r.last_activity_at as Date) < cutoff || r.deleted_at !== null)
            .slice(0, take)
            .map((r) => ({ id: r.id, deleted_at: r.deleted_at, last_activity_at: r.last_activity_at }));
        }),
        deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          deleted.push(...where.id.in);
          return { count: where.id.in.length };
        }),
      },
      romanMessage: {
        deleteMany: jest.fn(async ({ where }: { where: { created_at: { lt: Date } } }) => {
          const n = messageRows.filter((m) => m.created_at < where.created_at.lt).length;
          return { count: n };
        }),
      },
    };
    return { prisma, deleted };
  }
  const messageRows: Array<{ created_at: Date }> = [];

  it('deletes sessions idle ≥ 180 days and client-deleted sessions; keeps live ones', async () => {
    const rows: Row[] = [
      { id: 'live', last_activity_at: days(3), deleted_at: null },
      { id: 'edge_keep', last_activity_at: days(179), deleted_at: null },
      { id: 'expired', last_activity_at: days(181), deleted_at: null },
      { id: 'client_deleted', last_activity_at: days(1), deleted_at: days(0.5) },
    ];
    const { prisma, deleted } = makeRetentionPrisma(rows);
    const svc = new RomanRetentionService(asPrismaDouble(prisma));
    const r = await svc.run(NOW);
    expect(ROMAN_TRANSCRIPT_RETENTION_DAYS).toBe(180);
    expect(r.cutoff).toBe(days(180).toISOString());
    expect(deleted.sort()).toEqual(['client_deleted', 'expired']);
    expect(r).toMatchObject({ expired_sessions_deleted: 1, client_deleted_sessions_purged: 1 });
    // hard delete (messages cascade via FK), never a soft flag
    expect(prisma.romanSession.deleteMany).toHaveBeenCalledTimes(1);
    // message-level TTL sweep by created_at < cutoff (defence in depth)
    expect(prisma.romanMessage.deleteMany).toHaveBeenCalledWith({
      where: { created_at: { lt: days(180) } },
    });
  });

  it('sweeps message rows older than 180 days even when their session is live', async () => {
    messageRows.length = 0;
    messageRows.push({ created_at: days(200) }, { created_at: days(181) }, { created_at: days(10) });
    const { prisma } = makeRetentionPrisma([{ id: 'live', last_activity_at: days(1), deleted_at: null }]);
    const r = await new RomanRetentionService(asPrismaDouble(prisma)).run(NOW);
    expect(r.expired_messages_deleted).toBe(2);
    messageRows.length = 0;
  });

  it('is a no-op when nothing qualifies', async () => {
    const { prisma } = makeRetentionPrisma([{ id: 'live', last_activity_at: days(1), deleted_at: null }]);
    const r = await new RomanRetentionService(asPrismaDouble(prisma)).run(NOW);
    expect(r).toMatchObject({
      expired_sessions_deleted: 0,
      client_deleted_sessions_purged: 0,
      expired_messages_deleted: 0,
    });
    expect(prisma.romanSession.deleteMany).not.toHaveBeenCalled();
  });

  it('the tick never throws and never logs transcript content', async () => {
    const prisma = {
      romanSession: {
        findMany: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
    };
    const svc = new RomanRetentionService(asPrismaDouble(prisma));
    await expect(svc.tick()).resolves.toBeUndefined();
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'roman', 'roman-retention.service.ts'), 'utf8');
    expect(src).not.toMatch(/\.content\b|content:/);
  });
});

// ─── store review (2026-09-30): consent guard on the send route; coach notes never in any AI context ──

describe('Store review blockers — Roman send route guard and coach-note exclusion', () => {
  it('POST /roman/sessions/:id/messages carries AiProcessingConsentGuard at the route level (plus the in-handler assert)', () => {
    // Lazy requires keep the Nest decorators out of the other describe blocks.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RomanController } = require('../../src/roman/roman.controller');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AiProcessingConsentGuard } = require('../../src/roman/consent/ai-processing-consent.guard');
    const guards: unknown[] =
      Reflect.getMetadata('__guards__', RomanController.prototype.sendMessage) ?? [];
    expect(guards).toContain(AiProcessingConsentGuard);
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'roman', 'roman.controller.ts'), 'utf8');
    const handler = src.slice(src.indexOf('async sendMessage('), src.indexOf('getOwnedSession(caller, id)'));
    expect(handler).toMatch(/assertAiConsent\(caller\.id\)/);
  });

  it('no client-facing or AI context path reads CoachingSession.coach_notes_md', () => {
    const SRC = join(__dirname, '..', '..', 'src');
    const readers = walk(join(SRC, 'ai'))
      .concat(walk(join(SRC, 'roman')))
      .filter((f) => /coach_notes_md/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !/^(ai\/client-ai-context\.(service|types)\.ts)$/.test(rel));
    expect(readers).toEqual([]);
    // the two allowed mentions are the exclusion comments, never a Prisma select
    const ctx = readFileSync(join(SRC, 'ai', 'client-ai-context.service.ts'), 'utf8');
    expect(ctx).not.toMatch(/coach_notes_md: true/);
    expect(ctx).toMatch(/coach_note: null/);
  });
});
