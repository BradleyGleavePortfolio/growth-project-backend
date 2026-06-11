/**
 * MWB-5 — exhaustive unit matrix for the PURE workout-diff applier.
 *
 * The applier (`src/ai/gateway/materialisers/__shared/workout-diff.applier.ts`)
 * is the single integrity boundary both live-create materialisers route ALL
 * plan mutation through (brief R0). It performs ZERO I/O, so it is deterministic
 * and fully testable in isolation. This suite proves the five invariants the
 * applier documents (I1 input immutability, I2 derived order, I3 stable refs,
 * I4 reorder totality, I5 empty-diff no-op) plus the defence-in-depth re-parse
 * and the empty-patch guards — the bulk of brief Test matrix #9.
 */

import {
  WorkoutDiffApplyError,
  applyWorkoutDiff,
} from '../src/ai/gateway/materialisers/__shared/workout-diff.applier';
import {
  PlanExerciseSnapshot,
  PlanSnapshot,
  WorkoutDiffOp,
  emptyPlanSnapshot,
} from '../src/ai/gateway/materialisers/__shared/workout-diff.types';

/** Build an exercise snapshot row with sensible defaults. */
function ex(
  client_ref: string,
  order: number,
  overrides: Partial<PlanExerciseSnapshot> = {},
): PlanExerciseSnapshot {
  return {
    client_ref,
    exercise_external_id: `ext-${client_ref}`,
    order,
    sets: 3,
    reps_or_duration_seconds: 10,
    weight_lbs: null,
    rest_seconds: null,
    superset_group_id: null,
    notes: null,
    ...overrides,
  };
}

/** A baseline with three ordered exercises a..c. */
function baselineABC(): PlanSnapshot {
  return {
    meta: { name: 'Leg day', type: 'strength', duration_estimate_minutes: 45 },
    exercises: [ex('a', 0), ex('b', 1), ex('c', 2)],
  };
}

const refs = (s: PlanSnapshot): string[] => s.exercises.map((e) => e.client_ref);
const orders = (s: PlanSnapshot): number[] => s.exercises.map((e) => e.order);

describe('applyWorkoutDiff — empty diff (I5 no-op)', () => {
  it('returns a faithful copy of an empty baseline unchanged', () => {
    const base = emptyPlanSnapshot();
    const out = applyWorkoutDiff(base, []);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });

  it('returns a faithful copy of a populated baseline unchanged', () => {
    const base = baselineABC();
    const out = applyWorkoutDiff(base, []);
    expect(out).toEqual(base);
    expect(refs(out)).toEqual(['a', 'b', 'c']);
    expect(orders(out)).toEqual([0, 1, 2]);
  });
});

describe('applyWorkoutDiff — input immutability (I1)', () => {
  it('never mutates the supplied baseline, even on structural ops', () => {
    const base = baselineABC();
    const snapshotJson = JSON.stringify(base);
    applyWorkoutDiff(base, [
      { kind: 'add_exercise', client_ref: 'd', exercise_external_id: 'ext-d', sets: 4, reps_or_duration_seconds: 8 },
      { kind: 'remove_exercise', client_ref: 'a' },
      { kind: 'reorder', ordered_client_refs: ['d', 'c', 'b'] },
    ]);
    // Baseline is byte-for-byte unchanged.
    expect(JSON.stringify(base)).toBe(snapshotJson);
  });

  it('does not share exercise object references with the result', () => {
    const base = baselineABC();
    const out = applyWorkoutDiff(base, []);
    out.exercises[0].sets = 999;
    expect(base.exercises[0].sets).toBe(3);
  });
});

