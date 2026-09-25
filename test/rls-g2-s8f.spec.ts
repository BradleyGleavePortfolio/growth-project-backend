// G2-S8-F proof on the isolated PostgreSQL 17 lane (S1-provisioned, synthetic data only).
// Ordered stages in ONE file, run with --runInBand, on a FRESH test/utils/g2-s8f-bootstrap.sh
// database (whole accepted history of the S8-F candidate composed onto the accepted S8-C head; no
// S8-F migration exists). The real ScoutEntitiesService / ScoutRosterService readers run in
// separate OS processes with the candidate generated client (unchanged test/utils/g2-tq0-worker.cjs)
// as the BYPASSRLS runtime role, exactly as the application does; the harness seeds the rows a
// writer would have produced. Only the cases the S8-F readiness (F04, F05, F07, F10) cannot prove
// with the default fakes are here: the NEW native joins against real RLS-enabled WorkoutPlan /
// WorkoutProgram tables, real provenance denial on the S8-B CHECK-constrained table, and archived-
// row paging on a real ledger. The accepted E/T-Q0, B, R, N/Q1, C, S8-B proofs are neither rerun
// nor restated. Nothing here claims deployment, S8-C acceptance, counts, activation or customer
// acceptance. PREPARED, NOT EXECUTED by the S8-F source-preparation lane.
//
// Environment: G2_S8F_DATABASE_URL, G2_S8F_CONFIRM (<db>:<port>), G2_S8F_PASSWORD, G2_S8F_PSQL.
import {
  ensureUser,
  evidence,
  expectedVersion,
  ledger,
  plan,
  program,
  refused,
  resetData,
  run,
  settle,
  sql,
  sqlAdmin,
  target,
  vouch,
} from './utils/g2-s8f-pg-harness';
import { G2_S8F_CLUSTER_MARKER, G2_S8F_DATABASE_MARKER } from './utils/g2-s8f-db';

jest.setTimeout(180000);

const OTHER = 'other-coach';
const entities = (options: Record<string, unknown> = {}) =>
  run({ action: 'entities', family: 'workouts', limit: 10, ...options });
const roster = (options: Record<string, unknown> = {}) =>
  run({ action: 'roster', limit: 10, ...options });
const ids = (r: { result?: any }) => (r.result?.entities ?? []).map((e: any) => e.id);

