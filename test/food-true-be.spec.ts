/**
 * FOOD-TRUE-BE (owner #191-E3 "either way, v1 fix", #197-S1; LO-FOOD C8 and C9), class-first over every path that
 * returns a food to the phone: the search (shared catalog, USDA, Open Food Facts, the fewer-than-2-characters list),
 * the barcode lookup and the stored import on log (usda_ and off_ ids).
 *  T1 a food whose numbers cannot be true never shows: over 900 kcal or over 100 g of protein, carbs or fat per
 *     100 g, or calories more than 30% and more than 40 kcal away from 4/4/9 of its protein, carbs and fat;
 *  T2 a packaged food (Open Food Facts, USDA Branded) missing its protein, carbs or fat is left out, never 0 g;
 *  T3 the barcode path and the stored-import path keep the same rules (nothing stored, "not found");
 *  T4 an answer with a failed source (USDA, Open Food Facts or the catalog query) is not cached;
 *  T5 one food from two sources shows once (name plus brand); one source's other products and the caller's own
 *     foods stay;
 *  T6 a built-in food shows only for typed words that are its words, never for text inside another word.
 */
import { Prisma } from '@prisma/client';
import { FoodService, FoodResult } from '../src/food/food.service';
import { numbersCanBeTrue } from '../src/food/food-truth';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;
const VIEWER = 'viewer-197';

// A stored catalog row with true numbers (100 kcal: 5 g protein, 10 g carbs, 4.4 g fat -> 99.6 kcal).
const stored = (id: string, name: string, extra: Row = {}): Row => ({
  id, name, brand_or_restaurant: null, category: 'generic', serving_description: '100 g', serving_size_grams: 100,
  calories: 100, protein_g: 5, carbs_g: 10, fat_g: 4.4, fiber_g: null, sugar_g: null, sodium_mg: null,
  tags: ['basic-food'], search_aliases: [], image_url: null, nutrient_basis: 'PER_100G', word_match: 0,
  created_by_user_id: null, ...extra,
});

// Open Food Facts product per 100 g; a macro set to undefined is missing from the label.
const off = (code: string, name: string, n: Record<string, number | undefined>, brands = 'Acme'): Row => ({
  code, product_name: name, brands,
  nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 4.4, ...n },
});

// USDA food per 100 g; a nutrient set to undefined is not in its list.
let fdc = 5000;
const usda = (description: string, n: Record<string, number | undefined> = {}, extra: Row = {}): Row => {
  const values: Record<string, number | undefined> = {
    Energy: 100, Protein: 5, 'Carbohydrate, by difference': 10, 'Total lipid (fat)': 4.4, ...n,
  };
  const units: Record<string, string> = { Energy: 'KCAL' };
  return {
    fdcId: ++fdc, description, dataType: 'Branded', brandOwner: 'Acme', foodCategory: 'Snacks',
    foodNutrients: Object.entries(values)
      .filter(([, v]) => v !== undefined)
      .map(([nutrientName, value]) => ({ nutrientName, unitName: units[nutrientName] ?? 'G', value })),
    ...extra,
  };
};

interface Opts { local?: Row[]; own?: Row[]; usdaFoods?: Row[]; offProducts?: Row[]; catalogFails?: boolean }

function setup(opts: Opts = {}) {
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const shared = Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL');
    if (shared && opts.catalogFails) throw new Error('catalog query refused');
    return shared ? opts.local ?? [] : opts.own ?? [];
  });
  const foodItem = {
    findMany: jest.fn().mockResolvedValue(opts.local ?? []),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }: { data: Row }) => ({ id: 'created-food', ...data })),
    upsert: jest.fn(async ({ create }: { create: Row }) => ({ id: 'upserted-food', ...create })),
  };
  const service = new FoodService(stub<PrismaService>({ $queryRaw, foodItem }));
  return { service, foodItem, $queryRaw };
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

