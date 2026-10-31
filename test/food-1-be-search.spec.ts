/**
 * FOOD-1-BE search, class-first:
 *  R3 — on a plain query the plain food comes first: a whole-word match of a
 *       basic food (USDA Foundation / SR Legacy, the seeded catalog) above
 *       branded items and partial matches; branded never above a plain food
 *       that matches; a brand query still finds its brand first.
 *  R4 — the one search-answer cache (Redis or the in-memory fallback, key
 *       food:search:v2:<query>) keeps no answer from a search where an
 *       upstream failed or timed out; a real answer, even empty, is kept.
 *  R5 — one food per identity (name + brand + calories + barcode / USDA id),
 *       so same-name foods of other brands, barcodes or calories stay.
 */
import { Prisma } from '@prisma/client';
import { FoodService, FoodResult } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

const kcal = (value: number) => [{ nutrientName: 'Energy', unitName: 'KCAL', value }];
let fdc = 1000;
const basic = (description: string, dataType = 'Foundation') =>
  ({ fdcId: ++fdc, description, dataType, foodCategory: 'Dairy and Egg Products', foodNutrients: kcal(100) });
const survey = (description: string) =>
  ({ fdcId: ++fdc, description, dataType: 'Survey (FNDDS)', foodCategory: 'Mixed Dishes', foodNutrients: kcal(200) });
const branded = (description: string, brandOwner: string, category = 'Candy') =>
  ({ fdcId: ++fdc, description, dataType: 'Branded', brandOwner, foodCategory: category, servingSize: 28, servingSizeUnit: 'g', foodNutrients: kcal(500) });
const product = (code: string, product_name: string, brands: string, kcal100 = 300) =>
  ({ code, product_name, brands, nutriments: { 'energy-kcal_100g': kcal100 } });
const seedRow = (id: string, name: string) => ({
  id, name, brand_or_restaurant: null, category: 'generic', serving_description: '100g', serving_size_grams: 100,
  calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1, fiber_g: null, sugar_g: null, sodium_mg: null,
  tags: ['seed:common-foods'], search_aliases: [], image_url: null, nutrient_basis: 'PER_100G',
});

function setup(opts: { usda?: Row[]; off?: Row[]; local?: Row[] } = {}) {
  // The shared local search answers with the given rows; the caller's own search with none.
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? opts.local ?? [] : []);
  return new FoodService(stub<PrismaService>({ $queryRaw, foodItem: { findMany: jest.fn().mockResolvedValue([]) } }));
}

let fetchSpy: jest.SpyInstance;
const key = process.env.USDA_API_KEY;
beforeEach(() => {
  process.env.USDA_API_KEY = 'test-key';
});
afterEach(() => {
  fetchSpy?.mockRestore();
  process.env.USDA_API_KEY = key;
});

function upstreams(usda: Row[], off: Row[]) {
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
    stub<Response>({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('api.nal.usda.gov') ? { foods: usda } : { products: off }),
    }),
  );
}

const names = (rows: FoodResult[]) => rows.map((r) => r.name);
const isBrand = (r: FoodResult) => !!r.brand_or_restaurant || r.id.startsWith('off_');
const fold = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
/** Every query word is a whole word of the name (worked out here, not by the code under test). */
const hasEveryWord = (name: string, q: string) => {
  const nameWords = name.toLowerCase().split(/[^a-z]+/).map(fold);
  return q.split(' ').every((w) => nameWords.includes(fold(w)));
};

