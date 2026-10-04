/**
 * AUD-OPUS-FU1-118 lens probe for growth-project-backend#698 (never merge).
 * Independent fake store (not the builder's): records every findMany call and
 * applies AND / OR / equality / null / one relation filter / `gt`, orderBy,
 * take and select the way Postgres would for a deterministic collation.
 *  - page boundaries 499/500/501/1000/1001: every row exactly once, one extra
 *    short read at most, page k>0 asks for `id > last id of page k-1`;
 *  - the owner filter and the erased-chat relation filter survive the AND
 *    wrapping on every later page (no other user's row, no erased chat);
 *  - the select (no internal columns) is sent on every page;
 *  - redaction of third-party coach messages holds on every page;
 *  - _findLatestRequest asks for the active row first, then the total order.
 */
import type { PrismaService } from '../src/prisma.service';
import { DataExportService } from '../src/data-export/data-export.service';
import { DataExportStatus } from '@prisma/client';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

type Row = Record<string, unknown>;
type Call = { model: string; args: Record<string, unknown> };
const U = 'user-a';
const OTHER = 'user-b';
const COACH = 'coach-c';
const cast = <T>(v: unknown) => v as T;

function makeStore(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const related = (key: string, row: Row): Row | undefined =>
    key === 'session' ? (tables.romanSession ?? []).find((s) => s.id === row.session_id) : undefined;
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, want]) => {
      if (k === 'AND') return cast<Row[]>(want).every((w) => matches(row, w));
      if (k === 'OR') return cast<Row[]>(want).some((w) => matches(row, w));
      if (want === null) return row[k] === null || row[k] === undefined;
      if (typeof want === 'object' && !(want instanceof Date)) {
        const w = cast<Row>(want);
        if ('gt' in w) return Buffer.compare(Buffer.from(String(row[k])), Buffer.from(String(w.gt))) > 0;
        const parent = related(k, row);
        return parent !== undefined && matches(parent, w);
      }
      return row[k] === want;
    });
  const byteCmp = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() - b.getTime()
      : Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
  const delegate = (model: string) => ({
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model, args: JSON.parse(JSON.stringify(args)) });
      let rows = (tables[model] ?? []).filter((r) => matches(r, cast<Row>(args.where ?? {})));
      const orderBy = cast<Array<Record<string, 'asc' | 'desc'>>>(args.orderBy ?? []);
      rows = [...rows].sort((a, b) => {
        for (const o of orderBy) {
          const [col, dir] = Object.entries(o)[0];
          const c = byteCmp(a[col], b[col]);
          if (c !== 0) return dir === 'asc' ? c : -c;
        }
        return 0;
      });
      if (typeof args.skip === 'number') rows = rows.slice(args.skip);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      const select = cast<Record<string, true> | undefined>(args.select);
      if (!select) return rows.map((r) => ({ ...r }));
      return rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => k in r).map((k) => [k, r[k]])));
    },
    findUnique: async () => null,
    findFirst: async () => null,
  });
  const prisma = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'user') return { findUnique: async () => ({ id: U, email: 'a@example.test' }) };
        if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
        return delegate(prop);
      },
    },
  );
  return { prisma: cast<PrismaService>(prisma), calls };
}

async function archiveOf(tables: Record<string, Row[]>) {
  const s = makeStore(tables);
  const svc = new DataExportService(s.prisma);
  const fn = cast<(u: string, e: string) => Promise<{ buffer: Buffer }>>(Reflect.get(svc, '_buildArchive'));
  const { buffer } = await fn.call(svc, U, '00000000-0000-4000-8000-0000000000ff');
  return { archive: cast<Record<string, unknown>>(JSON.parse(buffer.toString('utf8'))), calls: s.calls };
}

/** uuid-like ids in a scrambled insertion order; another user's rows interleave by id. */
function weightRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let k = 0; k < n; k += 1) {
    const i = (k * 7919) % n;
    rows.push({ id: `${String(i).padStart(8, '0')}-a`, user_id: U, weight_kg: 70 });
    rows.push({ id: `${String(i).padStart(8, '0')}-b`, user_id: OTHER, weight_kg: 99 });
  }
  return rows;
}

