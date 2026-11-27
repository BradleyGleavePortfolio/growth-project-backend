/**
 * SAVED-FOODS-TRUTH-BE (#ALM-E19, V1_1_MUST_DO 21.33): the Kitchen reads her saved meals and favourites, so each item
 * says what the check POST /log/food runs reads from its stored food (`food_truth`: 'ok', 'held', 'legacy_zero'),
 * no item is left out, and another person's rows are never returned. The real SavedFoodsService and FoodService run
 * over an in-memory store that answers by the query's user_id. The live half (a food deleted from the catalog, the
 * row rules on a real database) is in test/rls/food-saved-rls.spec.ts.
 */
import { FoodService } from '../src/food/food.service';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import type { StoredFoodTruth } from '../src/food/food-truth';
import type { PrismaService } from '../src/prisma.service';
import { carbsFor, fatFor, offNutrimentsFor } from './support/food-true-numbers';

function stub<T>(value: unknown): T {
  return value as T;
}

const VIEWER = 'viewer-client';
const OTHER = 'other-client';

/** A stored food: 200 kcal per 100 g made of carbs and fat (numbers that can be true), 0 g protein. */
const food = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Food ${id}`, brand_or_restaurant: null, category: 'generic', serving_description: '100 g',
  serving_size_grams: 100, nutrient_basis: 'PER_100G', calories: 200, protein_g: 0, carbs_g: carbsFor(200),
  fat_g: fatFor(200), fiber_g: null, tags: [] as string[], search_aliases: [], image_url: null, barcode: null,
  created_by_user_id: null as string | null, created_at: new Date('2026-01-01'), ...over,
});
const impossible = { calories: 500, carbs_g: 1, fat_g: 1 };

// name | stored food | food_truth on both lists | POST /log/food when its source lists nothing (404), except row 10
const TABLE: Array<[string, ReturnType<typeof food>, StoredFoodTruth, 'logs' | 'refused']> = [
  ['1 a good shared food', food('good'), 'ok', 'logs'],
  ['2 a packaged food checked on import (0 g protein listed)', food('checked-off', { tags: ['off:111', 'truth:checked'] }), 'ok', 'logs'],
  ['3 a basic USDA food (its missing macro reads 0 g)', food('basic-usda', { tags: ['usda:666', 'basic-food'] }), 'ok', 'logs'],
  ['4 her own food, whatever its numbers', food('own', { created_by_user_id: VIEWER, calories: 5000 }), 'ok', 'logs'],
  ['5 a held food: numbers that cannot be true', food('held', impossible), 'held', 'refused'],
  ['6 a held packaged food its source does not confirm', food('held-off', { tags: ['off:222'], ...impossible }), 'held', 'refused'],
  ['7 a legacy-zero Open Food Facts row', food('zero-off', { tags: ['off:333'] }), 'legacy_zero', 'refused'],
  ['8 a legacy-zero USDA Branded row', food('zero-usda', { tags: ['usda:444'] }), 'legacy_zero', 'refused'],
  ['9 a legacy-zero scanned barcode row', food('zero-barcode', { barcode: '555' }), 'legacy_zero', 'refused'],
  // The list never asks the source (200 favourites would be 200 calls): a 0 its source confirms still reads
  // 'legacy_zero' on the list, and POST /log/food logs it after reading the source.
  ['10 a legacy-zero row its source confirms when logged', food('zero-confirmed', { tags: ['off:777'] }), 'legacy_zero', 'logs'],
];
const FOODS = TABLE.map(([, row]) => row);
const EXPECTED = TABLE.map(([, row, truth]) => [row.id, truth]);

/** The store: VIEWER favourites every food and has one meal of all of them; OTHER has a favourite and a meal too. */
function world() {
  const foods = new Map(FOODS.map((row) => [row.id, row]));
  const withFood = <T extends { food_item_id: string }>(row: T) => ({ ...row, food_item: foods.get(row.food_item_id) });
  const favorite = (user_id: string, food_item_id: string, n: number) =>
    ({ id: `fav-${user_id}-${n}`, user_id, food_item_id, created_at: new Date(Date.UTC(2026, 10, 30 - n)) });
  const favorites = [...FOODS.map((row, n) => favorite(VIEWER, row.id, n)), favorite(OTHER, 'good', 0), favorite(OTHER, 'held', 1)];
  const meal = (id: string, user_id: string, ids: string[]) => ({
    id, user_id, name: `Meal ${id}`, created_at: new Date('2026-11-01'), updated_at: new Date('2026-11-01'),
    items: ids.map((food_item_id, position) => ({
      id: `${id}-item-${position}`, saved_meal_id: id, food_item_id, quantity_multiplier: 1,
      original_quantity: null, original_unit: null, position,
    })),
  });
  const meals = [meal('mine', VIEWER, FOODS.map((row) => row.id)), meal('theirs', OTHER, ['good', 'zero-off'])];
  const mealOut = (m: (typeof meals)[number]) => ({ ...m, items: m.items.map(withFood) });
  const prisma = {
    foodItem: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => foods.get(where.id) ?? null) },
    foodFavorite: {
      findMany: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        favorites.filter((f) => f.user_id === where.user_id).map(withFood)),
      findUnique: jest.fn(async ({ where }: { where: { user_id_food_item_id: { user_id: string; food_item_id: string } } }) => {
        const key = where.user_id_food_item_id;
        const row = favorites.find((f) => f.user_id === key.user_id && f.food_item_id === key.food_item_id);
        return row ? withFood(row) : null;
      }),
    },
    savedMeal: {
      findMany: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        meals.filter((m) => m.user_id === where.user_id).map(mealOut)),
      findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => {
        const row = meals.find((m) => m.id === where.id && m.user_id === where.user_id);
        return row ? mealOut(row) : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { name: string } }) =>
        mealOut({ ...meals.find((m) => m.id === where.id)!, name: data.name })),
      count: jest.fn(async () => 1),
      create: jest.fn(async ({ data }: { data: { user_id: string; name: string; items: { createMany: { data: Array<{ food_item_id: string }> } } } }) =>
        mealOut({ ...meal('new', data.user_id, data.items.createMany.data.map((i) => i.food_item_id)), name: data.name })),
    },
  };
  const foodService = new FoodService(stub<PrismaService>(prisma));
  const saved = new SavedFoodsService(stub<PrismaService>(prisma), foodService, stub({ capture: jest.fn() }),
    stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }));
  return { prisma, foodService, saved, foods };
}

type Item = { food_item_id: string; food_truth: StoredFoodTruth; food_item: unknown };
const LISTS: Array<[string, (s: SavedFoodsService, who: string) => Promise<Item[]>]> = [
  ['GET /me/foods/favorites', (s, who) => s.listFavorites(who) as Promise<Item[]>],
  ['GET /me/foods/saved-meals', async (s, who) => (await s.listSavedMeals(who)).flatMap((m) => m.items as Item[])],
];

describe('SAVED-FOODS-TRUTH-BE: saved meals and favourites run the food truth check', () => {
  const usdaKey = process.env.USDA_API_KEY;
  let fetched: string[] = [];

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-usda-key';
    fetched = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      fetched.push(String(url));
      if (!String(url).includes('/product/777.json')) return stub<Response>({ ok: false, status: 404, json: async () => ({}) });
      const product = { code: '777', product_name: 'Food zero-confirmed', nutriments: offNutrimentsFor(200) };
      return stub<Response>({ ok: true, status: 200, json: async () => ({ product }) });
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (usdaKey === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = usdaKey;
  });

  describe.each(LISTS)('%s', (_route, read) => {
    it('marks every item with its food_truth, in order, leaves none out and changes no number', async () => {
      const w = world();
      const items = await read(w.saved, VIEWER);
      expect(items.map((i) => [i.food_item_id, i.food_truth])).toEqual(EXPECTED);
      for (const item of items) expect(item.food_item).toEqual(w.foods.get(item.food_item_id));
      expect(fetched).toEqual([]);
    });

    it("never returns another person's rows: the query asks for the signed-in client's rows only", async () => {
      const w = world();
      const theirs = await read(w.saved, OTHER);
      expect(theirs.length).toBeGreaterThan(0);
      const mine = await read(w.saved, VIEWER);
      expect(mine).toHaveLength(FOODS.length);
      const asked = [...w.prisma.foodFavorite.findMany.mock.calls, ...w.prisma.savedMeal.findMany.mock.calls]
        .map(([q]) => (q as { where: unknown }).where);
      expect(asked).toEqual([{ user_id: OTHER }, { user_id: VIEWER }]);
    });
  });

  it.each(TABLE)("%s: the list's food_truth is POST /log/food's own first step", async (_name, row, truth, log) => {
    const w = world();
    // 'ok' is exactly the foods POST /log/food logs without asking the source; any other state asks or refuses.
    expect(w.foodService.storedTruth(row as never)).toBe(truth);
    const logged = w.foodService.resolveOrImportId(row.id, VIEWER);
    if (log === 'logs') await expect(logged).resolves.toBe(row.id);
    else await expect(logged).rejects.toThrow(/not found/i);
    if (truth === 'ok') expect(fetched).toEqual([]);
  });

  it('the answers to POST /me/foods/favorites, POST /me/foods/saved-meals and PATCH carry the same field', async () => {
    const w = world();
    const favourite = await w.saved.addFavorite(VIEWER, 'zero-confirmed');
    expect([favourite.food_item_id, favourite.food_truth]).toEqual(['zero-confirmed', 'legacy_zero']);
    const created = await w.saved.createSavedMeal(VIEWER, { name: ' Lunch ', items: [
      { food_item_id: 'good' }, { food_item_id: 'own' }, { food_item_id: 'zero-confirmed' }] });
    expect(created.items.map((i) => [i.food_item_id, i.food_truth])).toEqual([
      ['good', 'ok'], ['own', 'ok'], ['zero-confirmed', 'legacy_zero']]);
    const renamed = await w.saved.renameSavedMeal(VIEWER, 'mine', 'Usual');
    expect(renamed.items.map((i) => [i.food_item_id, i.food_truth])).toEqual(EXPECTED);
  });
});
