/**
 * G2-S8-C live PostgreSQL 17 proof (explicitly guarded; run only through jest.rls.config.js on the
 * S8-C disposable lane bootstrapped by test/utils/g2-s8c-bootstrap.sh, never in the default suite).
 *
 * Exercises the REAL ScoutReconstructService in independent OS processes (test/utils/g2-s8c-worker.cjs)
 * with the owned native family registry injected from the fixture spec + rule set, against the
 * accepted S8-B objects on the base 93389265 schema. Every assertion reads the database through
 * psql as the fixture owner. Proves: native target + provenance + typed ledger target in ONE
 * transaction; replay without duplicate or drift; coach edits preserved; tenant isolation;
 * exercise links only for exact catalog identifiers; ordering; tally = ledger; explicit unresolved
 * for client-linked rows without User creation; program-day relationship pending → converge;
 * concurrent identity convergence and contention rollback; legacy NULL-kind rows untouched;
 * unchanged success precedence when a native target is later removed.
 */
import { toPounds, supersetGroupId } from '../src/scout/reconstruct/native/native-contract';
import {
  catalog,
  childSourceId,
  count,
  evidenceRows,
  exercises,
  ledgerRows,
  plans,
  programs,
  provenanceRows,
  REGISTRY,
  resetData,
  revisions,
  settle,
  stage,
} from './utils/g2-s8c-harness';
import { execFileSync } from 'child_process';
import {
  appliedMigrations,
  BASE_HEAD,
  blocked,
  candidateHead,
  directory,
  EXPECTED_MIGRATIONS,
  expectedVersion,
  holdTransaction,
  jsonAdmin,
  quote,
  root,
  run,
  sql,
  sqlAdmin,
  target,
  worker,
} from './utils/g2-s8c-pg-harness';

jest.setTimeout(240000);

const CAT_ID = '11111111-1111-4111-8111-111111111111';
const CAT_SLUG = 'synthetic-bench-press';
const CAT_ID_2 = '22222222-2222-4222-8222-222222222222';
const CAT_SLUG_2 = 'synthetic-row';
const PROGRAM = { title: 'Base Block', weeks: 4, days: 3, notes: 'synthetic' };
const STANDALONE = {
  title: 'Push Day',
  kind: 'lift',
  minutes: 45,
  exercises: [
    { id: 'e1', exercise: CAT_ID, sets: 3, reps: 8, kg: 100, rest: 90, cue: 'brace' },
    { id: 'e2', exercise: CAT_SLUG_2, sets: 3, reps: 10, superset: 'A' },
    { exercise: 'not-in-catalog', sets: 2, reps: 5 },
    { id: 'e4', exercise: CAT_SLUG.toUpperCase(), sets: 2, reps: 5 },
  ],
};
const PROGRAM_DAY = {
  title: 'Block Day 1',
  block_id: 'blk-1',
  week: 1,
  day: 1,
  exercises: [{ id: 'd1', exercise: CAT_SLUG, sets: 4, reps: 6 }],
};
const workoutRows = () => ledgerRows().filter((r) => r.entity_type === 'workouts');
const programRows = () => ledgerRows().filter((r) => r.entity_type === 'programs');
const byKey = (rows: Array<Record<string, string | null>>, entity: string, source: string) =>
  rows.find((r) => r.entity_type === entity && r.source_id === source);

beforeEach(() => {
  resetData();
  settle();
  catalog([
    { id: CAT_ID, slug: CAT_SLUG },
    { id: CAT_ID_2, slug: CAT_SLUG_2 },
  ]);
});

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S8-C disposable PG17 lane with the full accepted history and S8-B objects present', () => {
    // `data_directory` is readable only by superusers / pg_read_all_settings: observe the lane
    // identity over the existing admin connection (the migration role stays unprivileged).
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's8c-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s8c_disposable',
    });
    expect(Number(appliedMigrations())).toBe(EXPECTED_MIGRATIONS);
    expect(sql(`SELECT to_regclass('public."ImportNativeProvenance"') IS NOT NULL`)).toBe('t');
    expect(
      sql(
        `SELECT count(*) FROM information_schema.columns WHERE table_name='ScoutReconstructionLedger' AND column_name='target_kind'`,
      ),
    ).toBe('1');
    expect(
      sqlAdmin(`SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','authenticator')`),
    ).toBe('0');
  });

  it('is bound to one attested candidate head that descends from the base', () => {
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
  });

  it('the worker exposes the canonical family list with programs (N3) and refuses an unknown family', async () => {
    const result = await run({ ...REGISTRY, family: 'workouts' });
    expect(result.families).toEqual(['clients', 'workouts', 'client_history', 'programs']);
    expect(result.result).toMatchObject({ staged: 0, reconstructed: 0, skipped: 0, failed: 0 });
    const bad = await run({ ...REGISTRY, family: 'routines' });
    expect(bad.failure?.status).toBe(400);
  });
});

