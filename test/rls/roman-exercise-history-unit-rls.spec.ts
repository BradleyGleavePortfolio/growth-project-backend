/**
 * ROMAN-HISTORY-UNIT-BE (agent alm), the live twin of test/roman/tools/roman-exercise-history-unit.spec.ts:
 * Roman's exercise_history tool, over the real database, sends each session's stored unit. A set stored with its
 * plan's ask in seconds (ExerciseSet.asked_unit; the ask has no foreign key, so it is written directly with a
 * random plan_assignment_id, as test/rls/workout-comments-history-rls.spec.ts's L1 does) reads unit 'seconds' with
 * no 1RM and no volume; a set logged with no plan row reads unit null. The tool runs as the API runs it: the
 * superuser connection, the caller's id in the where (roman-exercise-history.ts readExerciseSets); RLS on
 * ExerciseSet itself stays proven by workout-comments-history-rls.spec.ts. Students A and B; B's hold carries
 * CANARY in its name so a leak into A's answer shows.
 * Runs in rls-live-tests (replayed chain). Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma.service';
import { WorkoutService } from '../../src/workout/workout.service';
import { RomanReadToolbox } from '../../src/roman/tools/roman-read-tools';
import type { CreateExerciseSetDto } from '../../src/workout/workout.dto';
import type { RomanTimelineReader } from '../../src/roman/memory/roman-timeline.reader';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error(
    'roman-exercise-history-unit-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.',
  );
}

function stub<T>(value: unknown): T {
  return value as T;
}

const NOW = new Date('2026-10-06T19:00:00.000Z');
type Json = Record<string, unknown>;

(DB_URL ? describe : describe.skip)(
  "ROMAN-HISTORY-UNIT-BE: Roman's exercise_history reads the stored unit, live",
  () => {
    const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
    const workouts = new WorkoutService(
      prisma,
      stub<PtmService>({ emit: jest.fn() }),
      stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
    );
    // exercise_history never reads the timeline; a call would fail the case.
    const tools = new RomanReadToolbox(
      prisma,
      stub<RomanTimelineReader>({
        read: jest.fn(async () => {
          throw new Error('exercise_history read the timeline');
        }),
      }),
    );
    const u: Record<string, string> = { A: randomUUID(), B: randomUUID() };
    const supa: Record<string, string> = { A: randomUUID(), B: randomUUID() };
    const bench = (lbs: number): CreateExerciseSetDto => ({
      exercise_name: 'Bench press',
      muscle_group: 'chest',
      sets_completed: 2,
      reps_per_set: [8, 8],
      weight_per_set: [lbs, lbs],
    });
    /** A set stored with its plan's ask, unit seconds (the server writes these fields when a set is logged from a plan row). */
    const hold = (workout_id: string, exercise_name: string) =>
      prisma.exerciseSet.create({
        data: {
          workout_id,
          exercise_name,
          muscle_group: 'core',
          sets_completed: 2,
          reps_per_set: [20, 20],
          weight_per_set: [25, 25],
          plan_assignment_id: randomUUID(),
          plan_order: 0,
          asked_sets: 2,
          asked_count: 20,
          asked_unit: 'seconds',
          asked_weight_lbs: 25,
        },
      });
    const run = async (who: string, exercise: string) => {
      const r = await tools.run(
        { id: u[who], role: 'student' },
        'exercise_history',
        { exercise, from: '2026-07-01', to: '2026-09-30' },
        { now: NOW },
      );
      expect(r).toMatchObject({ ok: true });
      return { content: r.content, body: stub<{ sessions: Json[] }>(JSON.parse(r.content)) };
    };

    beforeAll(async () => {
      for (const k of Object.keys(u)) {
        await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`rhu-${u[k]}@example.test`}, ${`Client ${k}`}, 'student'::"Role", ${null})`;
      }
      const a = await workouts.createWorkout(u.A, {
        date: '2026-08-01',
        workout_name: 'Push',
        workout_type: 'strength',
        exercises: [bench(135)],
      });
      await hold(a.id, 'Plank hold');
      const b = await workouts.createWorkout(u.B, {
        date: '2026-08-01',
        workout_name: 'Push',
        workout_type: 'strength',
        exercises: [bench(315)],
      });
      await hold(b.id, 'Plank B-CANARY');
    });
    afterAll(() => prisma.$disconnect());

    it("ROMAN-HISTORY-UNIT-BE L1: A's hold reads seconds with no rep math, her bench reads null, and nothing crosses", async () => {
      const plank = await run('A', 'plank');
      expect(plank.content).not.toContain('CANARY');
      expect(plank.body.sessions).toEqual([
        {
          date: '2026-08-01',
          exercise: 'Plank hold',
          sets: 2,
          reps_per_set: [20, 20],
          weight_per_set_lbs: [25, 25],
          rpe: null,
          top_set: { weight_lbs: 25, reps: 20 },
          est_1rm_lbs: null,
          volume_lbs: null,
          unit: 'seconds',
        },
      ]);
      const press = await run('A', 'bench');
      expect(press.body.sessions).toHaveLength(1);
      expect(press.body.sessions[0]).toMatchObject({
        exercise: 'Bench press',
        top_set: { weight_lbs: 135, reps: 8 },
        est_1rm_lbs: 171,
        volume_lbs: 2160,
      });
      expect('unit' in press.body.sessions[0] && press.body.sessions[0].unit).toBeNull();
      const own = await run('B', 'plank');
      expect(own.body.sessions.map((s) => [s.exercise, s.unit])).toEqual([
        ['Plank B-CANARY', 'seconds'],
      ]);
      expect(own.content).not.toContain('Plank hold');
      expect((await run('B', 'bench')).body.sessions.map((s) => s.top_set)).toEqual([
        { weight_lbs: 315, reps: 8 },
      ]);
    });
  },
);
