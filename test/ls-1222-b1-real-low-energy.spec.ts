import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
type Row = Record<string, unknown>;

// FDA GRN 886, Zerose specification: 0 kcal, 99.9 g carbohydrate, 0 g protein/fat per 100 g.
// https://www.fda.gov/media/132946/download
const erythritol = { calories: 0, protein_g: 0, carbs_g: 99.9, fat_g: 0 };
const water = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
const controls = [
  ['oil', { calories: 884, protein_g: 0, carbs_g: 0, fat_g: 100 }],
  ['butter', { calories: 717, protein_g: 0.9, carbs_g: 0.1, fat_g: 81.1 }],
  ['salt', water],
  ['protein powder', { calories: 400, protein_g: 80, carbs_g: 10, fat_g: 4.4 }],
] as const;

const row = (name: string, nums: Row): Row => ({
  id: 'catalog-1', name, ...nums, serving_size_grams: 100, serving_description: '100 g',
  nutrient_basis: 'PER_100G', created_by_user_id: null, tags: [], word_match: 0,
});
const usda = (name: string, nums: typeof erythritol) => ({
  fdcId: 1222001, description: name, dataType: 'Branded', foodNutrients: [
    { nutrientName: 'Energy', unitName: 'KCAL', value: nums.calories },
    { nutrientName: 'Protein', unitName: 'G', value: nums.protein_g },
    { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: nums.carbs_g },
    { nutrientName: 'Total lipid (fat)', unitName: 'G', value: nums.fat_g },
    { nutrientName: 'Sugar alcohols', unitName: 'G', value: nums.carbs_g },
  ],
});
const off = (name: string, nums: typeof erythritol) => ({
  code: '1222001', product_name: name, nutriments: {
    'energy-kcal_100g': nums.calories, proteins_100g: nums.protein_g,
    carbohydrates_100g: nums.carbs_g, fat_100g: nums.fat_g, polyols_100g: nums.carbs_g,
  },
});

describe('LS-1222 B1: complete real low-energy foods remain usable', () => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it.each(['catalog', 'USDA', 'OFF'] as const)(
    'erythritol remains searchable from %s instead of being treated as impossible',
    async (source) => {
      const product = off('Erythritol', erythritol);
      jest.spyOn(global, 'fetch').mockImplementation(async (url) => stub<Response>({
        ok: true, status: 200, json: async () => String(url).includes('api.nal.usda.gov')
          ? { foods: source === 'USDA' ? [usda('Erythritol', erythritol)] : [] }
          : { products: source === 'OFF' ? [product] : [] },
      }));
      const service = new FoodService(stub<PrismaService>({
        $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
          source === 'catalog' && Prisma.sql(strings, ...values).sql.includes('IS NULL')
            ? [row('Erythritol', erythritol)] : []),
      }));
      expect((await service.search('erythritol', 50, 'viewer')).results).toHaveLength(1);
    },
  );

  it.each(['barcode', 'off_ import', 'usda_ import'] as const)(
    'complete erythritol is usable through %s',
    async (path) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
        ok: true, status: 200, json: async () => path === 'usda_ import'
          ? usda('Erythritol', erythritol) : { product: off('Erythritol', erythritol) },
      }));
      const service = new FoodService(stub<PrismaService>({ foodItem: {
        findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'stored' }), upsert: jest.fn().mockResolvedValue({ id: 'stored' }),
      } }));
      const result = path === 'barcode' ? service.lookupByBarcode('1222001', 'viewer')
        : service.resolveOrImportId(path === 'usda_ import' ? 'usda_1222001' : 'off_1222001', 'viewer');
      await expect(result).resolves.toBe('stored');
    },
  );

  it('a complete zero-calorie drink from OFF remains searchable', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => stub<Response>({
      ok: true, status: 200, json: async () => String(url).includes('api.nal.usda.gov')
        ? { foods: [] } : { products: [off('Sparkling water', water)] },
    }));
    const service = new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue([]) }));
    expect((await service.search('sparkling water', 50, 'viewer')).results).toHaveLength(1);
  });

  it.each(controls)('control: %s still passes every source-neutral number check', async (name, nums) => {
    const { numbersCanBeTrue } = await import('../src/food/food-truth');
    expect(numbersCanBeTrue(stub<Parameters<typeof numbersCanBeTrue>[0]>(row(name, nums)))).toBe(true);
  });
});
