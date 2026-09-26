/**
 * S11 G2 live proof — entry spec of the ONE S11 harness (docs/decisions/2026-09-26-s11-journey.md
 * D-S11-6, D-S11-8 row S11-A1). Run by jest.rls.config.js (testMatch `test/rls-*.spec.ts`).
 *
 * Derived from the landed test/rls-g2-s9c.spec.ts (as landed at 92b96715; unchanged) for its lane-identity and
 * tenant blocks only. This file owns: the lane identity (S11-only disposable PG17 lane, never
 * repaired here), the candidate binding, the two-host harness self-check (two worker processes are
 * two server hosts, each with its own OS process), the database-role posture of the journey tables,
 * and the legacy intent-string case J07 defers to ("Legacy intent strings are covered by a separate
 * case"). The J-cases themselves live in test/scout/s11/*.pg.spec.ts (J01-J08:
 * test/scout/s11/journey-core.pg.spec.ts), which later S11 slices extend; those files are run with
 * the default jest config and the same G2_S11_* environment, one file at a time, in band.
 *
 * Service level only: roles are labels, not signed-in users (B2, D-S11-1).
 */
import { execFileSync } from 'child_process';
import {
  ensureUser,
  intent,
  legacyRun,
  on,
  pairInit,
  progressOf,
  REGISTRY,
  resetData,
  runCount,
  SETUP_LABEL,
  snapshotRows,
  statusOf,
  TOKEN,
} from './utils/g2-s11-harness';
import {
  appliedMigrations,
  BASE_HEAD,
  candidateHead,
  directory,
  EXPECTED_MIGRATIONS,
  expectedVersion,
  jsonAdmin,
  root,
  run,
  S10B_MIGRATION,
  S10B_TABLES,
  sql,
  sqlAdmin,
  target,
} from './utils/g2-s11-pg-harness';

jest.setTimeout(300000);

const COACH = 's11-coach-a';
const OTHER = 's11-coach-b';
const LEGACY_INTENT = 'intent_legacy_s11';
const JOURNEY_TABLES = [
  'ImportIntent',
  'ExtensionPairCode',
  'ScoutImport',
  'ScoutProgressSnapshot',
];

beforeEach(() => resetData());
afterAll(() => resetData());

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S11 disposable PG17 lane at the accepted history through S10-B; S7-L, S8-B and S10-B objects present', () => {
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's11-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s11_disposable',
    });
    expect([55646, 55647]).not.toContain(target.port);
    expect(Number(appliedMigrations())).toBe(EXPECTED_MIGRATIONS);
    expect(
      sql(
        `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
      ),
    ).toBe(S10B_MIGRATION);
    expect(sql(`SELECT to_regclass('public."ImportNativeProvenance"') IS NOT NULL`)).toBe('t');
    for (const table of JOURNEY_TABLES)
      expect(sql(`SELECT to_regclass('public."${table}"') IS NOT NULL`)).toBe('t');
    // The landed S10-B tables: present with RLS ENABLED AND FORCED (fix 3).
    for (const table of S10B_TABLES)
      expect([
        table,
        sql(
          `SELECT relrowsecurity::text || '/' || relforcerowsecurity::text FROM pg_class WHERE oid=to_regclass('public."${table}"')`,
        ),
      ]).toEqual([table, 'true/true']);
    expect(
      sqlAdmin(`SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','authenticator')`),
    ).toBe('0');
  });

  it('is bound to one attested candidate head that descends from the base and adds no migration', () => {
    expect(candidateHead).toMatch(/^[0-9a-f]{40}$/);
    expect(candidateHead).not.toBe(BASE_HEAD);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(
      candidateHead,
    );
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', BASE_HEAD, candidateHead], {
        cwd: root,
        stdio: 'ignore',
      }),
    ).not.toThrow();
    expect(
      execFileSync(
        'git',
        [
          'diff',
          '--stat',
          BASE_HEAD,
          candidateHead,
          '--',
          'prisma/migrations',
          'prisma/schema.prisma',
        ],
        { cwd: root, encoding: 'utf8' },
      ).trim(),
    ).toBe('');
  });
});

describe('two hosts (D-S11-6): each step is its own OS process with its own ScoutService', () => {
  it('P1 and P2 are distinct processes over the same PG; the family registry is injected; removed donor actions are gone', async () => {
    const init = await pairInit('P1', COACH);
    expect(init.failure).toBeUndefined();
    const a = await statusOf('P1', COACH, init.result.import_intent_id);
    const b = await statusOf('P2', COACH, init.result.import_intent_id);
    // No run yet: the uniform 404 on both hosts (no row, no staged row, no snapshot).
    expect(a.failure).toMatchObject({ status: 404 });
    expect(b.failure).toEqual(a.failure);
    expect(new Set([init.pid, a.pid, b.pid, process.pid]).size).toBe(4);
    expect(a.families).toEqual(['clients', 'workouts', 'client_history', 'programs']);
    for (const action of ['report', 'reconstruct', 'run-pass', 'settled']) {
      const gone = await run({ ...REGISTRY, action, coach: COACH, intent: 'x' });
      expect([action, gone.failure?.status]).toEqual([action, 500]);
    }
    // A host label is never an input: the same call labelled P2 answers identically.
    const labelled = await on('P2', 'phone', { action: 'pair-current', coach: COACH });
    const unlabelled = await run({ ...REGISTRY, action: 'pair-current', coach: COACH });
    expect(labelled.result).toEqual(unlabelled.result);
    expect(labelled.result).toMatchObject({ status: 'pending', chosen_platform: SETUP_LABEL });
  });
});

