/**
 * Row security for a moved client's meal plan and guidelines (MOVERLS2, owner
 * 4 and 4b) on the replayed migration chain, as the non-bypass `authenticated`
 * role. Coach A has clients X and Y and a seated sub-coach S, who coaches T;
 * coach C coaches Z. X then moves to coach B. pFrozen is A's archived plan held
 * only by X (the state #961's freezeForMovedClients leaves), tFrozen its
 * template; pShared is a live plan of A's held by Y and X. Every 0 below is
 * preceded by a read or write of the same row that returned 1.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('former-coach-meal-plan-guideline-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: a moved client\'s meal plan and guidelines leave the former coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'ABCSXYZT'].map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { S: 'A', X: 'A', Y: 'A', Z: 'C', T: 'S' };
  const isCoach = (k: string) => 'ABCS'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const tag = (rows: { id: string }[]) => rows.map((r) => r.id.slice(0, -run.length - 1)).sort();
  // plans: [coach, archived, holders]; templates: [coach, archived, plan]; one slot per template
  const plans: Record<string, [string, boolean, string[]]> = {
    pLive: ['A', false, ['Y']], pShared: ['A', false, ['Y', 'X']], pFrozen: ['A', true, ['X']],
    pOld: ['A', true, ['Y']], pC: ['C', false, ['Z']], pS: ['S', true, ['T']],
  };
  const templates: Record<string, [string, boolean, string]> = {
    tLive: ['A', false, 'pLive'], tShared: ['A', false, 'pShared'], tFrozen: ['A', true, 'pFrozen'],
    tC: ['C', false, 'pC'], tS: ['S', true, 'pS'],
  };
  const guidelines: Record<string, [string, string]> = { gAX: ['A', 'X'], gAY: ['A', 'Y'], gCZ: ['C', 'Z'], gST: ['S', 'T'] };
  const slot = (t: string) => `s${t.slice(1)}`;

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${u[k]}, ${`m2-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "TeamSubCoachAssignment" ("id", "head_coach_id", "sub_coach_id")
      VALUES (${randomUUID()}, ${u.A}, ${u.S})`;
    for (const [p, [coach, archived, holders]] of Object.entries(plans)) {
      await prisma.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name", "archived_at")
        VALUES (${id(p)}, ${u[coach]}, 'Plan', ${archived ? new Date() : null})`;
      for (const h of holders) {
        await prisma.$executeRaw`INSERT INTO "DailyMealPlanAssignment"
            ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
          VALUES (${id(`${p}.${h}`)}, ${id(p)}, ${u[h]}, ${u[coach]}, CURRENT_DATE)`;
      }
    }
    for (const [t, [coach, archived, plan]] of Object.entries(templates)) {
      await prisma.$executeRaw`INSERT INTO "MealTemplate"
          ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g", "archived_at")
        VALUES (${id(t)}, ${u[coach]}, 'Meal', 500, 30, 50, 20, ${archived ? new Date() : null})`;
      await prisma.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label")
        VALUES (${id(slot(t))}, ${id(plan)}, ${id(t)}, 'Lunch')`;
    }
    for (const [g, [coach, client]] of Object.entries(guidelines)) {
      await prisma.$executeRaw`INSERT INTO "CoachGuideline" ("id", "coach_id", "client_id", "content", "updated_at")
        VALUES (${id(g)}, ${u[coach]}, ${u[client]}, 'Guideline', now())`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Runs `query` as the signed-in API role, with both identity forms the
  // policies read (app.current_user_id and the Supabase JWT subject).
  const asUser = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: u[who] }));
      return query(tx);
    });
  const ours = (tx: Prisma.TransactionClient, table: string) =>
    tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${table}" WHERE "id" LIKE $1`, `%-${run}`).then(tag);
  const seen = (who: string) =>
    asUser(who, async (tx) => ({
      plans: await ours(tx, 'DailyMealPlan'),
      templates: await ours(tx, 'MealTemplate'),
      slots: await ours(tx, 'DailyMealPlanSlot'),
      guidelines: await ours(tx, 'CoachGuideline'),
    }));
  // Harmless writes (a column set to itself), keyed by the row tag's first letter.
  const TABLE: Record<string, [string, string]> = {
    p: ['DailyMealPlan', 'notes'], t: ['MealTemplate', 'name'], s: ['DailyMealPlanSlot', 'order'], g: ['CoachGuideline', 'content'],
  };
  const writes = async (who: string, verb: 'UPDATE' | 'DELETE', rows: string[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const [table, col] = TABLE[r[0]];
      const sql = verb === 'UPDATE' ? `UPDATE "${table}" SET "${col}" = "${col}" WHERE "id" = $1` : `DELETE FROM "${table}" WHERE "id" = $1`;
      out[r] = await asUser(who, (tx) => tx.$executeRawUnsafe(sql, id(r)));
    }
    return out;
  };
  const all = (rows: string[], n: number) => Object.fromEntries(rows.map((r) => [r, n]));
  const addSlot = (who: string, tagName: string, plan: string, template: string) =>
    asUser(who, (tx) => tx.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label", "order")
      VALUES (${id(tagName)}, ${id(plan)}, ${id(template)}, 'Dinner', 1)`);
  const addGuideline = (who: string, tagName: string, coach: string, client: string) =>
    asUser(who, (tx) => tx.$executeRaw`INSERT INTO "CoachGuideline" ("id", "coach_id", "client_id", "content", "updated_at")
      VALUES (${id(tagName)}, ${u[coach]}, ${u[client]}, 'Guideline', now())`);
  const FENCED = ['pFrozen', 'pShared', 'tFrozen', 'tShared', 'sFrozen', 'sShared', 'gAX'];

  it('runs as a role that does not bypass row security', async () => {
    expect(await asUser('A', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the move, each coach and client reaches their own rows', async () => {
    expect(await seen('A')).toEqual({
      plans: ['pFrozen', 'pLive', 'pOld', 'pShared'], templates: ['tFrozen', 'tLive', 'tShared'],
      slots: ['sFrozen', 'sLive', 'sShared'], guidelines: ['gAX', 'gAY'],
    });
    expect(await seen('C')).toEqual({ plans: ['pC'], templates: ['tC'], slots: ['sC'], guidelines: ['gCZ'] });
    expect(await seen('S')).toEqual({ plans: ['pS'], templates: ['tS'], slots: ['sS'], guidelines: ['gST'] });
    expect(await seen('B')).toEqual({ plans: [], templates: [], slots: [], guidelines: [] });
    // A client reads the plans they hold, their slots and templates (20270502000700).
    expect(await seen('X')).toEqual({
      plans: ['pFrozen', 'pShared'], templates: ['tFrozen', 'tShared'], slots: ['sFrozen', 'sShared'], guidelines: ['gAX'],
    });
    expect(await writes('A', 'UPDATE', FENCED)).toEqual(all(FENCED, 1));
  });

  describe('after X moves to coach B', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.B} WHERE "id" = ${u.X}`;
    });

    it('the former coach reads none of the frozen copy or their guideline about X; Y\'s rows stay', async () => {
      expect(await seen('A')).toEqual({
        plans: ['pLive', 'pOld', 'pShared'], templates: ['tLive', 'tShared'], slots: ['sLive', 'sShared'], guidelines: ['gAY'],
      });
    });

    it('the former coach can no longer change, delete or add to any row X holds', async () => {
      expect(await writes('A', 'UPDATE', FENCED)).toEqual(all(FENCED, 0));
      expect(await writes('A', 'DELETE', FENCED)).toEqual(all(FENCED, 0));
      await expect(addSlot('A', 'sAdded', 'pFrozen', 'tLive')).rejects.toThrow(/row-level security/);
      await expect(addSlot('A', 'sAdded', 'pShared', 'tLive')).rejects.toThrow(/row-level security/);
      await expect(addGuideline('A', 'gAdded', 'A', 'X')).rejects.toThrow(/row-level security/);
      // The same writes for the client who stays still pass.
      const kept = ['pLive', 'tLive', 'sLive', 'gAY'];
      expect(await writes('A', 'UPDATE', kept)).toEqual(all(kept, 1));
      expect(await addSlot('A', 'sLive2', 'pLive', 'tLive')).toBe(1);
    });

    it('the current coach writes and reads their own plan and guideline, never the former coach\'s', async () => {
      await asUser('B', async (tx) => {
        await tx.$executeRaw`INSERT INTO "DailyMealPlan" ("id", "coach_id", "name") VALUES (${id('pB')}, ${u.B}, 'Plan')`;
        await tx.$executeRaw`INSERT INTO "MealTemplate" ("id", "coach_id", "name", "calories_kcal", "protein_g", "carbs_g", "fats_g")
          VALUES (${id('tB')}, ${u.B}, 'Meal', 500, 30, 50, 20)`;
        await tx.$executeRaw`INSERT INTO "DailyMealPlanSlot" ("id", "daily_meal_plan_id", "meal_template_id", "slot_label")
          VALUES (${id('sB')}, ${id('pB')}, ${id('tB')}, 'Lunch')`;
        await tx.$executeRaw`INSERT INTO "DailyMealPlanAssignment" ("id", "daily_meal_plan_id", "client_id", "assigned_by_coach_id", "starts_on")
          VALUES (${id('pB.X')}, ${id('pB')}, ${u.X}, ${u.B}, CURRENT_DATE)`;
      });
      expect(await addGuideline('B', 'gBX', 'B', 'X')).toBe(1);
      expect(await writes('B', 'UPDATE', ['pB', 'tB', 'sB', 'gBX'])).toEqual(all(['pB', 'tB', 'sB', 'gBX'], 1));
      expect(await seen('B')).toEqual({ plans: ['pB'], templates: ['tB'], slots: ['sB'], guidelines: ['gBX'] });
      // gAX read 1 for A before the move and still reads 1 for X (next test).
      expect(await writes('B', 'UPDATE', ['gAX', 'pFrozen'])).toEqual({ gAX: 0, pFrozen: 0 });
      expect(await writes('B', 'DELETE', ['gAX'])).toEqual({ gAX: 0 });
      await expect(addGuideline('B', 'gForged', 'C', 'X')).rejects.toThrow(/row-level security/);
      expect(await seen('A').then((a) => [a.plans.includes('pB'), a.guidelines.includes('gBX')])).toEqual([false, false]);
    });

    it('the client keeps every guideline and meal-plan assignment they had', async () => {
      expect(await seen('X')).toEqual({
        plans: ['pB', 'pFrozen', 'pShared'], templates: ['tB', 'tFrozen', 'tShared'], slots: ['sB', 'sFrozen', 'sShared'],
        guidelines: ['gAX', 'gBX'],
      });
      const holds = await asUser('X', (tx) => ours(tx, 'DailyMealPlanAssignment'));
      expect(holds).toEqual(['pB.X', 'pFrozen.X', 'pShared.X']);
    });

    it('another coach is untouched', async () => {
      expect(await seen('C')).toEqual({ plans: ['pC'], templates: ['tC'], slots: ['sC'], guidelines: ['gCZ'] });
      expect(await writes('C', 'UPDATE', ['pC', 'tC', 'sC', 'gCZ', 'gAX', 'gBX', 'pFrozen', 'pB']))
        .toEqual({ pC: 1, tC: 1, sC: 1, gCZ: 1, gAX: 0, gBX: 0, pFrozen: 0, pB: 0 });
      expect(await seen('Z')).toEqual({ plans: ['pC'], templates: ['tC'], slots: ['sC'], guidelines: ['gCZ'] });
    });

    it('a sub-coach reaches these rows only as the client\'s own coach; after removal, nothing', async () => {
      // Seated, with an open delegation of A's client Y: still only S's own client's rows.
      await prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
        VALUES (${randomUUID()}, ${u.A}, ${u.S}, ${u.Y})`;
      expect(await seen('S')).toEqual({ plans: ['pS'], templates: ['tS'], slots: ['sS'], guidelines: ['gST'] });
      expect(await writes('S', 'UPDATE', ['pS', 'tS', 'sS', 'gST', 'gAY'])).toEqual({ pS: 1, tS: 1, sS: 1, gST: 1, gAY: 0 });
      // Removal (#978's state): seat archived, S's client back with the head, a delegation of T left open.
      await prisma.$executeRaw`UPDATE "TeamSubCoachAssignment" SET "archived_at" = now()
        WHERE "head_coach_id" = ${u.A} AND "sub_coach_id" = ${u.S}`;
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.A} WHERE "id" = ${u.T}`;
      await prisma.$executeRaw`INSERT INTO "SubCoachAssignment" ("id", "head_coach_id", "sub_coach_id", "client_id")
        VALUES (${randomUUID()}, ${u.A}, ${u.S}, ${u.T})`;
      expect(await seen('S')).toEqual({ plans: [], templates: [], slots: [], guidelines: [] });
      expect(await writes('S', 'UPDATE', ['pS', 'tS', 'sS', 'gST'])).toEqual(all(['pS', 'tS', 'sS', 'gST'], 0));
      await expect(addGuideline('S', 'gST2', 'S', 'T')).rejects.toThrow(/row-level security/);
      // T keeps the guideline; the head, now T's coach, does not read S's.
      expect(await seen('T').then((t) => t.guidelines)).toEqual(['gST']);
      expect(await seen('A').then((a) => a.guidelines)).toEqual(['gAY']);
      expect(await writes('A', 'UPDATE', ['gST'])).toEqual({ gST: 0 });
    });
  });

  it('policy comments match the rules in force', async () => {
    const rows = await prisma.$queryRaw<{ table: string; policy: string; qual: string | null; comment: string | null }[]>`
      SELECT c."relname" AS "table", p."polname" AS "policy", pg_get_expr(p."polqual", p."polrelid") AS "qual",
             obj_description(p."oid", 'pg_policy') AS "comment"
      FROM pg_policy p JOIN pg_class c ON c."oid" = p."polrelid"
      WHERE c."relname" IN ('DailyMealPlan', 'MealTemplate', 'DailyMealPlanSlot', 'CoachGuideline', 'WorkoutAdjustmentProposal')
        AND p."polname" NOT LIKE '%service_role%' AND p."polname" NOT LIKE 'deny_all%'`;
    const narrowed = rows.filter((r) => r.comment?.startsWith('20270419000000: ')).map((r) => r.policy).sort();
    expect(narrowed).toEqual([
      'p_coachguideline_delete', 'p_coachguideline_insert', 'p_coachguideline_select', 'p_coachguideline_update',
      'p_dailymealplan_delete', 'p_dailymealplan_select', 'p_dailymealplan_update',
      'p_dailymealplanslot_delete', 'p_dailymealplanslot_insert', 'p_dailymealplanslot_update',
      'p_mealtemplate_delete', 'p_mealtemplate_select', 'p_mealtemplate_update',
    ]);
    const proposal = rows.find((r) => r.policy === 'p_workoutadjustmentproposal_select_coach');
    const current = proposal?.qual?.includes('is_user_coached_by') ?? false;
    expect(proposal?.comment?.includes('while the client is still theirs')).toBe(current);
  });
});