/** USDA search and detail, Open Food Facts search and product: the given foods; `fail` makes that host throw. */
function upstreams(usdaFoods: Row[], offProducts: Row[], fail: 'usda' | 'off' | null = null) {
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const host = u.hostname === 'api.nal.usda.gov' ? 'usda' : 'off';
    if (fail === host) throw new Error(`${host} down`);
    let body: unknown;
    if (host === 'usda') body = u.pathname.includes('/food/') ? usdaFoods[0] : { foods: usdaFoods };
    else body = u.pathname.includes('/product/') ? { product: offProducts[0] } : { products: offProducts };
    return stub<Response>({ ok: true, status: 200, json: async () => body });
  });
}

const names = (rows: FoodResult[]) => rows.map((r) => r.name);

describe('T1: numbersCanBeTrue (per 100 g, 4/4/9)', () => {
  it.each([
    ['true numbers', { calories: 100, protein_g: 5, carbs_g: 10, fat_g: 4.4 }, true],
    ['pure oil, 884 kcal and 100 g fat', { calories: 884, protein_g: 0, carbs_g: 0, fat_g: 100 }, true],
    ['water, all zero', { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, true],
    ['over 900 kcal per 100 g', { calories: 950, protein_g: 0, carbs_g: 0, fat_g: 100 }, false],
    ['over 100 g protein per 100 g', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0 }, false],
    ['over 100 g carbs per 100 g', { calories: 440, protein_g: 0, carbs_g: 110, fat_g: 0 }, false],
    ['over 100 g fat per 100 g', { calories: 890, protein_g: 0, carbs_g: 0, fat_g: 101 }, false],
    ['calories far above the macros (250 vs 17)', { calories: 250, protein_g: 1, carbs_g: 1, fat_g: 1 }, false],
    // FIX-1222 (LO-1222 B2): carbs count 0-4 kcal a gram (unlisted fibre, sugar alcohols), so the floor is protein and fat.
    ['calories far below the protein (50 vs 400)', { calories: 50, protein_g: 100, carbs_g: 0, fat_g: 0 }, false],
    ['a zero-energy sweetener (0 kcal, 100 g carbs)', { calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0 }, true],
    ['39 kcal away is close enough', { calories: 139, protein_g: 5, carbs_g: 10, fat_g: 4.4 }, true],
    ['35% but only 7 kcal away is close enough', { calories: 27, protein_g: 0, carbs_g: 5, fat_g: 0 }, true],
    ['45 kcal but only 10% away is close enough', { calories: 470, protein_g: 10, carbs_g: 40, fat_g: 25 }, true],
    ['a negative macro', { calories: 100, protein_g: -5, carbs_g: 30, fat_g: 0 }, false],
    ['a number that is not a number', { calories: Number.NaN, protein_g: 5, carbs_g: 10, fat_g: 4.4 }, false],
    ['per serving: 1,000 kcal in a 200 g serving is 500 per 100 g',
      { calories: 1000, protein_g: 50, carbs_g: 100, fat_g: 44, nutrient_basis: 'PER_SERVING' as const, serving_size_grams: 200 }, true],
    ['per serving: 60 g protein in a 50 g serving',
      { calories: 240, protein_g: 60, carbs_g: 0, fat_g: 0, nutrient_basis: 'PER_SERVING' as const, serving_size_grams: 50 }, false],
  ])('%s', (_label, food, expected) => {
    expect(numbersCanBeTrue(food)).toBe(expected);
  });

  it('alcohol counts at 7 kcal a gram when the source lists it (wine: 83 kcal, 2.7 g carbs, 10.6 g alcohol)', () => {
    const wine = { calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0 };
    expect(numbersCanBeTrue(wine)).toBe(false);
    expect(numbersCanBeTrue(wine, 10.6)).toBe(true);
  });
});

