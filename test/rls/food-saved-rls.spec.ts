/**
 * FOODSAVED (migration 20270502001300): favourites, saved meals and their items
 * are read and written by their client only, read by the client's current
 * coach, and a SavedMealItem follows its meal. Row access runs as the API role
 * `authenticated` (no RLS bypass) on the replayed chain, with each person's JWT
 * claims (their supabase_id, never their User id), and every zero comes right
 * after a control read of 1 of the same row. The service cases call the real
 * SavedFoodsService and LogService on the superuser connection, as the API does.
 * The last case builds the real data-export archive for two clients and a coach,
 * then runs the account-deletion manifest's FOODSAVED steps.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../src/prisma.service';
import { FoodService } from '../../src/food/food.service';
import { LogService } from '../../src/log/log.service';
import { SavedFoodsService } from '../../src/log/saved-foods.service';
import { DataExportService } from '../../src/data-export/data-export.service';
import { ERASURE_MANIFEST, executeErasureManifest } from '../../src/account-deletion/account-deletion.manifest';
import { CreateSavedMealDto, FAVORITES_MAX, SAVED_MEALS_MAX } from '../../src/log/saved-foods.dto';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PtmService } from '../../src/ptm/ptm.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-saved-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270502001300_food_favorites_saved_meals';
const RLS = /row-level security/;
const TABLES = ['FoodFavorite', 'SavedMeal', 'SavedMealItem'] as const;

function stub<T>(value: unknown): T {
  return value as T;
}

(DB_URL ? describe : describe.skip)('FOODSAVED: favourites and saved meals stay with their client', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const food = new FoodService(prisma);
  const deps = [
    stub<AnalyticsService>({ capture: jest.fn() }),
    stub<PtmService>({ emit: jest.fn() }),
    stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
  ] as const;
  const saved = new SavedFoodsService(prisma, food, ...deps);
  const log = new LogService(prisma, food, ...deps);
  // Fictional people, fresh ids per run. Coaches h and k. a: h's client.
  // b: k's client. c: h's client who fills up to the limits.
  const [h, k, a, b, c] = Array.from({ length: 5 }, () => randomUUID());
  const roleOf: Record<string, string> = { [h]: 'coach', [k]: 'coach' };
  const supa = Object.fromEntries([h, k, a, b, c].map((id) => [id, randomUUID()]));
  let oats = '';
  let banana = '';
  let aCustom = '';
  let aMeal = '';
  let aItem = '';
  let aFav = '';

  /** Runs `fn` in one transaction as the API role `authenticated`, signed in as `who` ('' = no user): JWT claims
   * and app context. `jwt:<id>` models the Data API: that person's JWT claims only, no app context. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const id = who.replace(/^jwt:/, '');
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify(id ? { sub: supa[id], role: 'authenticated' } : { role: 'authenticated' }));
      if (id === who) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, roleOf[who] ?? 'student');
      }
      return fn(tx);
    });
  /** Rows of `table` with this id that `who` reads. */
  const seen = async (who: string, table: string, id: string): Promise<number> => {
    const [{ n }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, id));
    return n;
  };
  /** Rows of `table` with this id that `who` changes with `sql` (an UPDATE or DELETE ... WHERE "id" = $1). */
  const changes = (who: string, sql: string, id: string) => asUser(who, (tx) => tx.$executeRawUnsafe(sql, id));
  /** `control` reads the row (1), right before `who` reads it, or writes it with `sql` (WHERE "id" = $1): 0 rows. */
  const zeroAfter = async (control: string, who: string, table: string, id: string, sql?: string) => {
    expect(await seen(control, table, id)).toBe(1);
    expect(await (sql ? changes(who, sql, id) : seen(who, table, id))).toBe(0);
  };
  const rowsOfA = (): Array<[string, string]> => [['FoodFavorite', aFav], ['SavedMeal', aMeal], ['SavedMealItem', aItem]];
  const insertFavorite = (who: string, owner: string, foodId: string) => asUser(who, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."FoodFavorite" ("id","user_id","food_item_id") VALUES ($1, $2, $3)`, randomUUID(), owner, foodId));
  const insertItem = (who: string, mealId: string, position: number) => asUser(who, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."SavedMealItem" ("id","saved_meal_id","food_item_id","position") VALUES ($1, $2, $3, $4)`,
    randomUUID(), mealId, oats, position));
  const insertMeal = (who: string, owner: string) => asUser(who, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO public."SavedMeal" ("id","user_id","name","updated_at") VALUES ($1, $2, 'Taken', now())`, randomUUID(), owner));
  const runSql = (file: 'migration.sql' | 'down.sql') => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, file), 'utf8');
    const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((st) => st.trim()).filter(Boolean);
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    });
  };
  const forced = () => prisma.$queryRawUnsafe<{ relname: string; forced: boolean }[]>(
    `SELECT relname::text AS relname, relrowsecurity AND relforcerowsecurity AS forced FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`, [...TABLES]);
  const catalogFood = (name: string, calories: number, protein_g: number) => prisma.foodItem.create({
    data: { name, serving_description: '100 g', serving_size_grams: 100, calories, protein_g, carbs_g: 20, fat_g: 3 },
  }).then((f) => f.id);

  beforeAll(async () => {
    // down.sql removes all three tables and the helper; the migration brings them back.
    await runSql('down.sql');
    expect(await forced()).toEqual([]);
    await runSql('migration.sql');
    expect(await forced()).toEqual(TABLES.map((relname) => ({ relname, forced: true })));

    const people: Array<[string, 'coach' | 'student', string | null]> = [
      [h, 'coach', null], [k, 'coach', null], [a, 'student', h], [b, 'student', k], [c, 'student', h],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: supa[id], email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    oats = await catalogFood('RLS oats', 380, 13);
    banana = await catalogFood('RLS banana', 89, 1.1);
    aCustom = (await food.create({ name: 'RLS custom bowl', serving_description: '1 bowl', serving_size_grams: 300,
      calories: 520, protein_g: 30, carbs_g: 60, fat_g: 15 }, a)).id;
    aFav = (await saved.addFavorite(a, oats)).id;
    const meal = await saved.createSavedMeal(a, { name: '  Usual breakfast ', items: [
      { food_item_id: oats, quantity_multiplier: 0.5, original_quantity: 50, original_unit: 'g' },
      { food_item_id: banana, quantity_multiplier: 1.2 },
    ] });
    aMeal = meal.id;
    aItem = meal.items[0].id;
  });
  afterAll(() => prisma.$disconnect());

  it('the client reads their own rows; another client reads none of them and cannot write them', async () => {
    for (const [table, id] of rowsOfA()) await zeroAfter(a, b, table, id);
    expect(await changes(a, `UPDATE public."SavedMeal" SET "name" = "name" WHERE "id" = $1`, aMeal)).toBe(1);
    await zeroAfter(a, b, 'SavedMeal', aMeal, `UPDATE public."SavedMeal" SET "name" = 'Taken' WHERE "id" = $1`);
    await zeroAfter(a, b, 'SavedMealItem', aItem, `DELETE FROM public."SavedMealItem" WHERE "id" = $1`);
    await zeroAfter(a, b, 'FoodFavorite', aFav, `DELETE FROM public."FoodFavorite" WHERE "id" = $1`);
    await expect(insertFavorite(b, a, banana)).rejects.toThrow(RLS);
    await expect(insertMeal(b, a)).rejects.toThrow(RLS);
    await expect(insertItem(b, aMeal, 9)).rejects.toThrow(RLS);
    await expect(insertItem(a, aMeal, 9)).resolves.toBe(1);
    expect(await changes(a, `DELETE FROM public."SavedMealItem" WHERE "saved_meal_id" = $1 AND "position" = 9`, aMeal)).toBe(1);
    // Moving an item into another person's meal is refused too.
    const bMeal = (await saved.createSavedMeal(b, { name: 'B lunch', items: [{ food_item_id: banana }] })).id;
    await expect(changes(a, `UPDATE public."SavedMealItem" SET "saved_meal_id" = '${bMeal}' WHERE "id" = $1`, aItem)).rejects.toThrow(RLS);
    expect(await prisma.savedMealItem.count({ where: { saved_meal_id: aMeal } })).toBe(2);
  });

  it('the current coach reads the rows but cannot change them; another coach reads none', async () => {
    for (const [table, id] of rowsOfA()) await zeroAfter(h, k, table, id);
    await zeroAfter(h, h, 'SavedMeal', aMeal, `UPDATE public."SavedMeal" SET "name" = 'Coach' WHERE "id" = $1`);
    await zeroAfter(h, h, 'SavedMealItem', aItem, `UPDATE public."SavedMealItem" SET "position" = 7 WHERE "id" = $1`);
    await zeroAfter(h, h, 'SavedMealItem', aItem, `DELETE FROM public."SavedMealItem" WHERE "id" = $1`);
    await zeroAfter(h, h, 'FoodFavorite', aFav, `DELETE FROM public."FoodFavorite" WHERE "id" = $1`);
    await expect(insertFavorite(h, a, banana)).rejects.toThrow(RLS);
    await expect(insertItem(h, aMeal, 9)).rejects.toThrow(RLS);
    expect((await prisma.savedMeal.findUniqueOrThrow({ where: { id: aMeal } })).name).toBe('Usual breakfast');
  });

  it('an API caller with no user reads nothing, and anon has no table access', async () => {
    for (const [table, id] of rowsOfA()) await zeroAfter(a, '', table, id);
    await expect(prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE anon');
      await tx.$queryRawUnsafe('SELECT count(*) FROM public."SavedMeal"');
    })).rejects.toThrow(/permission denied/);
  });

  it("the Data API with only the client's own JWT (no app context) reads none of the rows and writes none", async () => {
    const jwtA = `jwt:${a}`;
    for (const [table, id] of rowsOfA()) {
      await zeroAfter(a, jwtA, table, id);
      await zeroAfter(a, jwtA, table, id, `UPDATE public."${table}" SET "id" = "id" WHERE "id" = $1`);
      await zeroAfter(a, jwtA, table, id, `DELETE FROM public."${table}" WHERE "id" = $1`);
    }
    await expect(insertFavorite(jwtA, a, banana)).rejects.toThrow(RLS);
    await expect(insertMeal(jwtA, a)).rejects.toThrow(RLS);
    await expect(insertItem(jwtA, aMeal, 9)).rejects.toThrow(RLS);
    for (const [table, id] of rowsOfA()) expect(await seen(a, table, id)).toBe(1);
  });

  it('logging a saved meal writes one ordinary entry per food, same slot and time, totalled like single logs', async () => {
    const entries = await saved.logSavedMeal(a, aMeal, { date: '2026-10-01', meal_type: 'breakfast' });
    expect(entries.map((e) => [e.food_item_id, e.quantity_multiplier, e.original_quantity, e.original_unit])).toEqual([
      [oats, 0.5, 50, 'g'], [banana, 1.2, null, null],
    ]);
    expect(new Set(entries.map((e) => `${e.user_id} ${e.meal_type} ${e.logged_at.toISOString()}`)).size).toBe(1);
    expect(entries[0].user_id).toBe(a);
    await log.logFood(a, { date: '2026-10-02', meal_type: 'breakfast', food_item_id: oats, quantity_multiplier: 0.5 });
    await log.logFood(a, { date: '2026-10-02', meal_type: 'breakfast', food_item_id: banana, quantity_multiplier: 1.2 });
    const [fromMeal, single] = await Promise.all([log.getDaily(a, '2026-10-01'), log.getDaily(a, '2026-10-02')]);
    expect(fromMeal.entries).toHaveLength(2);
    const totals = (d: typeof single) => [d.total_calories, d.total_protein_g, d.total_carbs_g, d.total_fat_g];
    expect(totals(fromMeal)).toEqual(totals(single));
    expect(fromMeal.total_calories).toBe(Math.round(380 * 0.5 + 89 * 1.2));
  });

  it('a retry with the same key returns the same entries and writes nothing; another client cannot reuse the key', async () => {
    const key = randomUUID();
    const first = await saved.logSavedMeal(a, aMeal, { date: '2026-10-03', meal_type: 'snack', client_uuid: key });
    const again = await saved.logSavedMeal(a, aMeal, { date: '2026-10-03', meal_type: 'snack', client_uuid: key });
    expect(again.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(first.map((e) => e.client_uuid)).toEqual([`${key}:0`, `${key}:1`]);
    expect(await prisma.loggedFoodEntry.count({ where: { user_id: a, date: new Date('2026-10-03') } })).toBe(2);
    const bMeal = (await saved.listSavedMeals(b))[0].id;
    await expect(saved.logSavedMeal(b, bMeal, { date: '2026-10-03', meal_type: 'snack', client_uuid: key }))
      .rejects.toThrow(NotFoundException);
    expect(await prisma.loggedFoodEntry.count({ where: { user_id: b } })).toBe(0);
  });

  it("another client cannot list, rename, log or delete the client's meal or favourites", async () => {
    expect((await saved.listSavedMeals(a)).map((m) => m.id)).toEqual([aMeal]);
    expect((await saved.listSavedMeals(b)).map((m) => m.id)).not.toContain(aMeal);
    expect((await saved.listFavorites(b)).map((f) => f.id)).not.toContain(aFav);
    await expect(saved.renameSavedMeal(b, aMeal, 'Mine now')).rejects.toThrow(NotFoundException);
    await expect(saved.logSavedMeal(b, aMeal, { date: '2026-10-04', meal_type: 'lunch' })).rejects.toThrow(NotFoundException);
    await expect(saved.deleteSavedMeal(b, aMeal)).rejects.toThrow(NotFoundException);
    expect(await saved.removeFavorite(b, oats)).toEqual({ removed: false });
    expect(await prisma.foodFavorite.count({ where: { id: aFav } })).toBe(1);
    // A custom food is private to its creator: nobody else can favourite or save it.
    await expect(saved.addFavorite(b, aCustom)).rejects.toThrow(NotFoundException);
    await expect(saved.createSavedMeal(b, { name: 'Copy', items: [{ food_item_id: aCustom }] })).rejects.toThrow(NotFoundException);
    expect((await saved.addFavorite(a, aCustom)).food_item.id).toBe(aCustom);
  });

  it('favourites are idempotent; rename keeps the items; delete takes the items and leaves logged entries', async () => {
    expect((await saved.addFavorite(a, oats)).id).toBe(aFav);
    const renamed = await saved.renameSavedMeal(a, aMeal, ' Sunday breakfast ');
    expect([renamed.name, renamed.items.map((i) => i.position)]).toEqual(['Sunday breakfast', [0, 1]]);
    expect(await saved.removeFavorite(a, oats)).toEqual({ removed: true });
    expect(await saved.removeFavorite(a, oats)).toEqual({ removed: false });
    const logged = await prisma.loggedFoodEntry.count({ where: { user_id: a } });
    expect(await prisma.savedMealItem.count({ where: { saved_meal_id: aMeal } })).toBe(2);
    expect(await saved.deleteSavedMeal(a, aMeal)).toEqual({ deleted: true });
    expect(await prisma.savedMealItem.count({ where: { saved_meal_id: aMeal } })).toBe(0);
    expect(await prisma.loggedFoodEntry.count({ where: { user_id: a } })).toBe(logged);
  });

  it(`limits: ${FAVORITES_MAX} favourites, ${SAVED_MEALS_MAX} saved meals, 30 foods a meal`, async () => {
    const foods = Array.from({ length: FAVORITES_MAX + 1 }, () => randomUUID());
    await prisma.foodItem.createMany({ data: foods.map((id) => ({ id, name: 'RLS filler', serving_description: '1',
      serving_size_grams: 1, calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0 })) });
    await prisma.foodFavorite.createMany({ data: foods.slice(0, FAVORITES_MAX).map((food_item_id) => ({ user_id: c, food_item_id })) });
    await expect(saved.addFavorite(c, foods[FAVORITES_MAX])).rejects.toThrow(ConflictException);
    expect((await saved.addFavorite(c, foods[0])).food_item_id).toBe(foods[0]);
    await prisma.savedMeal.createMany({ data: Array.from({ length: SAVED_MEALS_MAX }, () => ({ user_id: c, name: 'Filler' })) });
    await expect(saved.createSavedMeal(c, { name: 'One more', items: [{ food_item_id: oats }] })).rejects.toThrow(ConflictException);
    expect(await prisma.savedMeal.count({ where: { user_id: c } })).toBe(SAVED_MEALS_MAX);
    const meal = (n: number, name = 'Big plate') =>
      validate(plainToInstance(CreateSavedMealDto, { name, items: Array.from({ length: n }, () => ({ food_item_id: oats })) }));
    expect(await meal(30)).toEqual([]);
    expect((await meal(31)).map((e) => e.property)).toEqual(['items']);
    expect((await meal(0)).map((e) => e.property)).toEqual(['items']);
    expect((await meal(1, '   ')).map((e) => e.property)).toEqual(['name']);
  });

  it('a former coach reads nothing once the client moves; the new coach reads the history', async () => {
    const meal = await saved.createSavedMeal(a, { name: 'Moved meal', items: [{ food_item_id: oats }] });
    const moved: Array<[string, string]> = [
      ['FoodFavorite', (await saved.addFavorite(a, banana)).id], ['SavedMeal', meal.id], ['SavedMealItem', meal.items[0].id]];
    for (const [table, id] of moved) expect(await seen(h, table, id)).toBe(1);
    await prisma.user.update({ where: { id: a }, data: { coach_id: k } });
    for (const [table, id] of moved) {
      await zeroAfter(a, h, table, id);
      expect(await seen(k, table, id)).toBe(1);
    }
  });

  it("a client's data download holds their own favourites and saved meals, items in order; erasure takes the same rows", async () => {
    const exporter = new DataExportService(prisma);
    const build = Reflect.get(exporter, '_buildArchive') as (u: string, e: string) => Promise<{ buffer: Buffer }>;
    const download = async (who: string): Promise<Record<string, Array<Record<string, unknown>>>> =>
      JSON.parse((await build.call(exporter, who, randomUUID())).buffer.toString('utf8'));
    const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => String(r.id)).sort();
    const exported = (d: Record<string, Array<Record<string, unknown>>>) =>
      ({ favs: ids(d.food_favorites), meals: ids(d.saved_meals), items: ids(d.saved_meal_items) });
    const rowsOf = async (who: string) => {
      const meals = await prisma.savedMeal.findMany({ where: { user_id: who }, include: { items: true } });
      const favs = await prisma.foodFavorite.findMany({ where: { user_id: who } });
      return { favs: ids(favs), meals: ids(meals), items: ids(meals.flatMap((m) => m.items)) };
    };
    const plate = await saved.createSavedMeal(a, { name: 'Export plate',
      items: [oats, banana, aCustom].map((food_item_id, n) => ({ food_item_id, quantity_multiplier: n + 1 })) });
    await saved.addFavorite(b, oats);
    const [aRows, bRows] = [await rowsOf(a), await rowsOf(b)];
    expect([aRows.favs.length, aRows.meals.length, aRows.items.length, bRows.favs.length, bRows.items.length]).toEqual([2, 2, 4, 1, 1]);
    const [aDownload, bDownload, kDownload] = [await download(a), await download(b), await download(k)];
    // Each client's download holds exactly their own rows; a coach's never holds a client's (k coaches both now).
    expect(exported(aDownload)).toEqual(aRows);
    expect(exported(bDownload)).toEqual(bRows);
    expect(exported(kDownload)).toEqual({ favs: [], meals: [], items: [] });
    expect(aDownload.saved_meals).toContainEqual(expect.objectContaining({ id: plate.id, name: 'Export plate', user_id: a }));
    expect(aDownload.saved_meal_items.filter((i) => i.saved_meal_id === plate.id)
      .map((i) => [i.food_item_id, i.quantity_multiplier, i.position])).toEqual([[oats, 1, 0], [banana, 2, 1], [aCustom, 3, 2]]);
    // Account deletion erases exactly what the download carried: all of A's rows, none of B's.
    const foodSteps = ERASURE_MANIFEST.filter((e) => e.model === 'FoodFavorite' || e.model === 'SavedMeal');
    expect(foodSteps.map((e) => [e.model, e.field, e.action.op]))
      .toEqual([['FoodFavorite', 'user_id', 'delete'], ['SavedMeal', 'user_id', 'delete']]);
    await prisma.$transaction((tx: Prisma.TransactionClient) => executeErasureManifest(tx,
      { userId: a, email: `${a}@example.test`, tombstoneEmail: `${randomUUID()}@example.test`, now: new Date() }, foodSteps));
    expect(await rowsOf(a)).toEqual({ favs: [], meals: [], items: [] });
    expect(exported(await download(a))).toEqual({ favs: [], meals: [], items: [] });
    expect(await rowsOf(b)).toEqual(bRows);
  });
});