describe('journey tables: database-role posture (tenant isolation below the service)', () => {
  it('anon and authenticated see no journey row (refused or zero) even when rows exist', () => {
    const i = intent(COACH);
    ensureUser(OTHER);
    sql(`INSERT INTO "ScoutProgressSnapshot" (id,coach_id,intent_id,device_id,snapshot)
      VALUES ('s11-snap-1','${COACH}','${i}','device-ext','{}'::jsonb)`);
    // Fix 3: one row in EACH S10-B table, seeded through the owner path (the parent run first, so
    // the composite FKs hold), so the API-role reads below are discriminating, never vacuous.
    legacyRun(COACH, i, null);
    const digest = 'a'.repeat(64);
    sql(`INSERT INTO "ScoutRunDeclaration"
      (coach_id,intent_id,source_platform,account_scope_id_digest,challenge,declared_at)
      VALUES ('${COACH}','${i}','s11-source','${digest}',decode(repeat('ab',32),'hex'),now())`);
    sql(`INSERT INTO "ScoutRunObservation" (id,coach_id,intent_id,execution_epoch,source_platform,
      account_scope_id_digest,family,basis_kind,evidence,evidence_digest,received_at)
      VALUES ('s11-obs-1','${COACH}','${i}',1,'s11-source','${digest}','clients',
        'source_signed_enumeration','{}'::jsonb,'${'b'.repeat(64)}',now())`);
    sql(`INSERT INTO "ScoutRunSettledBasis"
      (coach_id,intent_id,execution_epoch,report_version,report,observation_digests,settled_at)
      VALUES ('${COACH}','${i}',1,1,'{}'::jsonb,ARRAY['${'b'.repeat(64)}'],now())`);
    // Owner count >= 1 for every seeded table (ExtensionPairCode is not seeded by this case).
    for (const table of ['ImportIntent', 'ScoutImport', 'ScoutProgressSnapshot', ...S10B_TABLES])
      expect([table, Number(sql(`SELECT count(*) FROM "${table}"`)) >= 1]).toEqual([table, true]);
    for (const role of ['anon', 'authenticated']) {
      for (const table of [...JOURNEY_TABLES, ...S10B_TABLES]) {
        let seen: string;
        try {
          seen = sql(`SET ROLE ${role}; SELECT count(*) FROM "${table}"`);
        } catch (e) {
          seen = /permission denied/.test(String(e)) ? 'refused' : `error: ${String(e)}`;
        }
        expect([role, table, ['0', 'refused'].includes(seen)]).toEqual([role, table, true]);
      }
    }
  });
});

describe('J07 legacy strings (separate case): a non-UUID intent is B-owned mirror state, never shared', () => {
  it("B's /progress on a legacy string writes a B-keyed mirror; B reads it back; A and the run table see nothing", async () => {
    ensureUser(COACH);
    ensureUser(OTHER);
    const before = runCount();
    const aMissing = await statusOf('P1', COACH, LEGACY_INTENT);
    expect(aMissing.failure).toMatchObject({ status: 404 });
    const posted = await progressOf('P2', OTHER, LEGACY_INTENT, {
      flush: true,
      progress: [{ entity_type: TOKEN.clients, count_committed: 3, total_estimated: 4 }],
    });
    expect(posted.failure).toBeUndefined();
    expect(posted.queries.filter((q: string) => /SET last_observed_at\s*=/.test(q))).toEqual([]);
    expect(snapshotRows()).toEqual([
      {
        coach_id: OTHER,
        intent_id: LEGACY_INTENT,
        device_id: 'device-ext',
        snapshot: {
          intent_id: LEGACY_INTENT,
          progress: [{ entity_type: TOKEN.clients, count_committed: 3, total_estimated: 4 }],
        },
        last_error: null,
      },
    ]);
    const bRead = await statusOf('P1', OTHER, LEGACY_INTENT);
    expect(bRead.failure).toBeUndefined();
    expect(bRead.result).toMatchObject({ intent_id: LEGACY_INTENT, status: 'running' });
    expect(bRead.result.mode).not.toBe('server');
    expect(bRead.result.entity_counts).toEqual([]);
    // A still has nothing under that string, on either host; no run row appeared.
    for (const host of ['P1', 'P2'] as const) {
      const a = await statusOf(host, COACH, LEGACY_INTENT);
      expect(a.failure).toEqual(aMissing.failure);
    }
    expect(runCount()).toBe(before);
  });

  it('a settled legacy row of A stays legacy: B gets the uniform 404 for it, A reads its own terminal', async () => {
    legacyRun(COACH, LEGACY_INTENT, 'success');
    const a = await statusOf('P1', COACH, LEGACY_INTENT);
    expect(a.failure).toBeUndefined();
    expect(a.result).toMatchObject({
      mode: 'legacy',
      status: 'success',
      claimed_status: 'success',
    });
    const b = await statusOf('P2', OTHER, LEGACY_INTENT);
    expect(b.failure).toMatchObject({ status: 404 });
  });
});
