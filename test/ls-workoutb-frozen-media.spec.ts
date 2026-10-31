import type { AuthedRequest } from '../src/auth/auth-request';
import { ExerciseCatalogController } from '../src/exercise-catalog/exercise-catalog.controller';
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import type { PrismaService } from '../src/prisma.service';
import type { MuxService } from '../src/video/mux.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';

const row = {
  id: 'catalog-bench', slug: 'barbell-bench-press', source_ref: 'seed:push-001',
  name: 'Barbell Bench Press', category: 'push', primary_muscle: 'chest',
  secondary_muscles: [], equipment: ['barbell'], difficulty: 'beginner',
  instructions: ['Lower under control.'], mux_playback_id: 'fixture-playback',
  mux_playback_policy: 'signed', mux_asset_status: 'ready',
};
const playback = 'https://stream.example.invalid/frozen-fixture.m3u8';
const request = { user: { id: 'member-one', role: 'student' } } as AuthedRequest;
const exercise = (ref: string) => ({
  exercise_external_id: ref, order: 1, sets: 3, reps_or_duration_seconds: 8,
  weight_lbs: 0, rest_seconds: 60, superset_group_id: null, notes: null,
});
type AssignmentLookup = {
  where: {
    client_id?: string;
    workout_plan?: { exercises: { some: { exercise_external_id: { in: string[] } } } };
  };
};

describe('LS-WORKOUTB signed media follows the prescription actually presented', () => {
  it.each([
    { scenario: 'an unchanged frozen assignment', frozenRef: row.id, liveRef: row.id, member: 'member-one', allowed: true },
    { scenario: 'a frozen exercise removed from the live plan', frozenRef: row.id, liveRef: 'catalog-row', member: 'member-one', allowed: true },
    { scenario: 'a new live exercise absent from the frozen assignment', frozenRef: 'catalog-row', liveRef: row.id, member: 'member-one', allowed: false },
    { scenario: 'a legacy assignment without a snapshot', frozenRef: null, liveRef: row.id, member: 'member-one', allowed: true },
    { scenario: 'another member assignment', frozenRef: row.id, liveRef: row.id, member: 'member-two', allowed: false },
  ])('B-LS-WORKOUT-6 honors $scenario when minting signed video', async ({
    frozenRef, liveRef, member, allowed,
  }) => {
    const assignment = {
      id: 'assignment-one', client_id: member, workout_plan_id: 'plan-one',
      workout_plan: { id: 'plan-one', exercises: [exercise(liveRef)] },
      snapshot: frozenRef === null ? null : { exercises_json: [exercise(frozenRef)] },
    };
    // Exercise the real, pure server presenter used by the assignment routes,
    // not a fabricated rule that substitutes frozen data only in this test.
    const presented = WorkoutBuilderService.prototype['presentAssignment'](assignment);
    expect(presented.exercises).toEqual([exercise(frozenRef ?? liveRef)]);
    expect(presented.snapshot_source).toBe(frozenRef !== null);

    const memberMatches = (where: AssignmentLookup['where']) =>
      where.client_id === undefined || where.client_id === member;
    const prisma = {
      exerciseCatalogItem: { findFirst: jest.fn(async () => row) },
      clientWorkoutAssignment: {
        // Model the current ORM predicate and expose complete scoped rows for
        // a repair that reads the same visible-assignment basis as the presenter.
        findFirst: jest.fn(async ({ where }: AssignmentLookup) =>
          memberMatches(where) &&
          where.workout_plan?.exercises.some.exercise_external_id.in.includes(liveRef)
            ? assignment : null),
        findMany: jest.fn(async ({ where }: AssignmentLookup) =>
          memberMatches(where) ? [assignment] : []),
      },
    } as unknown as PrismaService;
    const mintPlaybackUrl = jest.fn(() => playback);
    const mux = { mintPlaybackUrl } as unknown as MuxService;
    const controller = new ExerciseCatalogController(new ExerciseCatalogService(prisma, mux));
    // Use the canonical catalog id throughout: this isolates snapshot version
    // authorization from the separate B2 external-reference identity failure.
    const detail = await controller.detail(row.id, request);
    expect(detail.name).toBe(row.name);
    expect(detail.playbackUrl).toBe(allowed ? playback : null);
    expect(mintPlaybackUrl).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
