import type {
  MappedProgram,
  MappedWorkoutTemplate,
} from '../../../../src/scout/reconstruct/native/native-rules';
import {
  persistEvidence,
  persistProgram,
  persistWorkoutTemplate,
  serialiseExerciseRows,
} from '../../../../src/scout/reconstruct/native/native-writers';
import { FakeNativeTx } from './fake-native-tx';

const COACH = 'coach-a';
const ROW = { source_platform: 's8c-proof', source_id: 'w-1' };

const program: MappedProgram = {
  sourcePlatform: 's8c-proof',
  name: 'Base',
  description: null,
  weeks: 4,
  daysPerWeek: 3,
  tags: ['defaulted:weeks'],
};

const child = (id: string, order: number, exerciseRef: string, tags: string[] = []) => ({
  childSourceId: `3:w-1#id:${id}`,
  ordinal: order,
  ok: true as const,
  fields: {
    exerciseRef,
    order,
    sets: 3,
    repsOrDurationSeconds: 8,
    weightLbs: null,
    restSeconds: 60,
    supersetGroupId: null,
    notes: null,
    tags,
  },
});

const standalone: MappedWorkoutTemplate = {
  sourcePlatform: 's8c-proof',
  name: 'Push Day',
  type: 'strength',
  durationEstimateMinutes: 45,
  programSourceId: null,
  weekIndex: null,
  dayIndex: null,
  exercises: [child('b', 1, 'barbell-bench-press'), child('a', 0, 'plank', ['prescription:time'])],
  tags: [],
};

function fresh() {
  const tx = new FakeNativeTx();
  tx.catalog = [
    { id: '11111111-1111-4111-8111-111111111111', slug: 'barbell-bench-press' },
    { id: '22222222-2222-4222-8222-222222222222', slug: 'plank' },
  ];
  return tx;
}

describe('persistProgram', () => {
  it('creates the template then its provenance, target before provenance, owner = importing coach', async () => {
    const tx = fresh();
    const out = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    expect(out).toEqual({
      ok: true,
      targetId: expect.any(String),
      targetKind: 'workout_program',
      unresolvedChildren: 0,
    });
    expect(tx.calls).toEqual([
      'importNativeProvenance.findUnique',
      'workoutProgram.create',
      'importNativeProvenance.create',
    ]);
    const created = [...tx.programs.values()][0];
    expect(created).toMatchObject({
      coach_id: COACH,
      owner_user_id: COACH,
      visibility: 'owner_only',
      name: 'Base',
      weeks: 4,
      days_per_week: 3,
      is_template: true,
      is_regime: false,
      version: 1,
    });
    expect([...tx.provenance.values()][0]).toMatchObject({
      coach_id: COACH,
      source_namespace: 's8c-proof',
      entity_type: 'programs',
      source_id: 'p-1',
      native_kind: 'workout_program',
      native_id: created.id,
      outcome: 'created',
      reason: 'defaulted:weeks',
    });
  });

  it('replays as already_present without touching the coach-edited row', async () => {
    const tx = fresh();
    const first = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    if (!first.ok) throw new Error('setup');
    tx.programs.get(first.targetId)!.name = 'Coach renamed';
    tx.calls = [];
    const again = await persistProgram(
      tx.asTx(),
      COACH,
      { ...ROW, source_id: 'p-1' },
      { ...program, name: 'Changed upstream' },
    );
    expect(again).toEqual({ ...first });
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'workoutProgram.findUnique']);
    expect(tx.programs.get(first.targetId)!.name).toBe('Coach renamed');
    expect(tx.programs.size).toBe(1);
  });

  it('honours a coach deletion (archived or gone → native_target_removed, never re-created)', async () => {
    const tx = fresh();
    const first = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    if (!first.ok) throw new Error('setup');
    tx.programs.get(first.targetId)!.archived_at = new Date();
    expect(await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program)).toEqual({
      ok: false,
      reason: 'unresolved:native_target_removed',
    });
    tx.programs.delete(first.targetId);
    expect(await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program)).toEqual({
      ok: false,
      reason: 'unresolved:native_target_removed',
    });
    expect(tx.programs.size).toBe(0);
  });

  it('reports identity_conflict when provenance points at another tenant or kind', async () => {
    const tx = fresh();
    const first = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    if (!first.ok) throw new Error('setup');
    tx.programs.get(first.targetId)!.coach_id = 'coach-b';
    expect(await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program)).toEqual({
      ok: false,
      reason: 'unresolved:identity_conflict',
    });
    [...tx.provenance.values()][0].native_kind = 'workout_plan';
    expect(await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program)).toEqual({
      ok: false,
      reason: 'unresolved:identity_conflict',
    });
  });

  it('rolls back the native row when provenance fails inside the transaction', async () => {
    const tx = fresh();
    tx.failAt = 'importNativeProvenance.create';
    await expect(
      tx.$transaction((t) =>
        persistProgram(t.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program),
      ),
    ).rejects.toThrow(/injected failure/);
    expect(tx.programs.size).toBe(0);
    expect(tx.provenance.size).toBe(0);
  });
});

