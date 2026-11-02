/**
 * LO-1198 B2 (audit of b#1198 @ be847235): the first row for "rolled oats" is
 * USDA Foundation "Oats, whole grain, rolled, old fashioned" (382 kcal/100 g,
 * category "Cereal Grains and Pasta", no household measure). Its cup comes from
 * the category density 0.65 g/ml: 1 cup = 156 g = about 596 kcal. A cup of
 * rolled oats is about 80 g, about 300 kcal (the seeded row's own label, "1/2
 * cup dry (40g)"). The USDA answer is the real one for "rolled oats"
 * (FoodData Central search, 20 rows, read 2026-10-31); the shared catalog
 * answers with the seeded row from prisma/data/seed-foods.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const usda: unknown[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lo-1198-usda-rolled-oats.json'), 'utf8'));
const seededOats = {
  id: 'seed-oats', name: 'Oats, rolled, dry', brand_or_restaurant: null, category: 'generic',
  serving_description: '1/2 cup dry (40g)', serving_size_grams: 40, calories: 379, protein_g: 13.2, carbs_g: 67.7,
  fat_g: 6.5, fiber_g: 10.1, sugar_g: 0.99, sodium_mg: null, image_url: null, nutrient_basis: 'PER_100G', search_aliases: [],
  tags: ['carbs', 'fiber', 'whole-grain', 'category:Cereal Grains and Pasta', 'seed:common-foods'],
};

describe('LO-1198 B2 rolled oats cup', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods: usda } : { products: [] }),
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('rolled oats: 1 cup of the first row counts at most 350 kcal', async () => {
    const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? [seededOats] : []);
    const prisma = { foodItem: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw };
    const { results } = await new FoodService(stub<PrismaService>(prisma)).search('rolled oats', 25, 'member-a');

    const first = results[0];
    const cupKcal = first.supports_volume_units ? (first.calories * (first.cup_grams ?? 0)) / 100 : 0;
    expect(cupKcal).toBeLessThanOrEqual(350);
  });
});