describe('R3: the plain food first on a plain query', () => {
  it.each([
    {
      q: 'eggs',
      usda: [branded('EGGS', 'Mars Chocolate North America LLC'), branded('EGGS', "Pete and Gerry's Organics", 'Eggs & Egg Substitutes'),
        survey('Egg, whole, fried'), basic('Eggplant, raw', 'SR Legacy'), basic('Eggs, Grade A, Large, egg whole')],
      off: [product('1', 'Eggs', 'Kinder')],
      first: 'Eggs, Grade A, Large, egg whole',
    },
    {
      q: 'banana',
      usda: [branded('BANANA', 'Acme Candy'), branded('BANANA CHIPS', 'Acme'), basic('Bananas, dehydrated, or banana powder', 'SR Legacy'), basic('Bananas, raw', 'SR Legacy')],
      off: [product('2', 'Banana', 'Chiquita', 89)],
      first: 'Bananas, raw',
    },
    {
      q: 'greek yogurt',
      usda: [branded('GREEK YOGURT', 'Chobani', 'Yogurt'), basic('Yogurt, Greek, plain, nonfat', 'SR Legacy'), survey('Yogurt, Greek, whole milk, fruit')],
      off: [product('3', 'Greek Yogurt', 'Fage')],
      first: 'Yogurt, Greek, plain, nonfat',
    },
    {
      q: 'rolled oats',
      usda: [branded('ROLLED OATS', 'Quaker', 'Cereal'), basic('Oats, whole grain, rolled, old fashioned')],
      off: [product('4', 'Rolled oats', 'Quaker', 375)],
      first: 'Oats, whole grain, rolled, old fashioned',
    },
    {
      q: 'chicken breast',
      usda: [branded('CHICKEN BREAST', 'Tyson', 'Chicken'), basic('Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw')],
      off: [product('5', 'Chicken breast', 'Perdue')],
      first: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw',
    },
    {
      q: 'rice',
      usda: [branded('RICE', 'Mahatma', 'Rice'), branded('LICORICE', 'Twizzlers'), basic('Rice, white, long-grain, regular, raw, enriched', 'SR Legacy')],
      off: [product('6', 'Rice', 'Uncle Ben')],
      first: 'Rice, white, long-grain, regular, raw, enriched',
    },
  ])('$q', async ({ q, usda, off, first }) => {
    upstreams(usda, off);
    const { results } = await setup().search(q, 50, 'viewer');
    expect(results[0].name).toBe(first);
    expect(results[0].basic_food).toBe(true);
    // No branded item above an unbranded food that has every query word.
    const plain = results.map((r, i) => (!isBrand(r) && hasEveryWord(r.name, q) ? i : -1)).filter((i) => i >= 0);
    const brands = results.map((r, i) => (isBrand(r) ? i : -1)).filter((i) => i >= 0);
    expect(brands.length).toBeGreaterThan(0);
    expect(Math.max(...plain)).toBeLessThan(Math.min(...brands));
  });

  it('no branded item ranks above a plain whole-word match (eggs)', async () => {
    upstreams([branded('EGGS', 'Mars'), survey('Egg, whole, fried'), basic('Eggs, Grade A, Large, egg whole')], []);
    const order = names((await setup().search('eggs', 50, 'viewer')).results);
    expect(order).toEqual(['Eggs, Grade A, Large, egg whole', 'Egg, whole, fried', 'EGGS']);
  });

  it('a partial match ("Eggplant") of a basic food ranks below the whole-word branded item', async () => {
    upstreams([basic('Eggplant, raw', 'SR Legacy'), branded('EGGS', 'Mars')], []);
    expect(names((await setup().search('eggs', 50, 'viewer')).results)).toEqual(['EGGS', 'Eggplant, raw']);
  });

  it('the seeded catalog counts as the plain food', async () => {
    upstreams([branded('BANANA', 'Acme Candy')], [product('7', 'Banana', 'Chiquita', 89)]);
    const { results } = await setup({ local: [seedRow('seed-banana', 'Banana, raw')] }).search('banana', 50, 'viewer');
    expect(results[0]).toMatchObject({ id: 'seed-banana', basic_food: true });
  });

  it('a brand query still finds the brand first', async () => {
    upstreams([basic('Milk, whole, 3.25% milkfat', 'SR Legacy'), branded('FAIRLIFE MILK', 'fairlife', 'Milk')], []);
    expect(names((await setup().search('fairlife milk', 50, 'viewer')).results)[0]).toBe('FAIRLIFE MILK');
  });
});

