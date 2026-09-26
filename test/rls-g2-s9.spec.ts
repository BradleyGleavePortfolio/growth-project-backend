/**
 * S9-B G2 live proof — real PostgreSQL 17, real generated Prisma client, real
 * ReconciliationFactsService (src/scout/reconciliation/facts.service.ts) composed with the frozen
 * S9-A `reconcile`, in independent OS processes (test/utils/g2-s9-worker.cjs). The rows the facts
 * classify are produced by the real S8-C ScoutReconstructService (worker `mode: 'reconstruct'`)
 * with the owned fixture registry injected from the fixture spec + rule set; the contradiction
 * cases (native drift, cross-tenant pointers, orphan ledger rows, unmapped tokens) are then
 * applied directly to the tables, exactly the situations D-S9-2's buckets name. No query result,
 * transaction or table is mocked.
 *
 * Guarded: test/utils/g2-s9-db.ts refuses anything but the explicitly acknowledged disposable
 * lane that test/utils/g2-s9-bootstrap.sh built and identified (cluster marker, database comment
 * marker, 172 migrations, S7-L/S8-B/S8-C objects); the harness binds the run to one attested
 * candidate head. Nothing here repairs the lane: an identity mismatch fails the suite.
 *
 * Invariants proven (S9-DOC + Addendum A; S9-B SOURCE_READY):
 *   - tenant isolation: coach B's staging, ledger, provenance and native rows never enter coach
 *     A's facts, a native row that belongs to another coach is `foreign_owner` (→ identity
 *     conflict), and the symmetric case holds (R11);
 *   - unknown never becomes zero: an empty run has `families: []`, `spec_families: null`,
 *     `claim: null`, `coverage: null`; `created_native` / `already_present_verified` /
 *     `observed_unique` are `null` and `completeness_basis` is `'none'` (D-S9-3, D-S9-4, R12);
 *   - no false Complete: a fully verified run is still `partial/coverage_basis_unknown` in v1;
 *     drift (archived/deleted targets), orphans and unmapped tokens each surface as their own
 *     condition (R04, R05, RC-3);
 *   - idempotent, no duplicate identity: replaying the writer leaves the facts byte-identical
 *     and every (platform, source_id) appears once; collecting twice yields identical facts;
 *   - read-only and bounded: one REPEATABLE READ transaction (read back from the server),
 *     SELECT-only, a query count fixed by the schema shape (+1 per extra 500-row page) and every
 *     watched table's content digest unchanged (C-9, R08).
 */
import { execFileSync } from 'child_process';
import { identityKey } from '../src/scout/reconciliation/facts.service';
import {
  BASE_HEAD,
  EXPECTED_MIGRATIONS,
  Result,
  appliedMigrations,
  candidateHead,
  directory,
  expectedVersion,
  jsonAdmin,
  quote,
  root,
  run,
  sql,
  sqlAdmin,
  target,
} from './utils/g2-s9-pg-harness';
import {
  COMPLETION,
  LEDGER,
  PLATFORM,
  PLATFORM_B,
  PROVENANCE,
  REGISTRY,
  REGISTRY_AB,
  catalog,
  childSourceId,
  claim,
  count,
  ledgerRow,
  ledgerRows,
  plans,
  programs,
  provenanceRows,
  resetData,
  settle,
  snapshot,
  stage,
} from './utils/g2-s9-harness';

jest.setTimeout(240000);

