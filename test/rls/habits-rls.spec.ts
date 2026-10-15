/**
 * HB1 (20270502002500): one row rule for habits and their logs, on the
 * replayed migration chain as the non-bypass `authenticated` role. Client A
 * moves from coach F to coach K. K also coaches B, who shares workouts with K
 * but turned habits sharing off; L coaches C; S is a sub-coach seated under K
 * with an open delegation of A. A shares habits (fitness.habits_progress) with
 * F, K and S; C shares them with L. A log is read exactly when its habit is
 * (found-not-fixed 6). Every 0 or 42501 below follows a 1 on the same row.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('habits-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const DENIED = '42501';
const HABITS_SCOPE = 'fitness.habits_progress';

(DB_URL ? describe : describe.skip)('Row rules: habits and their logs follow the current coach and the sharing switch', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLSABC'].map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKLS'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  // Seeded habits: tag -> [client, coach who set it]. Each has one log, l.<tag>.
  const SEEDED: Record<string, [string, string | null]> = {
    'own.A': ['A', null], 'F.A': ['A', 'F'], 'own.B': ['B', null], 'own.C': ['C', null],
  };

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${randomUUID()}, ${`hb1-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    const consent = (client: string, coach: string, scope: string, revoked: boolean) => prisma.$executeRaw`
      INSERT INTO "ClientCoachConsent" ("id", "client_id", "coach_id", "scope", "granted_at", "revoked_at", "updated_at")
      VALUES (${randomUUID()}, ${u[client]}, ${u[coach]}, ${scope}, now() - interval '1 day', ${revoked ? new Date() : null}, now())`;
    for (const [client, coach] of [['A', 'F'], ['A', 'K'], ['A', 'S'], ['C', 'L']]) await consent(client, coach, HABITS_SCOPE, false);
    await consent('B', 'K', 'fitness.workouts', false);
    await consent('B', 'K', HABITS_SCOPE, true);
    for (const [tag, [client, coach]] of Object.entries(SEEDED)) {
      await prisma.$executeRaw`INSERT INTO "Habit" ("id", "user_id", "name", "assigned_by_coach_id")
        VALUES (${id(`h.${tag}`)}, ${u[client]}, 'Walk', ${coach ? u[coach] : null})`;
      await prisma.$executeRaw`INSERT INTO "HabitLog" ("id", "habit_id", "date", "completed")
        VALUES (${id(`l.${tag}`)}, ${id(`h.${tag}`)}, CURRENT_DATE, true)`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id") VALUES (${randomUUID()}, ${u.K}, ${u.S})`;
  });
  afterAll(() => prisma.$disconnect());

  // Backend model: the API role with app.current_user_id and app.current_user_role.
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      return query(tx);
    });
  const count = (who: string, table: string, row: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1`, id(row)))
      .then(([{ n }]) => n);
  // [habit rows, log rows] the caller reads for each habit tag.
  const sees = async (who: string, tags: string[]) => {
    const out: Record<string, [number, number]> = {};
    for (const t of tags) out[t] = [await count(who, 'Habit', `h.${t}`), await count(who, 'HabitLog', `l.${t}`)];
    return out;
  };
  const only = (tags: string[], seen: string[]) => Object.fromEntries(tags.map((t) => [t, seen.includes(t) ? [1, 1] : [0, 0]]));
  // Rows written, or the SQLSTATE of the refusal.
  const write = (who: string, sql: string, params: unknown[]) =>
    as(who, (tx) => tx.$executeRawUnsafe(sql, ...params)).then((n): number | string => n, (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (/Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501)\b/.exec(msg))?.[1] ?? `unparsed: ${msg.slice(0, 200)}`;
    });
  const SQL = {
    set: `INSERT INTO "Habit" ("id", "user_id", "name", "assigned_by_coach_id") VALUES ($1, $2, 'Walk', $3)`,
    edit: `UPDATE "Habit" SET "sort_order" = "sort_order" + 1 WHERE "id" = $1`,
    handTo: `UPDATE "Habit" SET "user_id" = $2 WHERE "id" = $1`,
    remove: `DELETE FROM "Habit" WHERE "id" = $1`,
    tick: `INSERT INTO "HabitLog" ("id", "habit_id", "date", "completed") VALUES ($1, $2, CURRENT_DATE, true)`,
    editTick: `UPDATE "HabitLog" SET "completed" = "completed" WHERE "id" = $1`,
  };
  // In order: [who, statement, params (row tags, user letters or null), rows written or SQLSTATE].
  type Step = [string, keyof typeof SQL, (string | null)[], number | string];
  const steps = async (list: Step[]) => {
    const param = (p: string | null) => (p === null ? null : p in u ? u[p] : id(p));
    const got: Step[] = [];
    for (const [who, verb, params] of list) got.push([who, verb, params, await write(who, SQL[verb], params.map(param))]);
    expect(got).toEqual(list);
  };

  it('runs as a role that does not bypass row security', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('the sharing helper is SECURITY DEFINER with an empty search_path, run only by the API and service roles', async () => {
    const [fn] = await prisma.$queryRaw<{ definer: boolean; config: string[]; anon: boolean; authed: boolean; service: boolean }[]>`
      SELECT p."prosecdef" AS "definer", p."proconfig" AS "config",
             has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon",
             has_function_privilege('authenticated', p."oid", 'EXECUTE') AS "authed",
             has_function_privilege('service_role', p."oid", 'EXECUTE') AS "service"
      FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
      WHERE n."nspname" = 'app' AND p."proname" = 'current_coach_has_scope'`;
    expect(fn).toEqual({ definer: true, config: ['search_path=""'], anon: false, authed: true, service: true });
  });

  it('before the move, coach F reads A\'s habits and logs and edits the habit F set', async () => {
    expect(await sees('F', ['own.A', 'F.A'])).toEqual(only(['own.A', 'F.A'], ['own.A', 'F.A']));
    await steps([['F', 'edit', ['h.F.A'], 1]]);
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
      await prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
        VALUES (${randomUUID()}, ${u.K}, ${u.S}, ${u.A})`;
    });

    it('K sets and edits only habits K set, for a client who shares habits; only the client ticks', () =>
      steps([
        ['K', 'set', ['h.K.A', 'A', 'K'], 1],
        ['K', 'set', ['h.x1', 'A', null], DENIED], // the setter is always the coach writing
        ['K', 'set', ['h.x2', 'B', 'K'], DENIED], // B does not share habits with K
        ['F', 'set', ['h.x3', 'A', 'F'], DENIED], // the former coach
        ['L', 'set', ['h.x4', 'A', 'L'], DENIED], // another coach
        ['S', 'set', ['h.x5', 'A', 'S'], DENIED], // the assistant coach
        ['K', 'edit', ['h.K.A'], 1],
        ['K', 'handTo', ['h.K.A', 'B'], DENIED],
        ['K', 'remove', ['h.K.A'], 0], // no coach deletes a habit
        ['A', 'edit', ['h.F.A'], 1],
        ['K', 'edit', ['h.F.A'], 0], // the habit F set stays with the client
        ['F', 'edit', ['h.F.A'], 0],
        ['A', 'edit', ['h.own.A'], 1],
        ['K', 'edit', ['h.own.A'], 0],
        ['A', 'edit', ['h.K.A'], 1], // the client owns every habit; PATCH narrows a coach-set one to its reminder
        ['A', 'tick', ['l.K.A', 'h.K.A'], 1],
        ['K', 'tick', ['l.x6', 'h.own.A'], DENIED],
        ['A', 'editTick', ['l.own.A'], 1],
        ['K', 'editTick', ['l.own.A'], 0],
      ]));

    const TAGS = ['own.A', 'F.A', 'K.A', 'own.B', 'own.C'];
    it.each<[string, string[]]>([
      ['A', ['own.A', 'F.A', 'K.A']], // the client: every habit of theirs, whoever set it
      ['B', ['own.B']],
      ['K', ['own.A', 'F.A', 'K.A']], // the current coach A shares habits with; not B's
      ['L', ['own.C']], // another coach: only their own client's
      ['F', []], // the former coach: none, not even the habit F set
      ['S', []], // the assistant coach: a delegation and a consent row open nothing
    ])('%s reads exactly %j, each habit and its log alike', async (who, seen) => {
      expect(await sees(who, TAGS)).toEqual(only(TAGS, seen));
    });
  });
});