describe('R4: the search cache keeps no upstream failure', () => {
  const banana = product('8', 'Banana', 'Chiquita', 89);

  const failure = {
    503: () => stub<Response>({ ok: false, status: 503, json: async () => ({}) }),
    429: () => stub<Response>({ ok: false, status: 429, json: async () => ({}) }),
    timeout: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    network: () => Promise.reject(new TypeError('fetch failed')),
    unreadable: () => stub<Response>({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
  };

  it.each([
    { label: 'an Open Food Facts 503', failing: 'off', fail: failure[503] },
    { label: 'a USDA 429', failing: 'usda', fail: failure[429] },
    { label: 'a timeout of both', failing: 'both', fail: failure.timeout },
    { label: 'a network error of both', failing: 'both', fail: failure.network },
    { label: 'an unreadable answer from both', failing: 'both', fail: failure.unreadable },
  ])('after $label the next search asks again and finds the food', async ({ failing, fail }) => {
    let down = true;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const source = String(url).includes('api.nal.usda.gov') ? 'usda' : 'off';
      if (down && (failing === 'both' || failing === source)) return fail();
      return stub<Response>({ ok: true, status: 200, json: async () => (source === 'usda' ? { foods: [] } : { products: [banana] }) });
    });
    const svc = setup();
    const first = await svc.search('banana', 50, 'viewer');
    // Whatever did answer is shown (a USDA failure still shows the OFF banana).
    expect(first.results.some((r) => r.name === 'Banana')).toBe(failing === 'usda');
    const calls = fetchSpy.mock.calls.length;
    down = false;
    const retry = await svc.search('banana', 50, 'viewer');
    expect(fetchSpy.mock.calls.length).toBe(calls + 2);
    expect(retry.results.some((r) => r.name === 'Banana')).toBe(true);
  });

  it.each([
    ['a real empty answer', { ok: true, status: 200 }],
    ['a 404 (nothing found), as at main', { ok: false, status: 404 }],
  ])('%s is kept: the next search does not ask again', async (_label, shape) => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      stub<Response>({ ...shape, json: async () => ({ foods: [], products: [] }) }));
    const svc = setup();
    await svc.search('zzqx', 50, 'viewer');
    const calls = fetchSpy.mock.calls.length;
    expect((await svc.search('zzqx', 50, 'viewer')).results).toEqual([]);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });
});

describe('R5: one row per food, not per name', () => {
  const bar = (code: string, brands: string, kcal100: number) => product(code, 'Protein bar', brands, kcal100);

  it.each([
    ['another brand', [bar('11', 'Alpha', 350), bar('12', 'Beta', 350)], 2],
    ['another barcode, same brand and calories', [bar('11', 'Alpha', 350), bar('13', 'Alpha', 350)], 2],
    ['other calories, same brand', [bar('11', 'Alpha', 350), bar('14', 'Alpha', 420)], 2],
    ['the same product twice', [bar('11', 'Alpha', 350), bar('11', 'Alpha', 350)], 1],
  ])('%s', async (_label, off, count) => {
    upstreams([], off);
    expect((await setup().search('protein bar', 50, 'viewer')).results).toHaveLength(count);
  });

  it('a stored import meets its upstream row once (the stored row wins)', async () => {
    const stored = {
      ...seedRow('stored-alpha', 'Protein bar'), brand_or_restaurant: 'Alpha', calories: 350, tags: ['off:11'],
    };
    upstreams([], [bar('11', 'Alpha', 350)]);
    const { results } = await setup({ local: [stored] }).search('protein bar', 50, 'viewer');
    expect(results.map((r) => r.id)).toEqual(['stored-alpha']);
  });
});
