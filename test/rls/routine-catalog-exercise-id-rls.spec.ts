/**
 * EXID-BE (#189-D4 op 1) on real Postgres: each routine exercise keeps the library exercise it came from.
 *
 * Runs the real WorkoutService against a superuser copy of rls_replay (the whole migration chain, so
 * 20270502010700_routine_exercise_catalog_id is applied as written), then checks:
 *   - the column is nullable TEXT with a foreign key to ExerciseCatalogItem, ON DELETE SET NULL, indexed;
 *   - a save keeps a library id, saves an id with no library row as null (the rest of the routine saves),
 *     and GET /routines (getRoutines) returns the id on each exercise; a row saved before the column reads null;
 *   - a library item removed later leaves null and the routine stays whole;
 *   - another member cannot write the field on someone else's routine (404, nothing changes), and the row
 *     rule (p_routineexercise_*, 20261213000000) still lets only the routine's creator read or change it,
 *     as the request role: a control read of 1 before each 0.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { WorkoutService } from '../../src/workout/workout.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('routine-catalog-exercise-id-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B';

(DB_URL ? describe : describe.skip)('EXID-BE: catalog_exercise_id on routine exercises, on Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const service = new WorkoutService(
    stub<ConstructorParameters<typeof WorkoutService>[0]>(prisma),
    stub<ConstructorParameters<typeof WorkoutService>[1]>({ emit: jest.fn() }),
    stub<ConstructorParameters<typeof WorkoutService>[2]>({ invalidateForUser: jest.fn() }),
  );
  const id: Record<Key, string> = { A: randomUUID(), B: randomUUID() };
  const sub: Record<Key, string> = { A: randomUUID(), B: randomUUID() };
  const bench = randomUUID();
  const squat = randomUUID();
  const notInLibrary = randomUUID();
  let routineId = '';

  const exercise = (name: string, order_index: number, catalog_exercise_id?: string | null) => ({
    exercise_name: name,
    muscle_group: 'chest' as const,
    default_sets: 3,
    default_reps: 8,
    order_index,
    catalog_exercise_id,
  });
  const idsOf = async (routine: string) =>
    (await prisma.routineExercise.findMany({ where: { routine_id: routine }, orderBy: { order_index: 'asc' } })).map(
      (e) => e.catalog_exercise_id,
    );

  // Runs `run` as the request role for `who`, so the row rule applies.
  const asMember = <T>(who: Key, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'student', true)`);
      return run(tx);
    });
  const reads = (who: Key, catalogId: string) =>
    asMember(who, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "RoutineExercise"
        WHERE "routine_id" = ${routineId} AND "catalog_exercise_id" = ${catalogId}`;
      return rows[0].n;
    });
  const writes = (who: Key, catalogId: string) =>
    asMember(who, (tx) => tx.$executeRaw`UPDATE "RoutineExercise" SET "catalog_exercise_id" = ${catalogId}
      WHERE "routine_id" = ${routineId} AND "order_index" = 2`);

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${id[k]}, ${sub[k]}, ${`exid-be-${id[k]}`}, 'RLS user', 'student'::"Role")`;
    }
    for (const [rowId, slug] of [[bench, 'exid-be-bench'], [squat, 'exid-be-squat']]) {
      await prisma.exerciseCatalogItem.create({
        data: { id: rowId, slug: `${slug}-${rowId}`, name: slug, category: 'strength', primary_muscle: 'chest' },
      });
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('the migration adds a nullable TEXT column with an indexed ON DELETE SET NULL key to the library', async () => {
    const cols = await prisma.$queryRaw<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type::text AS "data_type", is_nullable::text AS "is_nullable" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'RoutineExercise' AND column_name = 'catalog_exercise_id'`;
    expect(cols).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    const fks = await prisma.$queryRaw<{ ref: string; on_delete: string }[]>`
      SELECT confrelid::regclass::text AS "ref", confdeltype::text AS "on_delete" FROM pg_constraint
      WHERE conname = 'RoutineExercise_catalog_exercise_id_fkey' AND contype = 'f'`;
    expect(fks).toEqual([{ ref: '"ExerciseCatalogItem"', on_delete: 'n' }]);
    const idx = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM pg_indexes
      WHERE tablename = 'RoutineExercise' AND indexname = 'RoutineExercise_catalog_exercise_id_idx'`;
    expect(idx[0].n).toBe(1);
  });

  it('a save keeps library ids, saves an id with no library row as null, and the read returns them', async () => {
    const saved = await service.createRoutine(id.A, {
      name: 'Push day',
      exercises: [
        exercise('Barbell Bench Press', 0, bench),
        exercise('Removed library move', 1, notInLibrary),
        exercise('My own press', 2),
      ],
    });
    routineId = saved.id;
    expect(saved.exercises.sort((a, b) => a.order_index - b.order_index).map((e) => e.catalog_exercise_id))
      .toEqual([bench, null, null]);
    const [mine] = (await service.getRoutines(id.A)).filter((r) => r.id === routineId);
    expect(mine.exercises.map((e) => [e.exercise_name, e.catalog_exercise_id])).toEqual([
      ['Barbell Bench Press', bench],
      ['Removed library move', null],
      ['My own press', null],
    ]);
  });

  it('a row saved before the column reads null', async () => {
    const oldId = randomUUID();
    await prisma.$executeRaw`INSERT INTO "RoutineExercise"
      ("id", "routine_id", "exercise_name", "muscle_group", "default_sets", "default_reps", "order_index")
      VALUES (${oldId}, ${routineId}, 'Old row', 'chest'::"MuscleGroup", 3, 8, 9)`;
    const [mine] = (await service.getRoutines(id.A)).filter((r) => r.id === routineId);
    expect(mine.exercises.find((e) => e.id === oldId)?.catalog_exercise_id).toBeNull();
    await prisma.routineExercise.delete({ where: { id: oldId } });
  });

  it('an edit sets, changes and clears ids; another member cannot write them (404, nothing changes)', async () => {
    await expect(
      service.updateRoutine(id.B, routineId, { exercises: [exercise('Squat', 0, squat)] }),
    ).rejects.toThrow(NotFoundException);
    expect(await idsOf(routineId)).toEqual([bench, null, null]);
    await service.updateRoutine(id.A, routineId, {
      exercises: [exercise('Squat', 0, squat), exercise('Barbell Bench Press', 1, bench), exercise('Lunge', 2, null)],
    });
    expect(await idsOf(routineId)).toEqual([squat, bench, null]);
  });

  it('the row rule: only the routine creator reads or changes the field (control 1 before each 0)', async () => {
    expect(await reads('A', squat)).toBe(1);
    expect(await reads('B', squat)).toBe(0);
    expect(await writes('A', squat)).toBe(1);
    expect(await writes('B', bench)).toBe(0);
    expect(await idsOf(routineId)).toEqual([squat, bench, squat]);
  });

  it('a library item removed later leaves null and the routine stays whole', async () => {
    await prisma.exerciseCatalogItem.delete({ where: { id: squat } });
    expect(await idsOf(routineId)).toEqual([null, bench, null]);
    const [mine] = (await service.getRoutines(id.A)).filter((r) => r.id === routineId);
    expect(mine.exercises.map((e) => e.exercise_name)).toEqual(['Squat', 'Barbell Bench Press', 'Lunge']);
  });
});
