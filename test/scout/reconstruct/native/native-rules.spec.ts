import type { Prisma } from '@prisma/client';
import {
  childSourceId,
  childSourceIdPrefix,
  supersetGroupId,
  toPounds,
  unresolved,
  UNRESOLVED_CODE,
} from '../../../../src/scout/reconstruct/native/native-contract';
import {
  interpretProgram,
  interpretWorkout,
  parseNativeRuleSet,
  type NativeRuleSet,
} from '../../../../src/scout/reconstruct/native/native-rules';

/**
 * S8-C native rule grammar + interpreters (pure, total). Fixtures are
 * synthetic: no real source has declared native fields yet, so nothing here
 * claims a TrueCoach mapping.
 */
const RULES: NativeRuleSet = parseNativeRuleSet(
  {
    specVersion: 1,
    sourcePlatform: 's8c-proof',
    families: {
      programs: {
        description: { kind: 'text', paths: [['description']] },
        weeks: { kind: 'integer', paths: [['weeks']], default: 1 },
        daysPerWeek: { kind: 'count', paths: [['days']] },
        archived: { kind: 'flag', paths: [['archived']], truthy: [true, 'yes'] },
      },
      workouts: {
        type: {
          kind: 'enum',
          paths: [['kind']],
          map: { lift: 'strength', run: 'cardio' },
          default: 'strength',
        },
        durationEstimateMinutes: { kind: 'duration', paths: [['duration_s']], unit: 'seconds' },
        programSourceId: { kind: 'identifier', paths: [['program', 'id']] },
        weekIndex: { kind: 'integer', paths: [['week']], base: 1 },
        dayIndex: { kind: 'integer', paths: [['day']], base: 1 },
        archived: { kind: 'flag', paths: [['deleted']], truthy: [true] },
        exercises: {
          paths: [['items']],
          item: {
            id: { kind: 'identifier', paths: [['id']] },
            exerciseRef: { kind: 'identifier', paths: [['exercise']] },
            order: { kind: 'integer', paths: [['position']], base: 1 },
            sets: { kind: 'integer', paths: [['sets']] },
            reps: { kind: 'integer', paths: [['reps']] },
            durationSeconds: { kind: 'duration', paths: [['seconds']], unit: 'seconds' },
            weight: { kind: 'weight', paths: [['kg']], unit: 'kg' },
            restSeconds: { kind: 'duration', paths: [['rest_min']], unit: 'minutes' },
            groupKey: { kind: 'identifier', paths: [['group']] },
            notes: { kind: 'text', paths: [['notes']] },
          },
        },
      },
    },
  },
  'test',
);

const seam = (
  payload: Prisma.JsonValue,
  label: string | null = 'Push Day',
  clientSourceId: string | null = null,
) => ({
  sourcePlatform: 's8c-proof',
  label,
  clientSourceId,
  payload,
  sourceId: 'w-1',
});

describe('native contract helpers', () => {
  it('encodes child identities so a parent id can never collide with a child (§3.3)', () => {
    expect(childSourceId('w-1', { id: 'x' })).toBe('3:w-1#id:x');
    expect(childSourceId('w-1', { ordinal: 2 })).toBe('3:w-1#ord:2');
    expect(childSourceIdPrefix('w-1')).toBe('3:w-1#');
    expect(childSourceId('w-1#id:x', { ordinal: 0 })).toBe('8:w-1#id:x#ord:0');
    expect(supersetGroupId('w-1', 'A')).toBe('3:w-1#group:A');
  });

  it('formats unresolved reasons from the closed code set and rejects data-bearing qualifiers', () => {
    expect(unresolved(UNRESOLVED_CODE.exercise_reference)).toBe('unresolved:exercise_reference');
    expect(unresolved(UNRESOLVED_CODE.missing_required_field, 'type')).toBe(
      'unresolved:missing_required_field:type',
    );
    expect(() => unresolved(UNRESOLVED_CODE.missing_required_field)).toThrow(/qualifier/);
    expect(() => unresolved(UNRESOLVED_CODE.invalid_value, 'Bench Press 3x10')).toThrow(
      /qualifier/,
    );
    expect(() => unresolved(UNRESOLVED_CODE.exercise_reference, 'x')).toThrow(/no qualifier/);
  });

  it('converts kilograms with the fixed factor', () => {
    expect(toPounds(100, 'kg')).toBeCloseTo(220.462, 3);
    expect(toPounds(45, 'lb')).toBe(45);
  });
});