const CAT_ID = '11111111-1111-4111-8111-111111111111';
const CAT_SLUG = 'synthetic-bench-press';
const CAT_ID_2 = '22222222-2222-4222-8222-222222222222';
const CAT_SLUG_2 = 'synthetic-row';
const PROGRAM = { title: 'Base Block', weeks: 4, days: 3, notes: 'synthetic' };
/** Standalone plan whose two children both resolve (exact catalog id / slug). */
const STANDALONE = {
  title: 'Push Day',
  kind: 'lift',
  minutes: 45,
  exercises: [
    { id: 'e1', exercise: CAT_ID, sets: 3, reps: 8, kg: 100, rest: 90, cue: 'brace' },
    { id: 'e2', exercise: CAT_SLUG_2, sets: 3, reps: 10, superset: 'A' },
  ],
};
/** Standalone plan with two resolved and two unresolved children (S8-C proof shape). */
const MIXED = {
  ...STANDALONE,
  title: 'Mixed Day',
  exercises: [
    ...STANDALONE.exercises,
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
const COACH_B = 'coach-b';
const COVERAGE_ONLY = { outcome: 'partial', reason_code: 'coverage_basis_unknown' };
const ALL_FAMILIES = ['client_history', 'clients', 'programs', 'workouts'];

// ── worker drivers ──────────────────────────────────────────────────────────────────────────
type Facts = Result & { result: { isolation: string; facts: any; verdict: any; report: any } };
/** One real facts collection + frozen reconcile in a fresh process; a service failure is fatal. */
async function collect(options: Record<string, unknown> = {}): Promise<Facts> {
  const outcome = await run({ ...REGISTRY, ...options });
  if (outcome.failure !== undefined)
    throw new Error(`facts failed: ${JSON.stringify(outcome.failure)}`);
  return outcome as Facts;
}
/** The real S8-C writer for one family (fixture rows come from production code, never by hand). */
async function write(family: 'programs' | 'workouts', coach = 'coach'): Promise<Result> {
  const outcome = await run({ ...REGISTRY, mode: 'reconstruct', family, coach });
  expect(outcome.failure).toBeUndefined();
  return outcome;
}
/** Stage + write the verified fixture: one program, its program-day plan, one standalone plan. */
async function verifiedFixture(coach = 'coach') {
  stage('blk-1', 'programs', PROGRAM, coach);
  stage('rt-2', 'workouts', PROGRAM_DAY, coach);
  stage('rt-1', 'workouts', STANDALONE, coach);
  await write('programs', coach);
  await write('workouts', coach);
  const [program] = programs(coach);
  const byName = (name: string) => plans(coach).find((p) => p.name === name)!;
  return { program, day: byName('Block Day 1'), standalone: byName('Push Day') };
}
// ── facts accessors ─────────────────────────────────────────────────────────────────────────
const family = (facts: any, name: string, mapped = true) =>
  facts.families.find((f: any) => f.family === name && f.mapped === mapped);
const identity = (fam: any, source: string, platform = PLATFORM) =>
  fam.identities.find((i: any) => i.identity === identityKey(platform, source));
const edges = (facts: any, edge: string, source: string, platform = PLATFORM) =>
  facts.relationships.filter(
    (r: any) => r.edge === edge && r.from_identity === identityKey(platform, source),
  );
const reportFamily = (report: any, name: string) =>
  report.families.find((f: any) => f.family === name);
/** A ledger fact whose native target is present and owned (provenance reason tags not pinned). */
const verified = (outcome: string) => ({
  status: 'reconstructed',
  provenance: expect.objectContaining({ outcome, native: 'present_owned' }),
});
/** Query-log statements the read-only proof accepts and the SELECTs the service itself issued. */
const statements = (outcome: Result) => outcome.queries.map((q) => q.trim());
const serviceSelects = (outcome: Result) =>
  statements(outcome).filter((q) => /^SELECT/i.test(q) && !/current_setting/.test(q));

beforeEach(() => {
  resetData();
  settle();
  catalog([
    { id: CAT_ID, slug: CAT_SLUG },
    { id: CAT_ID_2, slug: CAT_SLUG_2 },
  ]);
});

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S9-B disposable PG17 lane with the full accepted history and S7-L/S8-B/S8-C objects present', () => {
    // `data_directory` is readable only by superusers / pg_read_all_settings: observe the lane
    // identity over the existing admin connection (the migration role stays unprivileged).
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's9-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s9_disposable',
    });
    expect(Number(appliedMigrations())).toBe(EXPECTED_MIGRATIONS);
    // S7-L: the completion claim table and the lifecycle columns the facts service reads around.
    expect(sql(`SELECT to_regclass('public."${COMPLETION}"') IS NOT NULL`)).toBe('t');
    expect(
      sql(
        `SELECT count(*) FROM information_schema.columns WHERE table_name='ScoutImport' AND column_name IN ('mode','execution_epoch','reason_code')`,
      ),
    ).toBe('3');
    // S8-B / S8-C: provenance table and the typed ledger target.
    expect(sql(`SELECT to_regclass('public."${PROVENANCE}"') IS NOT NULL`)).toBe('t');
    expect(
      sql(
        `SELECT count(*) FROM information_schema.columns WHERE table_name='${LEDGER}' AND column_name='target_kind'`,
      ),
    ).toBe('1');
    expect(sql(`SELECT to_regclass('public."WorkoutProgram"') IS NOT NULL`)).toBe('t');
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
});

