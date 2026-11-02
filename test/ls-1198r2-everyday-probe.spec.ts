/** Independent LS-1198R2 query/portion evidence, not a replacement ranker. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

const stub = <T>(v: unknown): T => v as T;
type Row = Record<string, unknown> & { name: string; food_category: string; serving_size_grams: number };
const seeds = JSON.parse(readFileSync(
  join(__dirname, '../prisma/data/seed-foods.json'), 'utf8',
)) as Row[];
const fixtures = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/ls-1198r2/everyday.json'), 'utf8',
)) as Array<{ query: string; foods: Array<Record<string, unknown>> }>;
const localize = (s: Row, index: number) => ({
  ...s, id: `seed-${index}`, category: 'generic', created_by_user_id: null,
  brand_or_restaurant: null, nutrient_basis: 'PER_100G', search_aliases: [],
  tags: ['seed:common-foods', `category:${s.food_category}`],
});
const originalKey = process.env.USDA_API_KEY;
afterEach(() => {
  jest.restoreAllMocks();
  if (originalKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = originalKey;
});

describe('required everyday queries: real USDA rows and matching shipped seeds', () => {
  it.each(fixtures)('$query fresh and cached', async ({ query, foods }) => {
    process.env.USDA_API_KEY = 'fixture-only';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => stub<Response>({
      ok: true, status: 200,
      json: async () => String(url).includes('api.nal.usda.gov') ? { foods } : { products: [] },
    }));
    const tokens = query.split(' ').map((t) => t.replace(/s$/, ''));
    // Known matching seeds only. This double does not claim to emulate SQL
    // trigram ordering; actual merging/ranking is entirely production code.
    const local = seeds.filter((s) => tokens.every((t) => s.name.toLowerCase().includes(t))).map(localize);
    const service = new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue(local) }));
    const fresh = await service.search(query, 50, 'viewer');
    const cached = await service.search(query, 50, 'viewer');
    expect(fresh.results.length).toBeGreaterThan(0);
    expect(cached.results).toEqual(fresh.results);
    expect(new Set(fresh.results.map((r) => r.id)).size).toBe(fresh.results.length);
    const first = fresh.results[0];
    console.log('EVERYDAY', JSON.stringify({
      query, first: first.name, brand: first.brand_or_restaurant, basis: first.nutrient_basis,
      serving: first.serving_description, grams: first.serving_size_grams, kcal: first.calories,
      cup: first.cup_grams ?? null, servingKcal: first.calories * first.serving_size_grams / 100,
      gramKcal: first.calories / 100, ounceKcal: first.calories * 28.3495 / 100,
      cupKcal: first.cup_grams ? first.calories * first.cup_grams / 100 : null,
      firstFive: fresh.results.slice(0, 5).map((r) => ({ name: r.name, brand: r.brand_or_restaurant })),
    }));
  });
});

describe('every shipped seed: portion support and stored gram basis', () => {
  it.each(seeds)('$name', async (seed) => {
    const row = localize(seed, 0);
    const service = new FoodService(stub<PrismaService>({
      foodItem: { findUnique: jest.fn().mockResolvedValue(row) },
    }));
    const food = (await service.getById(row.id, 'viewer'))!;
    expect(food.nutrient_basis).toBe('PER_100G');
    expect(food.serving_size_grams).toBe(seed.serving_size_grams);
    expect(food.serving_size_grams).toBeGreaterThan(0);
    if (food.supports_volume_units) {
      expect(food.cup_grams).toBeGreaterThan(0);
      expect(food.tbsp_grams).toBeCloseTo(food.cup_grams! / 16, 0);
      expect(food.tsp_grams).toBeCloseTo(food.cup_grams! / 48, 0);
    } else {
      expect(food.cup_grams).toBeUndefined();
      expect(food.tbsp_grams).toBeUndefined();
      expect(food.tsp_grams).toBeUndefined();
    }
    console.log('SEED_PORTION', JSON.stringify({
      name: food.name, serving: food.serving_description, grams: food.serving_size_grams,
      kcal100g: food.calories, cup: food.cup_grams ?? null,
      servingKcal: food.calories * food.serving_size_grams / 100,
    }));
  });
});