describe('parseNativeRuleSet', () => {
  it('rejects unknown keys, wrong kinds and missing units (fail closed)', () => {
    expect(() =>
      parseNativeRuleSet({ specVersion: 2, sourcePlatform: 'x', families: {} }, 't'),
    ).toThrow(/specVersion/);
    expect(() =>
      parseNativeRuleSet({ specVersion: 1, sourcePlatform: 'x', families: { billing: {} } }, 't'),
    ).toThrow();
    expect(() =>
      parseNativeRuleSet(
        {
          specVersion: 1,
          sourcePlatform: 'x',
          families: { workouts: { type: { kind: 'text', paths: [['t']] } } },
        },
        't',
      ),
    ).toThrow();
    expect(() =>
      parseNativeRuleSet(
        {
          specVersion: 1,
          sourcePlatform: 'x',
          families: { programs: { weeks: { kind: 'duration', paths: [['w']] } } },
        },
        't',
      ),
    ).toThrow();
    expect(() =>
      parseNativeRuleSet(
        {
          specVersion: 1,
          sourcePlatform: 'x',
          families: { workouts: { exercises: { paths: [], item: {} } } },
        },
        't',
      ),
    ).toThrow(/paths/);
  });

  it('accepts an empty families object (a source that declares nothing native)', () => {
    const set = parseNativeRuleSet({ specVersion: 1, sourcePlatform: 'x', families: {} }, 't');
    expect(set.families.workouts).toBeUndefined();
    expect(set.families.programs).toBeUndefined();
  });
});

describe('interpretProgram', () => {
  it('maps a coach-owned program with defaults tagged on the created record', () => {
    const result = interpretProgram(
      RULES.families.programs,
      seam({ days: ['mon', 'tue', 'wed', 'thu'], description: ' 12 week block ' }, 'Base'),
    );
    expect(result).toEqual({
      ok: true,
      mapped: {
        sourcePlatform: 's8c-proof',
        name: 'Base',
        description: '12 week block',
        weeks: 1,
        daysPerWeek: 4,
        tags: ['defaulted:weeks'],
      },
    });
  });

  it('refuses client-linked, archived, nameless and non-integral rows with exact reasons', () => {
    const rules = RULES.families.programs;
    expect(
      interpretProgram(rules, seam({ days: ['mon', 'tue', 'wed', 'thu'] }, 'Base', 'c-9')),
    ).toEqual({
      ok: false,
      reason: 'unresolved:no_native_client_principal',
    });
    expect(
      interpretProgram(
        rules,
        seam({ days: ['mon', 'tue', 'wed', 'thu'], archived: 'yes' }, 'Base'),
      ),
    ).toEqual({
      ok: false,
      reason: 'unresolved:source_archived',
    });
    expect(interpretProgram(rules, seam({ days: ['mon', 'tue', 'wed', 'thu'] }, null))).toEqual({
      ok: false,
      reason: 'unresolved:missing_required_field:name',
    });
    expect(
      interpretProgram(rules, seam({ days: ['mon', 'tue', 'wed', 'thu'], weeks: 2.5 }, 'Base')),
    ).toEqual({
      ok: false,
      reason: 'unresolved:invalid_value:weeks',
    });
    expect(interpretProgram(rules, seam({}, 'Base'))).toEqual({
      ok: false,
      reason: 'unresolved:missing_required_field:days_per_week',
    });
    expect(interpretProgram(rules, seam({ days: 4 }, 'Base'))).toEqual({
      ok: false,
      reason: 'unresolved:invalid_value:days_per_week',
    });
  });
});