describe('native evidence → facts → frozen reconcile', () => {
  it('an empty run: nothing is fabricated (families [], spec null, claim null, coverage null) and it is never Complete (R19, R12)', async () => {
    const empty = await collect();
    expect(empty.result.facts).toEqual({
      claim: null,
      families: [],
      relationships: [],
      spec_families: null,
      ledger_without_staged: 0,
      coverage: null,
    });
    expect(empty.result.verdict).toEqual(COVERAGE_ONLY);
    expect(empty.result.report).toMatchObject({
      report_version: 1,
      basis: 'recomputed',
      conditions: ['coverage_basis_unknown'],
      required_families: null,
      ledger_without_staged: 0,
      families: [],
    });
    // The legacy claim is read from ScoutImportCompletion and admitted only from the closed set.
    claim('complete'); // the server vocabulary, stored verbatim by an older client → not a claim
    expect((await collect()).result.facts.claim).toBeNull();
    for (const status of ['success', 'partial', 'failed']) {
      claim(status);
      const withClaim = await collect();
      expect(withClaim.result.facts.claim).toBe(status);
      // A stored claim, on its own, never turns an unknown coverage basis into Complete.
      expect(withClaim.result.verdict).toEqual(COVERAGE_ONLY);
    }
  });

  it('rows the real writer produced classify as present_owned with consistent E-R1/E-R2 edges; verified is still partial/coverage_basis_unknown; replay leaves the facts identical', async () => {
    const { program, day, standalone } = await verifiedFixture();
    claim('success');
    const first = await collect();
    const facts = first.result.facts;
    expect(facts.claim).toBe('success');
    expect(facts.spec_families).toEqual(ALL_FAMILIES);
    expect(facts.coverage).toBeNull();
    expect(facts.ledger_without_staged).toBe(0);
    expect(facts.families.map((f: any) => [f.family, f.mapped, f.identities.length])).toEqual([
      ['programs', true, 1],
      ['workouts', true, 2],
    ]);
    expect(identity(family(facts, 'programs'), 'blk-1')).toEqual({
      token: 'programs',
      identity: identityKey(PLATFORM, 'blk-1'),
      client_linked: false,
      ledger: {
        status: 'reconstructed',
        target_kind: 'workout_program',
        provenance: {
          outcome: 'created',
          native: 'present_owned',
          reason: null,
          unresolved_children: {},
        },
      },
    });
    expect(identity(family(facts, 'workouts'), 'rt-1').ledger).toEqual({
      status: 'reconstructed',
      target_kind: 'workout_plan',
      provenance: {
        outcome: 'created',
        native: 'present_owned',
        reason: null,
        unresolved_children: {},
      },
    });
    expect(identity(family(facts, 'workouts'), 'rt-2').ledger).toMatchObject(verified('created'));
    // E-R1: the program-day plan's program_id is the verified program and (week, day) = (0, 0).
    expect(day).toMatchObject({ program_id: program.id, week_index: 0, day_index: 0 });
    expect(edges(facts, 'program_parent', 'rt-2')).toEqual([
      {
        edge: 'program_parent',
        from_family: 'workouts',
        from_identity: identityKey(PLATFORM, 'rt-2'),
        to_family: 'programs',
        to_identity: identityKey(PLATFORM, 'blk-1'),
        consistent: true,
      },
    ]);
    expect(edges(facts, 'program_parent', 'rt-1')).toEqual([]); // standalone declares no parent
    // E-R2: one edge per created child (from = to = the parent), consistent against the real rows.
    expect(standalone.program_id).toBeNull();
    const children = edges(facts, 'child_order', 'rt-1');
    expect(children).toHaveLength(2);
    expect(children.every((e: any) => e.to_identity === identityKey(PLATFORM, 'rt-1'))).toBe(true);
    expect(children.map((e: any) => e.consistent)).toEqual([true, true]);
    expect(edges(facts, 'child_order', 'rt-2')).toEqual([
      expect.objectContaining({ to_identity: identityKey(PLATFORM, 'rt-2'), consistent: true }),
    ]);
    expect(facts.relationships.filter((r: any) => r.edge === 'client_link')).toEqual([]);
    // Frozen reconcile: fully verified, closure verified, and STILL partial in v1 (D-S9-3: no
    // coverage basis exists) — the one condition held is coverage_basis_unknown.
    expect(first.result.verdict).toEqual(COVERAGE_ONLY);
    expect(first.result.report.conditions).toEqual(['coverage_basis_unknown']);
    expect(first.result.report.required_families).toEqual(ALL_FAMILIES);
    expect(
      first.result.report.families.map((f: any) => [
        f.family,
        f.staged_unique,
        f.native_present_verified,
        f.relationship_closure,
      ]),
    ).toEqual([
      ['client_history', 0, 0, 'not_applicable'],
      ['clients', 0, 0, 'not_applicable'],
      ['programs', 1, 1, 'not_applicable'],
      ['workouts', 2, 2, 'verified'],
    ]);
    for (const f of first.result.report.families) {
      // Unknown never becomes zero (D-S9-4 split, D-S9-3 basis).
      expect(f).toMatchObject({
        created_native: null,
        already_present_verified: null,
        completeness_basis: 'none',
        observed_unique: null,
        pagination_terminal_evidence: null,
        date_window: null,
        media_policy: null,
        unresolved: 0,
        rejected: 0,
        failed: 0,
        unresolved_children: 0,
        relationship_unverified: 0,
        reasons: [],
      });
    }
    // Idempotence / no duplicate identity: the writer's byte-identical replay and a second
    // collection change nothing; every (platform, source_id) is one identity.
    await write('programs');
    await write('workouts');
    const replayed = await collect();
    expect(replayed.result.facts).toEqual(facts);
    expect(replayed.result.report).toEqual(first.result.report);
    const keys = facts.families.flatMap((f: any) => f.identities.map((i: any) => i.identity));
    expect(new Set(keys).size).toBe(keys.length);
    expect(count('WorkoutPlan')).toBe(2);
    expect(count('WorkoutProgram')).toBe(1);
  });

  it('native drift after the ledger was written is reported as removed, never as present (R04)', async () => {
    const { program, standalone } = await verifiedFixture();
    const ledgerBefore = ledgerRows();
    const provenanceBefore = provenanceRows();
    // Coach archives the program and deletes the standalone plan (children first, FK order).
    sql(`UPDATE "WorkoutProgram" SET archived_at = now() WHERE id = ${quote(program.id)};
      DELETE FROM "WorkoutPlanExercise" WHERE workout_plan_id = ${quote(standalone.id)};
      DELETE FROM "WorkoutPlan" WHERE id = ${quote(standalone.id)}`);
    const drifted = await collect();
    const facts = drifted.result.facts;
    expect(identity(family(facts, 'programs'), 'blk-1').ledger.provenance).toMatchObject({
      outcome: 'created',
      native: 'removed',
    });
    expect(identity(family(facts, 'workouts'), 'rt-1').ledger.provenance).toMatchObject({
      outcome: 'created',
      native: 'removed',
    });
    // The program-day plan itself still exists and is owned, but its parent is no longer verified.
    expect(identity(family(facts, 'workouts'), 'rt-2').ledger).toMatchObject(verified('created'));
    expect(edges(facts, 'program_parent', 'rt-2')[0].consistent).toBe(false);
    // The deleted plan's children are gone: both E-R2 edges are still emitted and fail closure.
    expect(edges(facts, 'child_order', 'rt-1').map((e: any) => e.consistent)).toEqual([
      false,
      false,
    ]);
    expect(drifted.result.verdict).toEqual({
      outcome: 'partial',
      reason_code: 'unresolved_identities',
    });
    expect(drifted.result.report.conditions).toEqual([
      'unresolved_identities',
      'relationship_unverified',
      'coverage_basis_unknown',
    ]);
    expect(reportFamily(drifted.result.report, 'programs')).toMatchObject({
      staged_unique: 1,
      native_present_verified: 0,
      unresolved: 1,
      reasons: [{ code: 'unresolved:native_target_removed', count: 1 }],
    });
    expect(reportFamily(drifted.result.report, 'workouts')).toMatchObject({
      staged_unique: 2,
      native_present_verified: 1,
      unresolved: 1,
      relationship_closure: 'unverified',
      // Bucket-j identities with a failing edge: rt-2 (E-R1). rt-1 is already unresolved in its
      // own right, so its failing E-R2 edges are not counted twice (Addendum A deviation 5).
      relationship_unverified: 1,
      reasons: [{ code: 'unresolved:native_target_removed', count: 1 }],
    });
    // Facts are recomputed from the native tables: the ledger and provenance said (and still say)
    // "reconstructed / created" — the read did not rewrite them, and did not believe them.
    expect(ledgerRows()).toEqual(ledgerBefore);
    expect(provenanceRows()).toEqual(provenanceBefore);
  });

  it("tenant isolation: coach B's rows never enter coach A's facts and a target owned by B is foreign_owner, symmetrically (R11)", async () => {
    settle(COACH_B);
    const a = await verifiedFixture();
    const b = await verifiedFixture(COACH_B);
    expect(a.program.id).not.toBe(b.program.id);
    const factsA = (await collect()).result.facts;
    const factsB = (await collect({ coach: COACH_B })).result.facts;
    for (const facts of [factsA, factsB]) {
      expect(facts.families.map((f: any) => [f.family, f.identities.length])).toEqual([
        ['programs', 1],
        ['workouts', 2],
      ]);
      expect(identity(family(facts, 'programs'), 'blk-1').ledger).toMatchObject(
        verified('created'),
      );
      expect(identity(family(facts, 'workouts'), 'rt-2').ledger).toMatchObject(verified('created'));
      expect(edges(facts, 'program_parent', 'rt-2')[0].consistent).toBe(true);
    }
    // Same source ids on both tenants, and both are present_owned in their own facts: the
    // identity is coach-scoped, never shared.
    expect(factsA).toEqual(factsB);
    // (1) A's provenance alone points at B's plan → provenance ≠ ledger target: provenance_mismatch.
    const rowA = `WHERE coach_id='coach' AND entity_type='workouts' AND source_id='rt-2'`;
    sql(`UPDATE "${PROVENANCE}" SET native_id = ${quote(b.day.id)} ${rowA}`);
    let repointed = (await collect()).result;
    expect(identity(family(repointed.facts, 'workouts'), 'rt-2').ledger.provenance.native).toBe(
      'provenance_mismatch',
    );
    expect(reportFamily(repointed.report, 'workouts').reasons).toEqual([
      { code: 'unresolved:identity_conflict', count: 1 },
    ]);
    // (2) A's ledger and provenance both point at B's plan: the row exists, but belongs to B.
    sql(`UPDATE "${LEDGER}" SET target_id = ${quote(b.day.id)} ${rowA}`);
    repointed = (await collect()).result;
    expect(identity(family(repointed.facts, 'workouts'), 'rt-2').ledger.provenance.native).toBe(
      'foreign_owner',
    );
    // B's plan hangs off B's program, which is not A's verified parent: E-R1 fails too.
    expect(edges(repointed.facts, 'program_parent', 'rt-2')[0].consistent).toBe(false);
    expect(repointed.verdict).toEqual({ outcome: 'partial', reason_code: 'unresolved_identities' });
    // rt-2 left bucket j, so its failing edge is subsumed by unresolved_identities (deviation 5).
    expect(repointed.report.conditions).toEqual([
      'unresolved_identities',
      'coverage_basis_unknown',
    ]);
    expect(reportFamily(repointed.report, 'workouts')).toMatchObject({
      native_present_verified: 1,
      unresolved: 1,
      reasons: [{ code: 'unresolved:identity_conflict', count: 1 }],
    });
    // Nothing of this is visible from B's side: B's facts are exactly what they were.
    expect((await collect({ coach: COACH_B })).result.facts).toEqual(factsB);
    // Symmetric: B's program repointed at A's program is foreign_owner for B, invisible to A.
    sql(`UPDATE "${PROVENANCE}" SET native_id = ${quote(a.program.id)} WHERE coach_id=${quote(COACH_B)} AND entity_type='programs' AND source_id='blk-1';
      UPDATE "${LEDGER}" SET target_id = ${quote(a.program.id)} WHERE coach_id=${quote(COACH_B)} AND entity_type='programs' AND source_id='blk-1'`);
    const factsB2 = (await collect({ coach: COACH_B })).result.facts;
    expect(identity(family(factsB2, 'programs'), 'blk-1').ledger.provenance.native).toBe(
      'foreign_owner',
    );
    expect(edges(factsB2, 'program_parent', 'rt-2')[0].consistent).toBe(false); // parent unverified
    expect(family(factsB2, 'workouts')).toEqual(family(factsB, 'workouts'));
    expect((await collect()).result.facts).toEqual(repointed.facts);
    // Native rows of the other tenant were only referenced, never touched.
    expect(programs(COACH_B)).toEqual([b.program]);
    expect(programs()).toEqual([a.program]);
  });
});

