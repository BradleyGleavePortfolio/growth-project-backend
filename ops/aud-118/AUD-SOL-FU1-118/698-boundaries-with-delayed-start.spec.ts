import { DataExportService } from '../src/data-export/data-export.service';
import type { PrismaService } from '../src/prisma.service';
import { DataExportStatus } from '@prisma/client';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

type Row = Record<string, unknown> & { id: string };
type Args = { where: Record<string, unknown>; orderBy: unknown; select?: Record<string, true>; take: number };

function invoke(svc: DataExportService, name: string, ...args: unknown[]): Promise<unknown> {
  const method: unknown = Reflect.get(svc, name);
  if (typeof method !== 'function') throw new Error(`No ${name}`);
  return method.call(svc, ...args);
}

function match(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND' && Array.isArray(v)) return v.every((w) => match(row, w));
    if (k === 'OR' && Array.isArray(v)) return v.some((w) => match(row, w));
    if (typeof v === 'object' && v !== null && 'gt' in v)
      return String(row[k]) > String((v as { gt: string }).gt);
    return row[k] === v;
  });
}

function delegate(initial: Row[], onPage?: (rows: Row[], call: number) => void) {
  const rows = [...initial];
  let call = 0;
  const queries: Args[] = [];
  const findMany = async (args: Args) => {
    queries.push(args);
    onPage?.(rows, ++call);
    const page = rows.filter((r) => match(r, args.where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take);
    return args.select
      ? page.map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])))
      : page;
  };
  return { findMany, queries };
}

function service(prisma: unknown) {
  return new DataExportService(prisma as PrismaService);
}

const id = (i: number) => `row-${String(i).padStart(6, '0')}`;