describe('persistWorkoutTemplate', () => {
  it('creates a standalone plan with ordered, catalog-verified children and per-child provenance', async () => {
    const tx = fresh();
    const out = await persistWorkoutTemplate(tx.asTx(), COACH, ROW, standalone);
    expect(out).toEqual({
      ok: true,
      targetId: expect.any(String),
      targetKind: 'workout_plan',
      unresolvedChildren: 0,
    });
    const plan = [...tx.plans.values()][0];
    expect(plan).toMatchObject({
      coach_id: COACH,
      name: 'Push Day',
      type: 'strength',
      duration_estimate_minutes: 45,
      program_id: null,
      week_index: null,
      day_index: null,
      is_template: false,
      version: 1,
    });
    expect(plan.head_revision_id).toBeUndefined();
    expect(tx.revisions.size).toBe(0);
    const rows = [...tx.exercises.values()];
    expect(rows.map((r) => [r.exercise_external_id, r.order, r.workout_plan_id])).toEqual([
      ['barbell-bench-press', 1, plan.id],
      ['plank', 0, plan.id],
    ]);
    const prov = [...tx.provenance.values()];
    expect(
      prov.map((p) => [p.entity_type, p.source_id, p.native_kind, p.outcome, p.reason]),
    ).toEqual([
      ['workouts.exercise', '3:w-1#id:b', 'workout_plan_exercise', 'created', null],
      ['workouts.exercise', '3:w-1#id:a', 'workout_plan_exercise', 'created', 'prescription:time'],
      ['workouts', 'w-1', 'workout_plan', 'created', null],
    ]);
    expect(prov.every((p) => p.source_namespace === 's8c-proof')).toBe(true);
    // Target rows are written before their provenance; the parent's provenance is last.
    expect(tx.calls.indexOf('workoutPlan.create')).toBeLessThan(
      tx.calls.indexOf('workoutPlanExercise.create'),
    );
    expect(tx.calls.lastIndexOf('importNativeProvenance.create')).toBe(tx.calls.length - 1);
  });

  it('links exercises only on an exact id or slug match; anything else is an unresolved child', async () => {
    const tx = fresh();
    const template: MappedWorkoutTemplate = {
      ...standalone,
      exercises: [
        child('u', 0, '22222222-2222-4222-8222-222222222222'),
        child('c', 1, 'Barbell Bench Press'),
        child('s', 2, 'barbell-bench-press '),
        child('n', 3, 'nonexistent'),
        {
          childSourceId: '3:w-1#ord:4',
          ordinal: 4,
          ok: false,
          reason: 'unresolved:invalid_value:sets',
        },
      ],
    };
    const out = await persistWorkoutTemplate(tx.asTx(), COACH, ROW, template);
    expect(out).toEqual({
      ok: true,
      targetId: expect.any(String),
      targetKind: 'workout_plan',
      unresolvedChildren: 4,
    });
    expect([...tx.exercises.values()].map((r) => r.exercise_external_id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
    ]);
    const unresolved = [...tx.provenance.values()].filter((p) => p.outcome === 'unresolved');
    expect(unresolved.map((p) => [p.entity_type, p.source_id, p.native_id, p.reason])).toEqual([
      ['workouts.exercise', '3:w-1#id:c', null, 'unresolved:exercise_reference'],
      ['workouts.exercise', '3:w-1#id:s', null, 'unresolved:exercise_reference'],
      ['workouts.exercise', '3:w-1#id:n', null, 'unresolved:exercise_reference'],
      ['workouts.exercise', '3:w-1#ord:4', null, 'unresolved:invalid_value:sets'],
    ]);
    // Replay: already_present with the unresolved children re-counted.
    expect(await persistWorkoutTemplate(tx.asTx(), COACH, ROW, template)).toEqual({
      ...out,
      unresolvedChildren: 4,
    });
    expect(tx.plans.size).toBe(1);

    // §3.3 namespace: a top-level workout whose raw source id equals an encoded child id is a
    // distinct identity (entity_type `workouts` vs `workouts.exercise`) and the parent's
    // unresolved children are still re-reported on replay.
    const collidingRow = { ...ROW, source_id: '3:w-1#id:n' };
    const colliding = await persistWorkoutTemplate(tx.asTx(), COACH, collidingRow, {
      ...standalone,
      exercises: [],
    });
    expect(colliding).toEqual({
      ok: true,
      targetId: expect.any(String),
      targetKind: 'workout_plan',
      unresolvedChildren: 0,
    });
    expect(tx.plans.size).toBe(2);
    expect(
      [...tx.provenance.values()]
        .filter((p) => p.source_id === '3:w-1#id:n')
        .map((p) => [p.entity_type, p.native_kind, p.outcome]),
    ).toEqual([
      ['workouts.exercise', 'workout_plan_exercise', 'unresolved'],
      ['workouts', 'workout_plan', 'created'],
    ]);
    expect(await persistWorkoutTemplate(tx.asTx(), COACH, ROW, template)).toEqual({
      ...out,
      unresolvedChildren: 4,
    });
    expect(await persistWorkoutTemplate(tx.asTx(), COACH, collidingRow, standalone)).toEqual({
      ...colliding,
      unresolvedChildren: 0,
    });
    expect(tx.exercises.size).toBe(1);
  });

  it('program day: pending until the program exists, then links with an initial coach-authored revision', async () => {
    const tx = fresh();
    const day: MappedWorkoutTemplate = {
      ...standalone,
      programSourceId: 'p-1',
      weekIndex: 0,
      dayIndex: 2,
    };
    expect(await persistWorkoutTemplate(tx.asTx(), COACH, ROW, day)).toEqual({
      ok: false,
      reason: 'unresolved:relationship_pending:programs',
    });
    expect(tx.plans.size).toBe(0);
    expect(tx.provenance.size).toBe(0);

    const parent = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    if (!parent.ok) throw new Error('setup');
    const out = await persistWorkoutTemplate(tx.asTx(), COACH, ROW, day);
    expect(out).toMatchObject({ ok: true, targetKind: 'workout_plan' });
    const plan = [...tx.plans.values()][0];
    expect(plan).toMatchObject({
      program_id: parent.targetId,
      week_index: 0,
      day_index: 2,
      is_template: true,
    });
    const revision = [...tx.revisions.values()][0];
    expect(revision).toMatchObject({
      workout_plan_id: plan.id,
      revision_index: 0,
      author_id: COACH,
      author_kind: 'coach',
      cause: 'initial',
      plan_meta_json: {
        name: 'Push Day',
        type: 'strength',
        duration_estimate_minutes: 45,
        week_index: 0,
        day_index: 2,
      },
    });
    expect(
      (revision.exercises_json as { exercise_external_id: string; order: number }[]).map(
        (e) => e.order,
      ),
    ).toEqual([0, 1]);
    expect(plan.head_revision_id).toBe(revision.id);
  });

  it('program day: a removed or foreign parent is relationship_missing (never a guessed link)', async () => {
    const tx = fresh();
    const parent = await persistProgram(tx.asTx(), COACH, { ...ROW, source_id: 'p-1' }, program);
    if (!parent.ok) throw new Error('setup');
    tx.programs.get(parent.targetId)!.archived_at = new Date();
    const day: MappedWorkoutTemplate = {
      ...standalone,
      programSourceId: 'p-1',
      weekIndex: 0,
      dayIndex: 0,
    };
    expect(await persistWorkoutTemplate(tx.asTx(), COACH, ROW, day)).toEqual({
      ok: false,
      reason: 'unresolved:relationship_missing:programs',
    });
    // Another coach's program with the same source id is invisible: tenant-scoped identity.
    expect(await persistWorkoutTemplate(tx.asTx(), 'coach-b', ROW, day)).toEqual({
      ok: false,
      reason: 'unresolved:relationship_pending:programs',
    });
    expect(tx.plans.size).toBe(0);
  });

  it('rolls back the plan and its children when a later write fails', async () => {
    const tx = fresh();
    tx.failAt = 'workoutPlanExercise.create';
    await expect(
      tx.$transaction((t) => persistWorkoutTemplate(t.asTx(), COACH, ROW, standalone)),
    ).rejects.toThrow(/injected failure/);
    expect(tx.plans.size).toBe(0);
    expect(tx.exercises.size).toBe(0);
    expect(tx.provenance.size).toBe(0);
  });

  it('serialises exercise rows in the frozen revision shape sorted by order', () => {
    expect(
      serialiseExerciseRows([
        {
          exercise_external_id: 'b',
          order: 1,
          sets: 3,
          reps_or_duration_seconds: 8,
          weight_lbs: null,
          rest_seconds: null,
          superset_group_id: null,
          notes: null,
        },
        {
          exercise_external_id: 'a',
          order: 0,
          sets: 3,
          reps_or_duration_seconds: 60,
          weight_lbs: 45,
          rest_seconds: 30,
          superset_group_id: 'g',
          notes: 'n',
        },
      ]),
    ).toEqual([
      {
        exercise_external_id: 'a',
        order: 0,
        sets: 3,
        reps_or_duration_seconds: 60,
        weight_lbs: 45,
        rest_seconds: 30,
        superset_group_id: 'g',
        notes: 'n',
      },
      {
        exercise_external_id: 'b',
        order: 1,
        sets: 3,
        reps_or_duration_seconds: 8,
        weight_lbs: null,
        rest_seconds: null,
        superset_group_id: null,
        notes: null,
      },
    ]);
  });
});

