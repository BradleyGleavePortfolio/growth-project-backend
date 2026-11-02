/**
 * WATER-WEIGHT-KEYS-BE (migration 20270502010800, agent 192; #191-D3 op 1): a water or weight save sent twice
 * counts once, on a real database.
 *
 * The migration adds water_logs.client_uuid and WeightLog.client_uuid (nullable TEXT, unique across all
 * members). Its down and up run here, and both tables keep the same row-level policies and forced RLS. The
 * service cases call the real WaterService and WeightService on the superuser connection, as the API does, so
 * the real unique index decides two sends at once. Row access runs as the API role `authenticated` (no RLS
 * bypass) with each person's JWT claims and app context, and every zero comes right after a control read of 1
 * of the same row. The last case builds the real data-export archive and runs the account-deletion manifest's
 * WeightLog and WaterLog steps.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { WaterService } from '../../src/water/water.service';
import { WeightService } from '../../src/weight/weight.service';
import { DataExportService } from '../../src/data-export/data-export.service';
import { ERASURE_MANIFEST, executeErasureManifest } from '../../src/account-deletion/account-deletion.manifest';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('water-weight-keys-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270502010800_water_weight_client_uuid';
const TABLES = ['WeightLog', 'water_logs'] as const;

function stub<T>(value: unknown): T {
  return value as T;
}

(DB_URL ? describe : describe.skip)('WATER-WEIGHT-KEYS-BE: one water or weight row per key, on the database', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const emit = jest.fn();
  const invalidateForUser = jest.fn();
  const water = new WaterService(prisma);
  const weight = new WeightService(prisma, stub<PtmService>({ emit }), stub<ClientAIContextService>({ invalidateForUser }));
  // Fictional people, fresh ids per run. Coach h; a and b are h's clients.
  const [h, a, b] = Array.from({ length: 3 }, () => randomUUID());
  const roleOf: Record<string, string> = { [h]: 'coach' };
  const supa = Object.fromEntries([h, a, b].map((id) => [id, randomUUID()]));

  /** Runs `fn` in one transaction as the API role `authenticated`, signed in as `who`: JWT claims and app context. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: supa[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, roleOf[who] ?? 'student');
      return fn(tx);
    });
  /** Rows of `table` with this id that `who` reads. */
  const seen = async (who: string, table: string, id: string): Promise<number> => {
    const [{ n }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, id));
    return n;
  };
  /** Rows of `table` with this id that `who` changes with `sql` (an UPDATE or DELETE ... WHERE "id" = $1). */
  const changes = (who: string, sql: string, id: string) => asUser(who, (tx) => tx.$executeRawUnsafe(sql, id));
  const runSql = (file: 'migration.sql' | 'down.sql') => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, file), 'utf8');
    const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((st) => st.trim()).filter(Boolean);
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    });
  };
  /** Who may read or write each table: every policy, its command, roles and expressions; and forced RLS. */
  const access = async () => ({
    policies: await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT tablename::text AS t, policyname::text AS p, cmd::text AS cmd, roles::text AS roles,
              coalesce(qual, '') AS qual, coalesce(with_check, '') AS with_check
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY 1, 2`, [...TABLES]),
    forced: await prisma.$queryRawUnsafe<{ relname: string; forced: boolean }[]>(
      `SELECT relname::text AS relname, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname COLLATE "C"`, [...TABLES]),
  });
  const keyColumns = () => prisma.$queryRawUnsafe<{ table_name: string; data_type: string; is_nullable: string }[]>(
    `SELECT table_name::text AS table_name, data_type::text AS data_type, is_nullable::text AS is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name = 'client_uuid' ORDER BY 1 COLLATE "C"`, [...TABLES]);
  const keyIndexes = () => prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
    `SELECT indexname::text AS indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND indexdef LIKE '%client_uuid%' ORDER BY 1 COLLATE "C"`, [...TABLES]);
  const waterOf = (who: string) => prisma.waterLog.findMany({ where: { user_id: who }, orderBy: { created_at: 'asc' } });
  const weightOf = (who: string) => prisma.weightLog.findMany({ where: { user_id: who }, orderBy: { logged_at: 'asc' } });

  beforeAll(async () => {
    const before = await access();
    // TABLES is in "C" order (upper case first), as every catalog read here sorts.
    expect(before.forced).toEqual(TABLES.map((relname) => ({ relname, forced: true })));
    expect(before.policies.length).toBeGreaterThan(0);
    // down.sql removes both keys and their indexes; the migration brings them back. Access never changes.
    await runSql('down.sql');
    expect(await keyColumns()).toEqual([]);
    expect(await keyIndexes()).toEqual([]);
    expect(await access()).toEqual(before);
    await runSql('migration.sql');
    expect(await keyColumns()).toEqual([
      { table_name: 'WeightLog', data_type: 'text', is_nullable: 'YES' },
      { table_name: 'water_logs', data_type: 'text', is_nullable: 'YES' },
    ]);
    expect(await keyIndexes()).toEqual([
      { indexname: 'WeightLog_client_uuid_key', indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX .* \(client_uuid\)$/) },
      { indexname: 'water_logs_client_uuid_key', indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX .* \(client_uuid\)$/) },
    ]);
    expect(await access()).toEqual(before);

    const people: Array<[string, 'coach' | 'student', string | null]> = [[h, 'coach', null], [a, 'student', h], [b, 'student', h]];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: supa[id], email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => {
    emit.mockClear();
    invalidateForUser.mockClear();
  });

  it('K2: the same key sent again stores one row and answers with it; five sends at once store one', async () => {
    const wKey = randomUUID();
    const first = await water.logWater(a, { amount_ml: 250, date: '2026-11-02T17:00:00.000Z', client_uuid: wKey });
    const again = await water.logWater(a, { amount_ml: 900, date: '2026-11-02T17:00:00.000Z', client_uuid: wKey });
    expect(again).toEqual(first);
    expect((await waterOf(a)).filter((r) => r.client_uuid === wKey).map((r) => [r.id, r.amount_ml])).toEqual([[first.id, 250]]);

    const kKey = randomUUID();
    const one = await weight.logWeight(a, { weight_lbs: 181.5, date: '2026-11-01', client_uuid: kKey });
    const two = await weight.logWeight(a, { weight_lbs: 170, date: '2026-11-01', client_uuid: kKey });
    expect(two).toEqual(one);
    expect((await weightOf(a)).filter((r) => r.client_uuid === kKey).map((r) => [r.id, r.weight_lbs])).toEqual([[one.id, 181.5]]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(invalidateForUser).toHaveBeenCalledTimes(1);

    // The real unique index decides a burst of sends of one key.
    const burstW = randomUUID();
    const burstK = randomUUID();
    const waters = await Promise.all(Array.from({ length: 5 }, () =>
      water.logWater(a, { amount_ml: 330, client_uuid: burstW })));
    const weights = await Promise.all(Array.from({ length: 5 }, () =>
      weight.logWeight(a, { weight_lbs: 181, date: '2026-11-02', client_uuid: burstK })));
    expect(new Set(waters.map((r) => r.id)).size).toBe(1);
    expect(new Set(weights.map((r) => r.id)).size).toBe(1);
    expect(await prisma.waterLog.count({ where: { client_uuid: burstW } })).toBe(1);
    expect(await prisma.weightLog.count({ where: { client_uuid: burstK } })).toBe(1);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("K3: another member's key answers 404 and leaves the row as it was", async () => {
    const wKey = randomUUID();
    const kKey = randomUUID();
    const aWater = await water.logWater(a, { amount_ml: 500, client_uuid: wKey });
    const aWeight = await weight.logWeight(a, { weight_lbs: 182, date: '2026-10-30', client_uuid: kKey });
    emit.mockClear();
    await expect(water.logWater(b, { amount_ml: 1, client_uuid: wKey })).rejects.toThrow(new NotFoundException('Entry not found'));
    await expect(weight.logWeight(b, { weight_lbs: 99, date: '2026-10-30', client_uuid: kKey }))
      .rejects.toThrow(new NotFoundException('Entry not found'));
    expect(await prisma.waterLog.findUniqueOrThrow({ where: { id: aWater.id } })).toEqual(aWater);
    expect(await prisma.weightLog.findUniqueOrThrow({ where: { id: aWeight.id } })).toEqual(aWeight);
    expect(await prisma.waterLog.count({ where: { user_id: b } })).toBe(0);
    expect(await prisma.weightLog.count({ where: { user_id: b } })).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('K3: no key is a plain create: two sends are two rows, null key, and the answer has no key field', async () => {
    const w1 = await water.logWater(a, { amount_ml: 200, date: '2026-10-29T08:00:00.000Z' });
    const w2 = await water.logWater(a, { amount_ml: 200, date: '2026-10-29T08:00:00.000Z' });
    const k1 = await weight.logWeight(a, { weight_lbs: 183, date: '2026-10-29' });
    const k2 = await weight.logWeight(a, { weight_lbs: 183, date: '2026-10-29' });
    expect(new Set([w1.id, w2.id]).size).toBe(2);
    expect(new Set([k1.id, k2.id]).size).toBe(2);
    expect(Object.keys(w1).sort()).toEqual(['amount_ml', 'created_at', 'id', 'logged_at', 'user_id']);
    expect(Object.keys(k1).sort()).toEqual(['date', 'id', 'logged_at', 'notes', 'user_id', 'weight_lbs']);
    const stored = await prisma.waterLog.findMany({ where: { id: { in: [w1.id, w2.id] } } });
    expect(stored.map((r) => r.client_uuid)).toEqual([null, null]);
    expect((await prisma.weightLog.findMany({ where: { id: { in: [k1.id, k2.id] } } })).map((r) => r.client_uuid)).toEqual([null, null]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('K4: who reads and writes a keyed row is as before: the member and their coach read it, another member reads none', async () => {
    const aWater = await water.logWater(a, { amount_ml: 410, client_uuid: randomUUID() });
    const aWeight = await weight.logWeight(a, { weight_lbs: 181.2, date: '2026-10-28', client_uuid: randomUUID() });
    for (const [table, id] of [['water_logs', aWater.id], ['WeightLog', aWeight.id]] as const) {
      expect(await seen(a, table, id)).toBe(1);
      expect(await seen(b, table, id)).toBe(0);
      expect(await seen(a, table, id)).toBe(1);
      expect(await seen(h, table, id)).toBe(1);
      // Another member and the coach change nothing; the member can.
      expect(await changes(b, `UPDATE public."${table}" SET "client_uuid" = 'taken' WHERE "id" = $1`, id)).toBe(0);
      expect(await changes(h, `UPDATE public."${table}" SET "client_uuid" = 'taken' WHERE "id" = $1`, id)).toBe(0);
      expect(await changes(b, `DELETE FROM public."${table}" WHERE "id" = $1`, id)).toBe(0);
      expect(await seen(a, table, id)).toBe(1);
    }
  });

  it('K4: edit and delete of a keyed row work as before; after a delete the key stores a new row', async () => {
    const kKey = randomUUID();
    const wKey = randomUUID();
    const aWeight = await weight.logWeight(a, { weight_lbs: 180, date: '2026-10-27', client_uuid: kKey });
    const edited = await weight.updateWeight(a, aWeight.id, { weight_lbs: 179.5 });
    expect(edited).toMatchObject({ id: aWeight.id, weight_lbs: 179.5, client_uuid: kKey });
    await expect(weight.updateWeight(b, aWeight.id, { weight_lbs: 1 })).rejects.toThrow(NotFoundException);
    // A resend after the edit answers with the edited row (the stored row is the answer).
    expect((await weight.logWeight(a, { weight_lbs: 180, date: '2026-10-27', client_uuid: kKey })).weight_lbs).toBe(179.5);
    await weight.deleteWeight(a, aWeight.id);
    expect(await prisma.weightLog.count({ where: { id: aWeight.id } })).toBe(0);

    const aWater = await water.logWater(a, { amount_ml: 600, client_uuid: wKey });
    await expect(water.deleteEntry(b, aWater.id)).rejects.toThrow(NotFoundException);
    expect(await water.deleteEntry(a, aWater.id)).toEqual({ id: aWater.id, deleted: true });
    const resent = await water.logWater(a, { amount_ml: 600, client_uuid: wKey });
    expect(resent.id).not.toBe(aWater.id);
    expect(await prisma.waterLog.count({ where: { client_uuid: wKey } })).toBe(1);
  });

  it("K4: the member's data download holds their rows with the key; erasure takes them and leaves others' rows", async () => {
    const wKey = randomUUID();
    const kKey = randomUUID();
    const aWater = await water.logWater(a, { amount_ml: 750, client_uuid: wKey });
    const aWeight = await weight.logWeight(a, { weight_lbs: 178, date: '2026-10-26', client_uuid: kKey });
    const bWater = await water.logWater(b, { amount_ml: 300, client_uuid: randomUUID() });
    const exporter = new DataExportService(prisma);
    const build = Reflect.get(exporter, '_buildArchive') as (u: string, e: string) => Promise<{ buffer: Buffer }>;
    const download = async (who: string): Promise<Record<string, Array<Record<string, unknown>>>> =>
      JSON.parse((await build.call(exporter, who, randomUUID())).buffer.toString('utf8'));
    const ids = (rows: Array<{ id: unknown }>) => rows.map((r) => String(r.id)).sort();
    const aDownload = await download(a);
    expect(ids(aDownload.water_logs)).toEqual(ids(await waterOf(a)));
    expect(ids(aDownload.weight_logs)).toEqual(ids(await weightOf(a)));
    expect(aDownload.water_logs).toContainEqual(expect.objectContaining({ id: aWater.id, amount_ml: 750, client_uuid: wKey }));
    expect(aDownload.weight_logs).toContainEqual(expect.objectContaining({ id: aWeight.id, weight_lbs: 178, client_uuid: kKey }));
    expect(ids(aDownload.water_logs)).not.toContain(bWater.id);
    expect((await download(h)).water_logs).toEqual([]);

    const steps = ERASURE_MANIFEST.filter((e) => e.model === 'WeightLog' || e.model === 'WaterLog');
    expect(steps.map((e) => [e.model, e.field, e.action.op])).toEqual([['WeightLog', 'user_id', 'delete'], ['WaterLog', 'user_id', 'delete']]);
    const bRows = [ids(await waterOf(b)), ids(await weightOf(b))];
    await prisma.$transaction((tx: Prisma.TransactionClient) => executeErasureManifest(tx,
      { userId: a, email: `${a}@example.test`, tombstoneEmail: `${randomUUID()}@example.test`, now: new Date() }, steps));
    expect([(await waterOf(a)).length, (await weightOf(a)).length]).toEqual([0, 0]);
    expect([ids(await waterOf(b)), ids(await weightOf(b))]).toEqual(bRows);
    // The keys are free again once the rows are erased.
    expect(await prisma.waterLog.count({ where: { client_uuid: wKey } })).toBe(0);
  });
});