describe('AUD-OPUS-FU1-118 #698 probe: keyset paging boundaries', () => {
  it.each([0, 1, 499, 500, 501, 1000, 1001, 1500])('%i weight logs: each exactly once, no other user', async (n) => {
    const { archive, calls } = await archiveOf({ weightLog: weightRows(n) });
    const got = cast<Row[]>(archive.weight_logs);
    expect(got).toHaveLength(n);
    expect(new Set(got.map((r) => r.id)).size).toBe(n);
    expect(got.every((r) => r.user_id === U)).toBe(true);
    const wl = calls.filter((c) => c.model === 'weightLog');
    expect(wl).toHaveLength(Math.floor(n / 500) + 1);
    let prevLast: string | null = null;
    wl.forEach((c, k) => {
      expect(c.args.orderBy).toEqual([{ id: 'asc' }]);
      expect(c.args.take).toBe(500);
      expect(c.args.skip).toBeUndefined();
      if (k === 0) expect(c.args.where).toEqual({ user_id: U });
      else expect(c.args.where).toEqual({ AND: [{ user_id: U }, { id: { gt: prevLast } }] });
      const page = got.slice(k * 500, k * 500 + 500);
      prevLast = page.length ? String(page[page.length - 1].id) : prevLast;
    });
  });

  it('roman messages: erased-chat and owner filters and the select hold on every page; oldest first', async () => {
    const live = { id: 'sess-live', user_id: U, deleted_at: null, surface: 'chat', created_at: new Date(0) };
    const erased = { id: 'sess-erased', user_id: U, deleted_at: new Date(1), surface: 'chat', created_at: new Date(0) };
    const foreign = { id: 'sess-foreign', user_id: OTHER, deleted_at: null, surface: 'chat', created_at: new Date(0) };
    const msgs: Row[] = [];
    for (let k = 0; k < 1300; k += 1) {
      const i = (k * 101) % 1300;
      const session = i % 3 === 0 ? erased : i % 3 === 1 ? live : foreign;
      msgs.push({
        id: `m${String(i).padStart(6, '0')}`,
        user_id: session === foreign ? OTHER : U,
        session_id: session.id,
        role: 'user',
        content: session === live ? `kept ${i}` : `MUST-NOT-EXPORT ${i}`,
        subject_context_json: 'INTERNAL',
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 10))),
      });
    }
    const { archive, calls } = await archiveOf({ romanSession: [live, erased, foreign], romanMessage: msgs });
    const got = cast<Row[]>(archive.roman_messages);
    const expected = msgs.filter((m) => m.session_id === 'sess-live');
    expect(got).toHaveLength(expected.length);
    expect(new Set(got.map((r) => r.id)).size).toBe(expected.length);
    expect(JSON.stringify(archive)).not.toContain('MUST-NOT-EXPORT');
    expect(JSON.stringify(archive)).not.toContain('INTERNAL');
    const keys = got.map((r) => `${new Date(String(r.created_at)).getTime()}|${r.id}`);
    expect(keys).toEqual(
      [...got]
        .sort((a, b) => new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime() || (String(a.id) < String(b.id) ? -1 : 1))
        .map((r) => `${new Date(String(r.created_at)).getTime()}|${r.id}`),
    );
    const rm = calls.filter((c) => c.model === 'romanMessage');
    expect(rm.length).toBeGreaterThanOrEqual(1);
    for (const c of rm) expect(Object.keys(cast<Row>(c.args.select))).not.toContain('subject_context_json');
  });

  it.each([500, 1000, 1001])('%i coach messages: third-party content redacted on every page', async (n) => {
    const rows: Row[] = [];
    for (let k = 0; k < n; k += 1) {
      const i = (k * 389) % n;
      const fromCoach = i % 2 === 0;
      rows.push({
        id: `c${String(i).padStart(6, '0')}`,
        sender_id: fromCoach ? COACH : U,
        coach_id: COACH,
        client_id: U,
        body: fromCoach ? `THIRD-PARTY ${i}` : `own ${i}`,
        created_at: new Date(i),
      });
      rows.push({ id: `c${String(i).padStart(6, '0')}x`, sender_id: OTHER, coach_id: COACH, client_id: OTHER, body: `FOREIGN ${i}` });
    }
    const { archive } = await archiveOf({ coachMessage: rows });
    const got = cast<Row[]>(archive.coach_messages);
    expect(got).toHaveLength(n);
    expect(new Set(got.map((r) => r.id)).size).toBe(n);
    const s = JSON.stringify(got);
    expect(s).not.toContain('THIRD-PARTY');
    expect(s).not.toContain('FOREIGN');
    expect(got.filter((r) => r.redacted === true)).toHaveLength(Math.ceil(n / 2));
  });
});

describe('AUD-OPUS-FU1-118 #698 probe: latest request', () => {
  it('asks for the one active row first, then the total order', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const active = { id: 'r-active', status: DataExportStatus.READY };
    const prisma = cast<PrismaService>({
      dataExportRequest: {
        findFirst: async (args: Record<string, unknown>) => {
          calls.push(JSON.parse(JSON.stringify(args)));
          return calls.length === 1 ? null : active;
        },
      },
    });
    const svc = new DataExportService(prisma);
    const fn = cast<(u: string) => Promise<unknown>>(Reflect.get(svc, '_findLatestRequest'));
    expect(await fn.call(svc, U)).toBe(active);
    expect(calls[0]).toEqual({
      where: { user_id: U, status: { in: ['PENDING', 'RUNNING', 'READY'] } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(calls[1]).toEqual({ where: { user_id: U }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
  });
});
