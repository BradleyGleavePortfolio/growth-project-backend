/**
 * FR-1198R2 (fix round 2 of b#1198), class-first tests written by agent 191 on
 * top of LS-1198R2's B-TEST (test/ls-1198r2-prefix-dishes.spec.ts).
 *
 * The class (LS-1198R2 B1, LO-1198R2 C1): a dish named for its first
 * ingredient is not the plain food. A row names the food when the food is its
 * whole head ("Oatmeal, NFS"), or when it follows USDA's group-first form
 * "<Group>, <food>, <form>" ("Fish, sardine, ...", "Beans, black, ...",
 * "Cheese, cheddar"). A head that only begins with the food and goes on to
 * another dish word ("Black bean soup", "Tuna salad") is a mention and ranks
 * after the rows that name it. Each block is one path of the class:
 *   G1 a second group-first USDA form (Beans, Cheese), source only;
 *   G2 a shared local catalog dish named for its first ingredient;
 *   G3 an Open Food Facts dish named for its first ingredient (search row and
 *      stored import: always branded, never "named"; a control);
 *   G4 a source-only search (no local row at all);
 *   G5 controls: a whole-head row still leads a group-first row; a two-word
 *      group ("Fish oil, salmon") and a group-first dish ("Fish, salmon cake
 *      or patty") are mentions; oatmeal before "Bread, oatmeal";
 *   G6 reversed words: a head of the query words in another order names the
 *      food, so a built-in food keeps its lead (red at the first fix commit).
 * Names are USDA-style test names, not claimed FDC records.
 */
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import { usdaNutrientsFor, offNutrimentsFor } from './support/food-true-numbers';

const stub = <T>(value: unknown): T => value as T;

type Usda = {
  fdcId: number;
  description: string;
  dataType: string;
  foodCategory: string;
  brandOwner?: string;
  foodNutrients: Array<{ nutrientName: string; unitName: string; value: number }>;
};
type Off = { code: string; product_name: string; brands?: string; nutriments: Record<string, number> };

let fdc = 950000;
const usda = (description: string, dataType: string): Usda => ({
  fdcId: ++fdc, description, dataType, foodCategory: 'Test category',
  foodNutrients: usdaNutrientsFor(100 + (fdc % 50)),
});
const off = (code: string, product_name: string, brands?: string): Off => ({
  code, product_name, brands, nutriments: offNutrimentsFor(210),
});
const catalogRow = (id: string, name: string, tags: string[] = []) => ({
  id, name, brand_or_restaurant: null, category: 'generic', created_by_user_id: null,
  serving_description: '100\u00a0g', serving_size_grams: 100, calories: 190,
  protein_g: 10, carbs_g: 5, fat_g: 12, nutrient_basis: 'PER_100G', search_aliases: [], tags,
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

/** Real FoodService search over stubbed transports; the shared local catalog answers `local`. */
function world(foods: Usda[], products: Off[] = [], local: unknown[] = []) {
  jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
    stub<Response>({
      ok: true,
      status: 200,
      json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods } : { products }),
    }),
  );
  return new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue(local) }));
}

async function freshAndCached(service: FoodService, query: string) {
  const fresh = await service.search(query, 50, 'viewer');
  const cached = await service.search(query, 50, 'viewer');
  expect(cached.results.map((r) => r.id)).toEqual(fresh.results.map((r) => r.id));
  return fresh.results;
}

describe('G1: a second group-first USDA form names the food (source only)', () => {
  it.each([
    // [query, rows in USDA answer order, expected first row]
    ['black beans', [usda('Black bean soup', 'Survey (FNDDS)'), usda('Black bean salad', 'Survey (FNDDS)'),
      usda('Beans, black, mature seeds, cooked, boiled, without salt', 'SR Legacy')],
    'Beans, black, mature seeds, cooked, boiled, without salt'],
    ['cheddar', [usda('Cheddar cheese soup', 'Survey (FNDDS)'), usda('Cheese, cheddar', 'SR Legacy')], 'Cheese, cheddar'],
    ['cheddar cheese', [usda('Cheddar cheese soup', 'Survey (FNDDS)'), usda('Cheese, cheddar', 'Survey (FNDDS)')],
      'Cheese, cheddar'],
  ])('%s', async (query, foods, first) => {
    const results = await freshAndCached(world(foods as Usda[]), query as string);
    expect(results.map((r) => r.name)).toContain(first);
    expect(results[0].name).toBe(first);
  });
});

