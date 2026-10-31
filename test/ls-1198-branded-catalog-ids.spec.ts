import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
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

  it('keeps two custom branded food IDs with different macros, fresh and cached', async () => {
    const rows: Array<Record<string, unknown>> = [];
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true,
      status: 200,
      json: async () => ({ foods: [], products: [] }),
    }));
    const service = new FoodService(stub<PrismaService>({
      foodItem: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, id: `00000000-0000-4000-8000-00000000000${rows.length + 1}` };
          rows.push(row);
          return row;
        }),
      },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Prisma.sql(strings, ...values);
        return sql.values.includes('viewer') ? rows : [];
      }),
    }));
    const common = {
      name: 'Protein bar', brand_or_restaurant: 'Acme',
      serving_description: '1 bar', serving_size_grams: 50,
      calories: 180, fat_g: 5,
    };
    const higherProtein = await service.create({ ...common, protein_g: 20, carbs_g: 15 }, 'viewer');
    const higherCarb = await service.create({ ...common, protein_g: 10, carbs_g: 25 }, 'viewer');

    const fresh = await service.search('protein bar', 50, 'viewer');
    const cached = await service.search('protein bar', 50, 'viewer');
    const expected = [higherProtein.id, higherCarb.id].sort();

    expect(fresh.results.map((food) => food.id).sort()).toEqual(expected);
    expect(cached.results.map((food) => food.id).sort()).toEqual(expected);
    expect(fresh.results.map((food) => food.protein_g).sort((a, b) => a - b)).toEqual([10, 20]);
  });
});
