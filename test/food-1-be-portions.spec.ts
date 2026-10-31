/**
 * FOOD-1-BE, owner ruling R1 (no guessed portions) and R2 ("100 g", not
 * "1 serving"), class-first: every place the server builds a food's portions
 * — USDA search, Open Food Facts search, an Open Food Facts barcode/import,
 * a USDA import, a USDA import stored before this change, every seeded row
 * and a custom food — offers a cup / tbsp / tsp only with a weight from the
 * food's own household measure or the density table for its real category.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService, FoodResult, HUNDRED_GRAMS } from '../src/food/food.service';
import { getGramsForVolume, volumeWeightsFor } from '../src/food/food-density';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

const nutrients = [
  { nutrientName: 'Energy', unitName: 'KCAL', value: 143 },
  { nutrientName: 'Protein', unitName: 'G', value: 12.6 },
];
const usda = (extra: Row) => ({ fdcId: 1, description: 'Food', foodNutrients: nutrients, ...extra });
const off = (extra: Row = {}) => ({
  code: '0030000010204', product_name: 'Old fashioned rolled oats', brands: 'Quaker',
  nutriments: { 'energy-kcal_100g': 375, proteins_100g: 12.5, carbohydrates_100g: 67.5, fat_100g: 6.3 },
  ...extra,
});

function service(foodItem: Row = {}) {
  return new FoodService(stub<PrismaService>({ foodItem, $queryRaw: jest.fn().mockResolvedValue([]) }));
}

function answer(body: unknown) {
  return stub<Response>({ ok: true, status: 200, json: async () => body });
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

async function searchOne(food: Row, source: 'usda' | 'off'): Promise<FoodResult> {
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
    new URL(String(url)).hostname === 'api.nal.usda.gov'
      ? answer({ foods: source === 'usda' ? [food] : [] })
      : answer({ products: source === 'off' ? [food] : [] }),
  );
  const res = await service().search(String(food.description ?? food.product_name), 50, 'viewer');
  expect(res.results).toHaveLength(1);
  return res.results[0];
}

describe('R1/R2: every food source offers only portions it can weigh', () => {
  it.each([
    {
      source: 'USDA Foundation, no package serving, real category',
      food: usda({ dataType: 'Foundation', foodCategory: 'Dairy and Egg Products' }),
      serving: HUNDRED_GRAMS, grams: 100, cup: getGramsForVolume('Dairy and Egg Products', 'cup', 1), basic: true,
    },
    {
      source: 'USDA Survey (FNDDS), no package serving, category without a density',
      food: usda({ dataType: 'Survey (FNDDS)', foodCategory: 'Burgers' }),
      serving: HUNDRED_GRAMS, grams: 100, cup: undefined, basic: false,
    },
    {
      source: 'USDA SR Legacy, no category at all',
      food: usda({ dataType: 'SR Legacy' }),
      serving: HUNDRED_GRAMS, grams: 100, cup: undefined, basic: true,
    },
    {
      source: 'USDA Branded, its own household measure',
      food: usda({ dataType: 'Branded', brandOwner: 'Acme', householdServingFullText: '1/2 cup', servingSize: 40, servingSizeUnit: 'g', foodCategory: 'Cereal' }),
      serving: '1/2 cup', grams: 40, cup: 80, basic: false,
    },
    {
      source: 'USDA Branded, a package serving that is not a volume',
      food: usda({ dataType: 'Branded', brandOwner: 'Acme', servingSize: 28, servingSizeUnit: 'g', foodCategory: 'Not A Table Category' }),
      serving: '28g', grams: 28, cup: undefined, basic: false,
    },
  ])('$source', async ({ food, serving, grams, cup, basic }) => {
    const row = await searchOne(food, 'usda');
    expect(row.serving_description).toBe(serving);
    expect(row.serving_description).not.toBe('1 serving');
    expect(row.serving_size_grams).toBe(grams);
    expect(row.cup_grams).toBe(cup ?? undefined);
    expect(row.supports_volume_units).toBe(cup != null);
    expect(row.basic_food).toBe(basic);
  });

  it('Open Food Facts search: 100 g, no cup / tbsp / tsp', async () => {
    const row = await searchOne(off(), 'off');
    expect(row).toMatchObject({ serving_description: '100g', serving_size_grams: 100, supports_volume_units: false });
    expect([row.cup_grams, row.tbsp_grams, row.tsp_grams]).toEqual([undefined, undefined, undefined]);
  });

  it('Open Food Facts barcode / import: the stored row offers no volume either', async () => {
    const stored: Row[] = [];
    const foodItem = {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        stored.find((r) => r.barcode === where.barcode || r.id === where.id) ?? null),
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        const row = { id: 'off-row', created_by_user_id: null, nutrient_basis: 'PER_100G', ...create };
        stored.push(row);
        return row;
      }),
    };
    const svc = service(foodItem);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(answer({ product: off() }));
    const id = await svc.lookupByBarcode('0030000010204', 'viewer');
    const row = await svc.getById(id, 'viewer');
    expect(row).toMatchObject({ category: 'generic', serving_description: '100g', supports_volume_units: false });
    expect(row?.cup_grams).toBeUndefined();
  });

  it('USDA import: the stored row keeps the search row portions, label and basic mark', async () => {
    const detail = usda({ fdcId: 748967, description: 'Eggs, Grade A, Large, egg whole', dataType: 'Foundation', foodCategory: { description: 'Dairy and Egg Products' } });
    const created: Row[] = [];
    const foodItem = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: 'imported', created_by_user_id: null, nutrient_basis: 'PER_100G', ...data };
        created.push(row);
        return row;
      }),
      findUnique: jest.fn(async () => created[0] ?? null),
    };
    const svc = service(foodItem);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(answer(detail));
    await svc.resolveOrImportId('usda_748967', 'viewer');
    expect(created[0]).toMatchObject({
      category: 'generic', serving_description: HUNDRED_GRAMS, serving_size_grams: 100,
      tags: ['usda:748967', 'category:Dairy and Egg Products', 'basic-food'],
    });
    const stored = await svc.getById('imported', 'viewer');
    const searched = await searchOne(detail, 'usda');
    for (const field of ['serving_description', 'serving_size_grams', 'supports_volume_units', 'cup_grams', 'tbsp_grams', 'tsp_grams', 'basic_food'] as const) {
      expect(stored?.[field]).toEqual(searched[field]);
    }
  });

  it("a USDA import stored before this change reads '100 g' for its 100 g, never '1 serving'", async () => {
    const svc = service({
      findUnique: jest.fn().mockResolvedValue({
        id: 'old', name: 'Big Mac', category: 'generic', serving_description: '1 serving', serving_size_grams: 100,
        calories: 261, protein_g: 12, carbs_g: 22, fat_g: 14, tags: ['usda:2706338'], created_by_user_id: null,
      }),
    });
    const row = await svc.getById('old', 'viewer');
    expect(row).toMatchObject({ serving_description: HUNDRED_GRAMS, serving_size_grams: 100, supports_volume_units: false });
  });

  it("a custom food's own '1 serving' is its creator's words and stays", async () => {
    const svc = service({
      findUnique: jest.fn().mockResolvedValue({
        id: 'mine', name: 'Lunch', category: 'generic', serving_description: '1 serving', serving_size_grams: 100,
        calories: 400, protein_g: 0, carbs_g: 0, fat_g: 0, tags: [], created_by_user_id: 'viewer', nutrient_basis: 'PER_SERVING',
      }),
    });
    const row = await svc.getById('mine', 'viewer');
    expect(row).toMatchObject({ serving_description: '1 serving', supports_volume_units: false, basic_food: false });
  });

  // Every row of the real seed, stored the way prisma/seed-foods.ts stores it.
  const seeds = JSON.parse(readFileSync(join(__dirname, '../prisma/data/seed-foods.json'), 'utf8')) as Row[];
  it.each(seeds.map((s) => [s.name, s] as const))('seeded %s', async (_name, seed) => {
    const svc = service({
      findUnique: jest.fn().mockResolvedValue({
        ...seed, id: 'seed', created_by_user_id: null, category: 'generic', nutrient_basis: 'PER_100G',
        brand_or_restaurant: seed.brand ?? null, tags: ['seed:common-foods', `category:${String(seed.food_category)}`],
      }),
    });
    const row = await svc.getById('seed', 'viewer');
    // Worked out here, not by the code under test: "1/2 cup dry (40g)" is 80 g a cup.
    const text = String(seed.serving_description);
    const measure = /(\d+\/\d+|\d+(?:\.\d+)?)\s*(cups?|tbsp|tsp)\b/i.exec(text);
    const written = /(\d+(?:\.\d+)?)\s*g\)/i.exec(text);
    const ml = { cup: 240, tbsp: 15, tsp: 5 };
    const qty = measure ? measure[1].split('/').map(Number).reduce((a, b) => a / b) : 0;
    const unit = measure ? (measure[2].toLowerCase().startsWith('cup') ? 'cup' : measure[2].toLowerCase()) : 'cup';
    const grams = written ? Number(written[1]) : Number(seed.serving_size_grams);
    const own = measure ? (grams * 240) / (qty * ml[unit as keyof typeof ml]) : null;
    const table = getGramsForVolume(String(seed.food_category), 'cup', 1);
    expect(row?.basic_food).toBe(true);
    if (own !== null) expect(row?.cup_grams).toBeCloseTo(own, 0);
    else expect(row?.cup_grams).toBe(table ?? undefined);
    expect(row?.supports_volume_units).toBe(row?.cup_grams !== undefined);
  });
});

describe('volumeWeightsFor: the food own measure, the table, or nothing', () => {
  it.each([
    ['1/2 cup dry (40g)', 40, null, 80],
    ['1 cup cooked (158g)', 158, null, 158],
    ['2 tbsp (32g)', 32, null, 256],
    ['1 1/2 cups', 360, null, 240],
    ['40 g (0.5 cup)', null, null, 80],
    ['1 cup (1g)', 1, null, null], // an implausible measure fails soft
    ['100g', 100, 'generic', null], // the catch-all is not a density
    ['1 large (50g)', 50, 'Dairy and Egg Products', getGramsForVolume('Dairy and Egg Products', 'cup', 1)],
    ['', 100, null, null],
  ])('%s (%s g, category %s) -> cup %s g', (measure, grams, category, cup) => {
    expect(volumeWeightsFor(measure, grams, category)?.cup_grams ?? null).toBe(cup);
  });
});
