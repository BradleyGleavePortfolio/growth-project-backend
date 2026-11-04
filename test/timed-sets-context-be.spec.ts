// test/timed-sets-context-be.spec.ts
//
// TIMED-SETS-CONTEXT-BE: Roman's client context and the AI workout context read
// each planned exercise's unit (reps or seconds) instead of guessing it from the
// number. A live row keeps the unit it states; a row frozen in an assignment
// snapshot before units existed reads its note ("SECONDS." means seconds,
// anything else reps), the same rule as unitOf.

import 'reflect-metadata';
import { RomanClientContextService } from '../src/roman/context/roman-client-context.service';
import { _resetRomanContextListeners } from '../src/roman/context/roman-context-invalidation';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../src/roman/roman.feature';
import { WorkoutContextService, coachStyleFromPlans } from '../src/ai/context/workout-context.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';
import { makePersonaDb, FakeSafetyIntakeSource, NOW, P1 } from './roman/fixtures/roman-personas';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
  _resetRomanContextListeners();
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

type Row = Record<string, unknown>;
type Select = { select?: Record<string, unknown> };
// Read untyped, so this spec also runs (and fails on behaviour) against a tree without the field.
const unitIn = (e: object): unknown => (e as { unit?: unknown }).unit;

// A live plan: a 60-second plank that says seconds (no "SECONDS." note) and a
// 50-rep row that says reps. Neither number tells the unit.
const LIVE_PLAN = {
  name: 'Conditioning',
  type: 'strength',
  program: { name: 'Program A Foundations' },
  exercises: [
    { exercise_external_id: 'ex-1', sets: 3, reps_or_duration_seconds: 60, unit: 'seconds', notes: null, order: 0, archived_at: null },
    { exercise_external_id: 'ex-2', sets: 2, reps_or_duration_seconds: 50, unit: 'reps', notes: 'Steady pace', order: 1, archived_at: null },
  ],
};

describe("TIMED-SETS-CONTEXT-BE: Roman's client context", () => {
  function setup() {
    const db = makePersonaDb();
    const a3 = db.raw.assignments.find((a) => a.id === 'a3') as Row;
    // P1's next session (Thu 10/01) was assigned from a snapshot frozen before units.
    a3.snapshot = {
      plan_name: 'Full Body B',
      plan_type: 'strength',
      exercises_json: [
        { exercise_external_id: 'ex-1', sets: 3, reps_or_duration_seconds: 45, notes: 'SECONDS. Hold the bottom.' },
        { exercise_external_id: 'ex-2', sets: 3, reps_or_duration_seconds: 40, notes: 'Pause at the chest' },
        { exercise_external_id: 'ex-3', sets: 3, reps_or_duration_seconds: 8, notes: null },
      ],
    };
    // P1's today session (Wed 9/30, 13:00 in Los Angeles) reads the live plan.
    db.raw.assignments.push({
      id: 'a-today',
      client_id: P1,
      assigned_by_coach_id: a3.assigned_by_coach_id,
      scheduled_for: new Date('2026-09-30T20:00:00Z'),
      completed_at: null,
      post_rpe: null,
      post_notes: null,
      snapshot: null,
      workout_plan: structuredClone(LIVE_PLAN),
    });
    const svc = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource(), grantAllEgress());
    return { db, svc };
  }

  it("today's live rows carry the unit each row states", async () => {
    const { svc } = setup();
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    expect(context.plan?.today_session?.exercises).toEqual([
      expect.objectContaining({ name: 'Goblet Squat', sets: 3, reps_or_duration_seconds: 60, unit: 'seconds' }),
      expect.objectContaining({ name: 'Dumbbell Bench Press', sets: 2, reps_or_duration_seconds: 50, unit: 'reps' }),
    ]);
  });

  it('a snapshot frozen without units reads its note: "SECONDS." is seconds, anything else reps', async () => {
    const { svc } = setup();
    const { context } = await svc.build({ id: P1, role: 'student' }, NOW);
    expect(context.plan?.next_session?.date).toBe('2026-10-01');
    expect(context.plan?.next_session?.exercises.map((e) => [e.reps_or_duration_seconds, unitIn(e)])).toEqual([
      [45, 'seconds'],
      [40, 'reps'],
      [8, 'reps'],
    ]);
  });

  it('the read of the coming sessions asks the database for each row\'s unit', async () => {
    const { db, svc } = setup();
    await svc.build({ id: P1, role: 'student' }, NOW);
    const findMany = db.prisma.clientWorkoutAssignment.findMany as unknown as jest.Mock;
    const exerciseSelects = findMany.mock.calls
      .map(([args]) => ((args as Select).select?.workout_plan as Select | undefined)?.select?.exercises as Select | undefined)
      .filter((s): s is Select => s?.select?.reps_or_duration_seconds === true);
    expect(exerciseSelects.length).toBeGreaterThan(0);
    for (const s of exerciseSelects) expect(s.select).toMatchObject({ unit: true });
  });
});

describe('TIMED-SETS-CONTEXT-BE: the AI workout context (coach style)', () => {
  const ROWS = [
    { exercise_external_id: 'a', sets: 3, reps_or_duration_seconds: 50, unit: 'reps' as const, rest_seconds: 60, superset_group_id: null },
    { exercise_external_id: 'b', sets: 3, reps_or_duration_seconds: 50, unit: 'reps' as const, rest_seconds: 60, superset_group_id: null },
    { exercise_external_id: 'c', sets: 3, reps_or_duration_seconds: 20, unit: 'seconds' as const, rest_seconds: 30, superset_group_id: null },
  ];

  it('a 50-rep row is not timed (it counts with the high reps) and a 20-second row is timed', () => {
    expect(coachStyleFromPlans([{ exercises: ROWS }])?.rep_range_pct).toEqual({
      low_1_5: 0,
      mid_6_12: 0,
      high_13_30: 67,
      timed: 33,
    });
  });

  it("the coach's plans are read with each row's unit", async () => {
    const findMany = jest.fn(async (_args: unknown) => [{ exercises: ROWS }]);
    const svc = new WorkoutContextService(fakeOf<PrismaService>({ workoutPlan: { findMany } }));
    const out = await svc.build({ coachId: 'coach-t', now: new Date('2026-11-04T12:00:00Z') });
    expect(out.coach_style?.rep_range_pct.timed).toBe(33);
    const args = findMany.mock.calls[0][0] as Select;
    expect((args.select?.exercises as Select).select).toMatchObject({ unit: true, reps_or_duration_seconds: true });
  });
});