describe('S8-F stage 0: disposable lane identity', () => {
  it('is the S8-F disposable database on the S8-F disposable PG17 cluster', () => {
    expect(sql('SELECT current_database()')).toBe('g2_s8f_disposable');
    expect(Number(sql('SHOW server_version_num'))).toBe(expectedVersion);
    expect(sql("SELECT current_setting('cluster_name')")).toBe(G2_S8F_CLUSTER_MARKER);
    expect(
      sqlAdmin(
        `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`,
      ),
    ).toBe(G2_S8F_DATABASE_MARKER);
    expect(sql('SELECT inet_server_port()')).toBe(String(target.port));
    // The S8-B catalog shape the new joins depend on is present (composed head, not S8-F's doing).
    expect(
      sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
        AND table_name='ScoutReconstructionLedger' AND column_name='target_kind'`),
    ).toBe('1');
    expect(sql(`SELECT relrowsecurity FROM pg_class WHERE relname='WorkoutPlan'`)).toBe('t');
    expect(sql(`SELECT relrowsecurity FROM pg_class WHERE relname='WorkoutProgram'`)).toBe('t');
    expect(sql(`SELECT relrowsecurity FROM pg_class WHERE relname='ImportNativeProvenance'`)).toBe(
      't',
    );
  });
});

describe('S8-F stage 1: native joins on real RLS-enabled tables (F01/F02/F04)', () => {
  beforeAll(() => {
    resetData();
    settle('coach', 'intent');
    settle(OTHER, 'intent');
    // Legacy evidence row (NULL kind) and an explicitly typed scout_entity row.
    evidence('ev-1', 'w-legacy');
    ledger({ source: 'w-legacy', targetId: 'ev-1', kind: null });
    evidence('ev-2', 'w-typed-evidence');
    ledger({ source: 'w-typed-evidence', targetId: 'ev-2', kind: 'scout_entity' });
    // Same-coach native plan with created provenance; same-coach program with already_present.
    plan('plan-own');
    vouch({ kind: 'workout_plan', nativeId: 'plan-own', source: 'w-plan' });
    ledger({ source: 'w-plan', targetId: 'plan-own', kind: 'workout_plan' });
    program('prog-own');
    vouch({
      kind: 'workout_program',
      nativeId: 'prog-own',
      source: 'w-prog',
      outcome: 'already_present',
    });
    ledger({ source: 'w-prog', targetId: 'prog-own', kind: 'workout_program' });
    // F04: the OTHER coach's native plan, vouched for by the OTHER coach, but named by a ledger
    // row of THIS coach (a cross-tenant pointer must never surface).
    plan('plan-other', OTHER);
    vouch({ kind: 'workout_plan', nativeId: 'plan-other', source: 'w-cross', coach: OTHER });
    ledger({ source: 'w-cross', targetId: 'plan-other', kind: 'workout_plan' });
  });

  it('F01/F02: legacy and typed rows materialize side by side with the effective kind', async () => {
    const r = await entities();
    expect(r.failure).toBeUndefined();
    const byId = Object.fromEntries(r.result.entities.map((e: any) => [e.id, e]));
    expect(byId['ev-1']).toMatchObject({
      target_kind: 'scout_entity',
      native_id: null,
      client_source_id: 'tc_client_1',
      label: 'Evidence w-legacy',
      source_id: 'w-legacy',
    });
    expect(byId['ev-2']).toMatchObject({ target_kind: 'scout_entity', native_id: null });
    expect(byId['plan-own']).toMatchObject({
      target_kind: 'workout_plan',
      native_id: 'plan-own',
      client_source_id: null,
      label: 'Plan plan-own',
      source_id: 'w-plan',
      source_platform: 'truecoach',
      entity_type: 'workouts',
    });
    expect(byId['prog-own']).toMatchObject({
      target_kind: 'workout_program',
      native_id: 'prog-own',
      label: 'Program prog-own',
    });
    // Ledger (source_id) order: w-cross (dropped) < w-legacy < w-plan < w-prog < w-typed-evidence.
    // page_count keeps its established meaning: the size of THIS page body (four of five rows).
    expect(ids(r)).toEqual(['ev-1', 'plan-own', 'prog-own', 'ev-2']);
    expect(r.result.page_count).toBe(4);
    expect(r.result.next_cursor).toBeNull();
  });

  it('F04: a cross-tenant native pointer is dropped even though the other coach vouched for it', async () => {
    const r = await entities();
    expect(ids(r)).not.toContain('plan-other');
    // And the other coach's own read of its own intent sees only its own row, never ours.
    const other = await entities({ coach: OTHER });
    expect(other.failure).toBeUndefined();
    expect(ids(other)).toEqual([]);
    expect(other.result.page_count).toBe(0);
  });

  it('F04: the API roles cannot read the native tables or provenance directly (RLS + grants)', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['WorkoutPlan', 'WorkoutProgram', 'ImportNativeProvenance']) {
        // Either the privilege was revoked (permission denied) or RLS yields no rows; both are a
        // denial. The owner session switches role inside the statement.
        let denied = false;
        try {
          const n = sql(`SET ROLE ${role}; SELECT count(*) FROM "${table}"`);
          denied = n === '0';
        } catch (e) {
          denied = String(e).includes('permission denied');
        }
        expect(denied).toBe(true);
      }
    }
  });
});

describe('S8-F stage 2: provenance denial on the real S8-B table (F05)', () => {
  beforeAll(() => {
    resetData();
    settle('coach', 'intent');
    // Plan exists, same coach, but NO provenance at all.
    plan('plan-unvouched');
    ledger({ source: 'w-unvouched', targetId: 'plan-unvouched', kind: 'workout_plan' });
    // Plan exists; provenance exists but is `unresolved` (native_id NULL by CHECK).
    plan('plan-unresolved');
    vouch({ kind: 'workout_plan', nativeId: null, source: 'w-unresolved', outcome: 'unresolved' });
    ledger({ source: 'w-unresolved', targetId: 'plan-unresolved', kind: 'workout_plan' });
    // Plan exists; provenance names the SAME id under the WRONG native kind.
    plan('plan-kind-mismatch');
    vouch({ kind: 'workout_program', nativeId: 'plan-kind-mismatch', source: 'w-mismatch' });
    ledger({ source: 'w-mismatch', targetId: 'plan-kind-mismatch', kind: 'workout_plan' });
    // Ledger says workout_plan, provenance says workout_plan, but the row lives in WorkoutProgram.
    program('prog-as-plan');
    vouch({ kind: 'workout_plan', nativeId: 'prog-as-plan', source: 'w-table-mismatch' });
    ledger({ source: 'w-table-mismatch', targetId: 'prog-as-plan', kind: 'workout_plan' });
    // Properly vouched control row.
    plan('plan-ok');
    vouch({ kind: 'workout_plan', nativeId: 'plan-ok', source: 'w-ok' });
    ledger({ source: 'w-ok', targetId: 'plan-ok', kind: 'workout_plan' });
  });

  it('F05: only the vouched row surfaces; every denial keeps its ledger slot in the page', async () => {
    const r = await entities();
    expect(r.failure).toBeUndefined();
    expect(ids(r)).toEqual(['plan-ok']);
    expect(r.result.page_count).toBe(1);
    expect(r.result.next_cursor).toBeNull();
  });

  it('F05: the S8-B CHECKs make a forged "resolved without native_id" record impossible', () => {
    refused(
      `INSERT INTO "ImportNativeProvenance" (id,coach_id,source_namespace,entity_type,source_id,native_kind,native_id,outcome)
       VALUES ('forge-1','coach','truecoach','workouts','w-forge','workout_plan',NULL,'created')`,
      'ImportNativeProvenance_native_id_shape_check',
    );
    refused(
      `INSERT INTO "ImportNativeProvenance" (id,coach_id,source_namespace,entity_type,source_id,native_kind,native_id,outcome)
       VALUES ('forge-2','coach','truecoach','workouts','w-forge','meal_plan','x','created')`,
      'ImportNativeProvenance_native_kind_check',
    );
  });

  it('F05: a typed ledger row cannot exist without a target_id (shape CHECK)', () => {
    refused(
      `INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_id,source_platform,status,target_id,target_kind)
       VALUES (gen_random_uuid(),'coach','intent','workouts','w-shape','truecoach','reconstructed',NULL,'workout_plan')`,
      'ScoutReconstructionLedger_target_kind_shape_check',
    );
  });
});

describe('S8-F stage 3: archived-row paging on a real ledger (F07)', () => {
  beforeAll(() => {
    resetData();
    settle('coach', 'intent');
    // Lexical ledger order: w1 (live) < w2 (archived) < w3 (live) < w4 (archived) < w5 (live).
    for (const [n, archived] of [
      ['1', false],
      ['2', true],
      ['3', false],
      ['4', true],
      ['5', false],
    ] as const) {
      plan(`plan-${n}`, 'coach', `Plan ${n}`, archived);
      vouch({ kind: 'workout_plan', nativeId: `plan-${n}`, source: `w${n}` });
      ledger({ source: `w${n}`, targetId: `plan-${n}`, kind: 'workout_plan' });
    }
  });

  it('F07: archived natives are dropped from the body while the cursor walks every ledger row', async () => {
    const p1 = await entities({ limit: 2 });
    expect(p1.failure).toBeUndefined();
    expect(ids(p1)).toEqual(['plan-1']);
    expect(p1.result.page_count).toBe(1);
    expect(p1.result.next_cursor).not.toBeNull();

    const p2 = await entities({ limit: 2, cursor: p1.result.next_cursor });
    expect(ids(p2)).toEqual(['plan-3']);
    expect(p2.result.page_count).toBe(1);
    expect(p2.result.next_cursor).not.toBeNull();

    const p3 = await entities({ limit: 2, cursor: p2.result.next_cursor });
    expect(ids(p3)).toEqual(['plan-5']);
    expect(p3.result.page_count).toBe(1);
    expect(p3.result.next_cursor).toBeNull();
  });

  it('F07: un-archiving a row makes it reappear on the same page position (no cached truth)', async () => {
    sql(`UPDATE "WorkoutPlan" SET archived_at=NULL WHERE id='plan-2'`);
    const p1 = await entities({ limit: 2 });
    expect(ids(p1)).toEqual(['plan-1', 'plan-2']);
  });
});

describe('S8-F stage 4: roster stays the Person bridge on a real ledger (F10)', () => {
  beforeAll(() => {
    resetData();
    settle('coach', 'intent');
    ensureUser('coach');
    // Prisma enum PersonState maps to the DB enum literal 'InvitePending' (the model default).
    sql(`INSERT INTO "Person" (id,coach_id,source_platform,source_person_id,display_name)
      VALUES ('person-1','coach','truecoach','tc_1','Synthetic Person')`);
    ledger({ source: 'c1', family: 'clients', targetId: 'person-1', kind: null });
    // A typed non-person row that points at the very same Person id.
    ledger({ source: 'c2', family: 'clients', targetId: 'person-1', kind: 'workout_plan' });
  });

  it('F10: the response is qualified and only the NULL/person-kind row is served', async () => {
    const r = await roster();
    expect(r.failure).toBeUndefined();
    expect(r.result.roster_bridge_pending).toBe(true);
    expect(r.result.persons.map((p: any) => p.source_person_id)).toEqual(['tc_1']);
    expect(r.result.accounting.reconstructed).toBe(2);
  });

  it('F10: an unsettled intent is still the uniform 404 for both readers', async () => {
    resetData();
    settle('coach', 'intent', null);
    const e = await entities();
    expect(e.failure).toMatchObject({ status: 404 });
    const ro = await roster();
    expect(ro.failure).toMatchObject({ status: 404 });
    // No cross-tenant oracle: the other coach gets the same 404 on this intent.
    expect((await entities({ coach: OTHER })).failure).toMatchObject({ status: 404 });
  });
});
