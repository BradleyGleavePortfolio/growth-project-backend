/**
 * C-636-2 (plus operator scope addition 10-02 12:33 and the B-RECIPES
 * follow-up "export omits created recipes"): the archive must carry
 *   - the recipes the user created (full content, not only saved ids),
 *   - the user's Roman/AI chats that are not deleted (sessions + messages),
 *   - the AI-processing consent ledger (every grant and withdrawal),
 * and nothing that belongs to another person or to an erased chat.
 *
 * The real DataExportService._buildArchive runs against an in-memory store
 * that applies each `where`, `select` and `orderBy` the service sends, so a
 * missing owner filter, a missing deleted-chat exclusion or an unselected
 * internal column shows up in the parsed archive.
 */
import type { PrismaService } from '../src/prisma.service';
import { DataExportService } from '../src/data-export/data-export.service';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

/** Matches flat equality, `null`, and one level of relation filter (`session: {...}`). */
function matches(
  row: Row,
  where: Record<string, unknown>,
  related: (key: string, row: Row) => Row | undefined,
): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR' && Array.isArray(want)) {
      return want.some((w: Record<string, unknown>) => matches(row, w, related));
    }
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const parent = related(key, row);
      return parent !== undefined && matches(parent, stub<Record<string, unknown>>(want), related);
    }
    return row[key] === want;
  });
}

const U = 'user-1';
const OTHER = 'user-2';
const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n));

function store() {
  const tables: Record<string, Row[]> = {
    recipe: [
      {
        id: 'r2',
        title: 'Overnight oats',
        created_by_id: U,
        ingredients: ['oats'],
        instructions: ['soak'],
        created_at: t(2),
      },
      {
        id: 'r1',
        title: 'Green salad',
        created_by_id: U,
        ingredients: ['kale'],
        instructions: ['toss'],
        created_at: t(1),
      },
      { id: 'r-other', title: 'Not mine', created_by_id: OTHER, created_at: t(0) },
    ],
    romanSession: [
      {
        id: 's-live',
        user_id: U,
        surface: 'client',
        day_key: '2026-10-01',
        message_count: 2,
        deleted_at: null,
        subject_context_json: { brief: 'about someone else' },
        quips_in_session: 1,
        created_at: t(1),
      },
      {
        id: 's-deleted',
        user_id: U,
        surface: 'client',
        day_key: 'erased:s-deleted',
        message_count: 0,
        deleted_at: t(5),
        subject_context_json: null,
        created_at: t(0),
      },
      {
        id: 's-other',
        user_id: OTHER,
        surface: 'client',
        day_key: '2026-10-01',
        message_count: 1,
        deleted_at: null,
        created_at: t(0),
      },
    ],
    romanMessage: [
      {
        id: 'm2',
        session_id: 's-live',
        user_id: U,
        role: 'assistant',
        content: 'Here is a plan.',
        model_id: 'claude-x',
        interrupted: false,
        prompt_tokens: 10,
        created_at: t(4),
      },
      {
        id: 'm1',
        session_id: 's-live',
        user_id: U,
        role: 'user',
        content: 'Help me plan my week.',
        model_id: null,
        interrupted: false,
        created_at: t(3),
      },
      {
        id: 'm-deleted',
        session_id: 's-deleted',
        user_id: U,
        role: 'user',
        content: 'a chat I deleted',
        created_at: t(1),
      },
      {
        id: 'm-other',
        session_id: 's-other',
        user_id: OTHER,
        role: 'user',
        content: 'someone else',
        created_at: t(1),
      },
    ],
    aiProcessingConsentEvent: [
      {
        id: 'c2',
        user_id: U,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 2,
        action: 'withdraw',
        consent_version: 'v4',
        copy_sha256: 'b'.repeat(64),
        created_at: t(6),
      },
      {
        id: 'c1',
        user_id: U,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 1,
        action: 'grant',
        consent_version: 'v4',
        copy_sha256: 'a'.repeat(64),
        created_at: t(2),
      },
      {
        id: 'c-other',
        user_id: OTHER,
        processor: 'anthropic',
        purpose: 'client_ai_processing',
        seq: 1,
        action: 'grant',
        created_at: t(2),
      },
    ],
  };
  const related = (key: string, row: Row): Row | undefined => {
    if (key === 'session') return tables.romanSession.find((s) => s.id === row.session_id);
    return undefined;
  };
  const delegate = (name: string) => ({
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, true>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      skip?: number;
      take?: number;
    }) => {
      let rows = (tables[name] ?? []).filter((r) => matches(r, args.where, related));
      for (const order of [...(args.orderBy ?? [])].reverse()) {
        const [col, dir] = Object.entries(order)[0];
        rows = [...rows].sort((a, b) => {
          const key = (v: unknown) => (v instanceof Date ? v.getTime() : String(v));
          const x = key(a[col]);
          const y = key(b[col]);
          const c = x < y ? -1 : x > y ? 1 : 0;
          return dir === 'asc' ? c : -c;
        });
      }
      rows = rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
      if (!args.select) return rows;
      const keys = Object.keys(args.select);
      return rows.map((r) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]])));
    },
    findUnique: async () => null,
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'user')
          return { findUnique: async () => ({ id: U, email: 'u@example.test' }) };
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
        return delegate(prop);
      },
    },
  );
  return stub<PrismaService>(prisma);
}

