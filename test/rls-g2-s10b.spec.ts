/**
 * S10-B G2 live proof — run declaration + observation persistence
 * (docs/decisions/2026-09-26-s10-induction.md D-S10-2, D-S10-4; acceptance cases R29, R30, R31,
 * R32 of §3, tier B).
 *
 * Derived by substitution from the S9-C proof test/rls-g2-s9c.spec.ts (d3a9-s9c-r2, read-only):
 * same real psql, same real generated Prisma client, the real ObservationController →
 * ObservationService (+ ScoutLifecycleService / ScoutIngestService / ScoutService for the races) in
 * separate OS processes (test/utils/g2-s10b-worker.cjs), no query or transaction mocks. Only the
 * S10-B-only lane (test/utils/g2-s10b-db.ts, G2_S10B_*, port chosen and double-entered by the
 * operator) is ever touched.
 *
 * Proven here: the catalog is exactly the shipped one (three tables, FKs, keys, triggers, grants,
 * RLS); the routes' refusals and replays on real rows; the epoch bound under the lock; the
 * deletion controls (REVOKE + insert-only trigger, the nested-DELETE negative control, the parent
 * cascade positive control, the one-challenge trigger); the down refusal and drop; and the two
 * races serialising on the run row lock. What stored evidence PROVES is not tested here: storage
 * never verifies (S10-C's evaluator does).
 */
import { execFileSync } from 'child_process';
import {
  DECLARATION,
  declarationInsert,
  declarationRows,
  expire,
  gateSql,
  intent,
  legacyRun,
  OBSERVATION,
  observationInsert,
  observationRows,
  PLATFORM,
  PLATFORM_B,
  REGISTRY,
  resetData,
  runRow,
  S10_TABLES,
  serverRunInsert,
  SETTLED,
  settledInsert,
  stage,
  count,
} from './utils/g2-s10b-harness';
import {
  appliedMigrations,
  BASE_HEAD,
  blocked,
  candidateHead,
  directory,
  downSql,
  EXPECTED_MIGRATIONS,
  expectedVersion,
  holdTransaction,
  json,
  jsonAdmin,
  quote,
  refused,
  root,
  run,
  S10B_MIGRATION,
  sql,
  sqlAdmin,
  sqlAs,
  target,
  upSql,
  worker,
} from './utils/g2-s10b-pg-harness';
import { SCOPE_1, SCOPE_2 } from './utils/g2-s10b-fixtures';

jest.setTimeout(300000);

const COACH = 'coach';
const OTHER = 'other-coach';

const started = async (coach = COACH) => {
  const intentId = intent(coach);
  const start = await run({ action: 'start', coach, intent: intentId });
  expect(start.failure).toBeUndefined();
  return intentId;
};
const PLATFORMS = [
  { source_platform: PLATFORM_B, account_scope_id_digests: [SCOPE_1] },
  { source_platform: PLATFORM, account_scope_id_digests: [SCOPE_2, SCOPE_1] },
];
const declare = (intentId: string, platforms: unknown = PLATFORMS, coach = COACH) =>
  run({ ...REGISTRY, action: 'declare', coach, intent: intentId, body: { platforms } });
