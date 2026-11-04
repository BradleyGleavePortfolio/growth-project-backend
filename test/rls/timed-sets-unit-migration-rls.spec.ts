/**
 * TIMED-SETS-BE (agent 193) on real Postgres: the plan exercise unit migration
 * (prisma/migrations/*_plan_exercise_unit) forward, down, forward again keeps every row (D7).
 *
 * Runs against a superuser copy of rls_replay (the whole migration chain, so the migration is
 * applied as written), then:
 *   - the column is the PlanExerciseUnit enum, NOT NULL, default reps; a row written without a
 *     unit reads reps;
 *   - down.sql, then migration.sql, then down.sql and migration.sql again, each as written:
 *     the same rows (ids and every other column unchanged) after every step; after down the
 *     column and its type are gone; after forward a row reads seconds only where the program
 *     note starts "SECONDS." (case as written) and reps otherwise. A unit set by a coach on a
 *     row with no such note goes back to reps on a down: down drops the column (PR body).
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('timed-sets-unit-migration-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const DIR = readdirSync(MIGRATIONS).find((d) => d.endsWith('_plan_exercise_unit')) ?? 'missing_plan_exercise_unit';
// Later reversible migrations, rolled back newest first before this down.sql and re-applied oldest
// first after its migration.sql, as a real rollback runs them: 20270502011000_exercise_set_asked's
// ExerciseSet.asked_unit uses PlanExerciseUnit, so the type cannot drop while that column stands.
const LATER = readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && d > DIR && existsSync(join(MIGRATIONS, d, 'down.sql')))
  .sort();
const statements = (file: string, dir = DIR): string[] =>
  readFileSync(join(MIGRATIONS, dir, file), 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

(DB_URL ? describe : describe.skip)('TIMED-SETS-BE: plan exercise unit migration on Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const coach = randomUUID();
  const plan = randomUUID();
  const row = { timedNote: randomUUID(), repsNote: randomUUID(), coachTimed: randomUUID(), lowerCase: randomUUID(), archived: randomUUID() };

  const run = (file: string, dir = DIR) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file, dir)) await tx.$executeRawUnsafe(s);
    });
  const rows = () =>
    prisma.$queryRawUnsafe<Array<{ id: string; rest: unknown }>>(
      `SELECT "id", to_jsonb(e) - 'unit' AS rest FROM "WorkoutPlanExercise" e WHERE "workout_plan_id" = $1 ORDER BY "id"`,
      plan,
    );
  const units = async () =>
    Object.fromEntries(
      (
        await prisma.$queryRawUnsafe<Array<{ id: string; unit: string }>>(
          `SELECT "id", "unit"::text AS unit FROM "WorkoutPlanExercise" WHERE "workout_plan_id" = $1`,
          plan,
        )
      ).map((r) => [r.id, r.unit]),
    );
  const hasColumn = async () =>
    (
      await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'WorkoutPlanExercise' AND column_name = 'unit'`,
      )
    )[0].n === 1;
  const hasType = async () =>
    (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'PlanExerciseUnit'`))[0].n === 1;

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${coach}, ${randomUUID()}, ${`ts-${coach}`}, 'Timed coach', 'coach'::"Role")`;
    await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
      VALUES (${plan}, ${coach}, 'Core', 'strength', now())`;
    const insert = (id: string, order: number, reps: number, notes: string | null, unit: string | null, archived = false) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "WorkoutPlanExercise" ("id", "workout_plan_id", "exercise_external_id", "order", "sets", "reps_or_duration_seconds", "notes", "archived_at"${unit ? ', "unit"' : ''})
         VALUES ($1, $2, 'plank', $3, 3, $4, $5, ${archived ? 'now()' : 'NULL'}${unit ? `, '${unit}'::"PlanExerciseUnit"` : ''})`,
        id,
        plan,
        order,
        reps,
        notes,
      );
    await insert(row.timedNote, 1, 45, 'SECONDS. WORK. RPE 3. Front plank.', 'seconds');
    await insert(row.repsNote, 2, 8, 'REPS. WORK. RPE 3. Squat.', null);
    await insert(row.coachTimed, 3, 60, null, 'seconds');
    await insert(row.lowerCase, 4, 30, 'seconds. a coach note', null);
    await insert(row.archived, 5, 20, 'SECONDS. WORK. Side plank.', 'seconds', true);
  });
  afterAll(() => prisma.$disconnect());

  it('the chain gives an enum column, NOT NULL, default reps; a row written without a unit reads reps', async () => {
    const [col] = await prisma.$queryRawUnsafe<Array<{ udt_name: string; is_nullable: string; column_default: string }>>(
      `SELECT udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'WorkoutPlanExercise' AND column_name = 'unit'`,
    );
    expect(col).toEqual({ udt_name: 'PlanExerciseUnit', is_nullable: 'NO', column_default: `'reps'::"PlanExerciseUnit"` });
    expect(await units()).toEqual({
      [row.timedNote]: 'seconds',
      [row.repsNote]: 'reps',
      [row.coachTimed]: 'seconds',
      [row.lowerCase]: 'reps',
      [row.archived]: 'seconds',
    });
  });

  it('forward, down, forward, down, forward keeps every row; seconds only where the program note says so', async () => {
    const before = await rows();
    expect(before).toHaveLength(5);
    const fromNotes = {
      [row.timedNote]: 'seconds',
      [row.repsNote]: 'reps',
      [row.coachTimed]: 'reps',
      [row.lowerCase]: 'reps',
      [row.archived]: 'seconds',
    };
    for (let round = 0; round < 2; round++) {
      for (const later of [...LATER].reverse()) await run('down.sql', later);
      await run('down.sql');
      expect(await hasColumn()).toBe(false);
      expect(await hasType()).toBe(false);
      expect(await rows()).toEqual(before);
      await run('migration.sql');
      for (const later of LATER) await run('migration.sql', later);
      expect(await hasColumn()).toBe(true);
      expect(await rows()).toEqual(before);
      expect(await units()).toEqual(fromNotes);
    }
  });
});