describe('unaccounted and unmapped input (R05, RC-3)', () => {
  it('orphan ledger rows, unresolved children and evidence-only rows are accounted, never dropped or zeroed (R05, R08)', async () => {
    stage('rt-1', 'workouts', STANDALONE);
    stage('rt-3', 'workouts', MIXED); // two children resolve, two do not
    stage('rt-c', 'workouts', { ...STANDALONE, title: 'Client Push', client_id: 'c-1' }); // client-linked
    await write('workouts');
    expect(count('WorkoutPlan')).toBe(2); // the client-linked row stays generic evidence (S8-C)
    expect(count('ScoutReconstructedEntity')).toBe(1);
    // Three orphans: one resolves to a staged family, one to a family nothing staged, one to no family.
    ledgerRow('ghost-1', 'workouts', 'reconstructed', {
      target_id: 'no-such-plan',
      target_kind: 'workout_plan',
    });
    ledgerRow('ghost-2', 'blocks', 'skipped', {
      reason: 'unresolved:relationship_pending:programs',
    });
    ledgerRow('ghost-3', 'notes', 'skipped', { reason: 'unresolved_family:notes' });
    const outcome = await collect();
    const facts = outcome.result.facts;
    expect(facts.ledger_without_staged).toBe(3);
    expect(
      facts.families.map((f: any) => [
        f.family,
        f.mapped,
        f.identities.length,
        f.ledger_without_staged,
      ]),
    ).toEqual([
      ['programs', true, 0, 1], // evidenced by the ledger alone (step token `blocks` → programs)
      ['workouts', true, 3, 1],
    ]);
    // The staged identities themselves are still verified; the orphans are additional, not substitutes.
    const workouts = family(facts, 'workouts');
    expect(identity(workouts, 'rt-1').ledger).toMatchObject(verified('created'));
    // R08: unresolved children are a histogram under their bucket-j parent, one edge per created child.
    expect(identity(workouts, 'rt-3').ledger).toEqual({
      status: 'reconstructed',
      target_kind: 'workout_plan',
      provenance: {
        outcome: 'created',
        native: 'present_owned',
        reason: null,
        unresolved_children: { 'unresolved:exercise_reference': 2 },
      },
    });
    expect(edges(facts, 'child_order', 'rt-3').map((e: any) => e.consistent)).toEqual([true, true]);
    expect(count(PROVENANCE, `source_id = ${quote(childSourceId('rt-3', { ordinal: 2 }))}`)).toBe(
      1,
    );
    // E-R3 / evidence only: the client-linked row was never a native target; the writer said why,
    // the facts carry it verbatim and the edge to the (unstaged) client identity is `null`.
    expect(identity(workouts, 'rt-c')).toMatchObject({
      client_linked: true,
      ledger: {
        status: 'reconstructed',
        target_kind: 'scout_entity',
        provenance: expect.objectContaining({
          outcome: 'unresolved',
          reason: 'unresolved:no_native_client_principal',
        }),
      },
    });
    expect(edges(facts, 'client_link', 'rt-c')).toEqual([
      {
        edge: 'client_link',
        from_family: 'workouts',
        from_identity: identityKey(PLATFORM, 'rt-c'),
        to_family: 'clients',
        to_identity: identityKey(PLATFORM, 'c-1'),
        consistent: null,
      },
    ]);
    expect(outcome.result.verdict).toEqual({
      outcome: 'partial',
      reason_code: 'unresolved_identities',
    });
    expect(outcome.result.report).toMatchObject({
      conditions: ['unresolved_identities', 'coverage_basis_unknown'],
      ledger_without_staged: 3,
    });
    expect(reportFamily(outcome.result.report, 'workouts')).toMatchObject({
      staged_unique: 3,
      native_present_verified: 2,
      unresolved: 1,
      failed: 0,
      rejected: 0,
      ledger_without_staged: 1,
      unresolved_children: 2,
      reasons: [{ code: 'unresolved:no_native_client_principal', count: 1 }],
      child_reasons: [{ code: 'unresolved:exercise_reference', count: 2 }],
      relationship_closure: 'verified',
    });
    expect(reportFamily(outcome.result.report, 'programs')).toMatchObject({
      staged_unique: 0,
      native_present_verified: 0,
      ledger_without_staged: 1,
    });
    expect(reportFamily(outcome.result.report, 'notes')).toBeUndefined(); // no staged token, no entry
  });

  it('unmapped tokens and unregistered platforms are their own condition; the declared-family union follows every registered staged platform (RC-3)', async () => {
    // Two registered platforms: `s9-proof` (four families) and `s9-proof-b` (workouts only).
    stage('rt-1', 'workouts', STANDALONE);
    await write('workouts');
    // Staged after the writer ran (what a later crawl step leaves behind): no ledger rows exist.
    stage('w-b', 'workouts', { title: 'B plan' }, 'coach', 'intent', PLATFORM_B);
    stage('n-1', 'notes', { title: 'a note' }); // a step the spec does not map
    stage('p-b', 'programs', { title: 'p' }, 'coach', 'intent', PLATFORM_B); // a family SPEC_B lacks
    const registered = await collect(REGISTRY_AB);
    let facts = registered.result.facts;
    expect(registered.families).toEqual([PLATFORM, PLATFORM_B]);
    expect(facts.spec_families).toEqual(ALL_FAMILIES); // the union, determinable
    expect(facts.families.map((f: any) => [f.family, f.mapped, f.resolution_reason])).toEqual([
      ['notes', false, 'unresolved_family:notes'],
      ['programs', false, 'unresolved_family:programs'],
      ['workouts', true, null],
    ]);
    // Identities follow the staged row order (id cursor), so compare as a set of two.
    expect(
      family(facts, 'workouts')
        .identities.map((i: any) => i.identity)
        .sort(),
    ).toEqual([identityKey(PLATFORM, 'rt-1'), identityKey(PLATFORM_B, 'w-b')].sort());
    expect(identity(family(facts, 'workouts'), 'rt-1').ledger).toMatchObject(verified('created'));
    // `w-b` is staged on a platform with no native rules and was never written: no ledger row.
    expect(identity(family(facts, 'workouts'), 'w-b', PLATFORM_B).ledger).toBeNull();
    expect(registered.result.verdict).toEqual({
      outcome: 'partial',
      reason_code: 'unresolved_family',
    });
    expect(registered.result.report.conditions).toEqual([
      'unresolved_family',
      'unresolved_identities',
      'coverage_basis_unknown',
    ]);
    expect(registered.result.report.required_families).toEqual(ALL_FAMILIES);
    expect(reportFamily(registered.result.report, 'notes')).toMatchObject({
      mapped: false,
      staged_unique: 1,
      unresolved: 1,
      reasons: [{ code: 'unresolved_family:notes', count: 1 }],
    });
    expect(reportFamily(registered.result.report, 'workouts')).toMatchObject({
      staged_unique: 2,
      native_present_verified: 1,
      unresolved: 1,
      reasons: [{ code: 'unresolved:not_reconstructed', count: 1 }],
    });
    // An unregistered platform makes the declared set undeterminable: null, never [] (RC-1).
    stage('x-1', 'routines', { title: 'x' }, 'coach', 'intent', 'unregistered');
    const unregistered = await collect(REGISTRY_AB);
    facts = unregistered.result.facts;
    expect(facts.spec_families).toBeNull();
    expect(family(facts, 'routines', false)).toMatchObject({
      resolution_reason: 'unsupported_platform:unregistered',
      identities: [expect.objectContaining({ identity: identityKey('unregistered', 'x-1') })],
    });
    expect(unregistered.result.report.required_families).toBeNull();
    expect(unregistered.result.verdict).toEqual({
      outcome: 'partial',
      reason_code: 'unresolved_family',
    });
    expect(reportFamily(unregistered.result.report, 'routines')).toMatchObject({
      mapped: false,
      rejected: 1,
      reasons: [{ code: 'unsupported_platform:unregistered', count: 1 }],
    });
    // Without the second spec the same rows are not "half known": `s9-proof-b` is unsupported.
    const single = (await collect()).result.facts;
    expect(single.spec_families).toBeNull();
    expect(family(single, 'workouts').identities).toHaveLength(1);
    expect(family(single, 'workouts', false)).toMatchObject({
      resolution_reason: 'unsupported_platform:s9-proof-b',
    });
  });
});