const observe = (
  intentId: string,
  evidence: Record<string, unknown>[] = [{}],
  coach = COACH,
  extra: Record<string, unknown> = {},
) => run({ ...REGISTRY, action: 'observe', coach, intent: intentId, body: { evidence }, ...extra });
const codeOf = (r: { failure?: any }) => r.failure?.response?.code;
/** Like `refused`, for a statement whose PostgreSQL discriminator is one of several texts. */
function refusedMatching(statement: string, pattern: RegExp): void {
  let error: unknown;
  try {
    sql(statement);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error('SQL unexpectedly succeeded');
  expect(String(error)).toMatch(pattern);
}
const noDeadlock = (r: { failure?: any }) => {
  expect(String(r.failure?.message ?? '')).not.toMatch(/deadlock/i);
  expect(r.failure?.code).not.toBe('P2034');
};

beforeEach(() => resetData());
afterAll(() => resetData());

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S10-B disposable PG17 lane at the accepted history plus the S10-B expand', () => {
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's10b-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s10b_disposable',
    });
    expect(Number(appliedMigrations())).toBe(EXPECTED_MIGRATIONS);
    expect(
      sql(
        `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
      ),
    ).toBe(S10B_MIGRATION);
    expect(
      sqlAdmin(`SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','authenticator')`),
    ).toBe('0');
  });

  it('is bound to one attested candidate head whose prisma diff is exactly schema + the S10-B migration', () => {
    expect(candidateHead).toMatch(/^[0-9a-f]{40}$/);
    expect(candidateHead).not.toBe(BASE_HEAD);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(
      candidateHead,
    );
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    expect(
      execFileSync('git', ['diff', '--name-only', BASE_HEAD, candidateHead, '--', 'prisma'], {
        cwd: root,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .sort(),
    ).toEqual([
      `prisma/migrations/${S10B_MIGRATION}/down.sql`,
      `prisma/migrations/${S10B_MIGRATION}/migration.sql`,
      'prisma/schema.prisma',
    ]);
  });
});

describe('R31 — catalog exactness', () => {
  it('three tables with forced RLS, exactly the shipped policies, grants, FKs, keys and triggers', () => {
    for (const t of S10_TABLES) {
      expect(
        sql(
          `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public."${t}"'::regclass`,
        ),
      ).toBe('t');
    }
    const policies = json(`SELECT jsonb_agg(jsonb_build_array(c.relname,p.polname,p.polpermissive,
        (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid = ANY(p.polroles)),
        pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname)
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      WHERE c.relname IN ('ScoutRunDeclaration','ScoutRunObservation','ScoutRunSettledBasis')`);
    const expected: unknown[] = [];
    for (const [table, slug] of [
      ['ScoutRunDeclaration', 'scout_run_declaration'],
      ['ScoutRunObservation', 'scout_run_observation'],
      ['ScoutRunSettledBasis', 'scout_run_settled_basis'],
    ]) {
      expected.push(
        [table, `deny_all_anon_${slug}`, false, ['anon'], 'false', 'false'],
        [table, `deny_all_authenticated_${slug}`, false, ['authenticated'], 'false', 'false'],
        [table, `p_${slug}_service_role_all`, true, ['service_role'], 'true', 'true'],
      );
    }
    expect(policies).toEqual(expected);
    // Grants: API roles nothing; service_role SELECT + INSERT only (DELETE/UPDATE REVOKEd).
    for (const t of S10_TABLES) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privs = json(`SELECT jsonb_build_object(
          'select',has_table_privilege(${quote(role)},'public."${t}"','SELECT'),
          'insert',has_table_privilege(${quote(role)},'public."${t}"','INSERT'),
          'update',has_table_privilege(${quote(role)},'public."${t}"','UPDATE'),
          'delete',has_table_privilege(${quote(role)},'public."${t}"','DELETE'),
          'truncate',has_table_privilege(${quote(role)},'public."${t}"','TRUNCATE'),
          'references',has_table_privilege(${quote(role)},'public."${t}"','REFERENCES'),
          'trigger',has_table_privilege(${quote(role)},'public."${t}"','TRIGGER'))`);
        const runtime = role === 'service_role';
        expect(privs).toEqual({
          select: runtime,
          insert: runtime,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        });
      }
    }
    const fks =
      json(`SELECT jsonb_agg(jsonb_build_array(conname,confrelid::regclass::text,confdeltype,confupdtype,convalidated) ORDER BY conname)
      FROM pg_constraint WHERE contype='f' AND conrelid IN ('public."ScoutRunDeclaration"'::regclass,
        'public."ScoutRunObservation"'::regclass,'public."ScoutRunSettledBasis"'::regclass)`);
    expect(fks).toEqual([
      ['ScoutRunDeclaration_coach_id_intent_id_fkey', '"ScoutImport"', 'c', 'r', true],
      ['ScoutRunObservation_coach_id_intent_id_fkey', '"ScoutImport"', 'c', 'r', true],
      ['ScoutRunObservation_declaration_fkey', '"ScoutRunDeclaration"', 'c', 'r', true],
      ['ScoutRunSettledBasis_coach_id_intent_id_fkey', '"ScoutImport"', 'c', 'r', true],
    ]);
    expect(sql(`SELECT pg_get_indexdef('public."ScoutRunObservation_unit_key"'::regclass)`)).toBe(
      'CREATE UNIQUE INDEX "ScoutRunObservation_unit_key" ON public."ScoutRunObservation" USING btree (coach_id, intent_id, execution_epoch, source_platform, account_scope_id_digest, family)',
    );
    expect(
      sql(`SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('public."ScoutRunDeclaration"'::regclass,'public."ScoutRunObservation"'::regclass,
          'public."ScoutRunSettledBasis"'::regclass)`),
    ).toBe(
      'ScoutRunDeclaration_insert_only,ScoutRunDeclaration_no_truncate,ScoutRunDeclaration_one_challenge,' +
        'ScoutRunObservation_insert_only,ScoutRunObservation_no_truncate,' +
        'ScoutRunSettledBasis_insert_only,ScoutRunSettledBasis_no_truncate',
    );
    expect(
      json(`SELECT jsonb_agg(jsonb_build_array(proname,prosecdef,proconfig) ORDER BY proname) FROM pg_proc
        WHERE proname IN ('scout_run_observation_insert_only','scout_run_declaration_one_challenge')`),
    ).toEqual([
      ['scout_run_declaration_one_challenge', false, ['search_path=""']],
      ['scout_run_observation_insert_only', false, ['search_path=""']],
    ]);
  });
});