describe('G2: a shared local catalog dish named for its first ingredient', () => {
  it('a catalog "Salmon salad" does not lead an available plain salmon', async () => {
    const service = world([usda('Fish, salmon, chinook, raw', 'SR Legacy')], [], [catalogRow('cat-1', 'Salmon salad')]);
    const results = await freshAndCached(service, 'salmon');
    expect(results.map((r) => r.id)).toContain('cat-1');
    expect(results[0].name).toBe('Fish, salmon, chinook, raw');
  });

  it('control: a catalog row whose whole head is the food still leads', async () => {
    const service = world(
      [usda('Fish, salmon, chinook, raw', 'SR Legacy')],
      [],
      [catalogRow('cat-2', 'Salmon, Atlantic, cooked', ['seed:common-foods'])],
    );
    expect((await freshAndCached(service, 'salmon'))[0].id).toBe('cat-2');
  });
});

describe('G3: Open Food Facts dishes named for their first ingredient (control: branded, never named)', () => {
  it('an Open Food Facts "Sardine spread" with no brand stays below the plain USDA row', async () => {
    const service = world(
      [usda('Fish, sardine, Atlantic, canned in oil, drained solids with bone', 'SR Legacy')],
      [off('3017620422003', 'Sardine spread'), off('3017620422004', 'Sardines', 'Acme')],
    );
    const results = await freshAndCached(service, 'sardines');
    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(['off_3017620422003', 'off_3017620422004']));
    expect(results[0].name).toBe('Fish, sardine, Atlantic, canned in oil, drained solids with bone');
  });

  it('a stored Open Food Facts import (off: tag) stays below the plain USDA row', async () => {
    const service = world(
      [usda('Fish, tuna, light, canned in water, drained solids', 'SR Legacy')],
      [],
      [catalogRow('stored-off', 'Tuna salad', ['off:3017620422005'])],
    );
    const results = await freshAndCached(service, 'tuna');
    expect(results.map((r) => r.id)).toContain('stored-off');
    expect(results[0].name).toBe('Fish, tuna, light, canned in water, drained solids');
  });
});

describe('G4: a source-only search (no local row)', () => {
  it('tuna: canned tuna before tuna salad and tuna noodle casserole', async () => {
    const service = world([
      usda('Tuna salad', 'Survey (FNDDS)'),
      usda('Tuna noodle casserole', 'Survey (FNDDS)'),
      usda('Fish, tuna, light, canned in water, drained solids', 'SR Legacy'),
    ]);
    expect((await freshAndCached(service, 'tuna'))[0].name).toBe('Fish, tuna, light, canned in water, drained solids');
  });
});

describe('G5: controls', () => {
  it.each([
    // A whole head beats a group-first row of a basic food.
    ['oatmeal', [usda('Bread, oatmeal', 'SR Legacy'), usda('Oatmeal, NFS', 'Survey (FNDDS)')], 'Oatmeal, NFS'],
    ['apple', [usda('Pie, apple, commercially prepared', 'SR Legacy'), usda('Apple, raw', 'Survey (FNDDS)')], 'Apple, raw'],
    // A two-word group is an ingredient mention, not the group-first form.
    ['salmon', [usda('Fish oil, salmon', 'SR Legacy'), usda('Fish, salmon, raw', 'Survey (FNDDS)')], 'Fish, salmon, raw'],
    // A group-first dish ("salmon cake or patty") is a mention.
    ['salmon', [usda('Fish, salmon cake or patty', 'SR Legacy'), usda('Fish, salmon, raw', 'Survey (FNDDS)')],
      'Fish, salmon, raw'],
    // Reversed words still find the group-first row.
    ['yogurt greek', [usda('Greek yogurt with fruit', 'Survey (FNDDS)'), usda('Yogurt, Greek, plain, lowfat', 'Survey (FNDDS)')],
      'Yogurt, Greek, plain, lowfat'],
  ])('%s', async (query, foods, first) => {
    expect((await freshAndCached(world(foods as Usda[]), query as string))[0].name).toBe(first);
  });
});

describe('G6: a head of the query words in another order names the food', () => {
  it('yogurt greek: the built-in "Greek yogurt" still leads the USDA group-first row', async () => {
    const service = world(
      [usda('Yogurt, Greek, plain, lowfat', 'Survey (FNDDS)')],
      [],
      [catalogRow('seed-greek', 'Greek yogurt, plain, nonfat', ['seed:common-foods'])],
    );
    expect((await freshAndCached(service, 'yogurt greek'))[0].id).toBe('seed-greek');
  });
});
