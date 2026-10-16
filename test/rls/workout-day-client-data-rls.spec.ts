/**
 * C1V2-C1 (20270502002900): the new workout-day columns follow the row rules
 * they sit on, on the replayed migration chain as the non-bypass
 * `authenticated` role. Coach K coaches B, coach L coaches C, and client A
 * starts with coach F, then moves to K. Columns: the swaps
 * (WorkoutPlanExercise.alternative_external_ids, and the copy the client
 * trains in ClientWorkoutAssignmentSnapshot.exercises_json), and the skipped
 * day and the coach's note (ClientWorkoutAssignment.skipped_at, client_note).
 * Every 0 below follows a read or write of the same row that returned 1.
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip,
 * except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('workout-day-client-data-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: swaps, skipped days and the coach note follow the client', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLABC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  // Each row is counted only when its new columns hold what was written.
  const SEEN: Record<string, string> = {
    ex: `SELECT count(*)::int AS "n" FROM "WorkoutPlanExercise" WHERE "id" = $1 AND "alternative_external_ids" = ARRAY['alt-1']`,
    assign: `SELECT count(*)::int AS "n" FROM "ClientWorkoutAssignment" WHERE "id" = $1 AND "skipped_at" IS NOT NULL AND "client_note" = 'Easy pace'`,
    snap: `SELECT count(*)::int AS "n" FROM "ClientWorkoutAssignmentSnapshot" WHERE "id" = $1 AND "exercises_json" -> 0 -> 'alternative_external_ids' = '["alt-1"]'::jsonb`,
  };

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`wd-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    for (const [coach, client] of [['F', 'A'], ['L', 'C']]) {
      await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
        VALUES (${id(`plan.${coach}`)}, ${u[coach]}, 'Day', 'strength', now())`;
      await prisma.$executeRaw`INSERT INTO "WorkoutPlanExercise" ("id", "workout_plan_id", "exercise_external_id", "order", "sets", "reps_or_duration_seconds", "alternative_external_ids")
        VALUES (${id(`ex.${coach}`)}, ${id(`plan.${coach}`)}, 'bench', 0, 3, 8, ARRAY['alt-1'])`;
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignment" ("id", "workout_plan_id", "client_id", "assigned_by_coach_id", "scheduled_for", "skipped_at", "client_note")
        VALUES (${id(`assign.${coach}`)}, ${id(`plan.${coach}`)}, ${u[client]}, ${u[coach]}, now(), now(), 'Easy pace')`;
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignmentSnapshot" ("id", "assignment_id", "plan_name", "plan_type", "exercises_json", "source_plan_id", "source_version")
        VALUES (${id(`snap.${coach}`)}, ${id(`assign.${coach}`)}, 'Day', 'strength', '[{"exercise_external_id":"bench","alternative_external_ids":["alt-1"]}]'::jsonb, ${id(`plan.${coach}`)}, 1)`;
    }
  });
  afterAll(() => prisma.$disconnect());

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const reads = async (who: string, rows: string[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [{ n }] = await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(SEEN[r.split('.')[0]], id(r)));
      out[r] = n;
    }
    return out;
  };
  const all = (rows: string[], n: number) => Object.fromEntries(rows.map((r) => [r, n]));
  // An API-role write: the row count, or the SQLSTATE it was refused with.
  const write = (who: string, sql: string, r: string) =>
    as(who, (tx) => tx.$executeRawUnsafe(sql, id(r))).then((n) => n, (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused');
  const A_ROWS = ['ex.F', 'assign.F', 'snap.F'];
  const L_ROWS = ['ex.L', 'assign.L', 'snap.L'];
  const DAY_ROWS = ['assign.F', 'snap.F'];
  // A no-op write of the three day columns: counts the rows a role may write.
  const DAY_WRITE = `UPDATE "ClientWorkoutAssignment" SET "skipped_at" = "skipped_at", "scheduled_for" = "scheduled_for", "client_note" = "client_note" WHERE "id" = $1`;

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the move: A and coach F read them; coach K, coach L and client C read none', async () => {
    expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
    expect(await reads('F', A_ROWS)).toEqual(all(A_ROWS, 1));
    expect(await reads('K', DAY_ROWS)).toEqual(all(DAY_ROWS, 0));
    expect(await reads('C', L_ROWS)).toEqual(all(L_ROWS, 1));
    expect(await reads('C', A_ROWS)).toEqual(all(A_ROWS, 0));
    expect(await reads('L', L_ROWS)).toEqual(all(L_ROWS, 1));
    expect(await reads('L', A_ROWS)).toEqual(all(A_ROWS, 0));
  });

  it('before the move: no API role writes the day row, the assigning coach F included (the backend writes it as service_role)', async () => {
    for (const who of [...'FAKLBC']) expect(await write(who, DAY_WRITE, 'assign.F')).not.toBe(1);
  });

  it("only the plan's coach writes its swaps", async () => {
    const sql = `UPDATE "WorkoutPlanExercise" SET "alternative_external_ids" = "alternative_external_ids" WHERE "id" = $1`;
    expect(await write('F', sql, 'ex.F')).toBe(1);
    for (const who of [...'AKLBC']) expect(await write(who, sql, 'ex.F')).toBe(0);
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it("A and the current coach read A's skipped day, note and swaps; the former coach, coach L and other clients read none", async () => {
      expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
      expect(await reads('K', DAY_ROWS)).toEqual(all(DAY_ROWS, 1));
      expect(await reads('F', DAY_ROWS)).toEqual(all(DAY_ROWS, 0));
      expect(await reads('L', A_ROWS)).toEqual(all(A_ROWS, 0));
      expect(await reads('B', A_ROWS)).toEqual(all(A_ROWS, 0));
      expect(await reads('C', A_ROWS)).toEqual(all(A_ROWS, 0));
    });

    it('no API role moves, skips or notes the day any more, the former coach F included (the backend writes them as service_role)', async () => {
      for (const set of [`"skipped_at" = NULL`, `"scheduled_for" = now() + interval '1 day'`, `"client_note" = 'changed'`]) {
        for (const who of [...'AKFLBC']) {
          expect(await write(who, `UPDATE "ClientWorkoutAssignment" SET ${set} WHERE "id" = $1`, 'assign.F')).not.toBe(1);
        }
      }
      expect(await reads('A', ['assign.F'])).toEqual({ 'assign.F': 1 });
      const [{ moved }] = await prisma.$queryRaw<{ moved: number }[]>`
        SELECT count(*)::int AS "moved" FROM "ClientWorkoutAssignment" WHERE "id" = ${id('assign.F')} AND "scheduled_for" > now()`;
      expect(moved).toBe(0);
    });
  });

  it("the server's service role still reads and writes every new column", async () => {
    const n = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return tx.$executeRawUnsafe(
        `UPDATE "ClientWorkoutAssignment" SET "skipped_at" = "skipped_at", "client_note" = "client_note", "scheduled_for" = "scheduled_for" WHERE "id" = $1`,
        id('assign.F'),
      );
    });
    expect(n).toBe(1);
  });
});
