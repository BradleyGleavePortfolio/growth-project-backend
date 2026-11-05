/**
 * LO-1222 (Opus lens, b#1222 round 1) B-TESTs. Each fails at 022a56be3bbbad0f56abde0d0f37a5134e081534.
 * Numbers are the real per-100 g figures of real foods (USDA SR Legacy rows in prisma/data/usda-foods.jsonl.gz,
 * Open Food Facts products by barcode).
 */
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import { numbersCanBeTrue } from '../src/food/food-truth';
import type { PrismaService } from '../src/prisma.service';

const stub = <T>(v: unknown) => v as T;
type Row = Record<string, unknown>;
const VIEWER = 'viewer-lo-1222';

const stored = (id: string, name: string, extra: Row = {}): Row => ({
  id, name, brand_or_restaurant: null, category: 'generic', serving_description: '100 g', serving_size_grams: 100,
  calories: 100, protein_g: 5, carbs_g: 10, fat_g: 4.4, fiber_g: null, sugar_g: null, sodium_mg: null,
  tags: ['basic-food'], search_aliases: [], image_url: null, nutrient_basis: 'PER_100G', word_match: 0,
  created_by_user_id: null, ...extra,
});

function setup(local: Row[] = []) {
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? local : [],
  );
  const foodItem = {
    findMany: jest.fn().mockResolvedValue(local),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }: { data: Row }) => ({ id: 'created-food', ...data })),
    upsert: jest.fn(async ({ create }: { create: Row }) => ({ id: 'upserted-food', ...create })),
  };
  return { service: new FoodService(stub<PrismaService>({ $queryRaw, foodItem })), foodItem };
}

let fetchSpy: jest.SpyInstance | undefined;
const key = process.env.USDA_API_KEY;
beforeEach(() => { process.env.USDA_API_KEY = 'test-key'; });
afterEach(() => { fetchSpy?.mockRestore(); process.env.USDA_API_KEY = key; });

function offProduct(product: Row) {
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const body = u.hostname === 'api.nal.usda.gov' ? { foods: [] } : u.pathname.includes('/product/') ? { product } : { products: [] };
    return stub<Response>({ ok: true, status: 200, json: async () => body });
  });
}

describe('LO-1222 B2: real foods whose label calories sit below 4/4/9 (fibre, sugar alcohols) still list', () => {
  it.each([
    ['USDA SR Legacy 169593 Cocoa, dry powder, unsweetened', { calories: 228, protein_g: 19.6, carbs_g: 57.9, fat_g: 13.7 }],
    ['USDA SR Legacy 168872 Oat bran, raw', { calories: 246, protein_g: 17.3, carbs_g: 66.2, fat_g: 7 }],
    ['USDA SR Legacy 169722 Wheat bran, crude', { calories: 216, protein_g: 15.6, carbs_g: 64.5, fat_g: 4.3 }],
    ['USDA SR Legacy 170679 Sweetener, herbal extract powder from Stevia leaf', { calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0 }],
    ["Open Food Facts 0034000052004 Hershey's Cocoa 100% Cacao", { calories: 200, protein_g: 20, carbs_g: 60, fat_g: 10 }],
    ['Open Food Facts 0812130020601 Truvia', { calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0 }],
  ])('%s', (_label, food) => {
    expect(numbersCanBeTrue(food)).toBe(true);
  });

  it("barcode: Hershey's Cocoa (0034000052004) is found, not \"not found\"", async () => {
    offProduct({ code: '0034000052004', product_name: "Hershey's Cocoa 100% Cacao Natural Unsweetened", brands: "Hershey's",
      nutriments: { 'energy-kcal_100g': 200, proteins_100g: 20, carbohydrates_100g: 60, fat_100g: 10, fiber_100g: 40 } });
    await expect(setup().service.lookupByBarcode('0034000052004', VIEWER)).resolves.toBe('upserted-food');
  });

  it('search: the loaded USDA cocoa row is listed for "cocoa powder"', async () => {
    offProduct({});
    const local = [stored('cocoa', 'Cocoa, dry powder, unsweetened', { calories: 228, protein_g: 19.6, carbs_g: 57.9, fat_g: 13.7, fiber_g: 37 })];
    const { results } = await setup(local).service.search('cocoa powder', 50, VIEWER);
    expect(results.map((r) => r.id)).toContain('cocoa');
  });
});