describe('AUD-SOL-FU1-118 independent export boundary probes', () => {
  it.each([0, 1, 499, 500, 501, 1000])('keyset termination and exact membership for %d rows', async (n) => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: id(n - i - 1), user_id: 'owner' }));
    const db = delegate([...rows, { id: 'row-999999', user_id: 'other' }]);
    const result = await invoke(service({ weightLog: db }), '_streamAll', 'weightLog', { user_id: 'owner' });
    expect(result).toEqual([...rows].reverse());
    expect(db.queries).toHaveLength(Math.floor(n / 500) + 1);
    expect(db.queries.every((q) => JSON.stringify(q.orderBy) === '[{"id":"asc"}]')).toBe(true);
    expect(db.queries.every((q) => !('skip' in q))).toBe(true);
  });

  it('deleting an already-exported earlier row cannot shift later pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: id(i), user_id: 'owner' }));
    const db = delegate(rows, (live, call) => {
      if (call === 2) live.splice(0, 1);
    });
    expect(await invoke(service({ weightLog: db }), '_streamAll', 'weightLog', { user_id: 'owner' })).toEqual(rows);
  });

  it('AND composes the keyset with every original OR tenant branch on subsequent pages', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: id(i),
      sender_id: i % 2 ? 'owner' : 'coach',
      coach_id: 'coach',
      client_id: 'owner',
      body: i % 2 ? 'own-visible' : 'third-party-private',
    }));
    const db = delegate([...rows, { id: 'row-999999', sender_id: 'other', coach_id: 'other', client_id: 'other', body: 'other-private' }]);
    const result = await invoke(service({ coachMessage: db }), '_streamCoachMessages', 'owner') as Row[];
    expect(result).toHaveLength(1001);
    expect(result.filter((r) => r.redacted)).toHaveLength(501);
    expect(JSON.stringify(result)).not.toMatch(/third-party-private|other-private/);
    expect(db.queries[1].where).toEqual({
      AND: [
        { OR: [{ sender_id: 'owner' }, { coach_id: 'owner' }, { client_id: 'owner' }] },
        { id: { gt: id(499) } },
      ],
    });
  });

  it('selected private columns stay omitted; chronological Date ties sort by id', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: id(1000 - i),
      created_by_id: 'owner',
      created_at: new Date(i % 2),
      private: 'omit-me',
    }));
    const db = delegate(rows);
    const result = await invoke(service({ recipe: db }), '_streamAll', 'recipe', { created_by_id: 'owner' }, {
      select: { id: true, created_at: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    }) as Row[];
    expect(result).toHaveLength(1001);
    expect(JSON.stringify(result)).not.toContain('omit-me');
    expect(result.map((r) => [Number(r.created_at), r.id])).toEqual(
      rows.map((r) => [Number(r.created_at), r.id]).sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1]))),
    );
    expect(db.queries.every((q) => JSON.stringify(q.select) === '{"id":true,"created_at":true}')).toBe(true);
  });

  it('missing id on a full page rejects instead of publishing a partial archive', async () => {
    const weightLog = { findMany: async () => Array.from({ length: 500 }, () => ({ user_id: 'owner' })) };
    await expect(invoke(service({ weightLog }), '_streamAll', 'weightLog', { user_id: 'owner' })).rejects.toThrow('Data export paging stopped on weightLog');
  });

  it('active-first lookup stays self-scoped, and terminal fallback is explicit and total', async () => {
    const active = { id: 'active', status: DataExportStatus.PENDING, user_id: 'owner' };
    const findFirst = jest.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'terminal' });
    const svc = service({ dataExportRequest: { findFirst } });
    expect(await invoke(svc, '_findLatestRequest', 'owner')).toBe(active);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0]).toEqual({
      where: { user_id: 'owner', status: { in: ['PENDING', 'RUNNING', 'READY'] } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(await invoke(svc, '_findLatestRequest', 'owner')).toEqual({ id: 'terminal' });
    expect(findFirst.mock.calls[2][0]).toEqual({
      where: { user_id: 'owner' },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  });

  it('characterizes pre-existing delayed worker-start resurrection (optional outside-diff hardening)', async () => {
    const oldId = '00000000-0000-4000-8000-000000000001';
    const newId = '00000000-0000-4000-8000-000000000002';
    const rows = [
      { id: oldId, user_id: 'owner', status: DataExportStatus.PENDING,
        created_at: new Date(0), completed_at: null, expires_at: null, file_size_bytes: null, file_url: null },
    ] as Array<Record<string, unknown> & { id: string; status: DataExportStatus }>;
    let releaseStart: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { releaseStart = resolve; });
    let observeStart: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { observeStart = resolve; });
    const prisma = {
      dataExportRequest: {
        update: async ({ where, data }: { where: { id: string }; data: { status: DataExportStatus } }) => {
          observeStart();
          await held;
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error('missing request');
          Object.assign(row, data);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: { id: string; status?: DataExportStatus }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id && (!where.status || r.status === where.status));
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        findFirst: async ({ where }: { where: { user_id: string; status?: { in: DataExportStatus[] } } }) =>
          rows.filter((r) => r.user_id === where.user_id && (!where.status || where.status.in.includes(r.status)))
            .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0] ?? null,
      },
    };
    const svc = service(prisma);
    Object.assign(svc, {
      _buildArchive: async () => ({ buffer: Buffer.from('{}'), sha256: 'probe' }),
      _uploadFile: async () => 'not-a-downloadable-store-url',
    });
    const worker = invoke(svc, '_runExport', oldId, 'owner');
    await started;
    // A different machine reaps the old PENDING row while its RUNNING write
    // has not reached the database. A replacement starts and fails first.
    rows[0].status = DataExportStatus.FAILED;
    rows.push({ ...rows[0], id: newId, created_at: new Date(1000), status: DataExportStatus.FAILED });
    releaseStart();
    await worker;
    // Characterization, not a protection assertion: unchanged _runExport
    // starts by unconditional id-only update, which revives the old row.
    expect(rows[0].status).toBe(DataExportStatus.READY);
    expect((await svc.getLatestStatus('owner')).id).toBe(oldId);
    expect(rows[1].status).toBe(DataExportStatus.FAILED);
  });
});