describe('bounded, read-only collection in one REPEATABLE READ transaction (C-9, R08)', () => {
  it('reads only, inside one REPEATABLE READ transaction, and changes nothing in any watched table', async () => {
    await verifiedFixture();
    claim('success');
    const before = snapshot();
    const outcome = await collect();
    // The isolation level is read back from PostgreSQL inside the very transaction that collected.
    expect(outcome.result.isolation).toBe('repeatable read');
    const log = statements(outcome);
    const begin = log.findIndex((q) => /^BEGIN/i.test(q));
    const commit = log.findIndex((q) => /^COMMIT/i.test(q));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(log.filter((q) => /^(BEGIN|COMMIT)/i.test(q))).toHaveLength(2); // one transaction
    expect(log.some((q) => /^ROLLBACK/i.test(q))).toBe(false);
    // Every SELECT sits inside the BEGIN..COMMIT span; nothing else is issued.
    for (const [n, statement] of log.entries()) {
      expect(statement).toMatch(/^(SELECT|BEGIN|COMMIT|SET |DEALLOCATE)/i);
      if (/^SELECT/i.test(statement)) {
        expect(n).toBeGreaterThan(begin);
        expect(n).toBeLessThan(commit);
      }
    }
    expect(log.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    expect(snapshot()).toEqual(before);
    expect(count('WorkoutPlan')).toBe(2);
    expect(count(COMPLETION)).toBe(1);
  });

  it('issues a query count fixed by the schema shape, +1 per additional 500-row staged page', async () => {
    // Empty run: claim, staged page, ledger page — no provenance or native lookups without families.
    const empty = await collect();
    expect(serviceSelects(empty)).toHaveLength(3);
    // Verified fixture: + provenance, + programs, + plans, + exercises (persons: no ids → no query).
    await verifiedFixture();
    const small = await collect();
    const smallSelects = serviceSelects(small);
    expect(smallSelects).toHaveLength(7);
    const tables = (selects: string[]) =>
      selects.map((q) => /FROM "public"\."([A-Za-z]+)"/.exec(q)?.[1]).sort();
    expect(tables(smallSelects)).toEqual(
      [
        COMPLETION,
        'ScoutIngestEntity',
        LEDGER,
        PROVENANCE,
        'WorkoutProgram',
        'WorkoutPlan',
        'WorkoutPlanExercise',
      ].sort(),
    );
    expect(tables(smallSelects)).not.toContain('Person');
    // 503 staged rows (RECONSTRUCT_PAGE_SIZE = 500): exactly one more staged page, nothing else grows.
    const values: string[] = [];
    for (let n = 0; n < 500; n++) {
      values.push(
        `(${quote(`coach-intent-workouts-${PLATFORM}-X${n}`)},'coach','intent','workouts',${quote(`X${n}`)},${quote(PLATFORM)},'{"title":"x"}')`,
      );
    }
    sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
      VALUES ${values.join(',\n')}`);
    expect(count('ScoutIngestEntity', `coach_id='coach' AND intent_id='intent'`)).toBe(503);
    const large = await collect();
    expect(serviceSelects(large)).toHaveLength(smallSelects.length + 1);
    expect(tables(serviceSelects(large)).filter((t) => t === 'ScoutIngestEntity')).toHaveLength(2);
    // The 500 never-written rows are unresolved identities, not zeros and not Complete.
    expect(family(large.result.facts, 'workouts').identities).toHaveLength(502);
    expect(reportFamily(large.result.report, 'workouts')).toMatchObject({
      staged_unique: 502,
      native_present_verified: 2,
      unresolved: 500,
      reasons: [{ code: 'unresolved:not_reconstructed', count: 500 }],
    });
    expect(large.result.verdict).toEqual({
      outcome: 'partial',
      reason_code: 'unresolved_identities',
    });
  });
});
