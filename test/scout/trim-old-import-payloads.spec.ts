import type { PrismaClient } from '@prisma/client';
import {
  CONFIRM_ENV,
  CONFIRM_VALUE,
  TrimArgsError,
  parseTrimArgs,
  run,
  trimOldImportPayloads,
} from '../../scripts/trim-old-import-payloads';

// P3b: rows saved before P3 are cut through the same keep as new rows. All
// values are synthetic; the fake Prisma stores JSON the way jsonb returns it.
type Row = { id: string; source_platform: string; payload: unknown };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const SECRETS = ['other.client@example.com', '+1 555 0100', 'private note', '<div>', 'hunter2'];
const full = {
  name: 'Synthetic Client',
  email: 'other.client@example.com',
  phone: '+1 555 0100',
  notes: 'private note from the other platform',
  html: '<div>full page</div>',
  password: 'hunter2',
};
const CONFIRMED = { [CONFIRM_ENV]: CONFIRM_VALUE };

function fakePrisma() {
  const store = new Map<string, Row>(
    [
      { id: 'a1', source_platform: 'truecoach', payload: full },
      { id: 'a2', source_platform: 'truecoach', payload: { name: 'Already Trimmed' } },
      { id: 'a3', source_platform: 'no-such-platform', payload: full },
      { id: 'a4', source_platform: 'truecoach', payload: full },
    ].map((r) => [r.id, json(r)]),
  );
  const scoutIngestEntity = {
    findMany: jest.fn(async (args: { where: { id?: { gt: string } }; take: number }) =>
      json([...store.values()].filter((r) => !args.where.id || r.id > args.where.id.gt))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take),
    ),
    update: jest.fn(async (args: { where: { id: string }; data: { payload: unknown } }) =>
      Object.assign(store.get(args.where.id) ?? {}, { payload: json(args.data.payload) }),
    ),
  };
  const tx = { scoutIngestEntity };
  const prisma = {
    scoutIngestEntity,
    $transaction: jest.fn(async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  // @ts-expect-error R0 partial Prisma test double: the two delegate methods and $transaction the script uses; no database is opened.
  const client: PrismaClient = prisma;
  return { client, prisma, store };
}

describe('trim-old-import-payloads (P3b)', () => {
  it('dry run counts per platform and changes nothing', async () => {
    const { client, prisma, store } = fakePrisma();
    const before = json([...store.values()]);
    expect(await trimOldImportPayloads(client, { apply: false, batchSize: 2 })).toEqual({
      mode: 'dry-run',
      rows_scanned: 4,
      rows_changed: 3,
      platforms: {
        truecoach: { rows_scanned: 3, rows_changed: 2 },
        unsupported: { rows_scanned: 1, rows_changed: 1 },
      },
    });
    expect(prisma.scoutIngestEntity.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect([...store.values()]).toEqual(before);
  });

  it('apply trims in batched transactions, never deletes; a second apply changes 0', async () => {
    const { client, prisma, store } = fakePrisma();
    const first = await trimOldImportPayloads(client, { apply: true, batchSize: 2 });
    expect(first).toMatchObject({ mode: 'apply', rows_scanned: 4, rows_changed: 3 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3); // 2 + 2 + empty page
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60_000,
      maxWait: 10_000,
    });
    expect([...store.values()].map((r) => r.payload)).toEqual([
      { name: 'Synthetic Client' },
      { name: 'Already Trimmed' },
      {},
      { name: 'Synthetic Client' },
    ]);
    expect(SECRETS.filter((s) => JSON.stringify([...store.values()]).includes(s))).toEqual([]);
    prisma.scoutIngestEntity.update.mockClear();
    const second = await trimOldImportPayloads(client, { apply: true, batchSize: 2 });
    expect(second).toMatchObject({ rows_scanned: 4, rows_changed: 0 });
    expect(prisma.scoutIngestEntity.update).not.toHaveBeenCalled();
  });

  it('apply needs the flag and the confirmation value; unknown flags are refused', () => {
    expect(parseTrimArgs([], CONFIRMED)).toEqual({ apply: false });
    expect(parseTrimArgs(['--apply'], CONFIRMED)).toEqual({ apply: true });
    expect(() => parseTrimArgs(['--apply'], {})).toThrow(TrimArgsError);
    expect(() => parseTrimArgs(['--apply'], { [CONFIRM_ENV]: 'yes' })).toThrow(CONFIRM_ENV);
    expect(() => parseTrimArgs(['--force'], {})).toThrow('Dry run is the default');
    expect(() => parseTrimArgs(['--apply', '--apply'], CONFIRMED)).toThrow(TrimArgsError);
  });

  it('a refused apply reads nothing; output is counts only, never payload text', async () => {
    const { client, prisma } = fakePrisma();
    const lines: string[] = [];
    const log = lines.push.bind(lines);
    await expect(run(['--apply'], {}, client, log)).rejects.toThrow(TrimArgsError);
    expect(prisma.scoutIngestEntity.findMany).not.toHaveBeenCalled();
    await run(['--apply'], CONFIRMED, client, log);
    await run([], {}, client, log);
    expect(lines.map((l) => JSON.parse(l.replace('[trim-old-import-payloads] ', '')))).toEqual([
      expect.objectContaining({ mode: 'apply', rows_changed: 3 }),
      expect.objectContaining({ mode: 'dry-run', rows_changed: 0 }),
    ]);
    const output = lines.join('\n');
    expect([...SECRETS, 'Synthetic Client'].filter((s) => output.includes(s))).toEqual([]);
  });
});
