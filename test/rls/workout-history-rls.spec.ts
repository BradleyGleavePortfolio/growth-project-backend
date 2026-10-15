/**
 * Row security for workout history (RLSLIVE1c, 20270502000900) on the replayed
 * migration chain, as the non-bypass `authenticated` role. Coach K coaches B,
 * coach L coaches C, and client A starts with coach F, then moves to K. Every
 * user's supabase_id differs from their id, so a policy keyed on the JWT
 * subject could not pass by accident. Every 0 or 42501 below follows a read or
 * write of the same row that returned 1.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('workout-history-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: workout history follows the client to their current coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLABC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const TABLE: Record<string, string> = {
    session: 'WorkoutSession', set: 'ExerciseSet', assign: 'ClientWorkoutAssignment', snap: 'ClientWorkoutAssignmentSnapshot',
    program: 'WorkoutProgram', lesson: 'Lesson',
  };
  // Client A's history: the session and set they logged, and the assignment
  // (with its snapshot) coach F gave them before the move.
  const HISTORY = ['session.A', 'set.A', 'assign.F', 'snap.F'];

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`wh-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    for (const k of 'AC') {
      await prisma.$executeRaw`INSERT INTO "WorkoutSession" ("id", "user_id", "date", "workout_name", "workout_type")
        VALUES (${id(`session.${k}`)}, ${u[k]}, CURRENT_DATE, 'Push', 'strength')`;
      await prisma.$executeRaw`INSERT INTO "ExerciseSet" ("id", "workout_id", "exercise_name", "muscle_group", "sets_completed", "reps_per_set", "weight_per_set")
        VALUES (${id(`set.${k}`)}, ${id(`session.${k}`)}, 'Bench press', 'chest', 3, '{10,10,8}', '{60,60,65}')`;
    }
    // Assignments (with snapshots): [tag, plan coach and assigner, client].
    for (const [t, coach, client] of [['F', 'F', 'A'], ['K', 'K', 'A'], ['C', 'L', 'C']]) {
      await prisma.$executeRaw`INSERT INTO "WorkoutPlan" ("id", "coach_id", "name", "type", "updated_at")
        VALUES (${id(`plan.${t}`)}, ${u[coach]}, 'Day', 'strength', now())`;
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignment" ("id", "workout_plan_id", "client_id", "assigned_by_coach_id", "scheduled_for")
        VALUES (${id(`assign.${t}`)}, ${id(`plan.${t}`)}, ${u[client]}, ${u[coach]}, now())`;
      await prisma.$executeRaw`INSERT INTO "ClientWorkoutAssignmentSnapshot" ("id", "assignment_id", "plan_name", "plan_type", "exercises_json", "source_plan_id", "source_version")
        VALUES (${id(`snap.${t}`)}, ${id(`assign.${t}`)}, 'Day', 'strength', '[]'::jsonb, ${id(`plan.${t}`)}, 1)`;
    }
    // A's program copies from each coach, and one lesson per coach.
    for (const k of 'FK') {
      await prisma.$executeRaw`INSERT INTO "WorkoutProgram" ("id", "coach_id", "owner_user_id", "name", "weeks", "days_per_week", "is_template", "client_id", "updated_at")
        VALUES (${id(`program.${k}`)}, ${u[k]}, ${u[k]}, 'Block', 4, 3, false, ${u.A}, now())`;
    }
    for (const k of 'FKL') {
      await prisma.$executeRaw`INSERT INTO "Lesson" ("id", "coach_id", "title") VALUES (${id(`lesson.${k}`)}, ${u[k]}, 'Lesson')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Backend model: the API role with app.current_user_id (and the JWT subject).
  // Data API model (jwtOnly): the JWT subject alone, no GUC.
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>, jwtOnly = false) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (!jwtOnly) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      }
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const table = (row: string) => TABLE[row.split('.')[0]];
  const reads = async (who: string, rows: string[], jwtOnly = false) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [{ n }] = await as(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table(r)}" WHERE "id" = $1`, id(r)), jwtOnly);
      out[r] = n;
    }
    return out;
  };
  // Harmless writes (a column set to itself).
  const COL: Record<string, string> = { session: 'notes', set: 'notes', assign: 'post_notes', snap: 'plan_name' };
  const write = (who: string, verb: 'UPDATE' | 'DELETE', r: string) => {
    const col = COL[r.split('.')[0]];
    const sql = verb === 'UPDATE' ? `UPDATE "${table(r)}" SET "${col}" = "${col}" WHERE "id" = $1` : `DELETE FROM "${table(r)}" WHERE "id" = $1`;
    return as(who, (tx) => tx.$executeRawUnsafe(sql, id(r)));
  };
  const all = (rows: string[], n: number) => Object.fromEntries(rows.map((r) => [r, n]));
  const sqlState = (p: Promise<unknown>) =>
    p.then(() => 'ok', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (/Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501)\b/.exec(msg))?.[1] ?? `unparsed: ${msg.slice(0, 200)}`;
    });
  const addSet = (who: string, tag: string, session: string) =>
    as(who, (tx) => tx.$executeRaw`INSERT INTO "ExerciseSet" ("id", "workout_id", "exercise_name", "muscle_group", "sets_completed", "reps_per_set", "weight_per_set")
      VALUES (${id(tag)}, ${id(session)}, 'Squat', 'legs', 1, '{5}', '{100}')`);

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the move, coach F reads A\'s history, program copy and lesson; coach K reads none of the history', async () => {
    expect(await reads('F', [...HISTORY, 'program.F'])).toEqual(all([...HISTORY, 'program.F'], 1));
    expect(await write('F', 'UPDATE', 'snap.F')).toBe(1);
    expect(await reads('K', HISTORY)).toEqual(all(HISTORY, 0));
    expect(await reads('A', ['program.F', 'lesson.F'])).toEqual({ 'program.F': 1, 'lesson.F': 1 });
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it('the current coach reads A\'s sessions, sets and F-era assignment; the former coach, another coach and other clients read none', async () => {
      expect(await reads('A', HISTORY)).toEqual(all(HISTORY, 1));
      expect(await reads('K', HISTORY)).toEqual(all(HISTORY, 1));
      expect(await reads('F', HISTORY)).toEqual(all(HISTORY, 0));
      expect(await reads('L', HISTORY)).toEqual(all(HISTORY, 0));
      expect(await reads('B', HISTORY)).toEqual(all(HISTORY, 0));
      expect(await reads('C', HISTORY)).toEqual(all(HISTORY, 0));
      const C_ROWS = ['session.C', 'set.C', 'assign.C', 'snap.C'];
      expect(await reads('C', C_ROWS)).toEqual(all(C_ROWS, 1));
      expect(await reads('L', C_ROWS)).toEqual(all(C_ROWS, 1));
      expect(await reads('K', C_ROWS)).toEqual(all(C_ROWS, 0));
      expect(await reads('A', C_ROWS)).toEqual(all(C_ROWS, 0));
    });

    it('the new reads write nothing: only A writes their sets, and only the assigning coach writes a snapshot', async () => {
      expect(await write('A', 'UPDATE', 'set.A')).toBe(1);
      expect(await write('K', 'UPDATE', 'set.A')).toBe(0);
      expect(await write('K', 'DELETE', 'set.A')).toBe(0);
      expect(await addSet('A', 'set.A2', 'session.A')).toBe(1);
      expect(await sqlState(addSet('K', 'set.K', 'session.A'))).toBe('42501');
      expect(await write('A', 'UPDATE', 'session.A')).toBe(1);
      expect(await write('K', 'UPDATE', 'session.A')).toBe(0);
      expect(await reads('K', ['assign.F', 'snap.F'])).toEqual({ 'assign.F': 1, 'snap.F': 1 });
      // DELETE, not UPDATE: before RLSLIVE1b an API-role UPDATE of an assignment
      // stops at 42P17 (its CHECK reads WorkoutPlan, whose client policy reads it back).
      expect(await write('K', 'DELETE', 'assign.F')).toBe(0);
      expect(await write('K', 'UPDATE', 'snap.F')).toBe(0);
      expect(await write('K', 'DELETE', 'snap.F')).toBe(0);
      expect(await write('F', 'UPDATE', 'snap.F')).toBe(0);
      expect(await write('K', 'UPDATE', 'snap.K')).toBe(1);
    });

    it('A reads their program copies and the current coach\'s lessons; other clients read none', async () => {
      expect(await reads('A', ['program.F', 'program.K', 'lesson.K'])).toEqual({ 'program.F': 1, 'program.K': 1, 'lesson.K': 1 });
      expect(await reads('B', ['program.F', 'program.K'])).toEqual({ 'program.F': 0, 'program.K': 0 });
      expect(await reads('C', ['program.F', 'program.K'])).toEqual({ 'program.F': 0, 'program.K': 0 });
      expect(await reads('F', ['program.F'])).toEqual({ 'program.F': 0 });
      expect(await reads('B', ['lesson.K'])).toEqual({ 'lesson.K': 1 });
      expect(await reads('C', ['lesson.L', 'lesson.K'])).toEqual({ 'lesson.L': 1, 'lesson.K': 0 });
      // A lesson stays with its coach: A no longer reads F's.
      expect(await reads('A', ['lesson.F'])).toEqual({ 'lesson.F': 0 });
    });

    it('the Data API model (JWT only, no app.current_user_id) reads none of it', async () => {
      const A_ROWS = ['session.A', 'set.A', 'snap.F', 'program.K', 'lesson.K'];
      expect(await reads('A', A_ROWS)).toEqual(all(A_ROWS, 1));
      expect(await reads('A', A_ROWS, true)).toEqual(all(A_ROWS, 0));
      expect(await reads('K', HISTORY)).toEqual(all(HISTORY, 1));
      expect(await reads('K', HISTORY, true)).toEqual(all(HISTORY, 0));
    });
  });

  it('the server\'s service role still reads and writes every row', async () => {
    const rows = [...HISTORY, 'session.C', 'set.C', 'assign.C', 'snap.C', 'program.F', 'program.K', 'lesson.F', 'lesson.K'];
    const seen = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      const out: Record<string, number> = {};
      for (const r of rows) {
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table(r)}" WHERE "id" = $1`, id(r));
        out[r] = n;
      }
      out.write = await tx.$executeRawUnsafe(`UPDATE "ExerciseSet" SET "notes" = "notes" WHERE "id" = $1`, id('set.A'));
      out.snapWrite = await tx.$executeRawUnsafe(`UPDATE "ClientWorkoutAssignmentSnapshot" SET "plan_name" = "plan_name" WHERE "id" = $1`, id('snap.F'));
      return out;
    });
    expect(seen).toEqual({ ...all(rows, 1), write: 1, snapWrite: 1 });
  });
});
