/**
 * FR-1198 (fix round 1 of b#1198), class-first tests written by agent 190 on
 * top of the auditors' B-TESTs. Each block covers a second member of a class
 * the audits found one member of:
 *   F1 ranking (LS-1198 B1, LO-1198 B1): a row named for the food comes before
 *      a basic row that only mentions it, for words other than "oatmeal".
 *   F1b plain form (LO-1198 C3): "whole grain" / "whole milk" is not the plain
 *      form of a food.
 *   F2 portions (LO-1198 B2): a mixed category is not a cup weight; a food with
 *      its own household measure keeps its cup; a dry form of a liquid does not
 *      take the liquid's weight.
 *   F3 identity (LS-1198 B2): two custom foods that differ only in macros both
 *      show; a stored USDA import still meets its upstream row.
 *   F4 save race (LO-1198 C1): the losing insert of two saves with one key
 *      answers with the stored entry.
 * Names are USDA-style test names, not claimed FDC records.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import { volumeWeightsFor } from '../src/food/food-density';
import { LogService } from '../src/log/log.service';
import type { FoodService as FoodServiceType } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import type { LogFoodDto } from '../src/log/log.dto';

function stub<T>(value: unknown): T {
  return value as T;
}

type Usda = {
  fdcId: number;
  description: string;
  dataType: string;
  foodCategory: string;
  brandOwner?: string;
  householdServingFullText?: string;
  servingSize?: number;
  foodNutrients: Array<{ nutrientName: string; unitName: string; value: number }>;
};

let fdc = 900000;
const usda = (description: string, dataType: string, extra: Partial<Usda> = {}): Usda => ({
  fdcId: ++fdc, description, dataType, foodCategory: 'Test category',
  foodNutrients: [{ nutrientName: 'Energy', unitName: 'KCAL', value: 100 + (fdc % 50) }],
  ...extra,
});

const env = process.env.USDA_API_KEY;
beforeEach(() => {
  process.env.USDA_API_KEY = 'fixture-only';
});
afterEach(() => {
  jest.restoreAllMocks();
  if (env === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = env;
});

function answering(foods: Usda[]) {
  jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
    stub<Response>({
      ok: true,
      status: 200,
      json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods } : { products: [] }),
    }),
  );
}

const searchService = (local: unknown[] = []) =>
  new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue(local) }));

describe('F1: a row named for the food comes before a basic row that only mentions it', () => {
  it.each([
    // [query, rows in USDA answer order, expected first row]
    ['apple', [usda('Pie, apple, commercially prepared', 'SR Legacy'), usda('Apple, raw', 'Survey (FNDDS)')], 'Apple, raw'],
    ['banana', [usda('Bread, banana, prepared from recipe', 'SR Legacy'), usda('Banana, raw', 'Survey (FNDDS)')], 'Banana, raw'],
    ['rice', [usda('Crackers, rice', 'SR Legacy'), usda('Rice, white, cooked', 'Survey (FNDDS)')], 'Rice, white, cooked'],
    ['salmon', [usda('Salad, salmon', 'SR Legacy'), usda('Salmon, baked or broiled', 'Survey (FNDDS)')], 'Salmon, baked or broiled'],
    // Controls: a basic plain row still leads; a branded exact name stays below
    // an unbranded basic row (owner ruling R3).
    ['salmon', [usda('SALMON', 'Branded', { brandOwner: 'Acme' }), usda('Fish, salmon, Atlantic, wild, raw', 'SR Legacy')], 'Fish, salmon, Atlantic, wild, raw'],
    ['milk', [usda('Milk, NFS', 'Survey (FNDDS)'), usda('Milk, whole, 3.25% milkfat', 'SR Legacy')], 'Milk, whole, 3.25% milkfat'],
    ['eggs', [usda('EGGS', 'Branded', { brandOwner: 'Acme' }), usda('Egg, whole, raw, fresh', 'SR Legacy')], 'Egg, whole, raw, fresh'],
  ])('%s', async (query, foods, first) => {
    answering(foods as Usda[]);
    const service = searchService();
    const fresh = await service.search(query as string, 50, 'viewer');
    const cached = await service.search(query as string, 50, 'viewer');
    expect(fresh.results[0].name).toBe(first);
    expect(cached.results.map((r) => r.id)).toEqual(fresh.results.map((r) => r.id));
  });
});

describe('F1b: "whole grain" and "whole milk" are not the plain form', () => {
  it.each([
    // Same match score and source: the plain form, then the shorter name, decides.
    ['oats', ['Oats, whole grain, rolled', 'Oats, steel cut'], 'Oats, steel cut'],
    ['greek yogurt', ['Greek yogurt, plain, whole milk', 'Greek yogurt, plain'], 'Greek yogurt, plain'],
    // Controls: "Milk, whole" and "egg whole" are still the plain form.
    ['milk', ['Milk, 2% milkfat', 'Milk, whole, 3.25%'], 'Milk, whole, 3.25%'],
    ['eggs', ['Eggs, Grade A, Large, egg yolk', 'Eggs, Grade A, Large, egg whole'], 'Eggs, Grade A, Large, egg whole'],
  ])('%s', async (query, names, first) => {
    answering((names as string[]).map((n) => usda(n, 'Foundation')));
    const { results } = await searchService().search(query as string, 50, 'viewer');
    expect(results[0].name).toBe(first);
  });
});

describe('F2: a cup weight comes from the food or from a one-density category', () => {
  it.each([
    // [name, own measure, grams, category, cup grams or null]
    ['Oats, whole grain, rolled, old fashioned', '100\u00a0g', 100, 'Cereal Grains and Pasta', null],
    ['Oatmeal, NFS', '100\u00a0g', 100, 'Oatmeal', null],
    ['Peanut butter, smooth style', '100\u00a0g', 100, 'Nut and Seed Products', null],
    ['Peanut butter, smooth', '100\u00a0g', 100, 'Nuts and seeds', null],
    ['Cheese, cheddar', '100\u00a0g', 100, 'Dairy and Egg Products', null],
    ['Orange juice, raw', '100\u00a0g', 100, 'Fruits and Fruit Juices', null],
    ['Chicken breast, raw, skinless', '4 oz (113g)', 113, 'Poultry Products', null],
    ['Burger', '100g', 100, 'fast_food', null],
    // Own household measure wins over any category.
    ['Oats, rolled, dry', '1/2 cup dry (40g)', 40, 'Cereal Grains and Pasta', 80],
    ['Peanut butter, smooth', '2 tbsp (32g)', 32, 'Nut and Seed Products', 256],
    // One-density categories keep their value; a dry form inside them does not.
    ['Oil, olive, salad or cooking', '100\u00a0g', 100, 'Fats and Oils', 220.8],
    ['Soup, chicken noodle, canned, ready-to-serve', '100\u00a0g', 100, 'Soups, Sauces, and Gravies', 252],
    ['Soup, chicken noodle, dry, mix', '100\u00a0g', 100, 'Soups, Sauces, and Gravies', null],
    ['Beverages, coffee, instant, powder', '100\u00a0g', 100, 'Beverages', null],
    ['Beverages, coffee, brewed', '100\u00a0g', 100, 'Beverages', 240],
  ])('%s (%s, %s) -> cup %s', (name, measure, grams, category, cup) => {
    // The fourth argument (the food's name) is new in FR-1198.
    const weigh = stub<(m: string, g: number, c: string, n: string) => { cup_grams: number } | null>(volumeWeightsFor);
    expect(weigh(measure as string, grams as number, category as string, name as string)?.cup_grams ?? null).toBe(cup);
  });

  it('the first USDA row for rolled oats offers no 156 g cup, and the stored seed keeps its 80 g cup', async () => {
    answering([usda('Oats, whole grain, rolled, old fashioned', 'Foundation', { foodCategory: 'Cereal Grains and Pasta' })]);
    const { results } = await searchService().search('rolled oats', 50, 'viewer');
    expect(results[0]).toMatchObject({ supports_volume_units: false, cup_grams: undefined });

    const seeds = JSON.parse(readFileSync(join(__dirname, '../prisma/data/seed-foods.json'), 'utf8')) as Array<Record<string, unknown>>;
    const read = async (seedName: string) => {
      const seed = seeds.find((s) => s.name === seedName)!;
      const prisma = {
        foodItem: {
          findUnique: jest.fn().mockResolvedValue({
            ...seed, id: 'seed', created_by_user_id: null, category: 'generic', nutrient_basis: 'PER_100G',
            brand_or_restaurant: null, tags: ['seed:common-foods', `category:${String(seed.food_category)}`],
          }),
        },
      };
      return new FoodService(stub<PrismaService>(prisma)).getById('seed', 'viewer');
    };
    // Own measure "1/2 cup dry (40g)": 80 g a cup.
    expect((await read('Oats, rolled, dry'))?.cup_grams).toBe(80);
    // No own cup measure and a mixed category: no cup (it was 264 g).
    expect(await read('Cheddar cheese')).toMatchObject({ supports_volume_units: false, cup_grams: undefined });
  });
});

describe('F3: a custom food is its own food', () => {
  const custom = (id: string, protein: number) => ({
    id, name: 'Overnight oats', brand_or_restaurant: null, category: 'generic', created_by_user_id: 'viewer',
    serving_description: '1 jar', serving_size_grams: 250, calories: 150, protein_g: protein, carbs_g: 20, fat_g: 4,
    tags: [], search_aliases: [], nutrient_basis: 'PER_100G',
  });

  it('keeps two unbranded custom foods that differ only in macros', async () => {
    answering([]);
    const { results } = await searchService([custom('c-1', 8), custom('c-2', 14)]).search('overnight oats', 50, 'viewer');
    expect(results.map((r) => r.id).sort()).toEqual(['c-1', 'c-2']);
  });

  it('control: one stored row returned twice shows once', async () => {
    answering([]);
    const { results } = await searchService([custom('c-1', 8), custom('c-1', 8)]).search('overnight oats', 50, 'viewer');
    expect(results.map((r) => r.id)).toEqual(['c-1']);
  });

  it('control: a stored USDA import still meets its upstream row', async () => {
    const upstream = usda('Oats, raw', 'Survey (FNDDS)');
    answering([upstream]);
    const stored = {
      ...custom('stored-1', 13), name: 'Oats, raw', created_by_user_id: null, serving_description: '100\u00a0g',
      serving_size_grams: 100, calories: upstream.foodNutrients[0].value, tags: [`usda:${upstream.fdcId}`],
    };
    const { results } = await searchService([stored]).search('oats', 50, 'viewer');
    expect(results.filter((r) => r.name === 'Oats, raw')).toHaveLength(1);
  });
});

describe('F4: two saves with one key at once', () => {
  const food = { id: 'food-1', name: 'Oats', calories: 380 };
  const dto = stub<LogFoodDto>({
    food_item_id: 'food-1', date: '2026-10-31', meal_type: 'breakfast', quantity_multiplier: 1, client_uuid: 'key-1',
  });

  function world(winner: { user_id: string } | null, error: unknown) {
    const loggedFoodEntry = {
      // The first read misses: the other save has not committed yet.
      findUnique: jest.fn().mockResolvedValueOnce(null)
        .mockResolvedValue(winner ? { id: 'entry-1', client_uuid: 'key-1', quantity_multiplier: 1, ...winner, food_item: food } : null),
      upsert: jest.fn().mockRejectedValue(error),
      create: jest.fn().mockRejectedValue(error),
    };
    const analytics = { capture: jest.fn() };
    const ptm = { emit: jest.fn() };
    const aiContext = { invalidateForUser: jest.fn() };
    const foodService = { resolveOrImportId: jest.fn(async (id: string) => id) };
    const log = new LogService(
      stub<PrismaService>({ loggedFoodEntry }), stub<FoodServiceType>(foodService), stub(analytics), stub(ptm), stub(aiContext),
    );
    return { log, signals: () => analytics.capture.mock.calls.length + ptm.emit.mock.calls.length };
  }
  const unique = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  it.each([
    ['the loser answers with the stored entry and sends no second signal', { user_id: 'client-a' }, unique, dto, 'entry-1'],
    ["another person's key reads as not found", { user_id: 'client-b' }, unique, dto, 'Entry not found'],
    ['another error still fails', { user_id: 'client-a' }, new Error('connection lost'), dto, 'connection lost'],
    ['no key: a unique error still fails', null, unique, { ...dto, client_uuid: undefined }, 'Unique constraint failed'],
  ])('%s', async (_label, winner, error, body, outcome) => {
    const { log, signals } = world(winner, error);
    const run = log.logFood('client-a', body as LogFoodDto);
    if (outcome === 'entry-1') await expect(run).resolves.toMatchObject({ id: 'entry-1', user_id: 'client-a' });
    else await expect(run).rejects.toThrow(outcome as string);
    expect(signals()).toBe(0);
  });
});
