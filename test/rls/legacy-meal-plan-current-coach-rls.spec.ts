/**
 * Row security for legacy MealPlan rows after a client moves (RLSMEALLEGACY,
 * 20270502001500) on the replayed migration chain, as the non-bypass
 * `authenticated` role. Coach F coaches A, then A moves to coach K; coach L
 * coaches C. meal.F is the plan F wrote for A, meal.K the one K wrote for A,
 * meal.L L's plan for C, meal.none F's plan whose client was removed. Every
 * user's supabase_id differs from their id. Every 0 or 42501 below follows a
 * read or write of the same row (or an insert of the same shape) that
 * returned 1. The assertions hold with or without #1009's MealPlan text.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('legacy-meal-plan-current-coach-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: a former coach loses a moved client\'s legacy meal plans', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLAC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const PLANS: Record<string, [string, string | null]> = {
    'meal.F': ['F', 'A'], 'meal.K': ['K', 'A'], 'meal.L': ['L', 'C'], 'meal.none': ['F', null],
  };

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`ml-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    for (const [p, [coach, client]] of Object.entries(PLANS)) {
      await prisma.$executeRaw`INSERT INTO "MealPlan" ("id", "coach_id", "client_id", "title", "items", "updated_at")
        VALUES (${id(p)}, ${u[coach]}, ${client ? u[client] : null}, 'Plan', '[]'::jsonb, now())`;
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
  const reads = async (who: string, rows: string[], jwtOnly = false) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [{ n }] = await as(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "MealPlan" WHERE "id" = $1`, id(r)), jwtOnly);
      out[r] = n;
    }
    return out;
  };
  // A harmless update (a column set to itself).
  const update = (who: string, r: string, jwtOnly = false) =>
    as(who, (tx) => tx.$executeRawUnsafe(`UPDATE "MealPlan" SET "title" = "title" WHERE "id" = $1`, id(r)), jwtOnly);
  // A delete whose count is returned and whose effect is rolled back, so the
  // same row can prove 1 before the move and 0 after it.
  class Rollback extends Error {
    constructor(readonly n: number) { super('rollback'); }
  }
  const dryDelete = (who: string, r: string, jwtOnly = false) =>
    as(who, async (tx) => {
      throw new Rollback(await tx.$executeRawUnsafe(`DELETE FROM "MealPlan" WHERE "id" = $1`, id(r)));
    }, jwtOnly).then(
      () => { throw new Error('unreachable'); },
      (e: unknown) => { if (e instanceof Rollback) return e.n; throw e; },
    );
  // Another client: C reads their own plan and none of A's; A reads none of C's.
  // Each 0 follows the owning client's read of the same row = 1.
  const clientsStayApart = async () => {
    expect(await reads('C', ['meal.L'])).toEqual({ 'meal.L': 1 });
    expect(await reads('A', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.K': 1 });
    expect(await reads('C', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 0, 'meal.K': 0 });
    expect(await reads('A', ['meal.L'])).toEqual({ 'meal.L': 0 });
  };
  const add = (who: string, tag: string, coach: string, client: string) =>
    as(who, (tx) => tx.$executeRaw`INSERT INTO "MealPlan" ("id", "coach_id", "client_id", "title", "items", "updated_at")
      VALUES (${id(tag)}, ${u[coach]}, ${u[client]}, 'Plan', '[]'::jsonb, now())`);
  const sqlState = (p: Promise<unknown>) =>
    p.then(() => 'ok', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (/Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501)\b/.exec(msg))?.[1] ?? `unparsed: ${msg.slice(0, 200)}`;
    });

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('F', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the move, the coach reads, updates, deletes and adds the client\'s legacy plan', async () => {
    expect(await reads('F', ['meal.F', 'meal.none'])).toEqual({ 'meal.F': 1, 'meal.none': 1 });
    expect(await update('F', 'meal.F')).toBe(1);
    expect(await dryDelete('F', 'meal.F')).toBe(1);
    expect(await add('F', 'meal.F2', 'F', 'A')).toBe(1);
    expect(await reads('A', ['meal.F', 'meal.F2'])).toEqual({ 'meal.F': 1, 'meal.F2': 1 });
  });

  it('before the move, another client reads none of A\'s legacy plans, and A none of theirs', clientsStayApart);

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it('the former coach reads, updates, deletes and adds none of A\'s legacy plans', async () => {
      expect(await reads('A', ['meal.F', 'meal.F2', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.F2': 1, 'meal.K': 1 });
      expect(await reads('F', ['meal.F', 'meal.F2', 'meal.K'])).toEqual({ 'meal.F': 0, 'meal.F2': 0, 'meal.K': 0 });
      expect(await update('F', 'meal.F')).toBe(0);
      expect(await dryDelete('F', 'meal.F')).toBe(0);
      expect(await sqlState(add('F', 'meal.F3', 'F', 'A'))).toBe('42501');
      // The plan with no client stays the coach's.
      expect(await reads('F', ['meal.none'])).toEqual({ 'meal.none': 1 });
    });

    it('the client still reads every legacy plan they had', async () => {
      expect(await reads('A', ['meal.F', 'meal.F2', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.F2': 1, 'meal.K': 1 });
    });

    it('the new coach reads A\'s plans and writes their own, as before', async () => {
      expect(await reads('K', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 1, 'meal.K': 1 });
      expect(await update('K', 'meal.K')).toBe(1);
      expect(await dryDelete('K', 'meal.K')).toBe(1);
      expect(await add('K', 'meal.K2', 'K', 'A')).toBe(1);
    });

    it('another client still reads none of A\'s legacy plans, and A none of theirs', clientsStayApart);

    it('another coach\'s client stays out of reach', async () => {
      expect(await reads('L', ['meal.L'])).toEqual({ 'meal.L': 1 });
      expect(await reads('L', ['meal.F', 'meal.K'])).toEqual({ 'meal.F': 0, 'meal.K': 0 });
      expect(await add('L', 'meal.L2', 'L', 'C')).toBe(1);
      expect(await sqlState(add('K', 'meal.KC', 'K', 'C'))).toBe('42501');
      expect(await reads('K', ['meal.L'])).toEqual({ 'meal.L': 0 });
    });

    it('the Data API model (JWT only, no app.current_user_id) reads and writes none of it', async () => {
      const rows = ['meal.F', 'meal.K'];
      expect(await reads('A', rows)).toEqual({ 'meal.F': 1, 'meal.K': 1 });
      expect(await reads('A', rows, true)).toEqual({ 'meal.F': 0, 'meal.K': 0 });
      expect(await reads('K', rows, true)).toEqual({ 'meal.F': 0, 'meal.K': 0 });
      expect(await reads('F', ['meal.none'], true)).toEqual({ 'meal.none': 0 });
      expect(await update('K', 'meal.K', true)).toBe(0);
      expect(await dryDelete('K', 'meal.K', true)).toBe(0);
    });
  });

  it('the server\'s service role still reads and writes every row', async () => {
    const seen = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS "n" FROM "MealPlan" WHERE "id" LIKE $1`, `%-${run}`);
      const write = await tx.$executeRawUnsafe(`UPDATE "MealPlan" SET "title" = "title" WHERE "id" = $1`, id('meal.F'));
      return { n, write };
    });
    expect(seen).toEqual({ n: 7, write: 1 });
  });

  it('the fence is one restrictive policy for the API roles, keyed on the tenure helper', async () => {
    const rows = await prisma.$queryRaw<{ name: string; permissive: string; roles: string[]; cmd: string; qual: string; check: string }[]>`
      SELECT "policyname" AS "name", "permissive", "roles"::text[] AS "roles", "cmd", "qual", "with_check" AS "check"
      FROM pg_policies WHERE "schemaname" = 'public' AND "tablename" = 'MealPlan' AND "permissive" = 'RESTRICTIVE'`;
    expect(rows.map(({ name, permissive, roles, cmd }) => ({ name, permissive, roles: [...roles].sort(), cmd }))).toEqual([
      { name: 'p_mealplan_coach_keeps_current_client', permissive: 'RESTRICTIVE', roles: ['anon', 'authenticated'], cmd: 'ALL' },
    ]);
    for (const expr of [rows[0].qual, rows[0].check]) {
      expect(expr).toContain('app.current_user_id() IS NOT NULL');
      expect(expr).toContain('app.is_user_coached_by(client_id, app.current_user_id())');
    }
  });
});