describe('persistEvidence (workouts kept as evidence)', () => {
  const entity = { sourcePlatform: 's8c-proof', clientSourceId: 'c-9', label: 'Leg day' };

  it('without native rules it is exactly the accepted generic upsert and never touches provenance', async () => {
    const tx = fresh();
    const out = await persistEvidence(tx.asTx(), COACH, ROW, entity, {
      recordNoNativePrincipal: false,
    });
    expect(out).toEqual({
      ok: true,
      targetId: expect.any(String),
      targetKind: 'scout_entity',
      unresolvedChildren: 0,
    });
    expect(tx.calls).toEqual(['scoutReconstructedEntity.upsert']);
    expect([...tx.entities.values()][0]).toMatchObject({
      coach_id: COACH,
      source_platform: 's8c-proof',
      entity_type: 'workouts',
      source_id: 'w-1',
      client_source_id: 'c-9',
      label: 'Leg day',
    });
  });

  it('client-linked under declared rules: evidence row + explicit unresolved provenance, no User/plan', async () => {
    const tx = fresh();
    const out = await persistEvidence(tx.asTx(), COACH, ROW, entity, {
      recordNoNativePrincipal: true,
    });
    expect(out).toMatchObject({ ok: true, targetKind: 'scout_entity' });
    expect(tx.plans.size).toBe(0);
    expect([...tx.provenance.values()]).toEqual([
      expect.objectContaining({
        entity_type: 'workouts',
        source_id: 'w-1',
        native_kind: 'workout_plan',
        native_id: null,
        outcome: 'unresolved',
        reason: 'unresolved:no_native_client_principal',
      }),
    ]);
    // Replay is idempotent: one evidence row, one provenance row.
    await persistEvidence(tx.asTx(), COACH, ROW, entity, { recordNoNativePrincipal: true });
    expect(tx.entities.size).toBe(1);
    expect(tx.provenance.size).toBe(1);
  });

  it('never downgrades an existing native plan to evidence', async () => {
    const tx = fresh();
    const native = await persistWorkoutTemplate(tx.asTx(), COACH, ROW, standalone);
    if (!native.ok) throw new Error('setup');
    const out = await persistEvidence(tx.asTx(), COACH, ROW, entity, {
      recordNoNativePrincipal: true,
    });
    expect(out).toEqual({
      ok: true,
      targetId: native.targetId,
      targetKind: 'workout_plan',
      unresolvedChildren: 0,
    });
    expect(tx.entities.size).toBe(0);
  });

  it('returns a failed verification as-is and writes nothing (plan gone or foreign)', async () => {
    const tx = fresh();
    const native = await persistWorkoutTemplate(tx.asTx(), COACH, ROW, standalone);
    if (!native.ok) throw new Error('setup');
    const snapshot = [...tx.provenance.values()].map((p) => ({ ...p }));
    const parent = snapshot.find((p) => p.native_kind === 'workout_plan')!;
    expect(parent).toMatchObject({ outcome: 'created', native_id: native.targetId });

    // Coach archived the plan → native_target_removed; no evidence row, provenance untouched.
    tx.plans.get(native.targetId)!.archived_at = new Date();
    tx.calls = [];
    expect(
      await persistEvidence(tx.asTx(), COACH, ROW, entity, { recordNoNativePrincipal: true }),
    ).toEqual({ ok: false, reason: 'unresolved:native_target_removed' });
    expect(tx.calls).toEqual(['importNativeProvenance.findUnique', 'workoutPlan.findUnique']);

    // Coach deleted the plan → still native_target_removed.
    tx.plans.delete(native.targetId);
    expect(
      await persistEvidence(tx.asTx(), COACH, ROW, entity, { recordNoNativePrincipal: true }),
    ).toEqual({ ok: false, reason: 'unresolved:native_target_removed' });

    // Provenance points at another tenant, or at the wrong native kind → identity_conflict.
    tx.plans.set(native.targetId, { id: native.targetId, coach_id: 'coach-b', archived_at: null });
    expect(
      await persistEvidence(tx.asTx(), COACH, ROW, entity, { recordNoNativePrincipal: true }),
    ).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });
    [...tx.provenance.values()].find((p) => p.id === parent.id)!.native_kind = 'workout_program';
    expect(
      await persistEvidence(tx.asTx(), COACH, ROW, entity, { recordNoNativePrincipal: true }),
    ).toEqual({ ok: false, reason: 'unresolved:identity_conflict' });

    expect(tx.entities.size).toBe(0);
    expect(tx.plans.size).toBe(1);
    // Every provenance row (parent and children) is byte-equal to the post-create snapshot,
    // apart from this test's own native_kind mutation on the parent.
    expect([...tx.provenance.values()]).toEqual(
      snapshot.map((p) => (p.id === parent.id ? { ...p, native_kind: 'workout_program' } : p)),
    );
    expect(tx.calls.filter((c) => /upsert|update|create/.test(c))).toEqual([]);
  });
});