async function build(): Promise<Record<string, unknown>> {
  const svc = new DataExportService(store());
  const buildArchive: unknown = Reflect.get(svc, '_buildArchive');
  if (typeof buildArchive !== 'function') throw new Error('no _buildArchive');
  const { buffer } = await buildArchive.call(svc, U, '00000000-0000-4000-8000-000000000001');
  return JSON.parse(buffer.toString('utf8'));
}

describe('data export archive inventory (C-636-2)', () => {
  it('exports the recipes the user created, in order, with their content, and no one else recipes', async () => {
    const archive = await build();
    const recipes = stub<Row[]>(archive.created_recipes);
    expect(recipes.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(recipes[0]).toMatchObject({
      title: 'Green salad',
      ingredients: ['kale'],
      instructions: ['toss'],
    });
    expect(recipes[0]).not.toHaveProperty('created_by_id');
  });

  it('exports the user live Roman chats in order, never a deleted chat or another person chat', async () => {
    const archive = await build();
    const sessions = stub<Row[]>(archive.roman_sessions);
    const messages = stub<Row[]>(archive.roman_messages);
    expect(sessions.map((s) => s.id)).toEqual(['s-live']);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messages.map((m) => m.content)).toEqual(['Help me plan my week.', 'Here is a plan.']);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      model_id: 'claude-x',
      session_id: 's-live',
    });
    const text = JSON.stringify(archive);
    expect(text).not.toContain('a chat I deleted');
    expect(text).not.toContain('someone else');
  });

  it('leaves out the internal session context blob and budget counters', async () => {
    const archive = await build();
    const [session] = stub<Row[]>(archive.roman_sessions);
    expect(session).not.toHaveProperty('subject_context_json');
    expect(session).not.toHaveProperty('quips_in_session');
    expect(JSON.stringify(archive)).not.toContain('about someone else');
    const [first] = stub<Row[]>(archive.roman_messages);
    expect(first).not.toHaveProperty('prompt_tokens');
  });

  it('exports the full AI-processing consent ledger of the user, oldest first', async () => {
    const archive = await build();
    const events = stub<Row[]>(archive.ai_processing_consent_events);
    expect(events.map((e) => [e.seq, e.action])).toEqual([
      [1, 'grant'],
      [2, 'withdraw'],
    ]);
    expect(events.every((e) => e.user_id === U)).toBe(true);
  });
});
