/**
 * Row security for meal photos (MEAL-PHOTO-BE, 20270502011300) on the replayed migration chain, as the
 * non-bypass `authenticated` role. Coach K coaches B, coach L coaches C, and client A starts with coach F,
 * then moves to K. Every user's supabase_id differs from their id. Every 0 or 42501 below follows a read
 * or write of the same row that returned 1. Shaped like food-body-rls.spec.ts.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-entry-photos-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Row rules: a meal photo follows its food entry\'s coaching relationship', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'FKLABC'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'F', B: 'K', C: 'L' };
  const isCoach = (k: string) => 'FKL'.includes(k);
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${sub[k]}, ${`fp-${u[k]}`}, 'RLS user', ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    await prisma.$executeRaw`INSERT INTO "FoodItem" ("id", "name", "serving_description", "serving_size_grams", "calories", "protein_g", "carbs_g", "fat_g")
      VALUES (${id('oats')}, 'Oats', '1 bowl', 80, 300, 10, 50, 5)`;
    for (const k of 'ABC') {
      await prisma.$executeRaw`INSERT INTO "LoggedFoodEntry" ("id", "user_id", "date", "meal_type", "food_item_id")
        VALUES (${id(`food.${k}`)}, ${u[k]}, CURRENT_DATE, 'lunch'::"MealType", ${id('oats')})`;
      await prisma.$executeRaw`INSERT INTO "food_entry_photos" ("entry_id", "user_id", "storage_key", "width", "height", "size_bytes", "mime")
        VALUES (${id(`food.${k}`)}, ${u[k]}, ${`${u[k]}/${randomUUID()}-0000000000000-0000000000000000-00000000000000000000000000000000.sent.jpg`}, 1200, 900, 4000, 'image/jpeg')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Backend model: the API role with app.current_user_id (and the JWT subject).
  // Data API model (jwtOnly): the JWT subject alone, no GUC. Anon: no claims at all.
  const as = <T>(who: string | null, query: (tx: Prisma.TransactionClient) => Promise<T>, jwtOnly = false) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (who === null) {
        await tx.$executeRawUnsafe('SET LOCAL ROLE anon');
        return query(tx);
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (!jwtOnly) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      }
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[who], role: 'authenticated' }));
      return query(tx);
    });
  const reads = async (who: string, clients: string[], jwtOnly = false) => {
    const out: Record<string, number> = {};
    for (const k of clients) {
      const [{ n }] = await as(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "food_entry_photos" WHERE "entry_id" = $1`, id(`food.${k}`)), jwtOnly);
      out[k] = n;
    }
    return out;
  };
  const sqlState = (p: Promise<unknown>) =>
    p.then(() => 'ok', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (/Code: `([0-9A-Z]{5})`/.exec(msg) ?? /\b(42501)\b/.exec(msg))?.[1] ?? `unparsed: ${msg.slice(0, 200)}`;
    });

  it('runs as a role that does not bypass row security, on a table with row security forced', async () => {
    expect(await as('K', (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    expect(await prisma.$queryRaw<{ on: boolean; forced: boolean }[]>`
      SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class WHERE "relname" = 'food_entry_photos'`).toEqual([{ on: true, forced: true }]);
  });

  it('before the move, the client and their coach of record read the photo; the next coach does not', async () => {
    expect(await reads('A', ['A'])).toEqual({ A: 1 });
    expect(await reads('F', ['A'])).toEqual({ A: 1 });
    expect(await reads('K', ['A', 'B'])).toEqual({ A: 0, B: 1 });
  });

  describe('after A moves from coach F to coach K', () => {
    beforeAll(async () => {
      await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    });

    it('the owner and the coach now read it; the former coach, another coach and another client read none', async () => {
      expect(await reads('A', ['A', 'B', 'C'])).toEqual({ A: 1, B: 0, C: 0 });
      expect(await reads('K', ['A', 'B', 'C'])).toEqual({ A: 1, B: 1, C: 0 });
      expect(await reads('F', ['A', 'B', 'C'])).toEqual({ A: 0, B: 0, C: 0 });
      expect(await reads('L', ['A', 'B', 'C'])).toEqual({ A: 0, B: 0, C: 1 });
      expect(await reads('B', ['A', 'C'])).toEqual({ A: 0, C: 0 });
    });

    it('anon reads none (no table rights), and the Data API model (JWT only) reads none', async () => {
      expect(await sqlState(as(null, (tx) => tx.$queryRawUnsafe(`SELECT count(*) FROM "food_entry_photos"`)))).toBe('42501');
      expect(await reads('A', ['A'], true)).toEqual({ A: 0 });
      expect(await reads('K', ['A'], true)).toEqual({ A: 0 });
    });

    it('no API role inserts, changes or deletes a photo row, not even the owner', async () => {
      const insert = (who: string) => as(who, (tx) => tx.$executeRaw`INSERT INTO "food_entry_photos"
        ("entry_id", "user_id", "storage_key", "width", "height", "size_bytes", "mime")
        VALUES (${id('food.A')}, ${u.A}, ${`${u.A}/${randomUUID()}.sent.jpg`}, 1, 1, 1, 'image/jpeg')`);
      expect(await sqlState(insert('A'))).toBe('42501');
      expect(await sqlState(insert('K'))).toBe('42501');
      for (const who of ['A', 'K']) {
        expect(await as(who, (tx) => tx.$executeRawUnsafe(`UPDATE "food_entry_photos" SET "width" = "width" WHERE "entry_id" = $1`, id('food.A')))).toBe(0);
        expect(await as(who, (tx) => tx.$executeRawUnsafe(`DELETE FROM "food_entry_photos" WHERE "entry_id" = $1`, id('food.A')))).toBe(0);
      }
      expect(await reads('A', ['A'])).toEqual({ A: 1 });
    });
  });

  it('the server\'s service role still reads and writes every row, and the row goes with its entry', async () => {
    const seen = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS "n" FROM "food_entry_photos" WHERE "entry_id" = ANY($1)`, [id('food.A'), id('food.B'), id('food.C')]);
      const write = await tx.$executeRawUnsafe(`UPDATE "food_entry_photos" SET "width" = "width" WHERE "entry_id" = $1`, id('food.C'));
      return { n, write };
    });
    expect(seen).toEqual({ n: 3, write: 1 });
    await prisma.$executeRaw`DELETE FROM "LoggedFoodEntry" WHERE "id" = ${id('food.C')}`;
    const [{ left }] = await prisma.$queryRaw<{ left: number }[]>`
      SELECT count(*)::int AS "left" FROM "food_entry_photos" WHERE "entry_id" = ${id('food.C')}`;
    expect(left).toBe(0);
  });
});