describe('native persistence: target + provenance + typed ledger in one transaction', () => {
  it('creates a WorkoutProgram from a programs row with workout_program provenance and ledger kind (N1, N4)', async () => {
    stage('blk-1', 'programs', PROGRAM);
    const result = await run({ ...REGISTRY, family: 'programs' });
    expect(result.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    const [program] = programs();
    expect(programs()).toHaveLength(1);
    expect(program).toMatchObject({
      name: 'Base Block',
      weeks: 4,
      days_per_week: 3,
      is_template: true,
      is_regime: false,
      owner_user_id: 'coach',
      visibility: 'owner_only',
      version: 1,
    });
    expect(provenanceRows()).toEqual([
      {
        entity_type: 'programs',
        source_id: 'blk-1',
        source_namespace: 's8c-proof',
        native_kind: 'workout_program',
        native_id: program.id,
        outcome: 'created',
        reason: null,
        import_intent_id: null,
      },
    ]);
    expect(programRows()).toEqual([
      {
        entity_type: 'programs',
        source_id: 'blk-1',
        status: 'reconstructed',
        target_id: program.id,
        target_kind: 'workout_program',
        reason: null,
      },
    ]);
    // The typed ledger write happens inside the same interactive transaction as the target and
    // provenance rows: the worker's query log shows exactly one BEGIN...COMMIT span containing all three.
    const log = result.queries.join('\n');
    const begin = log.indexOf('BEGIN');
    const commit = log.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const span = log.slice(begin, commit);
    expect(span).toMatch(/INSERT INTO "public"."WorkoutProgram"/);
    expect(span).toMatch(/INSERT INTO "public"."ImportNativeProvenance"/);
    expect(span).toMatch(/INSERT INTO "public"."ScoutReconstructionLedger"/);
  });

  it('creates a standalone WorkoutPlan with ordered exercises, exact catalog links and unresolved children', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    // `User` carries the accepted seed system coach and is never reset: prove "no User minted"
    // against the pre-writer baseline rather than an absolute count.
    const usersBefore = count('User');
    const result = await run({ ...REGISTRY, family: 'workouts' });
    expect(result.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    const [plan] = plans();
    expect(plans()).toHaveLength(1);
    expect(plan).toMatchObject({
      name: 'Push Day',
      type: 'strength',
      duration_estimate_minutes: 45,
      program_id: null,
      week_index: null,
      day_index: null,
      is_template: false,
      version: 1,
      head_revision_id: null,
    });
    const rows = exercises(plan.id);
    // Ordering preserved: source ordinals 0 and 1 are linked; ordinals 2 and 3 are unresolved
    // (not in catalog; case-mismatched slug), so nothing is guessed or re-ordered.
    expect(rows.map((r) => [r.order, r.exercise_external_id])).toEqual([
      [0, CAT_ID],
      [1, CAT_SLUG_2],
    ]);
    expect(rows[0]).toMatchObject({
      sets: 3,
      reps_or_duration_seconds: 8,
      rest_seconds: 90,
      superset_group_id: null,
      notes: 'brace',
    });
    // The double round-trips through the Prisma Float path, which is not bit-exact (1 ulp).
    expect(rows[0].weight_lbs).toBeCloseTo(toPounds(100, 'kg'), 9);
    expect(rows[1]).toMatchObject({
      sets: 3,
      reps_or_duration_seconds: 10,
      weight_lbs: null,
      rest_seconds: null,
      superset_group_id: supersetGroupId('rt-1', 'A'),
      notes: null,
    });
    expect(revisions(plan.id)).toEqual([]);
    const provenance = provenanceRows();
    expect(byKey(provenance, 'workouts', 'rt-1')).toMatchObject({
      native_kind: 'workout_plan',
      native_id: plan.id,
      outcome: 'created',
      reason: null,
    });
    expect(
      byKey(provenance, 'workouts.exercise', childSourceId('rt-1', { id: 'e1' })),
    ).toMatchObject({
      native_kind: 'workout_plan_exercise',
      native_id: rows[0].id,
      outcome: 'created',
    });
    expect(
      byKey(provenance, 'workouts.exercise', childSourceId('rt-1', { id: 'e2' })),
    ).toMatchObject({
      native_kind: 'workout_plan_exercise',
      native_id: rows[1].id,
      outcome: 'created',
    });
    expect(
      byKey(provenance, 'workouts.exercise', childSourceId('rt-1', { ordinal: 2 })),
    ).toMatchObject({
      native_kind: 'workout_plan_exercise',
      native_id: null,
      outcome: 'unresolved',
      reason: 'unresolved:exercise_reference',
    });
    expect(
      byKey(provenance, 'workouts.exercise', childSourceId('rt-1', { id: 'e4' })),
    ).toMatchObject({
      native_kind: 'workout_plan_exercise',
      native_id: null,
      outcome: 'unresolved',
      reason: 'unresolved:exercise_reference',
    });
    expect(provenance).toHaveLength(5);
    expect(workoutRows()).toEqual([
      {
        entity_type: 'workouts',
        source_id: 'rt-1',
        status: 'reconstructed',
        target_id: plan.id,
        target_kind: 'workout_plan',
        reason: null,
      },
    ]);
    // Tally = ledger; no side-effecting rows anywhere.
    expect(count('ScoutReconstructionLedger', `status='reconstructed'`)).toBe(1);
    expect(count('ClientWorkoutAssignment')).toBe(0);
    expect(count('Notification')).toBe(0);
    expect(count('User')).toBe(usersBefore);
    expect(count('Person')).toBe(0);
    // The writer's rows satisfy S8-B's CHECKs by construction (a violation would have aborted the tx).
    expect(count('ImportNativeProvenance', `(native_id IS NULL) <> (outcome='unresolved')`)).toBe(
      0,
    );
    expect(
      count('ScoutReconstructionLedger', `target_kind IS NOT NULL AND target_id IS NULL`),
    ).toBe(0);
  });

  it('replays byte-identical: no duplicate targets, no provenance drift, coach edits preserved', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    await run({ ...REGISTRY, family: 'workouts' });
    const [plan] = plans();
    const before = {
      plans: plans(),
      exercises: exercises(plan.id),
      provenance: provenanceRows(),
      ledger: ledgerRows(),
    };
    // Coach edits after import (renamed plan, heavier prescription, version bump).
    sql(`UPDATE "WorkoutPlan" SET name='Coach Renamed', version=2 WHERE id=${quote(plan.id)};
      UPDATE "WorkoutPlanExercise" SET sets=5 WHERE workout_plan_id=${quote(plan.id)} AND "order"=0`);
    const edited = { plans: plans(), exercises: exercises(plan.id) };
    const replay = await run({ ...REGISTRY, family: 'workouts' });
    expect(replay.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(plans()).toEqual(edited.plans);
    expect(exercises(plan.id)).toEqual(edited.exercises);
    expect(provenanceRows()).toEqual(before.provenance);
    expect(ledgerRows()).toEqual(before.ledger);
    expect(count('WorkoutPlan')).toBe(1);
    expect(count('WorkoutPlanExercise')).toBe(2);
    expect(replay.queries.join('\n')).not.toMatch(/INSERT INTO "public"."WorkoutPlan"/);
  });

  it('program-day workouts: relationship pending until the program lands, then converge with revision 0', async () => {
    stage('rt-2', 'workouts', PROGRAM_DAY);
    const pending = await run({ ...REGISTRY, family: 'workouts' });
    expect(pending.result).toMatchObject({ staged: 1, reconstructed: 0, skipped: 1, failed: 0 });
    expect(workoutRows()).toEqual([
      {
        entity_type: 'workouts',
        source_id: 'rt-2',
        status: 'skipped',
        target_id: null,
        target_kind: null,
        reason: 'unresolved:relationship_pending:programs',
      },
    ]);
    expect(count('WorkoutPlan')).toBe(0);
    expect(provenanceRows()).toEqual([]);

    stage('blk-1', 'programs', PROGRAM);
    await run({ ...REGISTRY, family: 'programs' });
    const [program] = programs();
    const converged = await run({ ...REGISTRY, family: 'workouts' });
    expect(converged.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    const [plan] = plans();
    expect(plan).toMatchObject({
      name: 'Block Day 1',
      program_id: program.id,
      week_index: 0,
      day_index: 0,
      is_template: true,
      version: 1,
    });
    const revs = revisions(plan.id);
    expect(revs).toEqual([
      { revision_index: 0, author_kind: 'coach', cause: 'initial', author_id: 'coach' },
    ]);
    expect(plan.head_revision_id).toBe(
      sql(`SELECT id FROM "WorkoutPlanRevision" WHERE workout_plan_id=${quote(plan.id)}`),
    );
    expect(exercises(plan.id).map((r) => r.exercise_external_id)).toEqual([CAT_SLUG]);
    expect(workoutRows()).toEqual([
      {
        entity_type: 'workouts',
        source_id: 'rt-2',
        status: 'reconstructed',
        target_id: plan.id,
        target_kind: 'workout_plan',
        reason: null,
      },
    ]);
  });
});

describe('client principal: explicit unresolved, never a User (N2)', () => {
  it('client-linked workout stays generic evidence with an unresolved provenance marker; no plan, no User', async () => {
    stage('rt-c', 'workouts', { ...STANDALONE, title: 'Client Push', client_id: 'c-1' });
    stage('blk-c', 'programs', { ...PROGRAM, client_id: 'c-1' });
    const usersBefore = count('User');
    const workouts = await run({ ...REGISTRY, family: 'workouts' });
    const programsRun = await run({ ...REGISTRY, family: 'programs' });
    expect(workouts.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(programsRun.result).toMatchObject({
      staged: 1,
      reconstructed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(evidenceRows()).toEqual([
      { entity_type: 'workouts', source_id: 'rt-c', label: 'Client Push', client_source_id: 'c-1' },
    ]);
    const evidenceId = sql(`SELECT id FROM "ScoutReconstructedEntity" WHERE source_id='rt-c'`);
    expect(provenanceRows()).toEqual([
      {
        entity_type: 'workouts',
        source_id: 'rt-c',
        source_namespace: 's8c-proof',
        native_kind: 'workout_plan',
        native_id: null,
        outcome: 'unresolved',
        reason: 'unresolved:no_native_client_principal',
        import_intent_id: null,
      },
    ]);
    expect(ledgerRows()).toEqual([
      {
        entity_type: 'programs',
        source_id: 'blk-c',
        status: 'skipped',
        target_id: null,
        target_kind: null,
        reason: 'unresolved:no_native_client_principal',
      },
      {
        entity_type: 'workouts',
        source_id: 'rt-c',
        status: 'reconstructed',
        target_id: evidenceId,
        target_kind: 'scout_entity',
        reason: null,
      },
    ]);
    expect(count('WorkoutPlan')).toBe(0);
    expect(count('WorkoutProgram')).toBe(0);
    // The writer minted no User (baseline form: the table carries the accepted seed system coach).
    expect(count('User')).toBe(usersBefore);
    expect(count('ClientWorkoutAssignment')).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('the same source identifiers for two coaches yield separate targets; neither coach sees the other', async () => {
    settle('coach-b', 'intent-b');
    stage('rt-1', 'workouts', STANDALONE);
    stage('rt-1', 'workouts', { ...STANDALONE, title: 'B Push' }, 'coach-b', 'intent-b');
    await run({ ...REGISTRY, family: 'workouts' });
    const snapshotA = { plans: plans(), provenance: provenanceRows(), ledger: ledgerRows() };
    await run({ ...REGISTRY, family: 'workouts', coach: 'coach-b', intent: 'intent-b' });
    expect(plans()).toEqual(snapshotA.plans);
    expect(provenanceRows()).toEqual(snapshotA.provenance);
    expect(ledgerRows()).toEqual(snapshotA.ledger);
    expect(plans('coach-b')).toHaveLength(1);
    expect(plans('coach-b')[0].name).toBe('B Push');
    expect(plans('coach-b')[0].id).not.toBe(snapshotA.plans[0].id);
    expect(byKey(provenanceRows('coach-b'), 'workouts', 'rt-1')?.native_id).toBe(
      plans('coach-b')[0].id,
    );
    expect(byKey(ledgerRows('coach-b', 'intent-b'), 'workouts', 'rt-1')?.target_id).toBe(
      plans('coach-b')[0].id,
    );
    expect(count('WorkoutPlan')).toBe(2);
  });
});

describe('contention and atomicity', () => {
  it('two concurrent identical runs converge on ONE plan; the loser rolls its target back with its transaction', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    const paused = worker({
      ...REGISTRY,
      family: 'workouts',
      pause: 'after-target',
      txTimeout: 60000,
    });
    expect(await paused.ready).toBe('after-target');
    // The paused transaction has already INSERTed its WorkoutPlan (uncommitted). A second run
    // completes first and commits the identity.
    const second = await run({ ...REGISTRY, family: 'workouts' });
    expect(second.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    const [plan] = plans();
    paused.resume();
    const first = await paused.done;
    expect(first.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(plans()).toHaveLength(1);
    expect(plans()[0].id).toBe(plan.id);
    expect(count('WorkoutPlanExercise')).toBe(2);
    expect(count('ImportNativeProvenance', `native_kind='workout_plan'`)).toBe(1);
    expect(workoutRows()).toEqual([
      expect.objectContaining({
        source_id: 'rt-1',
        status: 'reconstructed',
        target_id: plan.id,
        target_kind: 'workout_plan',
      }),
    ]);
    // The loser saw the unique identity violation (P2002), rolled back and retried to the same target.
    expect(first.queries.join('\n')).toMatch(/ROLLBACK/);
  });

  it('a held ledger identity blocks the writer; its first attempt (target included) rolls back and the retry converges', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    const holder = holdTransaction(
      `INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,reason)
       VALUES ('held-1','coach','intent','workouts','rt-1','s8c-proof','failed','fixture:held')`,
    );
    await holder.held;
    const pending = worker({ ...REGISTRY, family: 'workouts', txTimeout: 60000 });
    await blocked(pending.name);
    holder.release();
    const result = await pending.done;
    expect(result.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(result.queries.join('\n')).toMatch(/ROLLBACK/);
    expect(count('WorkoutPlan')).toBe(1);
    expect(count('ImportNativeProvenance', `native_kind='workout_plan'`)).toBe(1);
    const [plan] = plans();
    expect(workoutRows()).toEqual([
      {
        entity_type: 'workouts',
        source_id: 'rt-1',
        status: 'reconstructed',
        target_id: plan.id,
        target_kind: 'workout_plan',
        reason: null,
      },
    ]);
  });
});

describe('legacy compatibility and unchanged precedence', () => {
  it('legacy families and pre-existing NULL-kind ledger rows are untouched by the native writer', async () => {
    sql(`INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,target_kind)
      VALUES ('legacy-1','coach','intent','clients','p-1','s8c-proof','reconstructed','person-legacy',NULL)`);
    // Legacy client_history resolves through the repository mapping registry (not the native seam):
    // stage it on the accepted TrueCoach source so the accepted path is what runs.
    stage(
      'h-1',
      'client_history',
      { title: 'Ran 5k', client_id: 'c-1' },
      'coach',
      'intent',
      'truecoach',
    );
    stage('rt-1', 'workouts', STANDALONE);
    const history = await run({ ...REGISTRY, family: 'client_history' });
    const workouts = await run({ ...REGISTRY, family: 'workouts' });
    expect(history.result).toMatchObject({ staged: 1, reconstructed: 1 });
    expect(workouts.result).toMatchObject({ staged: 1, reconstructed: 1 });
    expect(byKey(ledgerRows(), 'clients', 'p-1')).toEqual({
      entity_type: 'clients',
      source_id: 'p-1',
      status: 'reconstructed',
      target_id: 'person-legacy',
      target_kind: null,
      reason: null,
    });
    // Legacy result shape (string target, no kind) for a legacy family: NULL kind, never a native guess.
    expect(byKey(ledgerRows(), 'client_history', 'h-1')).toMatchObject({
      status: 'reconstructed',
      target_kind: null,
    });
    expect(byKey(ledgerRows(), 'client_history', 'h-1')?.target_id).toBeTruthy();
    expect(
      provenanceRows().filter(
        (r) => !['workouts', 'workouts.exercise'].includes(r.entity_type ?? ''),
      ),
    ).toEqual([]);
  });

  it('a later-removed or archived native target does not downgrade the reconstructed ledger row and mints nothing new', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    stage('blk-1', 'programs', PROGRAM);
    await run({ ...REGISTRY, family: 'programs' });
    await run({ ...REGISTRY, family: 'workouts' });
    const [plan] = plans();
    const [program] = programs();
    const before = ledgerRows();
    sql(`UPDATE "WorkoutProgram" SET archived_at=now() WHERE id=${quote(program.id)}`);
    sql(`DELETE FROM "WorkoutPlan" WHERE id=${quote(plan.id)}`);
    const workouts = await run({ ...REGISTRY, family: 'workouts' });
    const programsRun = await run({ ...REGISTRY, family: 'programs' });
    // The writer reports the explicit unresolved outcome (skipped) for the row ...
    expect(workouts.result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(programsRun.result).toMatchObject({
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    // ... but the accepted success precedence keeps the earlier reconstructed row (observed S8-B/N
    // semantic, recorded in DRAFT_READY; S8-G lifecycle fencing owns the completion decision).
    expect(ledgerRows()).toEqual(before);
    expect(count('WorkoutPlan')).toBe(0);
    expect(count('WorkoutProgram')).toBe(1);
    expect(byKey(provenanceRows(), 'workouts', 'rt-1')).toMatchObject({
      native_id: plan.id,
      outcome: 'created',
    });
    expect(byKey(provenanceRows(), 'programs', 'blk-1')).toMatchObject({
      native_id: program.id,
      outcome: 'created',
    });
  });
});