describe('R29 — the declaration route on real rows', () => {
  it('accepted with zero staged rows: all rows share ONE challenge; a reordered exact replay returns it and writes nothing', async () => {
    const intentId = await started();
    const first = await declare(intentId);
    expect(first.failure).toBeUndefined();
    const rows = declarationRows(COACH, intentId);
    // declarationRows orders by (platform, scope digest), so the scopes are in sorted-digest order.
    const [lo, hi] = [SCOPE_1, SCOPE_2].sort();
    expect(rows.map((r) => [r.source_platform, r.account_scope_id_digest])).toEqual([
      [PLATFORM, lo],
      [PLATFORM, hi],
      [PLATFORM_B, SCOPE_1],
    ]);
    expect(new Set(rows.map((r) => r.challenge)).size).toBe(1);
    expect(Buffer.from(first.result.challenge_b64, 'base64').toString('hex')).toBe(
      rows[0].challenge,
    );
    const replay = await declare(intentId, [...PLATFORMS].reverse());
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(first.result);
    expect(declarationRows(COACH, intentId)).toEqual(rows);
  });

  it('changed / appended set → declaration_conflict before and after ingest; nothing written', async () => {
    const intentId = await started();
    expect((await declare(intentId)).failure).toBeUndefined();
    const before = declarationRows(COACH, intentId);
    const changed = [{ source_platform: PLATFORM, account_scope_id_digests: [SCOPE_1] }];
    expect(codeOf(await declare(intentId, changed))).toBe('declaration_conflict');
    stage(COACH, intentId, 'clients', 'c-1');
    const appended = [
      ...PLATFORMS,
      { source_platform: 'synthetic-src-c', account_scope_id_digests: [SCOPE_1] },
    ];
    expect(codeOf(await declare(intentId, appended))).toBe('declaration_conflict');
    expect(declarationRows(COACH, intentId)).toEqual(before);
  });

  it('first declaration after a staged row → declaration_after_ingest; empty/duplicate input → 400, no row', async () => {
    const intentId = await started();
    for (const bad of [
      [],
      [{ source_platform: PLATFORM, account_scope_id_digests: [] }],
      [{ source_platform: PLATFORM, account_scope_id_digests: [SCOPE_1, SCOPE_1] }],
      [
        { source_platform: PLATFORM, account_scope_id_digests: [SCOPE_1] },
        { source_platform: PLATFORM, account_scope_id_digests: [SCOPE_2] },
      ],
    ]) {
      expect((await declare(intentId, bad)).failure?.status).toBe(400);
    }
    expect(count(DECLARATION)).toBe(0);
    stage(COACH, intentId, 'clients', 'c-1');
    expect(codeOf(await declare(intentId))).toBe('declaration_after_ingest');
    expect(count(DECLARATION)).toBe(0);
  });

  it('an injected mid-insert failure rolls every declaration row back', async () => {
    const intentId = await started();
    const r = await run({
      ...REGISTRY,
      action: 'declare',
      coach: COACH,
      intent: intentId,
      body: { platforms: PLATFORMS },
      failAfter: { model: 'scoutRunDeclaration', n: 2 },
    });
    expect(r.failure?.injected).toBe(true);
    expect(r.queries).toContain('-- tx:rollback');
    expect(count(DECLARATION)).toBe(0);
  });

  it('fenced → run_fenced, expired → run_fenced, legacy → legacy_run, other coach → 404; no row', async () => {
    const a = await started();
    expect((await run({ action: 'cancel', coach: COACH, intent: a })).failure).toBeUndefined();
    expect(codeOf(await declare(a))).toBe('run_fenced');
    const b = await started(OTHER);
    expire(OTHER, b);
    expect(codeOf(await declare(b, PLATFORMS, OTHER))).toBe('run_fenced');
    expect(runRow(OTHER, b).fence_reason).toBe('timed_out');
    legacyRun(COACH, 'intent_legacy_s10b');
    expect(codeOf(await declare('intent_legacy_s10b'))).toBe('legacy_run');
    const c = await started();
    expect((await declare(c, PLATFORMS, OTHER)).failure?.status).toBe(404);
    expect(count(DECLARATION)).toBe(0);
  });
});

