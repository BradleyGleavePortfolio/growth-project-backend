/**
 * SET-ASKED-BE (20270502011000): each logged set keeps what her plan asked that day, on the
 * replayed migration chain. The real WorkoutService writes on the superuser connection, as the
 * API does; the copied columns are then read back as the API role `authenticated` (no RLS
 * bypass): her and her coach read them, another member reads none. The fake-store twin with
 * the malformed-reference and keyed-resend rows is test/set-asked-be.spec.ts.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { WorkoutService } from '../../src/workout/workout.service';
import type { CreateExerciseSetDto } from '../../src/workout/workout.dto';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('set-asked-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

function stub<T>(value: unknown): T {
  return value as T;
}

const ASKED = ['plan_assignment_id', 'plan_order', 'asked_sets', 'asked_count', 'asked_unit', 'asked_weight_lbs'] as const;
const NO_ASK = Object.fromEntries(ASKED.map((k) => [k, null]));
const asks = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(ASKED.map((k) => [k, r[k]])));
const ask = (id: string, order: number, s: number, count: number, unit: string, lbs: number | null) => ({
  plan_assignment_id: id, plan_order: order, asked_sets: s, asked_count: count, asked_unit: unit, asked_weight_lbs: lbs,
});

(DB_URL ? describe : describe.skip)('SET-ASKED-BE: a logged set keeps what the plan asked that day (live Postgres)', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const workouts = new WorkoutService(prisma, stub<PtmService>({ emit: jest.fn() }),
    stub<ClientAIContextService>({ invalidateForUser: jest.fn() }));
  const u: Record<string, string> = Object.fromEntries([...'CHO'].map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const a: Record<string, string> = {};
  const plan: Record<string, string> = {};
  const set = (name: string, plan_assignment_id?: string, plan_order?: number) => stub<CreateExerciseSetDto>({
    exercise_name: name, muscle_group: 'chest', sets_completed: 3, reps_per_set: [8, 8, 8], weight_per_set: [100, 100, 100],
    plan_assignment_id, plan_order,
  });
  const log = async (who: string, exercises: CreateExerciseSetDto[]) =>
    workouts.createWorkout(u[who], { date: '2026-11-04', workout_name: 'Push', workout_type: 'strength', exercises });
  const storedAsks = async (workoutId: string) =>
    asks(await prisma.exerciseSet.findMany({ where: { workout_id: workoutId }, orderBy: { exercise_name: 'asc' } }));
  const snapRow = (order: number, sets: number, count: number, weight: number | null, extra: object = {}) => ({
    exercise_external_id: `ex-${order}`, order, sets, reps_or_duration_seconds: count, weight_lbs: weight,
    rest_seconds: 60, superset_group_id: null, notes: null, alternative_external_ids: [], ...extra,
  });
  const assign = async (key: string, client: string, frozen: object[] | null) => {
    a[key] = (await prisma.clientWorkoutAssignment.create({
      data: {
        workout_plan_id: plan[key], client_id: u[client], assigned_by_coach_id: u.C, scheduled_for: new Date('2026-11-04'),
        ...(frozen
          ? { snapshot: { create: { plan_name: 'Push', plan_type: 'strength', exercises_json: frozen, source_plan_id: plan[key], source_version: 1 } } }
          : {}),
      },
    })).id;
  };
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who === 'C' ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: supa[who], role: 'authenticated' }));
      return query(tx);
    });

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`sab-${u[k]}@example.test`}, ${`Member ${k}`}, ${k === 'C' ? 'coach' : 'student'}::"Role", ${k === 'C' ? null : u.C})`;
    }
    for (const key of ['frozen', 'legacy', 'roman', 'others']) {
      plan[key] = (await prisma.workoutPlan.create({
        data: {
          coach_id: u.C, name: `Push ${key}`, type: 'strength',
          exercises: {
            create: [
              { exercise_external_id: 'ex-0', order: 0, sets: 5, reps_or_duration_seconds: 5, weight_lbs: 225 },
              { exercise_external_id: 'ex-1', order: 1, sets: 2, reps_or_duration_seconds: 60, unit: 'seconds' },
            ],
          },
        },
      })).id;
    }
    await assign('frozen', 'H', [snapRow(0, 4, 8, 135), snapRow(1, 3, 45, null, { notes: 'SECONDS. Hold.' })]);
    await assign('legacy', 'H', null);
    await assign('roman', 'H', [snapRow(0, 4, 10, 95), snapRow(1, 4, 12, 40)]);
    await assign('others', 'O', [snapRow(0, 6, 6, 300)]);
    await prisma.workoutAdjustmentProposal.create({
      data: {
        coach_id: u.C, client_id: u.H, assignment_id: a.roman, rule_key: 'sab-volume', rule_version: 1, status: 'approved',
        severity: 'low', signals: {}, proposed_change: {}, base_fingerprint: 'sab', roman_text: 'Lighter day.',
        decided_at: new Date('2026-11-03T10:00:00Z'), applied_change: { exercises: [{ order: 0, sets_before: 4, sets_after: 3 }] },
      },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('frozen day copies the snapshot, legacy day the live row, Roman day the approved sets; seconds rows copy seconds', async () => {
    const w = await log('H', [
      set('a frozen 0', a.frozen, 0), set('b frozen 1', a.frozen, 1), set('c legacy 0', a.legacy, 0),
      set('d legacy 1', a.legacy, 1), set('e roman 0', a.roman, 0), set('f roman 1', a.roman, 1),
    ]);
    expect(await storedAsks(w.id)).toEqual([
      ask(a.frozen, 0, 4, 8, 'reps', 135), ask(a.frozen, 1, 3, 45, 'seconds', null), ask(a.legacy, 0, 5, 5, 'reps', 225),
      ask(a.legacy, 1, 2, 60, 'seconds', null), ask(a.roman, 0, 3, 10, 'reps', 95), ask(a.roman, 1, 4, 12, 'reps', 40),
    ]);
  });

  it("another member's assignment, an order with no row, an unknown assignment: saved, no ask", async () => {
    const w = await log('H', [set('a', a.others, 0), set('b', a.frozen, 9), set('c', randomUUID(), 0), set('d')]);
    expect(await storedAsks(w.id)).toEqual([NO_ASK, NO_ASK, NO_ASK, NO_ASK]);
  });

  it('the coach edits the plan, then the assignment is deleted: the stored asks stay; PUT keeps the first ask and copies a fresh one for a new set', async () => {
    const w = await log('H', [set('a', a.legacy, 0), set('b', a.frozen, 0)]);
    await prisma.workoutPlanExercise.updateMany({ where: { workout_plan_id: plan.legacy, order: 0 }, data: { sets: 1, weight_lbs: 1 } });
    await prisma.clientWorkoutAssignmentSnapshot.update({
      where: { assignment_id: a.frozen },
      data: { exercises_json: [snapRow(0, 1, 1, 1), snapRow(1, 3, 45, null, { notes: 'SECONDS. Hold.' })] },
    });
    expect(await storedAsks(w.id)).toEqual([ask(a.legacy, 0, 5, 5, 'reps', 225), ask(a.frozen, 0, 4, 8, 'reps', 135)]);
    await workouts.updateWorkout(u.H, w.id, { exercises: [set('a', a.legacy, 0), set('b', a.frozen, 0), set('c', a.frozen, 1), set('d')] });
    expect(await storedAsks(w.id)).toEqual([
      ask(a.legacy, 0, 5, 5, 'reps', 225), ask(a.frozen, 0, 4, 8, 'reps', 135), ask(a.frozen, 1, 3, 45, 'seconds', null), NO_ASK,
    ]);
    await prisma.clientWorkoutAssignment.delete({ where: { id: a.legacy } });
    expect((await storedAsks(w.id))[0]).toEqual(ask(a.legacy, 0, 5, 5, 'reps', 225));
    const after = await log('H', [set('a', a.legacy, 0)]);
    expect(await storedAsks(after.id)).toEqual([NO_ASK]);
  });

  it('as the API role: her and her coach read the copied asks; another member reads none', async () => {
    const w = await log('H', [set('a', a.frozen, 0)]);
    const read = (who: string) => as(who, (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "ExerciseSet" WHERE "workout_id" = ${w.id} AND "asked_sets" = 4 AND "asked_unit" = 'reps'`);
    expect(await as('H', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect([(await read('H'))[0].n, (await read('C'))[0].n, (await read('O'))[0].n]).toEqual([1, 1, 0]);
  });
});
