/**
 * LO-1222 (Opus lens, b#1222 round 1) B-TESTs. Each fails at 022a56be3bbbad0f56abde0d0f37a5134e081534.
 * Numbers are the real per-100 g figures of real foods (USDA SR Legacy rows in prisma/data/usda-foods.jsonl.gz,
 * Open Food Facts products by barcode).
 */
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

const stub = <T>(v: unknown) => v as T;
type Row = Record<string, unknown>;
const VIEWER = 'viewer-lo-1222';

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

describe('LO-1222 B1: a wine stored by its first scan is found on every later scan and log', () => {
  it('barcode: the second scan of a red wine (13% vol) finds the row its first scan stored', async () => {
    offProduct({ code: '3263280113013', product_name: 'Red wine', brands: 'Acme',
      nutriments: { 'energy-kcal_100g': 83, proteins_100g: 0, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13 } });
    const { service, foodItem } = setup();
    await expect(service.lookupByBarcode('3263280113013', VIEWER)).resolves.toBe('upserted-food');
    const row = { id: 'upserted-food', created_by_user_id: null, nutrient_basis: 'PER_100G', ...foodItem.upsert.mock.calls[0][0].create };
    foodItem.findUnique.mockResolvedValue(row);
    await expect(service.lookupByBarcode('3263280113013', VIEWER)).resolves.toBe('upserted-food');
    await expect(service.resolveOrImportId('off_3263280113013', VIEWER)).resolves.toBe('upserted-food');
  });
});
