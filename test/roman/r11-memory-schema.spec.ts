/**
 * Roman v1.1 slice R11-M1 (A-ROMAN11-124 plan): memory schema, RLS, deletion
 * and export.
 *
 * Static proof over the files that build the database and the code that
 * erases and exports it:
 *   - migration 20270401000000_roman_memory: the three tables are server-only
 *     (RLS enabled + forced, no API-role grant, a service_role policy and a
 *     restrictive anon deny, nothing else), the closed sets and lengths are
 *     CHECKs, and a note's source message is ON DELETE SET NULL so deleting a
 *     chat keeps the note with a null source (plan decision 9);
 *   - schema.prisma declares the same shape (the schema-parity job proves
 *     the DDL matches it);
 *   - the account-deletion manifest deletes all three by client_id;
 *   - the data export carries the client's own notes and summaries and
 *     nobody else's.
 * The Postgres proof of the chat-delete behaviour is
 * test/roman/r11-memory-schema.live.spec.ts (mwb-3-live-tests job).
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { PrismaService } from '../../src/prisma.service';
import { DataExportService } from '../../src/data-export/data-export.service';
import { ERASURE_MANIFEST } from '../../src/account-deletion/account-deletion.manifest';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

const ROOT = join(__dirname, '../..');
const NAME = '20270401000000_roman_memory';
const DIR = join(ROOT, 'prisma/migrations', NAME);
const TABLES = ['RomanClientNote', 'RomanClientSummary', 'RomanMemoryState'] as const;

/** SQL without comments, whitespace collapsed. */
function code(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SQL = code(readFileSync(join(DIR, 'migration.sql'), 'utf8'));
const DOWN = code(readFileSync(join(DIR, 'down.sql'), 'utf8'));
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');

function checkBody(constraint: string): string {
  const m = new RegExp(`CONSTRAINT "${constraint}" CHECK \\((.*?)\\);`).exec(SQL);
  if (!m) throw new Error(`CHECK ${constraint} not found`);
  return m[1].trim();
}

function quotedSet(body: string): string[] {
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

function modelBlock(model: string): string {
  const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA);
  if (!m) throw new Error(`model ${model} not found`);
  return m[1];
}

describe('R11-M1 migration: placement and scope', () => {
  it('sorts after the newest migration main had when the slice was cut, with a down.sql', () => {
    const dirs = readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
    expect(dirs).toContain(NAME);
    expect(NAME > '20270318122000_coach_booking_options').toBe(true);
    expect(existsSync(join(DIR, 'down.sql'))).toBe(true);
  });

  it('is additive: it creates the three tables and alters nothing else', () => {
    const created = [...SQL.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
    const altered = new Set([...SQL.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]));
    expect([...altered].every((t) => (TABLES as readonly string[]).includes(t))).toBe(true);
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/\b(DELETE FROM|UPDATE "|INSERT INTO|TRUNCATE)\b/i);
  });

  it('down.sql drops exactly the three tables', () => {
    const dropped = [...DOWN.matchAll(/DROP TABLE IF EXISTS "(\w+)"/g)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([...TABLES].sort());
    expect(DOWN.replace(/DROP TABLE IF EXISTS "\w+";/g, '').trim()).toBe('');
  });
});

describe('R11-M1 migration: RLS (server only; coaches and clients never read the tables)', () => {
  it.each(TABLES)('%s: RLS enabled and forced, no anon or authenticated grant', (table) => {
    expect(SQL).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
    expect(SQL).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    expect(SQL).toContain(`REVOKE ALL ON TABLE "${table}" FROM anon, authenticated;`);
  });

  it.each(TABLES)('%s: only a service_role policy and a restrictive anon deny', (table) => {
    const lower = table.toLowerCase();
    const policies = [
      ...SQL.matchAll(new RegExp(`CREATE POLICY "(\\w+)" ON "${table}" (.*?);`, 'g')),
    ].map((m) => [m[1], m[2]]);
    expect(policies).toEqual([
      [
        `p_${lower}_service_role_all`,
        'AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
      ],
      [`p_${lower}_anon_deny`, 'AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)'],
    ]);
  });

  it('declares no other policy and grants nothing', () => {
    expect([...SQL.matchAll(/CREATE POLICY/g)]).toHaveLength(TABLES.length * 2);
    expect(SQL).not.toMatch(/\bGRANT\b/i);
    expect(SQL).not.toMatch(/TO (public|authenticated)\b/i);
    expect(SQL).not.toMatch(/current_user_id|is_owner|auth\.uid/i);
  });
});

describe('R11-M1 migration: closed sets, lengths and keys', () => {
  it('note kind is the closed set of the plan', () => {
    expect(quotedSet(checkBody('RomanClientNote_kind_check'))).toEqual(
      [
        'preference',
        'schedule',
        'household',
        'work',
        'injury_history',
        'goal',
        'equipment',
        'diet_like',
        'diet_dislike',
        'travel',
        'other',
      ].sort(),
    );
  });

  it('note text <= 200, key <= 120, source kind roman_chat, superseded_by implies superseded_at', () => {
    expect(checkBody('RomanClientNote_text_check')).toBe('char_length("text") BETWEEN 1 AND 200');
    expect(checkBody('RomanClientNote_key_check')).toBe('char_length("key") BETWEEN 1 AND 120');
    expect(quotedSet(checkBody('RomanClientNote_source_kind_check'))).toEqual(['roman_chat']);
    expect(checkBody('RomanClientNote_superseded_check')).toBe(
      '"superseded_by_id" IS NULL OR "superseded_at" IS NOT NULL',
    );
  });

  it('summary period is day | week | month and text <= 1,200', () => {
    expect(quotedSet(checkBody('RomanClientSummary_period_check'))).toEqual([
      'day',
      'month',
      'week',
    ]);
    expect(checkBody('RomanClientSummary_text_check')).toBe(
      'char_length("text") BETWEEN 1 AND 1200',
    );
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX "RomanClientSummary_client_id_period_period_start_key" ON "RomanClientSummary"("client_id", "period", "period_start");',
    );
  });

  it('memory state outcome is the closed code set (or null before the first run)', () => {
    const body = checkBody('RomanMemoryState_last_outcome_check');
    expect(body.startsWith('"last_outcome" IS NULL OR ')).toBe(true);
    expect(quotedSet(body)).toEqual(['breaker', 'error', 'no_consent', 'ok', 'pool_empty']);
  });

  it('a chat delete keeps the note: source_message_id is ON DELETE SET NULL', () => {
    expect(SQL).toContain(
      'ADD CONSTRAINT "RomanClientNote_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "RomanMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
    expect(SQL).toContain(
      'ADD CONSTRAINT "RomanClientNote_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "RomanClientNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
    expect(SQL).toContain('CREATE INDEX "RomanClientNote_source_message_id_idx"');
  });

  it.each(TABLES)('%s: client_id references User', (table) => {
    expect(SQL).toContain(
      `ADD CONSTRAINT "${table}_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    );
  });
});

describe('R11-M1 schema.prisma', () => {
  it('declares the note shape with a SET NULL source message relation', () => {
    const note = modelBlock('RomanClientNote');
    for (const field of [
      'id',
      'client_id',
      'kind',
      'key',
      'text',
      'source_kind',
      'source_message_id',
      'source_at',
      'expires_at',
      'superseded_at',
      'superseded_by_id',
      'created_at',
      'updated_at',
    ]) {
      expect(note).toMatch(new RegExp(`^\\s+${field}\\s`, 'm'));
    }
    expect(note).toMatch(
      /source_message\s+RomanMessage\?\s+@relation\("RomanClientNoteSourceMessage", fields: \[source_message_id\], references: \[id\], onDelete: SetNull\)/,
    );
    expect(note).toContain('@@index([client_id, superseded_at, expires_at])');
  });

  it('declares one summary per (client, period, period_start) on a date column', () => {
    const summary = modelBlock('RomanClientSummary');
    expect(summary).toMatch(/period_start\s+DateTime\s+@db\.Date/);
    expect(summary).toMatch(/facts\s+Json\n/);
    expect(summary).toContain('@@unique([client_id, period, period_start])');
  });

  it('keys memory state by client', () => {
    expect(modelBlock('RomanMemoryState')).toMatch(/client_id\s+String\s+@id\n/);
  });
});

describe('R11-M1 account deletion', () => {
  it('deletes notes, summaries and memory state by client_id, before the chat rows', () => {
    const idx = (model: string) => ERASURE_MANIFEST.findIndex((e) => e.model === model);
    for (const model of TABLES) {
      const entries = ERASURE_MANIFEST.filter((e) => e.model === model);
      expect(entries).toEqual([{ model, field: 'client_id', action: { op: 'delete' } }]);
      expect(idx(model)).toBeLessThan(idx('RomanMessage'));
    }
  });
});

// ── Data export ──────────────────────────────────────────────────────────────

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;
const A = 'client-a';
const B = 'client-b';
const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n));

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'AND' && Array.isArray(want)) return want.every((w) => matches(row, w));
    if (key === 'OR' && Array.isArray(want)) return want.some((w) => matches(row, w));
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      if ('gt' in want) return String(row[key]) > String((want as { gt: unknown }).gt);
      return false; // relation filters: no related rows in this store
    }
    return row[key] === want;
  });
}

function exportStore(tables: Record<string, Row[]>): PrismaService {
  const delegate = (name: string) => ({
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, true>;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      take?: number;
    }) => {
      let rows = (tables[name] ?? []).filter((r) => matches(r, args.where));
      rows = [...rows].sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1));
      rows = rows.slice(0, args.take ?? rows.length);
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
        if (prop === 'user') return { findUnique: async () => ({ id: A, email: 'a@example.test' }) };
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
        return delegate(prop);
      },
    },
  );
  return stub<PrismaService>(prisma);
}

async function buildArchive(tables: Record<string, Row[]>): Promise<Record<string, unknown>> {
  const svc = new DataExportService(exportStore(tables));
  const build: unknown = Reflect.get(svc, '_buildArchive');
  if (typeof build !== 'function') throw new Error('no _buildArchive');
  const { buffer } = await build.call(svc, A, '00000000-0000-4000-8000-000000000011');
  return JSON.parse(buffer.toString('utf8'));
}

describe('R11-M1 data export: the client own notes and summaries only', () => {
  const tables: Record<string, Row[]> = {
    romanClientNote: [
      {
        id: 'n2',
        client_id: A,
        kind: 'diet_dislike',
        key: 'diet_dislike.oats',
        text: 'Dislikes oats.',
        source_message_id: 'msg-a',
        source_at: t(2),
        expires_at: null,
        superseded_at: null,
        created_at: t(3),
      },
      {
        id: 'n1',
        client_id: A,
        kind: 'travel',
        key: 'travel.lisbon',
        text: 'In Lisbon until the 14th.',
        source_message_id: null,
        source_at: t(0),
        expires_at: t(9),
        superseded_at: null,
        created_at: t(1),
      },
      {
        id: 'n-b',
        client_id: B,
        kind: 'injury_history',
        key: 'injury_history.knee',
        text: 'Left knee surgery last year.',
        source_at: t(0),
        created_at: t(0),
      },
    ],
    romanClientSummary: [
      {
        id: 'sum-a',
        client_id: A,
        period: 'day',
        period_start: '2026-10-01',
        text: 'Logged 2,100 kcal and one session.',
        facts: { kcal: 2100, refs: [{ table: 'LoggedFoodEntry', id: 'f1' }] },
        input_hash: 'h'.repeat(64),
        model_id: 'background-model',
        generated_at: t(5),
      },
      {
        id: 'sum-b',
        client_id: B,
        period: 'day',
        period_start: '2026-10-01',
        text: 'Another client summary.',
        facts: {},
        input_hash: 'x'.repeat(64),
        model_id: 'background-model',
        generated_at: t(5),
      },
    ],
    romanMemoryState: [{ client_id: A, id: A, last_outcome: 'ok', last_run_at: t(5) }],
  };

  it('exports A notes oldest first with kind, text, dates; never the slot key or source id', async () => {
    const archive = await buildArchive(tables);
    const notes = archive.roman_notes as Row[];
    expect(notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(notes[1]).toEqual({
      id: 'n2',
      kind: 'diet_dislike',
      text: 'Dislikes oats.',
      source_at: t(2).toISOString(),
      expires_at: null,
      superseded_at: null,
      created_at: t(3).toISOString(),
    });
  });

  it('exports A summaries without the facts blob, digest or model id', async () => {
    const archive = await buildArchive(tables);
    expect(archive.roman_summaries).toEqual([
      {
        id: 'sum-a',
        period: 'day',
        period_start: '2026-10-01',
        text: 'Logged 2,100 kcal and one session.',
        generated_at: t(5).toISOString(),
      },
    ]);
  });

  it('carries nothing of B and no memory job state', async () => {
    const archive = await buildArchive(tables);
    const text = JSON.stringify(archive);
    expect(text).not.toContain('Left knee surgery');
    expect(text).not.toContain('Another client summary');
    expect(text).not.toContain('diet_dislike.oats');
    expect(text).not.toContain('msg-a');
    expect(Object.keys(archive)).not.toContain('roman_memory_state');
    expect(text).not.toContain('last_outcome');
  });
});