describe('R29 / R30 — the observation route on real rows', () => {
  it('declaration_missing, then stored bound to the locked epoch; identical replay adds nothing; a different digest conflicts', async () => {
    const intentId = await started();
    expect(codeOf(await observe(intentId))).toBe('declaration_missing');
    const decl = await declare(intentId);
    const challengeHex = Buffer.from(decl.result.challenge_b64, 'base64').toString('hex');
    const entry = { platform: PLATFORM, scope: SCOPE_1, family: 'clients', challengeHex };
    const stored = await observe(intentId, [entry, { ...entry, family: 'workouts' }]);
    expect(stored.failure).toBeUndefined();
    expect(stored.result).toMatchObject({
      execution_epoch: runRow(COACH, intentId).execution_epoch,
      stored: 2,
      replayed: 0,
    });
    const rows = observationRows(COACH, intentId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.execution_epoch).toBe(runRow(COACH, intentId).execution_epoch);
      expect(row.basis_kind).toBe('source_signed_enumeration');
      expect(row.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const replay = await observe(intentId, [entry]);
    expect(replay.result).toMatchObject({ stored: 0, replayed: 1 });
    expect(observationRows(COACH, intentId)).toEqual(rows);
    expect(codeOf(await observe(intentId, [{ ...entry, observedUnique: 99 }]))).toBe(
      'observation_conflict',
    );
    expect(observationRows(COACH, intentId)).toEqual(rows);
  });

  it('R30: after the epoch moves, the same unit is a NEW row at the new epoch; earlier rows keep theirs', async () => {
    const intentId = await started();
    await declare(intentId);
    const entry = { platform: PLATFORM, scope: SCOPE_1, family: 'clients' };
    expect((await observe(intentId, [entry])).failure).toBeUndefined();
    // Fixture clock/epoch shaping as the owner (the service never updates the run row).
    sql(
      `UPDATE "ScoutImport" SET execution_epoch=execution_epoch+1 WHERE coach_id=${quote(COACH)} AND intent_id=${quote(intentId)}`,
    );
    const moved = await observe(intentId, [{ ...entry, observedUnique: 7 }]);
    expect(moved.failure).toBeUndefined();
    const rows = observationRows(COACH, intentId);
    expect(rows.map((r) => r.execution_epoch)).toEqual([1, 2]);
  });

  it('undeclared scope, family outside the manifest, platform without a manifest → observation_not_declared; nothing stored', async () => {
    const intentId = await started();
    await declare(intentId, [
      ...PLATFORMS,
      { source_platform: 'synthetic-src-c', account_scope_id_digests: [SCOPE_1] },
    ]);
    for (const bad of [
      { platform: PLATFORM_B, scope: SCOPE_2 },
      { platform: PLATFORM_B, family: 'workouts' },
      { platform: 'synthetic-src-c' },
    ]) {
      expect(codeOf(await observe(intentId, [{}, bad]))).toBe('observation_not_declared');
    }
    expect(count(OBSERVATION)).toBe(0);
  });

  it('an injected mid-insert failure rolls every observation row back', async () => {
    const intentId = await started();
    await declare(intentId);
    const r = await observe(intentId, [{}, { family: 'workouts' }], COACH, {
      failAfter: { model: 'scoutRunObservation', n: 1 },
    });
    expect(r.failure?.injected).toBe(true);
    expect(count(OBSERVATION)).toBe(0);
  });

  it('a 32769-byte body → 400 before any statement; other coach → 404; a settled (terminal) run → run_terminal', async () => {
    const intentId = await started();
    await declare(intentId);
    const big = await observe(intentId, [{}], COACH, { rawBytes: 32 * 1024 + 1 });
    expect(big.failure?.status).toBe(400);
    expect(big.queries.filter((q) => q.includes('FOR NO KEY UPDATE'))).toHaveLength(0);
    expect((await observe(intentId, [{}], OTHER)).failure?.status).toBe(404);
    // The real claim + settle path makes the run terminal (not fenced).
    const done = await run({ action: 'complete', coach: COACH, intent: intentId });
    expect(done.failure).toBeUndefined();
    const settled = runRow(COACH, intentId);
    expect(settled.terminal_status).not.toBeNull();
    expect(settled.fenced_at).toBeNull();
    expect(codeOf(await observe(intentId))).toBe('run_terminal');
    expect(count(OBSERVATION)).toBe(0);
  });
});

describe('R31 — access and deletion controls', () => {
  const seedRun = (coach: string) => {
    const intentId = intent(coach);
    sql(`${serverRunInsert(coach, intentId)}; ${declarationInsert(coach, intentId)};
      ${observationInsert(coach, intentId)}; ${settledInsert(coach, intentId)};`);
    return intentId;
  };

  it('anon/authenticated are refused on all three tables; a service_role rollback persists nothing', () => {
    const intentId = seedRun(COACH);
    for (const t of S10_TABLES) {
      for (const role of ['anon', 'authenticated']) {
        refused(`SET ROLE ${role}; SELECT count(*) FROM "${t}"`, 'permission denied');
      }
    }
    refused(
      `SET ROLE anon; ${declarationInsert(COACH, intentId, { platform: PLATFORM_B })}`,
      'permission denied',
    );
    sqlAs(
      'service_role',
      `BEGIN; ${declarationInsert(COACH, intentId, { platform: PLATFORM_B })}; ROLLBACK;`,
    );
    expect(count(DECLARATION, `source_platform=${quote(PLATFORM_B)}`)).toBe(0);
  });

  it("the FK refuses a row for another coach on A's intent (unrepresentable)", () => {
    const intentId = seedRun(COACH);
    refused(
      declarationInsert(OTHER, intentId),
      'ScoutRunDeclaration_coach_id_intent_id_fkey',
      'service_role',
    );
    refused(observationInsert(OTHER, intentId), 'violates foreign key constraint', 'service_role');
    refused(
      settledInsert(OTHER, intentId),
      'ScoutRunSettledBasis_coach_id_intent_id_fkey',
      'service_role',
    );
    // An observation of an undeclared (platform, scope) is refused by the declaration FK too.
    refused(
      observationInsert(COACH, intentId, { platform: PLATFORM_B }),
      'ScoutRunObservation_declaration_fkey',
      'service_role',
    );
  });

  it('UPDATE and DELETE: service_role has no privilege; the owner is refused by the insert-only trigger; TRUNCATE refused', () => {
    seedRun(COACH);
    for (const t of S10_TABLES) {
      refused(`UPDATE "${t}" SET coach_id=coach_id`, 'permission denied', 'service_role');
      refused(`DELETE FROM "${t}"`, 'permission denied', 'service_role');
      refused(`UPDATE "${t}" SET coach_id=coach_id`, 'G2-S10B insert-only: UPDATE');
      refused(`DELETE FROM "${t}"`, 'G2-S10B insert-only: DELETE');
      // The declaration table is also an FK target, so PostgreSQL may refuse its TRUNCATE on the
      // reference before the statement trigger fires; either way nothing is truncated.
      refusedMatching(
        `TRUNCATE "${t}"`,
        t === DECLARATION
          ? /G2-S10B insert-only: TRUNCATE|cannot truncate a table referenced in a foreign key constraint/
          : /G2-S10B insert-only: TRUNCATE/,
      );
      expect(count(t)).toBe(1);
    }
  });

  it('negative control: a non-FK child DELETE from a nested trigger in a service_role session is refused (no privilege)', () => {
    seedRun(COACH);
    refused(
      `BEGIN;
       CREATE TABLE public.g2_s10b_probe (id int);
       CREATE FUNCTION public.g2_s10b_probe_delete() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN DELETE FROM public."ScoutRunObservation"; RETURN NEW; END $$;
       CREATE TRIGGER g2_s10b_probe_after AFTER INSERT ON public.g2_s10b_probe
         FOR EACH ROW EXECUTE FUNCTION public.g2_s10b_probe_delete();
       GRANT INSERT ON public.g2_s10b_probe TO service_role;
       SET ROLE service_role;
       INSERT INTO public.g2_s10b_probe VALUES (1);
       ROLLBACK;`,
      'permission denied for table ScoutRunObservation',
    );
    expect(sql(`SELECT to_regclass('public.g2_s10b_probe') IS NULL`)).toBe('t');
    expect(count(OBSERVATION)).toBe(1);
  });

  it('positive control: deleting a parent run cascades ITS children only; a differing challenge is refused', () => {
    const a1 = seedRun(COACH);
    const other = seedRun(OTHER);
    sql(`DELETE FROM "ScoutImport" WHERE coach_id=${quote(COACH)} AND intent_id=${quote(a1)}`);
    for (const t of S10_TABLES) {
      expect(count(t, `coach_id=${quote(COACH)}`)).toBe(0);
      expect(count(t, `coach_id=${quote(OTHER)} AND intent_id=${quote(other)}`)).toBe(1);
    }
    refused(
      declarationInsert(OTHER, other, {
        platform: PLATFORM_B,
        challenge: "decode(repeat('08',32),'hex')",
      }),
      'G2-S10B declaration challenge differs within one run',
      'service_role',
    );
    refused(
      declarationInsert(OTHER, other, {
        platform: PLATFORM_B,
        declaredAt: "'2026-09-26 00:00:01'",
      }),
      'G2-S10B declaration challenge differs within one run',
      'service_role',
    );
    sqlAs('service_role', declarationInsert(OTHER, other, { platform: PLATFORM_B }));
    expect(count(DECLARATION, `coach_id=${quote(OTHER)}`)).toBe(2);
  });

  it('CHECKs: raw scope ids, a short challenge, an unknown family, epoch 0 or a non-hex digest are refused', () => {
    const intentId = intent(COACH);
    sql(serverRunInsert(COACH, intentId));
    refused(
      declarationInsert(COACH, intentId, { scope: quote('raw-account-id') }),
      'ScoutRunDeclaration_scope_digest_check',
    );
    refused(
      declarationInsert(COACH, intentId, { challenge: "decode('00','hex')" }),
      'ScoutRunDeclaration_challenge_check',
    );
    sql(declarationInsert(COACH, intentId));
    refused(
      observationInsert(COACH, intentId, { family: 'notes' }),
      'ScoutRunObservation_family_check',
    );
    refused(observationInsert(COACH, intentId, { epoch: 0 }), 'ScoutRunObservation_epoch_check');
    refused(
      observationInsert(COACH, intentId, { digest: quote('not-hex') }),
      'ScoutRunObservation_evidence_digest_check',
    );
  });
});

describe('R32 — races serialise on the run row lock (used, or refused with its code; never partial, never 40P01)', () => {
  it('first ingest holds the row → the declaration waits, then refuses declaration_after_ingest', async () => {
    const intentId = await started();
    const holder = holdTransaction(
      `${gateSql(COACH, intentId)}; INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
        VALUES ('race-1',${quote(COACH)},${quote(intentId)},'clients','c-1',${quote(PLATFORM)},'{}')`,
    );
    await holder.held;
    const w = worker({
      ...REGISTRY,
      action: 'declare',
      coach: COACH,
      intent: intentId,
      body: { platforms: PLATFORMS },
    });
    await blocked(w.name);
    holder.release();
    const r = await w.done;
    noDeadlock(r);
    expect(codeOf(r)).toBe('declaration_after_ingest');
    expect(count(DECLARATION)).toBe(0);
  });

  it('the declaration holds the row → the first ingest waits, then both are used', async () => {
    const intentId = await started();
    const d = worker({
      ...REGISTRY,
      action: 'declare',
      coach: COACH,
      intent: intentId,
      body: { platforms: PLATFORMS },
      pause: 'locked',
      txTimeout: 60000,
    });
    await d.ready;
    const i = worker({ action: 'ingest', coach: COACH, intent: intentId });
    await blocked(i.name);
    d.resume();
    const [dr, ir] = await Promise.all([d.done, i.done]);
    noDeadlock(dr);
    noDeadlock(ir);
    expect(dr.failure).toBeUndefined();
    expect(ir.failure).toBeUndefined();
    expect(count(DECLARATION)).toBe(3);
    expect(count('ScoutIngestEntity')).toBe(1);
  });

  it('/complete holds the row → the observation waits, then refuses observation_after_claim', async () => {
    const intentId = await started();
    await declare(intentId);
    const c = worker({
      action: 'complete',
      coach: COACH,
      intent: intentId,
      pause: 'gated',
      txTimeout: 60000,
    });
    await c.ready;
    const o = worker({
      ...REGISTRY,
      action: 'observe',
      coach: COACH,
      intent: intentId,
      body: { evidence: [{}] },
    });
    await blocked(o.name);
    c.resume();
    const [cr, or] = await Promise.all([c.done, o.done]);
    noDeadlock(cr);
    noDeadlock(or);
    expect(cr.failure).toBeUndefined();
    expect(codeOf(or)).toBe('observation_after_claim');
    expect(count(OBSERVATION)).toBe(0);
  });

  it('the observation holds the row → /complete waits, then both are used', async () => {
    const intentId = await started();
    await declare(intentId);
    const o = worker({
      ...REGISTRY,
      action: 'observe',
      coach: COACH,
      intent: intentId,
      body: { evidence: [{}] },
      pause: 'locked',
      txTimeout: 60000,
    });
    await o.ready;
    const c = worker({ action: 'complete', coach: COACH, intent: intentId });
    await blocked(c.name);
    o.resume();
    const [or, cr] = await Promise.all([o.done, c.done]);
    noDeadlock(or);
    noDeadlock(cr);
    expect(or.failure).toBeUndefined();
    expect(cr.failure).toBeUndefined();
    expect(count(OBSERVATION)).toBe(1);
  });
});

describe('R31 — down.sql refuses with rows, drops only the S10 objects when empty (then re-expand)', () => {
  it('refuses while any row exists; drops cleanly when empty; the expand re-applies', () => {
    const intentId = intent(COACH);
    sql(`${serverRunInsert(COACH, intentId)}; ${declarationInsert(COACH, intentId)}`);
    refused(
      downSql(),
      'Run declaration or observation state exists; retain schema and use compatible forward repair',
    );
    expect(count(DECLARATION)).toBe(1);
    resetData();
    sql(downSql());
    for (const t of S10_TABLES)
      expect(sql(`SELECT to_regclass('public."${t}"') IS NULL`)).toBe('t');
    expect(sql(`SELECT to_regclass('public."ScoutImport"') IS NOT NULL`)).toBe('t');
    refused(downSql(), 'G2-S10B observation tables absent');
    sql(upSql());
    for (const t of S10_TABLES)
      expect(sql(`SELECT to_regclass('public."${t}"') IS NOT NULL`)).toBe('t');
    refused(upSql(), 'G2-S10B observation tables already present');
    expect(count(SETTLED)).toBe(0);
  });
});