describe('interpretWorkout', () => {
  const rules = RULES.families.workouts;

  it('maps a standalone template with typed, unit-converted, base-adjusted children in source order', () => {
    const result = interpretWorkout(
      rules,
      seam({
        kind: 'lift',
        duration_s: 2700,
        items: [
          {
            id: 'e2',
            exercise: 'barbell-bench-press',
            position: 2,
            sets: 3,
            reps: 8,
            kg: 100,
            rest_min: 2,
            group: 'A',
          },
          { id: 'e1', exercise: 'plank', position: 1, sets: 3, seconds: 60, notes: ' hold ' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapped.type).toBe('strength');
    expect(result.mapped.durationEstimateMinutes).toBe(45);
    expect(result.mapped.programSourceId).toBeNull();
    expect(result.mapped.tags).toEqual([]);
    expect(result.mapped.exercises.map((c) => c.childSourceId)).toEqual([
      '3:w-1#id:e2',
      '3:w-1#id:e1',
    ]);
    const [bench, plank] = result.mapped.exercises;
    expect(bench.ok && bench.fields).toEqual({
      exerciseRef: 'barbell-bench-press',
      order: 1,
      sets: 3,
      repsOrDurationSeconds: 8,
      weightLbs: toPounds(100, 'kg'),
      restSeconds: 120,
      supersetGroupId: '3:w-1#group:A',
      notes: null,
      tags: [],
    });
    expect(plank.ok && plank.fields).toEqual({
      exerciseRef: 'plank',
      order: 0,
      sets: 3,
      repsOrDurationSeconds: 60,
      weightLbs: null,
      restSeconds: null,
      supersetGroupId: null,
      notes: 'hold',
      tags: ['prescription:time'],
    });
  });

  it('keeps the parent when a child is unresolved and names the exact native field', () => {
    const result = interpretWorkout(
      rules,
      seam({
        kind: 'run',
        items: [
          { exercise: 'plank', position: 1, sets: 0, reps: 5 },
          { exercise: 'plank', position: 2, sets: 3 },
          { position: 3, sets: 3, reps: 5 },
          'not-an-object',
          { exercise: 'plank', position: 1, sets: 2, reps: 2.5 },
          { exercise: 'plank', position: 1, sets: 2, reps: 2 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapped.type).toBe('cardio');
    expect(result.mapped.exercises.map((c) => [c.childSourceId, c.ok ? 'ok' : c.reason])).toEqual([
      ['3:w-1#ord:0', 'unresolved:invalid_value:sets'],
      ['3:w-1#ord:1', 'unresolved:missing_required_field:reps_or_duration_seconds'],
      ['3:w-1#ord:2', 'unresolved:exercise_reference'],
      ['3:w-1#ord:3', 'unresolved:invalid_value:exercises'],
      ['3:w-1#ord:4', 'unresolved:prescription_not_integral:reps_or_duration_seconds'],
      ['3:w-1#ord:5', 'ok'],
    ]);
  });

  it('marks the LATER duplicate order unresolved so ordering stays stable', () => {
    const result = interpretWorkout(
      rules,
      seam({
        items: [
          { id: 'a', exercise: 'plank', position: 1, sets: 1, reps: 1 },
          { id: 'b', exercise: 'plank', position: 1, sets: 1, reps: 1 },
        ],
      }),
    );
    expect(result.ok && result.mapped.tags).toEqual(['defaulted:type']);
    expect(result.ok && result.mapped.exercises.map((c) => (c.ok ? 'ok' : c.reason))).toEqual([
      'ok',
      'unresolved:invalid_value:order',
    ]);
  });

  it('requires week/day for a program-linked day and refuses unknown enum values', () => {
    expect(interpretWorkout(rules, seam({ program: { id: 'p-1' }, week: 1 }))).toEqual({
      ok: false,
      reason: 'unresolved:missing_required_field:day_index',
    });
    const linked = interpretWorkout(rules, seam({ program: { id: 'p-1' }, week: 1, day: 3 }));
    expect(
      linked.ok && [linked.mapped.programSourceId, linked.mapped.weekIndex, linked.mapped.dayIndex],
    ).toEqual(['p-1', 0, 2]);
    expect(interpretWorkout(rules, seam({ kind: 'yoga' }))).toEqual({
      ok: false,
      reason: 'unresolved:invalid_value:type',
    });
    expect(interpretWorkout(rules, seam({ items: { not: 'a list' } }))).toEqual({
      ok: false,
      reason: 'unresolved:invalid_value:exercises',
    });
    expect(interpretWorkout(rules, seam({ deleted: true }))).toEqual({
      ok: false,
      reason: 'unresolved:source_archived',
    });
  });

  it('is total without declared rules: nothing is guessed, the missing native field is named', () => {
    expect(interpretWorkout(undefined, seam({ anything: true }))).toEqual({
      ok: false,
      reason: 'unresolved:missing_required_field:type',
    });
  });
});
