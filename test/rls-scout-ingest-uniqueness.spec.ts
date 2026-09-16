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

import { scoutIngestTestTarget } from './utils/scout-ingest-db';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { ScoutReconstructService } from '../src/scout/scout-reconstruct.service';
import { ScoutIngestService } from '../src/scout/scout-ingest.service';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';

const RAW_TEST_DB_URL = process.env.SCOUT_INGEST_TEST_DATABASE_URL || '';
const TARGET = RAW_TEST_DB_URL
  ? scoutIngestTestTarget(RAW_TEST_DB_URL, process.env.SCOUT_INGEST_TEST_CONFIRM)
  : null;
const PSQL_URL = TARGET?.psqlUrl ?? '';

const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');
const SHIM_SQL = join(REPO_ROOT, 'scripts', 'ci', 'supabase-shim.sql');
const CREATE_SQL = join(MIGRATIONS, '20261222000000_scout_ingest_entity', 'migration.sql');
const WIDEN_DIR = join(MIGRATIONS, '20261224000100_scout_ingest_entity_type_uniqueness');

const PLATFORM_DIR = WIDEN_DIR;
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
    execFileSync('psql', [PSQL_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        PGOPTIONS: '-csearch_path=public -clock_timeout=5s -cstatement_timeout=20s',
      },
    });
  }

  /** The production write path; `count` becomes the service's `received - deduped`. */
  function insertBatch(...data: Row[]): Promise<{ count: number }> {
    return prisma.scoutIngestEntity.createMany({ data, skipDuplicates: true });
  }

  /** Index names on the table, from the live catalog. */
  async function indexNames(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ScoutIngestEntity'`,
    );
    return rows.map((i) => i.indexname);
  }

  /** Drop and rebuild the table at the CURRENT (widened) key. */
  async function resetToWidened(platform = true): Promise<void> {
    for (const table of [
      'ScoutIngestEntity',
      'ScoutReconstructionLedger',
      'Person',
      'ScoutReconstructedEntity',
      'ScoutImport',
    ]) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    }
    await prisma.$executeRawUnsafe('DROP TYPE IF EXISTS public."PersonState"');
    applySqlFile(CREATE_SQL);
    for (const migration of [
      '20261223000100_scout_import_state',
      '20261223000200_scout_reconstruction',
      '20261223000300_scout_reconstructed_entity',
    ]) {
      applySqlFile(join(MIGRATIONS, migration, 'migration.sql'));
    }
    if (platform) applySqlFile(join(PLATFORM_DIR, 'migration.sql'));
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TARGET?.prismaUrl } } });
    await prisma.$connect();
    applySqlFile(SHIM_SQL);
    await resetToWidened();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger", public."ScoutImport", public."Person", public."ScoutReconstructedEntity"',
    );
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
    it('treats a full 5-tuple replay as a no-op', async () => {
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

    it('collapses in-batch duplicates of the same 5-tuple', async () => {
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
      await insertBatch(
        row({
          id: 'roundtrip',
          entity_type: 'clients',
          source_id: 'roundtrip',
          payload: { untouched: true },
        }),
      );
      const before = await prisma.scoutIngestEntity.findMany();
      try {
        applySqlFile(join(WIDEN_DIR, 'down.sql'));

        const names = await indexNames();
        expect(names).toContain('ScoutIngestEntity_coach_id_intent_id_source_id_key');
        expect(names).not.toContain('ScoutIngestEntity_identity_key');
        expect(await prisma.scoutIngestEntity.findMany()).toEqual(before);
        applySqlFile(join(WIDEN_DIR, 'migration.sql'));
        expect(await prisma.scoutIngestEntity.findMany()).toEqual(before);
      } finally {
        await resetToWidened();
      }
    });

    it('REFUSES to reverse — rather than delete data — when rows only the widened key permits exist', async () => {
      await insertBatch(
        row({ id: 'a', entity_type: 'client', source_id: '1042' }),
        row({ id: 'b', entity_type: 'workout', source_id: '1042' }),
      );

      // The narrow index cannot be built over these two rows, so down.sql must
      // abort with a duplicate-key error and leave every row in place.
      try {
        expect(() => applySqlFile(join(WIDEN_DIR, 'down.sql'))).toThrow(/duplicat/i);
        expect(await prisma.scoutIngestEntity.count()).toBe(2);
        expect(await indexNames()).toContain('ScoutIngestEntity_identity_key');
      } finally {
        await resetToWidened();
      }
    });
  });

  describe('RLS posture survives the index swap', () => {
    it('keeps ENABLE + FORCE row level security on the table', async () => {
      const [rls] = await prisma.$queryRawUnsafe<RlsFlags[]>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."ScoutIngestEntity"'::regclass`,
      );
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);
    });

    it('keeps exact restrictive client denial and permissive service policy semantics', async () => {
      const policies = await prisma.$queryRawUnsafe<
        {
          policyname: string;
          permissive: string;
          roles: string[];
          cmd: string;
          qual: string;
          with_check: string;
        }[]
      >(
        `SELECT policyname, permissive, roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ScoutIngestEntity'`,
      );
      const byName = new Map(policies.map((p) => [p.policyname, p.permissive]));

      expect(byName.get('deny_all_anon_scout_ingest')).toBe('RESTRICTIVE');
      expect(byName.get('deny_all_authenticated_scout_ingest')).toBe('RESTRICTIVE');
      expect(byName.get('p_scout_ingest_service_role_all')).toBe('PERMISSIVE');
      expect(policies).toHaveLength(3);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(policies.find((p) => p.roles.includes(role))).toMatchObject({
          roles: [role],
          cmd: 'ALL',
          qual: role === 'service_role' ? 'true' : 'false',
          with_check: role === 'service_role' ? 'true' : 'false',
        });
      }
    });
  });
  describe('R2 discriminating integrity regressions', () => {
    it('persists the same source ID on two platforms through the real service and replays unchanged', async () => {
      const db = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
        scoutIngestEntity: prisma.scoutIngestEntity,
      });
      const analytics = Object.assign(
        Object.create(AnalyticsService.prototype) as AnalyticsService,
        { capture: jest.fn() },
      );
      const service = new ScoutIngestService(db, analytics);
      const entities = ['truecoach', 'conformance_alpha'].map((sourcePlatform) => ({
        sourceId: '1042',
        sourcePlatform,
        capturedAt: '2026-09-15T12:00:00Z',
        payload: { title: sourcePlatform },
      }));
      const dto = { intent_id: INTENT, entity_type: 'workouts', entities };
      expect(await service.ingest(COACH, dto)).toEqual({ received: 2, deduped: 0 });
      const before = await prisma.scoutIngestEntity.findMany({
        orderBy: { source_platform: 'asc' },
      });
      expect(
        await service.ingest(COACH, {
          ...dto,
          entities: entities.map((e) => ({
            ...e,
            capturedAt: '2026-09-16T00:00:00Z',
            payload: { title: 'changed' },
          })),
        }),
      ).toEqual({ received: 2, deduped: 2 });
      expect(
        await prisma.scoutIngestEntity.findMany({ orderBy: { source_platform: 'asc' } }),
      ).toEqual(before);
    });
    it('ignores a same-named table in a different schema in catalog lookups', async () => {
      await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS ingest_r2_decoy');
      await prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS ingest_r2_decoy."ScoutIngestEntity" (id text)',
      );
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS ingest_r2_decoy_only ON ingest_r2_decoy."ScoutIngestEntity" (id)',
      );
      expect(await indexNames()).not.toContain('ingest_r2_decoy_only');
    });
    it('refuses repeated raw migration execution atomically (Prisma history owns reruns)', async () => {
      await insertBatch(row({ id: 'rerun', entity_type: 'clients', source_id: 'rerun' }));
      const before = await indexNames();
      expect(() => applySqlFile(join(PLATFORM_DIR, 'migration.sql'))).toThrow();
      expect(await indexNames()).toEqual(before);
      expect(await prisma.scoutIngestEntity.count()).toBe(1);
    });
  });

  it('targets the public table/index OIDs in BOTH directions despite a shadow schema', async () => {
    const old = 'ScoutIngestEntity_coach_id_intent_id_source_id_key';
    const wide = 'ScoutIngestEntity_identity_key';
    try {
      await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS ingest_r2_shadow');
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS ingest_r2_shadow.decoy');
      await prisma.$executeRawUnsafe('CREATE TABLE ingest_r2_shadow.decoy (id text)');
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "${old}" ON ingest_r2_shadow.decoy (id)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "${wide}" ON ingest_r2_shadow.decoy (id)`,
      );
      await resetToWidened(false);
      const shadowApply = (file: string) =>
        execFileSync(
          'psql',
          [
            PSQL_URL,
            '-X',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            'SET search_path = ingest_r2_shadow, public',
            '-f',
            file,
          ],
          { timeout: 30000 },
        );
      shadowApply(join(WIDEN_DIR, 'migration.sql'));
      expect(
        await insertBatch(
          row({ id: 'shadow-a', entity_type: 'clients', source_id: '1' }),
          row({ id: 'shadow-b', entity_type: 'workouts', source_id: '1' }),
        ),
      ).toEqual({ count: 2 });
      await prisma.$executeRawUnsafe('TRUNCATE public."ScoutIngestEntity"');
      shadowApply(join(WIDEN_DIR, 'down.sql'));
      const decoys = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='ingest_r2_shadow' AND tablename='decoy'",
      );
      expect(decoys.map((r) => r.indexname).sort()).toEqual([old, wide].sort());
    } finally {
      await resetToWidened();
    }
  });

  it('reconstructs and replays identical IDs across platforms without losing ledger counts', async () => {
    await insertBatch(
      ...['truecoach', 'conformance_alpha', 'unknown'].map((source_platform) =>
        row({ id: source_platform, source_platform, entity_type: 'workouts', source_id: '1042' }),
      ),
    );
    await prisma.scoutImport.create({
      data: { coach_id: COACH, intent_id: INTENT, terminal_status: 'success' },
    });
    const db = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
      scoutIngestEntity: prisma.scoutIngestEntity,
      scoutReconstructionLedger: prisma.scoutReconstructionLedger,
      scoutImport: prisma.scoutImport,
      $transaction: prisma.$transaction.bind(prisma),
    });
    const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
      capture: jest.fn(),
    });
    const service = new ScoutReconstructService(db, analytics);
    const first = await service.reconstruct(COACH, INTENT, 'workouts');
    expect(first).toMatchObject({ staged: 3, reconstructed: 2, skipped: 1, failed: 0 });
    expect(await service.reconstruct(COACH, INTENT, 'workouts')).toEqual(first);
    expect(await prisma.scoutReconstructionLedger.count()).toBe(3);
    expect(await prisma.scoutReconstructedEntity.count()).toBe(2);
  });
  it('backfills exact ledger provenance and refuses orphaned history without fabricating a platform', async () => {
    try {
      await resetToWidened(false);
      await insertBatch(row({ id: 'backfill', entity_type: 'clients', source_id: '1042' }));
      await prisma.$executeRawUnsafe(`INSERT INTO public."ScoutReconstructionLedger"
        (id, coach_id, intent_id, entity_type, source_id, status) VALUES
        ('backfill', 'coach-i1a', 'intent-i1a', 'clients', '1042', 'skipped')`);
      applySqlFile(join(PLATFORM_DIR, 'migration.sql'));
      expect(
        await prisma.scoutReconstructionLedger.findUnique({ where: { id: 'backfill' } }),
      ).toMatchObject({ source_platform: 'truecoach', status: 'skipped' });
      applySqlFile(join(PLATFORM_DIR, 'down.sql'));
      await prisma.$executeRawUnsafe('TRUNCATE public."ScoutIngestEntity"');
      expect(() => applySqlFile(join(PLATFORM_DIR, 'migration.sql'))).toThrow(/null/i);
      expect(await indexNames()).toContain('ScoutIngestEntity_coach_id_intent_id_source_id_key');
      const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ScoutReconstructionLedger'",
      );
      expect(columns.map((c) => c.column_name)).not.toContain('source_platform');
    } finally {
      await resetToWidened();
    }
  });
  it('refuses a platform-losing rollback atomically', async () => {
    await insertBatch(
      row({ id: 'a', entity_type: 'clients', source_id: '1042' }),
      row({
        id: 'b',
        entity_type: 'clients',
        source_id: '1042',
        source_platform: 'conformance_alpha',
      }),
    );
    expect(() => applySqlFile(join(PLATFORM_DIR, 'down.sql'))).toThrow(/duplicat/i);
    expect(await indexNames()).toContain('ScoutIngestEntity_identity_key');
    expect(await prisma.scoutIngestEntity.count()).toBe(2);
  });
  it('proves real non-superuser CRUD denial even with hostile permissive policy', async () => {
    await insertBatch(row({ id: 'rls', entity_type: 'clients', source_id: 'rls' }));
    const rollback = new Error('rollback test-only ACLs and roles');
    for (const role of ['anon', 'authenticated']) {
      const attributes = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${role}`;
      expect(attributes).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO anon, authenticated');
          await tx.$executeRawUnsafe(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON public."ScoutIngestEntity" TO anon, authenticated',
          );
          await tx.$executeRawUnsafe(
            'CREATE POLICY hostile_allow ON public."ScoutIngestEntity" FOR ALL TO PUBLIC USING (true) WITH CHECK (true)',
          );
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          expect(await tx.scoutIngestEntity.count()).toBe(0);
          expect(
            await tx.scoutIngestEntity.updateMany({ data: { entity_type: 'forbidden' } }),
          ).toEqual({ count: 0 });
          expect(await tx.scoutIngestEntity.deleteMany()).toEqual({ count: 0 });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'GRANT INSERT ON public."ScoutIngestEntity" TO anon, authenticated',
          );
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await tx.$executeRawUnsafe(`INSERT INTO public."ScoutIngestEntity" (id, coach_id, intent_id, entity_type, source_id, source_platform, payload)
          VALUES ('denied', 'x', 'x', 'x', 'x', 'truecoach', '{}')`);
        }),
      ).rejects.toMatchObject({ meta: { code: '42501' } });
    }
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE ROLE ingest_r2_policy_probe NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT',
        );
        await tx.$executeRawUnsafe('GRANT service_role TO ingest_r2_policy_probe');
        await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO ingest_r2_policy_probe');
        await tx.$executeRawUnsafe(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON public."ScoutIngestEntity" TO ingest_r2_policy_probe',
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE ingest_r2_policy_probe');
        expect(await tx.scoutIngestEntity.count()).toBe(1);
        await tx.scoutIngestEntity.create({
          data: row({ id: 'allowed', entity_type: 'clients', source_id: 'allowed' }),
        });
        expect(await tx.scoutIngestEntity.updateMany({ data: { entity_type: 'updated' } })).toEqual(
          { count: 2 },
        );
        expect(await tx.scoutIngestEntity.deleteMany()).toEqual({ count: 2 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await prisma.scoutIngestEntity.count()).toBe(1);
  });

  it('rolls back the first narrowing index when the ledger alone requires platform separation', async () => {
    await prisma.scoutReconstructionLedger.createMany({
      data: ['truecoach', 'conformance_alpha'].map((source_platform) => ({
        coach_id: COACH,
        intent_id: INTENT,
        entity_type: 'clients',
        source_id: 'ledger-only',
        source_platform,
        status: 'skipped',
      })),
    });
    expect(() => applySqlFile(join(PLATFORM_DIR, 'down.sql'))).toThrow(/duplicat/i);
    expect(await indexNames()).toContain('ScoutIngestEntity_identity_key');
    expect(await indexNames()).not.toContain('ScoutIngestEntity_coach_id_intent_id_source_id_key');
    expect(await prisma.scoutReconstructionLedger.count()).toBe(2);
  });
  it('refuses an unrelated public index instead of dropping it', async () => {
    try {
      await resetToWidened(false);
      await prisma.$executeRawUnsafe(
        'ALTER INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key" RENAME TO ingest_r2_saved_key',
      );
      await prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS public.ingest_r2_index_decoy (id text)',
      );
      await prisma.$executeRawUnsafe(
        'CREATE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key" ON public.ingest_r2_index_decoy (id)',
      );
      expect(() => applySqlFile(join(WIDEN_DIR, 'migration.sql'))).toThrow(
        /[Uu]nexpected identity index owner/i,
      );
      const index = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_indexes WHERE schemaname='public' AND indexname='ScoutIngestEntity_coach_id_intent_id_source_id_key'`,
      );
      expect(index).toEqual([{ tablename: 'ingest_r2_index_decoy' }]);
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.ingest_r2_index_decoy');
      await resetToWidened();
    }
  });
});
