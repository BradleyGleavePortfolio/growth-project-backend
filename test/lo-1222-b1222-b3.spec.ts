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

describe('LO-1222 B3: pure animal fats at USDA\'s 902 kcal per 100 g still list', () => {
  it.each([
    ['USDA SR Legacy 171401 Lard'],
    ['USDA SR Legacy 171400 Fat, beef tallow'],
    ['USDA SR Legacy 173577 Fish oil, cod liver'],
  ])('%s (902 kcal, 100 g fat)', () => {
    expect(numbersCanBeTrue({ calories: 902, protein_g: 0, carbs_g: 0, fat_g: 100 })).toBe(true);
  });

  it('search: the loaded USDA lard row is listed for "lard"', async () => {
    offProduct({});
    const local = [stored('lard', 'Lard', { calories: 902, protein_g: 0, carbs_g: 0, fat_g: 100 })];
    const { results } = await setup(local).service.search('lard', 50, VIEWER);
    expect(results.map((r) => r.id)).toContain('lard');
  });
});
