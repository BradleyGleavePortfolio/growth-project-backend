/**
 * IMPORTER I1a — LIVE-DB proof of the ScoutIngestEntity idempotency key.
 *
 * The structural guard (test/scout/scout-ingest.idempotency.spec.ts) proves the
 * key is *declared* correctly. It cannot prove the thing that actually matters,
 * because the defect it replaces was invisible at the type level: Prisma's
 * `createMany({ skipDuplicates: true })` compiles to INSERT ... ON CONFLICT DO
 * NOTHING, which never raises P2002. A colliding row does not error — it simply
 * never lands, and `deduped = received - count` then reports the lost row as a
 * successful replay. Only a real Postgres can distinguish "deduped a replay"
 * from "silently discarded a distinct entity".
 *
 * This suite applies the REAL migration SQL verbatim (the 20261222000000 create
 * followed by the 20261224000100 widening) rather than a Prisma schema diff, so
 * it asserts against the migration output an operator will actually deploy, and
 * then exercises the real `createMany` path through the generated client.
 *
 * What it proves:
 *   1. Two entity_types sharing a source_id within one intent BOTH persist
 *      (the P0 fix; this returned count 1 and lost a row before the widening).
 *   2. A true 4-tuple replay is still a no-op — replay-safety is not traded away.
 *   3. captured_at is still OUT of the key: a re-observation with a fresh
 *      timestamp is a replay, not a new row (original R-IDEMP-1, preserved).
 *   4. A different intent_id starts a new observation series and inserts.
 *   5. R106 down-migration dry-run, both directions, including the DOCUMENTED
 *      asymmetry: the reverse NARROWS the key and therefore correctly REFUSES
 *      when rows exist that only the widened key permits, rather than deleting
 *      a coach's crawl data to satisfy a constraint.
 *   6. The RLS posture survives the index swap (ENABLE + FORCE + deny-all
 *      RESTRICTIVE policies for anon and authenticated).
 *
 * Live-DB gating (repo pattern, R66/R69): matched by `jest.rls.config.js`
 * (test/rls-*.spec.ts). Connects when `SCOUT_INGEST_TEST_DATABASE_URL` is set;
 * otherwise `describe.skip` with a logged reason — never a silent pass. A
 * DEDICATED env var, never the app `DATABASE_URL`: beforeAll DROPs and recreates
 * the table, which would destroy a real database.
 *
 * To run locally:
 *   1. docker run -e POSTGRES_PASSWORD=pw -p 55433:5432 -d postgres:16
 *   2. SCOUT_INGEST_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:55433/postgres \
 *        npx jest --config jest.rls.config.js test/rls-scout-ingest-uniqueness --runInBand
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const RAW_TEST_DB_URL = process.env.SCOUT_INGEST_TEST_DATABASE_URL || '';

const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const SHIM_SQL = join(REPO_ROOT, 'scripts', 'ci', 'supabase-shim.sql');
const CREATE_SQL = join(MIGRATIONS, '20261222000000_scout_ingest_entity', 'migration.sql');
const WIDEN_DIR = join(MIGRATIONS, '20261224000100_scout_ingest_entity_type_uniqueness');

const COACH = 'coach-i1a';
const INTENT = 'intent-i1a';

type Row = Prisma.ScoutIngestEntityCreateManyInput;

function row(overrides: Partial<Row> & Pick<Row, 'id' | 'entity_type' | 'source_id'>): Row {
  return {
    coach_id: COACH,
    intent_id: INTENT,
    source_platform: 'truecoach',
    captured_at: new Date('2026-07-27T00:00:00.000Z'),
    payload: {},
    ...overrides,
  };
}

const describeOrSkip = RAW_TEST_DB_URL ? describe : describe.skip;

if (!RAW_TEST_DB_URL) {
  // Loud, not silent (R69): an unset URL means UNPROVEN, not PASSED.
  // eslint-disable-next-line no-console
  console.warn(
    '[rls-scout-ingest-uniqueness] SKIPPED — set SCOUT_INGEST_TEST_DATABASE_URL to a throwaway Postgres to run the live proof.',
  );
}

describeOrSkip('IMPORTER I1a — ScoutIngestEntity uniqueness (live Postgres)', () => {
  let prisma: PrismaClient;

  /** Apply a .sql file as a single batch. Throws on any error. */
  async function applySqlFile(client: PrismaClient, file: string): Promise<void> {
    await client.$executeRawUnsafe(readFileSync(file, 'utf8'));
  }

  /** Drop and rebuild the table at the CURRENT (widened) key. */
  async function resetToWidened(): Promise<void> {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "ScoutIngestEntity" CASCADE');
    await applySqlFile(prisma, CREATE_SQL);
    await applySqlFile(prisma, join(WIDEN_DIR, 'migration.sql'));
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: RAW_TEST_DB_URL } } });
    await prisma.$connect();
    await applySqlFile(prisma, SHIM_SQL);
    await resetToWidened();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ScoutIngestEntity"');
  });

  describe('the P0 fix — entity_type is part of the identity', () => {
    it('persists two entity_types that share a source_id within one intent', async () => {
      const { count } = await prisma.scoutIngestEntity.createMany({
        data: [
          row({ id: 'a', entity_type: 'client', source_id: '1042' }),
          row({ id: 'b', entity_type: 'workout', source_id: '1042' }),
        ],
        skipDuplicates: true,
      });

      // Before the widening this was 1, and the caller reported deduped = 1 —
      // a lost entity indistinguishable from a replay.
      expect(count).toBe(2);

      const stored = await prisma.scoutIngestEntity.findMany({
        where: { coach_id: COACH, intent_id: INTENT, source_id: '1042' },
        orderBy: { entity_type: 'asc' },
        select: { entity_type: true },
      });
      expect(stored.map((r) => r.entity_type)).toEqual(['client', 'workout']);
    });

    it('reports deduped = 0 when every entity in the batch is distinct', async () => {
      const received = 3;
      const { count } = await prisma.scoutIngestEntity.createMany({
        data: [
          row({ id: 'a', entity_type: 'client', source_id: '1' }),
          row({ id: 'b', entity_type: 'workout', source_id: '1' }),
          row({ id: 'c', entity_type: 'exercise', source_id: '1' }),
        ],
        skipDuplicates: true,
      });
      expect(received - count).toBe(0);
    });
  });

  describe('replay-safety is preserved, not traded away', () => {
    it('treats a full 4-tuple replay as a no-op', async () => {
      const original = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await prisma.scoutIngestEntity.createMany({ data: [original], skipDuplicates: true });

      const replay = await prisma.scoutIngestEntity.createMany({
        data: [{ ...original, id: 'a-retry' }],
        skipDuplicates: true,
      });

      expect(replay.count).toBe(0);
      expect(await prisma.scoutIngestEntity.count()).toBe(1);
    });

    it('keeps captured_at OUT of the key — a fresh timestamp is a replay, not a new row', async () => {
      const first = row({
        id: 'a',
        entity_type: 'client',
        source_id: '1042',
        captured_at: new Date('2026-07-27T00:00:00.000Z'),
      });
      await prisma.scoutIngestEntity.createMany({ data: [first], skipDuplicates: true });

      const laterObservation = await prisma.scoutIngestEntity.createMany({
        data: [{ ...first, id: 'b', captured_at: new Date('2026-07-28T00:00:00.000Z') }],
        skipDuplicates: true,
      });

      expect(laterObservation.count).toBe(0);
      expect(await prisma.scoutIngestEntity.count()).toBe(1);
    });

    it('collapses in-batch duplicates of the same 4-tuple', async () => {
      const { count } = await prisma.scoutIngestEntity.createMany({
        data: [
          row({ id: 'a', entity_type: 'client', source_id: '1042' }),
          row({ id: 'b', entity_type: 'client', source_id: '1042' }),
        ],
        skipDuplicates: true,
      });
      expect(count).toBe(1);
    });

    it('starts a new observation series for a different intent_id', async () => {
      const base = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await prisma.scoutIngestEntity.createMany({ data: [base], skipDuplicates: true });

      const nextSession = await prisma.scoutIngestEntity.createMany({
        data: [{ ...base, id: 'b', intent_id: 'intent-2' }],
        skipDuplicates: true,
      });

      expect(nextSession.count).toBe(1);
      expect(await prisma.scoutIngestEntity.count()).toBe(2);
    });

    it('scopes the key per coach — another coach is never deduped against this one', async () => {
      const base = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await prisma.scoutIngestEntity.createMany({ data: [base], skipDuplicates: true });

      const otherCoach = await prisma.scoutIngestEntity.createMany({
        data: [{ ...base, id: 'b', coach_id: 'coach-other' }],
        skipDuplicates: true,
      });

      expect(otherCoach.count).toBe(1);
    });
  });

  describe('R106 — down-migration dry-run, both directions', () => {
    it('reverses cleanly when no row depends on the widened key', async () => {
      await applySqlFile(prisma, join(WIDEN_DIR, 'down.sql'));

      const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ScoutIngestEntity'`,
      );
      const names = indexes.map((i) => i.indexname);
      expect(names).toContain('ScoutIngestEntity_coach_id_intent_id_source_id_key');
      expect(names).not.toContain('ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key');

      await resetToWidened();
    });

    it('REFUSES to reverse — rather than delete data — when rows only the widened key permits exist', async () => {
      await prisma.scoutIngestEntity.createMany({
        data: [
          row({ id: 'a', entity_type: 'client', source_id: '1042' }),
          row({ id: 'b', entity_type: 'workout', source_id: '1042' }),
        ],
        skipDuplicates: true,
      });

      // The narrow index cannot be built over these two rows. The documented
      // contract is that down.sql aborts and leaves the data intact.
      await expect(applySqlFile(prisma, join(WIDEN_DIR, 'down.sql'))).rejects.toThrow();
      expect(await prisma.scoutIngestEntity.count()).toBe(2);

      const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ScoutIngestEntity'`,
      );
      expect(indexes.map((i) => i.indexname)).toContain(
        'ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key',
      );
    });
  });

  describe('RLS posture survives the index swap', () => {
    it('keeps ENABLE + FORCE row level security on the table', async () => {
      const [rls] = await prisma.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ScoutIngestEntity'`,
      );
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);
    });

    it('keeps RESTRICTIVE deny-all for anon and authenticated, and the service_role bypass', async () => {
      const policies = await prisma.$queryRawUnsafe<{ policyname: string; permissive: string }[]>(
        `SELECT policyname, permissive FROM pg_policies WHERE tablename = 'ScoutIngestEntity'`,
      );
      const byName = new Map(policies.map((p) => [p.policyname, p.permissive]));

      expect(byName.get('deny_all_anon_scout_ingest')).toBe('RESTRICTIVE');
      expect(byName.get('deny_all_authenticated_scout_ingest')).toBe('RESTRICTIVE');
      expect(byName.get('p_scout_ingest_service_role_all')).toBe('PERMISSIVE');
    });
  });
});