describe('T1 and T2 in search: every source', () => {
  const impossible = [
    ['950 kcal per 100 g', { 'energy-kcal_100g': 950, fat_100g: 100, proteins_100g: 0, carbohydrates_100g: 0 }],
    ['120 g protein per 100 g', { 'energy-kcal_100g': 480, proteins_100g: 120, carbohydrates_100g: 0, fat_100g: 0 }],
    ['calories 250 from 1/1/1 g', { 'energy-kcal_100g': 250, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 }],
  ] as const;
  const missing = [
    ['no protein', { proteins_100g: undefined }],
    ['no carbs', { carbohydrates_100g: undefined }],
    ['no fat', { fat_100g: undefined }],
  ] as const;

  it.each([...impossible, ...missing])('Open Food Facts: a product with %s never shows', async (_label, n) => {
    upstreams([], [off('1', 'Snack bar true', {}), off('2', 'Snack bar bad', n)]);
    const { results } = await setup().service.search('snack bar', 50, VIEWER);
    expect(names(results)).toEqual(['Snack bar true']);
  });

  it('Open Food Facts: a product missing a macro is never shown as 0 g', async () => {
    upstreams([], [off('3', 'Granola', { proteins_100g: undefined, 'energy-kcal_100g': 60, carbohydrates_100g: 15, fat_100g: 0 })]);
    const { results } = await setup().service.search('granola', 50, VIEWER);
    expect(results.filter((r) => r.protein_g === 0)).toEqual([]);
  });

  it.each([
    ['950 kcal per 100 g', { Energy: 950, 'Total lipid (fat)': 100, Protein: 0, 'Carbohydrate, by difference': 0 }],
    ['110 g carbs per 100 g', { Energy: 440, 'Carbohydrate, by difference': 110, Protein: 0, 'Total lipid (fat)': 0 }],
    ['calories 300 from 1/1/1 g', { Energy: 300, Protein: 1, 'Carbohydrate, by difference': 1, 'Total lipid (fat)': 1 }],
    ['no protein (Branded)', { Protein: undefined }],
    ['no carbs (Branded)', { 'Carbohydrate, by difference': undefined }],
    ['no fat (Branded)', { 'Total lipid (fat)': undefined }],
  ])('USDA: a food with %s never shows', async (_label, n) => {
    upstreams([usda('Cracker true'), usda('Cracker bad', n)], []);
    const { results } = await setup().service.search('cracker', 50, VIEWER);
    expect(names(results)).toEqual(['Cracker true']);
  });

  it('USDA: wine, whose calories are its alcohol, still shows', async () => {
    const wine = usda('Alcoholic beverage, wine, table, red', {
      Energy: 85, Protein: 0.1, 'Carbohydrate, by difference': 2.6, 'Total lipid (fat)': 0, 'Alcohol, ethyl': 10.6,
    }, { dataType: 'SR Legacy', brandOwner: undefined, foodCategory: 'Beverages' });
    upstreams([wine], []);
    const { results } = await setup().service.search('wine', 50, VIEWER);
    expect(names(results)).toEqual(['Alcoholic beverage, wine, table, red']);
  });

  it('Open Food Facts: wine (alcohol as % by volume) still shows', async () => {
    upstreams([], [off('4', 'Red wine', { 'energy-kcal_100g': 83, proteins_100g: 0, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13 })]);
    const { results } = await setup().service.search('red wine', 50, VIEWER);
    expect(names(results)).toEqual(['Red wine']);
  });

  it.each([
    ['over 900 kcal', { calories: 950, protein_g: 0, carbs_g: 0, fat_g: 100 }],
    ['over 100 g protein', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0 }],
    ['calories far from the macros', { calories: 250, protein_g: 1, carbs_g: 1, fat_g: 1 }],
  ])('catalog: a stored shared row with %s never shows, in search and in the short list', async (_label, nums) => {
    upstreams([], []);
    const local = [stored('ok', 'Oat bar'), stored('bad', 'Oat bar crunchy', nums)];
    const { service } = setup({ local });
    expect(names((await service.search('oat bar', 50, VIEWER)).results)).toEqual(['Oat bar']);
    expect(names((await service.search('', 50, VIEWER)).results)).toEqual(['Oat bar']);
  });

  it('catalog: a row left out is not counted toward answering without USDA and Open Food Facts', async () => {
    upstreams([], []);
    const local = Array.from({ length: 5 }, (_, i) => stored(`bad-${i}`, `Egg, whole, raw ${i}`, { calories: 900, protein_g: 1 }));
    await setup({ local }).service.search('egg', 50, VIEWER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("the caller's own custom food is theirs: it is listed with the numbers they typed", async () => {
    upstreams([], []);
    const own = [stored('mine', 'Oat bar homemade', { calories: 250, protein_g: 0, carbs_g: 0, fat_g: 0, tags: [], created_by_user_id: VIEWER })];
    const { results } = await setup({ own }).service.search('oat bar', 50, VIEWER);
    expect(results.map((r) => r.id)).toEqual(['mine']);
  });
});

describe('T3: the barcode path and the stored-import path keep the same rules', () => {
  it.each([
    ['true numbers', {}, true],
    ['950 kcal per 100 g', { 'energy-kcal_100g': 950, fat_100g: 100, proteins_100g: 0, carbohydrates_100g: 0 }, false],
    ['calories far from the macros', { 'energy-kcal_100g': 250, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 }, false],
    ['no protein', { proteins_100g: undefined }, false],
    ['no carbs', { carbohydrates_100g: undefined }, false],
    ['no fat', { fat_100g: undefined }, false],
    ['no calories', { 'energy-kcal_100g': undefined }, false],
  ])('barcode and off_ import: a product with %s', async (_label, n, ok) => {
    for (const path of ['barcode', 'off_ import'] as const) {
      upstreams([], [off('0123', 'Cereal', n)]);
      const { service, foodItem } = setup();
      const run = path === 'barcode' ? service.lookupByBarcode('0123', VIEWER) : service.resolveOrImportId('off_0123', VIEWER);
      if (ok) {
        await expect(run).resolves.toBe('upserted-food');
        expect(foodItem.upsert.mock.calls[0][0].create).toMatchObject({ protein_g: 5, carbs_g: 10, fat_g: 4.4 });
      } else {
        await expect(run).rejects.toThrow(/not found/);
        expect(foodItem.upsert).not.toHaveBeenCalled();
      }
      fetchSpy.mockRestore();
    }
  });

  it('barcode: a stored shared row whose numbers cannot be true reads as not found (the row is not changed)', async () => {
    const { service, foodItem } = setup();
    foodItem.findUnique.mockResolvedValue(stored('held', 'Cereal', { calories: 250, protein_g: 0, carbs_g: 0, fat_g: 0, barcode: '0123' }));
    await expect(service.lookupByBarcode('0123', VIEWER)).rejects.toThrow(/not found/);
    expect(foodItem.upsert).not.toHaveBeenCalled();
    foodItem.findUnique.mockResolvedValue(stored('held', 'Cereal', { barcode: '0123' }));
    await expect(service.lookupByBarcode('0123', VIEWER)).resolves.toBe('held');
  });

  it.each([
    ['true numbers', {}, true],
    ['over 900 kcal', { Energy: 950, 'Total lipid (fat)': 100, Protein: 0, 'Carbohydrate, by difference': 0 }, false],
    ['over 100 g protein', { Energy: 480, Protein: 120, 'Carbohydrate, by difference': 0, 'Total lipid (fat)': 0 }, false],
    ['calories far from the macros', { Energy: 300, Protein: 1, 'Carbohydrate, by difference': 1, 'Total lipid (fat)': 1 }, false],
    ['no protein (Branded)', { Protein: undefined }, false],
    ['no fat (Branded)', { 'Total lipid (fat)': undefined }, false],
  ])('usda_ import: a food with %s', async (_label, n, ok) => {
    upstreams([usda('Pretzels', n)], []);
    const { service, foodItem } = setup();
    const run = service.resolveOrImportId('usda_777', VIEWER);
    if (ok) {
      await expect(run).resolves.toBe('created-food');
      expect(foodItem.create.mock.calls[0][0].data).toMatchObject({ protein_g: 5, carbs_g: 10, fat_g: 4.4 });
    } else {
      await expect(run).rejects.toThrow(/not found/);
      expect(foodItem.create).not.toHaveBeenCalled();
    }
  });
});

describe('T4: an answer with a failed source is not kept in the cache', () => {
  it.each([
    ['USDA fails', { fail: 'usda' as const }],
    ['Open Food Facts fails', { fail: 'off' as const }],
    ['the catalog query fails', { catalogFails: true }],
  ])('%s: the next search asks again', async (_label, o) => {
    upstreams([], [off('9', 'Rice cake', {})], 'fail' in o ? o.fail : null);
    const { service, $queryRaw } = setup({ catalogFails: 'catalogFails' in o });
    await service.search('rice cake', 50, VIEWER);
    const asked = fetchSpy.mock.calls.length + $queryRaw.mock.calls.length;
    await service.search('rice cake', 50, VIEWER);
    expect(fetchSpy.mock.calls.length + $queryRaw.mock.calls.length).toBeGreaterThanOrEqual(asked * 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).memoryCache.size).toBe(0);
  });

  it.each(['v3', 'v4'])('an answer cached before this change (food:search:%s:) is never served', async (v) => {
    upstreams([], []);
    const { service } = setup();
    const bad = { ...stored('old', 'Rice cake'), calories: 900, protein_g: 1 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).memoryCache.set(`food:search:${v}:rice cake`, {
      value: { results: [bad], suggestions: [], did_you_mean: false, query: 'rice cake' }, expiresAt: Date.now() + 60_000,
    });
    expect(names((await service.search('rice cake', 50, VIEWER)).results)).toEqual([]);
  });
});

describe('T5: one food from two sources shows once (name plus brand)', () => {
  it('a catalog row and an Open Food Facts product with one name and brand: once, the catalog row', async () => {
    upstreams([], [off('55', 'Protein bar', { 'energy-kcal_100g': 380, proteins_100g: 30, carbohydrates_100g: 40, fat_100g: 11 }, 'Alpha')]);
    const local = [stored('cat-alpha', 'Protein bar', { brand_or_restaurant: 'Alpha', tags: ['seed:common-foods'] })];
    const { results } = await setup({ local }).service.search('protein bar', 50, VIEWER);
    expect(results.map((r) => r.id)).toEqual(['cat-alpha']);
  });

  it('a USDA food and an Open Food Facts product with one name and brand (any case): once, the USDA row', async () => {
    upstreams([usda('Protein Bar', {}, { brandOwner: 'ALPHA' })], [off('56', 'protein bar', {}, 'Alpha')]);
    const { results } = await setup().service.search('protein bar', 50, VIEWER);
    expect(results.map((r) => r.id)).toEqual([`usda_${fdc}`]);
  });

  it.each([
    ['another brand', [off('11', 'Protein bar', {}, 'Alpha'), off('12', 'Protein bar', {}, 'Beta')], 2],
    ['two barcodes of one brand from one source', [off('11', 'Protein bar', {}, 'Alpha'), off('13', 'Protein bar', {}, 'Alpha')], 2],
  ])('%s: both stay', async (_label, products, count) => {
    upstreams([], products);
    expect((await setup().service.search('protein bar', 50, VIEWER)).results).toHaveLength(count);
  });

  it("the caller's own food with a shared food's name and brand: both stay", async () => {
    upstreams([], [off('57', 'Protein bar', {}, 'Alpha')]);
    const own = [stored('mine', 'Protein bar', { brand_or_restaurant: 'Alpha', tags: [], created_by_user_id: VIEWER })];
    const { results } = await setup({ own }).service.search('protein bar', 50, VIEWER);
    expect(results.map((r) => r.id).sort()).toEqual(['mine', 'off_57']);
  });
});

describe('T6: a built-in food shows only for its own words', () => {
  it.each([
    ['ham', 'Graham crackers', 2, false],
    ['pea', 'Chickpeas', 2, false],
    ['ham', 'Ham, sliced', 0, true],
    ['pea', 'Peanut butter', 1, true],
  ])('"%s" and the built-in "%s" (word match %i): shown %s', async (q, name, word_match, shown) => {
    upstreams([], []);
    const local = [stored('seed-1', name, { tags: ['seed:common-foods'], word_match })];
    const { results } = await setup({ local }).service.search(q, 50, VIEWER);
    expect(names(results)).toEqual(shown ? [name] : []);
  });

  it('a loaded USDA row found by the typed text inside a word still shows, as before', async () => {
    upstreams([], []);
    const local = [stored('usda-1', 'Crackers, graham', { tags: ['basic-food', 'usda:1'], word_match: 2 })];
    const { results } = await setup({ local }).service.search('ham', 50, VIEWER);
    expect(names(results)).toEqual(['Crackers, graham']);
  });
});