describe('applyWorkoutDiff — add_exercise', () => {
  it('appends a new exercise and derives 0-based contiguous order (I2)', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'add_exercise', client_ref: 'd', exercise_external_id: 'ext-d', sets: 5, reps_or_duration_seconds: 5 },
    ]);
    expect(refs(out)).toEqual(['a', 'b', 'c', 'd']);
    expect(orders(out)).toEqual([0, 1, 2, 3]);
    const added = out.exercises[3];
    expect(added.sets).toBe(5);
    expect(added.reps_or_duration_seconds).toBe(5);
    // Optional fields default to null when omitted.
    expect(added.weight_lbs).toBeNull();
    expect(added.rest_seconds).toBeNull();
    expect(added.superset_group_id).toBeNull();
    expect(added.notes).toBeNull();
  });

  it('adds onto an empty baseline', () => {
    const out = applyWorkoutDiff(emptyPlanSnapshot(), [
      { kind: 'add_exercise', client_ref: 'x', exercise_external_id: 'ext-x', sets: 3, reps_or_duration_seconds: 12, weight_lbs: 95, notes: 'tempo' },
    ]);
    expect(refs(out)).toEqual(['x']);
    expect(orders(out)).toEqual([0]);
    expect(out.exercises[0].weight_lbs).toBe(95);
    expect(out.exercises[0].notes).toBe('tempo');
  });

  it('throws DUPLICATE_REF when adding a ref already present (I3, no silent overwrite)', () => {
    expect(() =>
      applyWorkoutDiff(baselineABC(), [
        { kind: 'add_exercise', client_ref: 'b', exercise_external_id: 'ext-dup', sets: 3, reps_or_duration_seconds: 10 },
      ]),
    ).toThrow(WorkoutDiffApplyError);
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'add_exercise', client_ref: 'b', exercise_external_id: 'ext-dup', sets: 3, reps_or_duration_seconds: 10 },
      ]);
    } catch (e) {
      expect(e).toBeInstanceOf(WorkoutDiffApplyError);
      expect((e as WorkoutDiffApplyError).code).toBe('DUPLICATE_REF');
      expect((e as WorkoutDiffApplyError).opIndex).toBe(0);
    }
  });
});

describe('applyWorkoutDiff — update_exercise (true patch)', () => {
  it('patches only the provided fields, leaving the rest untouched', () => {
    const base: PlanSnapshot = {
      meta: { name: 'p', type: 'strength', duration_estimate_minutes: null },
      exercises: [ex('a', 0, { sets: 3, reps_or_duration_seconds: 10, weight_lbs: 100, notes: 'old' })],
    };
    const out = applyWorkoutDiff(base, [
      { kind: 'update_exercise', client_ref: 'a', sets: 5 },
    ]);
    const row = out.exercises[0];
    expect(row.sets).toBe(5);
    // Untouched fields preserved.
    expect(row.reps_or_duration_seconds).toBe(10);
    expect(row.weight_lbs).toBe(100);
    expect(row.notes).toBe('old');
  });

  it('distinguishes "omit field" from "set field to null" (clears a nullable)', () => {
    const base: PlanSnapshot = {
      meta: { name: 'p', type: 'strength', duration_estimate_minutes: null },
      exercises: [ex('a', 0, { weight_lbs: 100, notes: 'keep' })],
    };
    const out = applyWorkoutDiff(base, [
      { kind: 'update_exercise', client_ref: 'a', weight_lbs: null },
    ]);
    expect(out.exercises[0].weight_lbs).toBeNull();
    // notes omitted → preserved.
    expect(out.exercises[0].notes).toBe('keep');
  });

  it('throws UNKNOWN_REF when updating a missing ref (I3)', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'update_exercise', client_ref: 'zzz', sets: 4 },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('UNKNOWN_REF');
    }
  });

  it('throws MALFORMED_OP when an update changes no field (defence-in-depth)', () => {
    // The op passes the per-op zod object schema (all fields optional) but the
    // applier must reject a no-field patch so it can never be a silent no-op.
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'update_exercise', client_ref: 'a' } as WorkoutDiffOp,
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('MALFORMED_OP');
    }
  });
});

describe('applyWorkoutDiff — remove_exercise', () => {
  it('removes the addressed exercise and renumbers the remainder (I2)', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'remove_exercise', client_ref: 'b' },
    ]);
    expect(refs(out)).toEqual(['a', 'c']);
    expect(orders(out)).toEqual([0, 1]);
  });

  it('can remove down to an empty plan', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'remove_exercise', client_ref: 'a' },
      { kind: 'remove_exercise', client_ref: 'b' },
      { kind: 'remove_exercise', client_ref: 'c' },
    ]);
    expect(out.exercises).toHaveLength(0);
  });

  it('throws UNKNOWN_REF when removing a missing ref (I3)', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'remove_exercise', client_ref: 'nope' },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('UNKNOWN_REF');
    }
  });
});

