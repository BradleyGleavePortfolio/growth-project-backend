/**
 * IMPORTER I1a — LIVE-DB proof of the ScoutIngestEntity idempotency key.
 *
 * The structural guard (test/scout/scout-ingest.idempotency.spec.ts) proves the
 * key is *declared* right; only a real Postgres proves behaviour, because
 * `createMany({ skipDuplicates: true })` is INSERT ... ON CONFLICT DO NOTHING and
 * never raises P2002 — a silently discarded entity and a deduped replay are
 * indistinguishable to the caller (`deduped = received - count`). So this suite
 * applies the REAL migration SQL (the 20261222000000 create, then the
 * 20261224000100 widening) through psql, as CI and an operator deploy it, and
 * drives the generated client against it.
 *
 * DESTRUCTIVE, DISPOSABLE DB ONLY: beforeAll DROPs and recreates the table, so it
 * runs only when SCOUT_INGEST_TEST_DATABASE_URL — a dedicated var, never the app
 * `DATABASE_URL` — points at a throwaway database. Unset means a loud skip (R69);
 * the CI job running it fails if it skips. Requires `psql` on PATH.
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const RAW_TEST_DB_URL = process.env.SCOUT_INGEST_TEST_DATABASE_URL || '';
// psql rejects Prisma-only params (connection_limit, schema, pgbouncer).
const PSQL_URL = RAW_TEST_DB_URL.split('?')[0];

const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const SHIM_SQL = join(REPO_ROOT, 'scripts', 'ci', 'supabase-shim.sql');
const CREATE_SQL = join(MIGRATIONS, '20261222000000_scout_ingest_entity', 'migration.sql');
const WIDEN_DIR = join(MIGRATIONS, '20261224000100_scout_ingest_entity_type_uniqueness');

const COACH = 'coach-i1a';
const INTENT = 'intent-i1a';

type Row = Prisma.ScoutIngestEntityCreateManyInput;
type RlsFlags = { relrowsecurity: boolean; relforcerowsecurity: boolean };

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
  console.warn('[rls-scout-ingest-uniqueness] SKIPPED — SCOUT_INGEST_TEST_DATABASE_URL unset.');
}

describeOrSkip('IMPORTER I1a — ScoutIngestEntity uniqueness (live Postgres)', () => {
  let prisma: PrismaClient;

  /** Apply a migration file as CI and an operator do: psql, ON_ERROR_STOP, the
   *  file's own BEGIN/COMMIT. Prisma's raw API cannot — it sends one prepared
   *  statement per call, so a multi-statement file always dies with `42601 cannot
   *  insert multiple commands into a prepared statement`, which would make the
   *  rollback-refusal assertion below pass vacuously. Non-zero psql exit throws,
   *  so a genuine refusal stays observable. */
  function applySqlFile(file: string): void {
    execFileSync('psql', [PSQL_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** The production write path; `count` becomes the service's `received - deduped`. */
  function insertBatch(...data: Row[]): Promise<{ count: number }> {
    return prisma.scoutIngestEntity.createMany({ data, skipDuplicates: true });
  }

  /** Index names on the table, from the live catalog. */
  async function indexNames(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ScoutIngestEntity'`,
    );
    return rows.map((i) => i.indexname);
  }

  /** Drop and rebuild the table at the CURRENT (widened) key. */
  async function resetToWidened(): Promise<void> {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "ScoutIngestEntity" CASCADE');
    applySqlFile(CREATE_SQL);
    applySqlFile(join(WIDEN_DIR, 'migration.sql'));
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: RAW_TEST_DB_URL } } });
    await prisma.$connect();
    applySqlFile(SHIM_SQL);
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
      const { count } = await insertBatch(
        row({ id: 'a', entity_type: 'client', source_id: '1042' }),
        row({ id: 'b', entity_type: 'workout', source_id: '1042' }),
      );

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
      const { count } = await insertBatch(
        row({ id: 'a', entity_type: 'client', source_id: '1' }),
        row({ id: 'b', entity_type: 'workout', source_id: '1' }),
        row({ id: 'c', entity_type: 'exercise', source_id: '1' }),
      );
      expect(received - count).toBe(0);
    });
  });

  describe('replay-safety is preserved, not traded away', () => {
    it('treats a full 4-tuple replay as a no-op', async () => {
      const original = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await insertBatch(original);

      const replay = await insertBatch({ ...original, id: 'a-retry' });

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
      await insertBatch(first);

      const laterObservation = await insertBatch({
        ...first,
        id: 'b',
        captured_at: new Date('2026-07-28T00:00:00.000Z'),
      });

      expect(laterObservation.count).toBe(0);
      expect(await prisma.scoutIngestEntity.count()).toBe(1);
    });

    it('collapses in-batch duplicates of the same 4-tuple', async () => {
      const { count } = await insertBatch(
        row({ id: 'a', entity_type: 'client', source_id: '1042' }),
        row({ id: 'b', entity_type: 'client', source_id: '1042' }),
      );
      expect(count).toBe(1);
    });

    it('starts a new observation series for a different intent_id', async () => {
      const base = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await insertBatch(base);

      const nextSession = await insertBatch({ ...base, id: 'b', intent_id: 'intent-2' });

      expect(nextSession.count).toBe(1);
      expect(await prisma.scoutIngestEntity.count()).toBe(2);
    });

    it('scopes the key per coach — another coach is never deduped against this one', async () => {
      const base = row({ id: 'a', entity_type: 'client', source_id: '1042' });
      await insertBatch(base);

      const otherCoach = await insertBatch({ ...base, id: 'b', coach_id: 'coach-other' });

      expect(otherCoach.count).toBe(1);
    });
  });

  describe('R106 — down-migration dry-run, both directions', () => {
    it('reverses cleanly when no row depends on the widened key', async () => {
      applySqlFile(join(WIDEN_DIR, 'down.sql'));

      const names = await indexNames();
      expect(names).toContain('ScoutIngestEntity_coach_id_intent_id_source_id_key');
      expect(names).not.toContain('ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key');

      await resetToWidened();
    });

    it('REFUSES to reverse — rather than delete data — when rows only the widened key permits exist', async () => {
      await insertBatch(
        row({ id: 'a', entity_type: 'client', source_id: '1042' }),
        row({ id: 'b', entity_type: 'workout', source_id: '1042' }),
      );

      // The narrow index cannot be built over these two rows, so down.sql must
      // abort with a duplicate-key error and leave every row in place.
      expect(() => applySqlFile(join(WIDEN_DIR, 'down.sql'))).toThrow(/duplicat/i);
      expect(await prisma.scoutIngestEntity.count()).toBe(2);
      expect(await indexNames()).toContain(
        'ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key',
      );
    });
  });

  describe('RLS posture survives the index swap', () => {
    it('keeps ENABLE + FORCE row level security on the table', async () => {
      const [rls] = await prisma.$queryRawUnsafe<RlsFlags[]>(
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
