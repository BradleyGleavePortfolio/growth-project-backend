/**
 * FIX-1222 (b#1222 fix round 1): what the lens tests do not already hold.
 *  H1 a shared import stores its evidence (checked, and the alcohol its source listed) as tags, never as search words.
 *  H2 a held row stored before FIX-1222 is read through its source: a wine whose row has no alcohol tag passes when
 *     the source lists its alcohol; a packaged row with a 0 g macro passes when its source lists that macro as 0.
 *  H3 a held Branded USDA row whose numbers fail is refused without a fetch (a Branded label never lists alcohol).
 *  H4 a source that cannot be reached throws (the queued log retries); a source with no such food is not found.
 *  H5 search leaves out unusable foods before the limit, so they do not cost usable ones their place.
 */
import { NotFoundException } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import { evidenceTags, storedAlcoholG, storedNumbersCanBeTrue } from '../src/food/food-truth';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

const row = (extra: Record<string, unknown>) => ({
  id: 'held-row', name: 'Held food', serving_size_grams: 100, serving_description: '100 g', nutrient_basis: 'PER_100G',
  created_by_user_id: null, barcode: null, fiber_g: null, tags: [], ...extra,
});
const wine = { name: 'Red wine', calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0 };

function answer(body: unknown, status = 200) {
  return stub<Response>({ ok: status < 400, status, json: async () => body });
}

describe('FIX-1222 held rows and their sources', () => {
  const key = process.env.USDA_API_KEY;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    process.env.USDA_API_KEY = 'fixture-key';
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it('H1: an import stores checked and its alcohol as tags, and they are read back', async () => {
    fetchMock.mockResolvedValue(answer({ product: { code: '7001', product_name: 'Red wine',
      nutriments: { 'energy-kcal_100g': 83, proteins_100g: 0.1, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13 } } }));
    const upsert = jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'stored', ...create }));
    const service = new FoodService(stub<PrismaService>({ foodItem: { findUnique: jest.fn().mockResolvedValue(null), upsert } }));
    await expect(service.lookupByBarcode('7001', 'viewer')).resolves.toBe('stored');
    const tags = upsert.mock.calls[0][0].create.tags as string[];
    expect(tags).toEqual(['off:7001', 'truth:checked', 'truth:alcohol_g=10.3']);
    expect(storedAlcoholG(tags)).toBe(10.3);
    expect(storedNumbersCanBeTrue({ ...wine, tags })).toBe(true);
    expect(storedNumbersCanBeTrue({ ...wine, tags: ['off:7001'] })).toBe(false);
    expect(evidenceTags(0)).toEqual(['truth:checked']);
  });

  it('H2: a loaded USDA wine with no alcohol tag is read through USDA, which lists its alcohol', async () => {
    fetchMock.mockResolvedValue(answer({ fdcId: 174837, description: 'Alcoholic beverage, wine, table, red',
      dataType: 'SR Legacy', foodNutrients: [
        { nutrientName: 'Energy', unitName: 'KCAL', value: 85 },
        { nutrientName: 'Protein', unitName: 'G', value: 0.07 },
        { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 2.61 },
        { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0 },
        { nutrientName: 'Alcohol, ethyl', unitName: 'G', value: 10.6 },
      ] }));
    const held = row({ ...wine, id: 'loaded-wine', tags: ['usda:174837', 'basic-food'] });
    const service = new FoodService(stub<PrismaService>({ foodItem: { findFirst: jest.fn().mockResolvedValue(held) } }));
    await expect(service.resolveOrImportId('usda_174837', 'viewer')).resolves.toBe('loaded-wine');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('H2: a packaged row stored before FIX-1222 with 0 g fat passes when its label lists fat as 0', async () => {
    fetchMock.mockResolvedValue(answer({ product: { code: '7002', product_name: 'Diet cola',
      nutriments: { 'energy-kcal_100g': 1, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0 } } }));
    const held = row({ id: 'cola', name: 'Diet cola', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0,
      tags: ['off:7002'], barcode: '7002' });
    const findUnique = jest.fn().mockResolvedValue(held);
    const service = new FoodService(stub<PrismaService>({ foodItem: { findUnique } }));
    await expect(service.lookupByBarcode('7002', 'viewer')).resolves.toBe('cola');
    await expect(service.resolveOrImportId('cola', 'viewer')).resolves.toBe('cola');
    // A row this fix stored (checked) is not read through its source again.
    findUnique.mockResolvedValue({ ...held, tags: ['off:7002', 'truth:checked'] });
    fetchMock.mockClear();
    await expect(service.lookupByBarcode('7002', 'viewer')).resolves.toBe('cola');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('H3: a held Branded USDA row whose numbers fail is refused without a fetch', async () => {
    const held = row({ ...wine, tags: ['usda:7003'] });
    const service = new FoodService(stub<PrismaService>({ foodItem: { findFirst: jest.fn().mockResolvedValue(held) } }));
    await expect(service.resolveOrImportId('usda_7003', 'viewer')).rejects.toThrow(/not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('H4: a source not reached throws a retryable error; a source with no such food is a 404', async () => {
    const held = row({ id: 'cereal', calories: 60, protein_g: 0, carbs_g: 15, fat_g: 0, tags: ['off:7004'], barcode: '7004' });
    const prisma = stub<PrismaService>({ foodItem: { findUnique: jest.fn().mockResolvedValue(held) },
      loggedFoodEntry: { create: jest.fn() } });
    const log = new LogService(prisma, new FoodService(prisma), stub({ capture: jest.fn() }), stub({ emit: jest.fn() }),
      stub({ invalidateForUser: jest.fn() }));
    const send = () => log.logFood('viewer', { food_item_id: 'off_7004', date: '2026-11-05', meal_type: 'lunch' } as never);
    fetchMock.mockResolvedValue(answer({}, 503));
    const outage = await send().catch((e: unknown) => e);
    expect(outage).not.toBeInstanceOf(NotFoundException);
    expect(String(outage)).toMatch(/fetch failed: 503/);
    fetchMock.mockResolvedValue(answer({ status: 0 }, 404));
    await expect(send()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('H5: unusable foods are left out before the limit', async () => {
    const product = (code: string, protein: number | undefined) => ({ code, product_name: `Bar ${code}`, nutriments: {
      'energy-kcal_100g': 400, ...(protein === undefined ? {} : { proteins_100g: protein }), carbohydrates_100g: 60, fat_100g: 10 } });
    fetchMock.mockImplementation(async (url) => new URL(String(url)).hostname === 'world.openfoodfacts.org'
      ? answer({ products: [product('1', undefined), product('2', undefined), product('3', 20)] })
      : answer({ foods: [] }));
    const service = new FoodService(stub<PrismaService>({}));
    const searchOpenFoodFacts = (service as unknown as { searchOpenFoodFacts(q: string, limit: number): Promise<{ id: string }[]> })
      .searchOpenFoodFacts.bind(service);
    expect((await searchOpenFoodFacts('protein bar', 1)).map((r) => r.id)).toEqual(['off_3']);
  });
});
