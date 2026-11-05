import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
type Row = Record<string, unknown>;
type Food = {
  name: string; calories: number; protein_g: number; carbs_g: number; fat_g: number;
  fiber_g?: number; alcohol_g?: number; polyols_g?: number;
};
// Named SR Legacy examples are present in prisma/data/usda-foods.jsonl.gz.
// Erythritol: https://www.fda.gov/media/132946/download, page 50.
const foods: Food[] = [
  { name: 'Oil', calories: 884, protein_g: 0, carbs_g: 0, fat_g: 100 },
  { name: 'Butter', calories: 717, protein_g: 0.9, carbs_g: 0.1, fat_g: 81.1 },
  { name: 'Wine', calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0, alcohol_g: 10.6 },
  { name: 'Spirit', calories: 231, protein_g: 0, carbs_g: 0, fat_g: 0, alcohol_g: 33 },
  { name: 'Sparkling water', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  { name: 'Salt', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  { name: 'Cinnamon', calories: 247, protein_g: 4, carbs_g: 80.6, fat_g: 1.2, fiber_g: 53.1 },
  { name: 'Cloves', calories: 274, protein_g: 6, carbs_g: 65.5, fat_g: 13, fiber_g: 33.9 },
  { name: 'Protein powder', calories: 400, protein_g: 80, carbs_g: 10, fat_g: 4.4 },
  { name: 'Sugar', calories: 400, protein_g: 0, carbs_g: 100, fat_g: 0 },
  { name: 'Erythritol', calories: 0, protein_g: 0, carbs_g: 99.9, fat_g: 0, polyols_g: 99.9 },
  { name: 'Cocoa', calories: 228, protein_g: 19.6, carbs_g: 57.9, fat_g: 13.7, fiber_g: 37 },
  { name: 'Oat bran', calories: 246, protein_g: 17.3, carbs_g: 66.2, fat_g: 7, fiber_g: 15.4 },
  { name: 'Lard', calories: 902, protein_g: 0, carbs_g: 0, fat_g: 100 },
  { name: 'Cod liver oil', calories: 902, protein_g: 0, carbs_g: 0, fat_g: 100 },
];
const paths = [
  'catalog search', 'short list', 'USDA search', 'OFF search', 'fresh barcode',
  'held barcode', 'fresh USDA import', 'held USDA import', 'fresh OFF import', 'held OFF import',
] as const;

describe.each(foods)('LS-1222 complete real food: $name', (food) => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it.each(paths)('%s accepts rather than falsely hiding the food', async (path) => {
    const stored = {
      id: 'stored-food', ...food, serving_size_grams: 100, serving_description: '100 g',
      nutrient_basis: 'PER_100G', created_by_user_id: null, word_match: 0,
      // FIX-1222: a row stored by this import keeps the alcohol its source listed as a tag (no alcohol column); a
      // loaded row stored without it is the found-not-fixed case (FIX-1222 READY), read through its source on a log.
      tags: ['usda:1222010', ...(food.alcohol_g === undefined ? [] : [`truth:alcohol_g=${food.alcohol_g}`])],
      barcode: '1222010',
    };
    const usda = {
      fdcId: 1222010, description: food.name, dataType: 'Branded', foodNutrients: [
        { nutrientName: 'Energy', unitName: 'KCAL', value: food.calories },
        { nutrientName: 'Protein', unitName: 'G', value: food.protein_g },
        { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: food.carbs_g },
        { nutrientName: 'Total lipid (fat)', unitName: 'G', value: food.fat_g },
        ...(food.alcohol_g === undefined ? [] : [{ nutrientName: 'Alcohol, ethyl', unitName: 'G', value: food.alcohol_g }]),
        ...(food.fiber_g === undefined ? [] : [{ nutrientName: 'Fiber, total dietary', unitName: 'G', value: food.fiber_g }]),
        ...(food.polyols_g === undefined ? [] : [{ nutrientName: 'Sugar alcohols', unitName: 'G', value: food.polyols_g }]),
      ],
    };
    const product = {
      code: '1222010', product_name: food.name, nutriments: {
        'energy-kcal_100g': food.calories, proteins_100g: food.protein_g,
        carbohydrates_100g: food.carbs_g, fat_100g: food.fat_g,
        ...(food.alcohol_g === undefined ? {} : { alcohol_100g: food.alcohol_g / 0.789 }),
        ...(food.fiber_g === undefined ? {} : { fiber_100g: food.fiber_g }),
        ...(food.polyols_g === undefined ? {} : { polyols_100g: food.polyols_g }),
      },
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const text = String(url);
      const body = text.includes('/food/') ? usda : text.includes('/product/') ? { product }
        : text.includes('api.nal.usda.gov') ? { foods: path === 'USDA search' ? [usda] : [] }
          : { products: path === 'OFF search' ? [product] : [] };
      return stub<Response>({ ok: true, status: 200, json: async () => body });
    });
    const foodItem = {
      findMany: jest.fn().mockResolvedValue([stored]),
      findFirst: jest.fn().mockResolvedValue(path === 'held USDA import' ? stored : null),
      findUnique: jest.fn().mockResolvedValue(path.startsWith('held') ? stored : null),
      create: jest.fn().mockResolvedValue(stored),
      upsert: jest.fn().mockResolvedValue(stored),
    };
    const service = new FoodService(stub<PrismaService>({
      foodItem,
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> =>
        path === 'catalog search' && Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [stored] : []),
    }));
    if (path.includes('search') || path === 'short list') {
      expect((await service.search(path === 'short list' ? '' : food.name, 50, 'viewer')).results).toHaveLength(1);
    } else {
      const request = path.includes('barcode') ? service.lookupByBarcode('1222010', 'viewer')
        : service.resolveOrImportId(`${path.includes('USDA') ? 'usda' : 'off'}_1222010`, 'viewer');
      await expect(request).resolves.toBe('stored-food');
    }
  });
});
