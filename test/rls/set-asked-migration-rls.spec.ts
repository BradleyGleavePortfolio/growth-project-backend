/**
 * SET-ASKED-BE (agent 195) on real Postgres: 20270502011000_exercise_set_asked forward, down,
 * forward again, each file as written, on a superuser copy of rls_replay (the whole chain).
 *   - the chain gives six nullable ExerciseSet columns with no default, no constraint and no index;
 *   - down.sql drops exactly those six and keeps every row and every other column;
 *   - migration.sql adds them back empty (no backfill), twice over;
 *   - the ExerciseSet policies are the same before and after (no RLS change).
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('set-asked-migration-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const DIR = readdirSync(MIGRATIONS).find((d) => d.endsWith('_exercise_set_asked')) ?? 'missing_exercise_set_asked';
const statements = (file: string): string[] =>
  readFileSync(join(MIGRATIONS, DIR, file), 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
const ADDED = {
  plan_assignment_id: 'text',
  plan_order: 'int4',
  asked_sets: 'int4',
  asked_count: 'int4',
  asked_unit: 'PlanExerciseUnit',
  asked_weight_lbs: 'float8',
};

(DB_URL ? describe : describe.skip)('SET-ASKED-BE: exercise set ask migration on Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const user = randomUUID();
  const workout = randomUUID();
  const sets = [randomUUID(), randomUUID()];

  const run = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  const columns = () =>
    prisma.$queryRawUnsafe<Array<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>>(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'ExerciseSet' AND column_name = ANY($1::text[]) ORDER BY column_name`,
      Object.keys(ADDED),
    );
  const rest = () =>
    prisma.$queryRawUnsafe<Array<{ id: string; rest: unknown }>>(
      `SELECT "id", to_jsonb(s) - $2::text[] AS rest FROM "ExerciseSet" s WHERE "workout_id" = $1 ORDER BY "id"`,
      workout,
      Object.keys(ADDED),
    );
  const policies = () =>
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies
        WHERE tablename = 'ExerciseSet' ORDER BY policyname`,
    );
  const touching = () =>
    prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT (SELECT count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                WHERE c.conrelid = '"ExerciseSet"'::regclass AND a.attname = ANY($1::text[]))
            + (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = '"ExerciseSet"'::regclass AND a.attname = ANY($1::text[])) AS n`,
      Object.keys(ADDED),
    );

  beforeAll(async () => {
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${user}, ${randomUUID()}, ${`sam-${user}@example.test`}, 'Asked member', 'student'::"Role")`;
    await prisma.$executeRaw`INSERT INTO "WorkoutSession" ("id", "user_id", "date", "workout_name", "workout_type")
      VALUES (${workout}, ${user}, '2026-11-04', 'Push', 'strength')`;
    await prisma.$executeRaw`INSERT INTO "ExerciseSet" ("id", "workout_id", "exercise_name", "muscle_group", "sets_completed", "reps_per_set", "weight_per_set",
        "plan_assignment_id", "plan_order", "asked_sets", "asked_count", "asked_unit", "asked_weight_lbs")
      VALUES (${sets[0]}, ${workout}, 'Bench', 'chest', 3, ARRAY[8,8,8], ARRAY[135,135,135]::double precision[],
        ${randomUUID()}, 0, 4, 8, 'reps'::"PlanExerciseUnit", 135)`;
    await prisma.$executeRaw`INSERT INTO "ExerciseSet" ("id", "workout_id", "exercise_name", "muscle_group", "sets_completed", "reps_per_set", "weight_per_set")
      VALUES (${sets[1]}, ${workout}, 'Plank', 'core', 3, ARRAY[45,45,45], ARRAY[0,0,0]::double precision[])`;
  });
  afterAll(() => prisma.$disconnect());

  it('the chain gives six nullable columns, no default, no constraint or index on them', async () => {
    expect(await columns()).toEqual(
      Object.entries(ADDED)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([column_name, udt_name]) => ({ column_name, udt_name, is_nullable: 'YES', column_default: null })),
    );
    expect(await touching()).toEqual([{ n: 0 }]);
  });

  it('forward, down, forward, down, forward keeps every row and column; the six come back empty; policies unchanged', async () => {
    const before = await rest();
    const policiesBefore = await policies();
    expect(before).toHaveLength(2);
    for (let round = 0; round < 2; round++) {
      await run('down.sql');
      expect(await columns()).toEqual([]);
      expect(await rest()).toEqual(before);
      await run('migration.sql');
      expect((await columns()).map((c) => c.column_name)).toHaveLength(6);
      expect(await rest()).toEqual(before);
      const asked = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "ExerciseSet" WHERE "workout_id" = $1 AND num_nonnulls(${Object.keys(ADDED).map((k) => `"${k}"`).join(', ')}) > 0`,
        workout,
      );
      expect(asked).toEqual([{ n: 0 }]);
    }
    expect(await policies()).toEqual(policiesBefore);
  });
});
