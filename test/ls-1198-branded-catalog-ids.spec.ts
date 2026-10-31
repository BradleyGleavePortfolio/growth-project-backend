import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const eggs = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/lo-food-usda-eggs.json'), 'utf8'),
) as Array<{ fdcId: number; brandOwner?: string }>;

describe('LS-1198 independent control: distinct branded catalog IDs remain selectable', () => {
  const oldKey = process.env.USDA_API_KEY;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'fixture-only';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (oldKey === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = oldKey;
  });

  it('keeps both actual USDA Mars EGGS IDs with different label nutrition', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        json: async () =>
          new URL(String(url)).hostname === 'api.nal.usda.gov'
            ? { foods: eggs }
            : { products: [] },
      }),
    );
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn().mockResolvedValue([]),
    }));

    const result = await service.search('eggs', 50, 'viewer');
    const mars = result.results.filter(
      (food) => food.brand_or_restaurant === 'Mars Chocolate North America LLC',
    );

    // Fixture IDs are different products/records with 525 vs 571 kcal/100g,
    // not two copies of the same identity. No request for a new schema.
    expect(mars.map((food) => food.id)).toEqual(expect.arrayContaining([
      'usda_2575422', 'usda_2498468',
    ]));
    expect(mars.find((food) => food.id === 'usda_2575422')?.calories).toBe(525);
    expect(mars.find((food) => food.id === 'usda_2498468')?.calories).toBe(571);
  });

  it('keeps two same-brand OFF product codes while removing the same code repeated', async () => {
    const product = (code: string, kcal: number) => ({
      code,
      product_name: 'Protein bar',
      brands: 'Acme',
      nutriments: {
        'energy-kcal_100g': kcal,
        proteins_100g: 20, carbohydrates_100g: 30, fat_100g: 10,
      },
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        json: async () =>
          new URL(String(url)).hostname === 'api.nal.usda.gov'
            ? { foods: [] }
            : { products: [product('111', 350), product('222', 420), product('111', 350)] },
      }),
    );
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn().mockResolvedValue([]),
    }));

    const result = await service.search('protein bar', 50, 'viewer');

    expect(result.results.map((food) => food.id).sort()).toEqual(['off_111', 'off_222']);
  });
});