describe('applyWorkoutDiff — reorder (I4 totality)', () => {
  it('reorders by listing every ref once and renumbers to match (I2)', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'reorder', ordered_client_refs: ['c', 'a', 'b'] },
    ]);
    expect(refs(out)).toEqual(['c', 'a', 'b']);
    expect(orders(out)).toEqual([0, 1, 2]);
  });

  it('throws REORDER_MISMATCH when a ref is missing from the request', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'reorder', ordered_client_refs: ['a', 'b'] },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('REORDER_MISMATCH');
    }
  });

  it('throws REORDER_MISMATCH when the request has an extra/unknown ref', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'reorder', ordered_client_refs: ['a', 'b', 'c', 'd'] },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('REORDER_MISMATCH');
    }
  });

  it('throws REORDER_MISMATCH when the request contains a duplicate ref', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'reorder', ordered_client_refs: ['a', 'a', 'b'] },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('REORDER_MISMATCH');
    }
  });
});

describe('applyWorkoutDiff — plan_meta', () => {
  it('patches only the provided meta fields', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'plan_meta', name: 'Renamed' },
    ]);
    expect(out.meta.name).toBe('Renamed');
    // type/duration unchanged.
    expect(out.meta.type).toBe('strength');
    expect(out.meta.duration_estimate_minutes).toBe(45);
  });

  it('can change type and clear duration to null', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'plan_meta', type: 'cardio', duration_estimate_minutes: null },
    ]);
    expect(out.meta.type).toBe('cardio');
    expect(out.meta.duration_estimate_minutes).toBeNull();
  });

  it('throws MALFORMED_OP when a plan_meta op changes no field', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'plan_meta' } as WorkoutDiffOp,
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('MALFORMED_OP');
    }
  });
});

describe('applyWorkoutDiff — composite sequences (ops observe earlier effects)', () => {
  it('applies add → update → reorder → remove in order', () => {
    const out = applyWorkoutDiff(baselineABC(), [
      { kind: 'add_exercise', client_ref: 'd', exercise_external_id: 'ext-d', sets: 4, reps_or_duration_seconds: 6 },
      { kind: 'update_exercise', client_ref: 'd', notes: 'finisher' },
      { kind: 'reorder', ordered_client_refs: ['d', 'a', 'b', 'c'] },
      { kind: 'remove_exercise', client_ref: 'b' },
    ]);
    expect(refs(out)).toEqual(['d', 'a', 'c']);
    expect(orders(out)).toEqual([0, 1, 2]);
    expect(out.exercises[0].notes).toBe('finisher');
  });

  it('reports the failing op index when a later op is unapplicable', () => {
    try {
      applyWorkoutDiff(baselineABC(), [
        { kind: 'update_exercise', client_ref: 'a', sets: 4 },
        { kind: 'remove_exercise', client_ref: 'missing' },
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).opIndex).toBe(1);
      expect((e as WorkoutDiffApplyError).code).toBe('UNKNOWN_REF');
    }
  });
});

describe('applyWorkoutDiff — defence-in-depth re-parse (drifted payload)', () => {
  it('throws MALFORMED_OP when an op fails the zod schema (e.g. sets < 1)', () => {
    try {
      applyWorkoutDiff(emptyPlanSnapshot(), [
        // sets:0 violates the schema bound; a drifted DB payload must not apply.
        { kind: 'add_exercise', client_ref: 'a', exercise_external_id: 'ext-a', sets: 0, reps_or_duration_seconds: 10 } as WorkoutDiffOp,
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('MALFORMED_OP');
    }
  });

  it('throws MALFORMED_OP on an unknown op kind', () => {
    try {
      applyWorkoutDiff(emptyPlanSnapshot(), [
        { kind: 'teleport', client_ref: 'a' } as unknown as WorkoutDiffOp,
      ]);
      fail('expected throw');
    } catch (e) {
      expect((e as WorkoutDiffApplyError).code).toBe('MALFORMED_OP');
    }
  });
});
