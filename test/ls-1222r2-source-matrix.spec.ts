import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import { numbersCanBeTrue } from '../src/food/food-truth';
import type { PrismaService } from '../src/prisma.service';

const stub = <T>(v: unknown) => v as T;
// Recorded figures from the round-1 source records, transported through both
// adapter shapes. This is not a claim that each transport was queried live.
const foods = [
  { name: 'Cocoa', calories: 228, protein_g: 19.6, carbs_g: 57.9, fat_g: 13.7, fiber_g: 37 },
  { name: 'Oat bran', calories: 246, protein_g: 17.3, carbs_g: 66.2, fat_g: 7, fiber_g: 15.4 },
  { name: 'Wheat bran', calories: 216, protein_g: 15.6, carbs_g: 64.5, fat_g: 4.3, fiber_g: 42.8 },
  { name: 'Cloves', calories: 274, protein_g: 6, carbs_g: 65.5, fat_g: 13, fiber_g: 33.9 },
  { name: 'Stevia leaf extract', calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0, fiber_g: 0 },
  { name: 'Truvia', calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0, fiber_g: 0 },
  { name: 'Erythritol', calories: 0, protein_g: 0, carbs_g: 99.9, fat_g: 0, fiber_g: 0 },
];
const paths = ['catalog', 'short', 'USDA search', 'OFF search', 'fresh barcode', 'held barcode',
  'fresh USDA', 'held USDA', 'fresh OFF', 'held OFF'] as const;
const key = process.env.USDA_API_KEY;
beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
afterEach(() => {
  jest.restoreAllMocks();
  if (key === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = key;
});

describe.each(foods)('LS-1222R2 source consistency: $name', (food) => {
  it.each(paths)('%s preserves the complete food', async (path) => {
    const held = {
      ...food, id: 'stored-food', created_by_user_id: null, nutrient_basis: 'PER_100G',
      serving_size_grams: 100, serving_description: '100 g', word_match: 0,
      tags: ['usda:1222203', 'truth:checked'], barcode: '1222203',
    };
    const source = {
      fdcId: 1222203, description: food.name, dataType: 'Branded', foodNutrients: [
        { nutrientName: 'Energy', unitName: 'KCAL', value: food.calories },
        { nutrientName: 'Protein', unitName: 'G', value: food.protein_g },
        { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: food.carbs_g },
        { nutrientName: 'Total lipid (fat)', unitName: 'G', value: food.fat_g },
        { nutrientName: 'Fiber, total dietary', unitName: 'G', value: food.fiber_g },
      ],
    };
    const product = {
      code: '1222203', product_name: food.name, nutriments: {
        'energy-kcal_100g': food.calories, proteins_100g: food.protein_g,
        carbohydrates_100g: food.carbs_g, fat_100g: food.fat_g, fiber_100g: food.fiber_g,
      },
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      return stub<Response>({
        ok: true, status: 200, json: async () => url.pathname.includes('/food/') ? source
          : url.pathname.includes('/product/') ? { product }
            : url.hostname === 'api.nal.usda.gov' ? { foods: path === 'USDA search' ? [source] : [] }
              : { products: path === 'OFF search' ? [product] : [] },
      });
    });
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        path === 'catalog' && Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [held] : []),
      foodItem: {
        findMany: jest.fn().mockResolvedValue([held]),
        findFirst: jest.fn().mockResolvedValue(path === 'held USDA' ? held : null),
        findUnique: jest.fn().mockResolvedValue(path.startsWith('held') ? held : null),
        create: jest.fn().mockResolvedValue(held), upsert: jest.fn().mockResolvedValue(held),
      },
    }));
    if (path === 'catalog' || path === 'short' || path.endsWith('search')) {
      expect((await service.search(path === 'short' ? '' : food.name, 50, 'viewer')).results).toHaveLength(1);
    } else {
      await expect(path.endsWith('barcode') ? service.lookupByBarcode('1222203', 'viewer')
        : service.resolveOrImportId(`${path.endsWith('USDA') ? 'usda' : 'off'}_1222203`, 'viewer'))
        .resolves.toBe(held.id);
    }
  });
});

describe('LS-1222R2 bounds and loaded alcohol fallback controls', () => {
  it.each([
    [940, 0, 0, 100, true], [940.1, 0, 0, 100, false],
    [400, 100, 0, 0, true], [400, 100.1, 0, 0, false],
    [300, 1, 1, 1, false], [0, 0, 100, 0, true],
  ] as const)('%s kcal and %s/%s/%s macros -> %s', (calories, protein_g, carbs_g, fat_g, expected) => {
    expect(numbersCanBeTrue({ calories, protein_g, carbs_g, fat_g })).toBe(expected);
  });

  it('a typed wine search can fall back to the complete live USDA record without rewriting its held row', async () => {
    const held = {
      id: 'loaded-wine', name: 'Alcoholic beverage, wine, table, red', calories: 85,
      protein_g: 0.1, carbs_g: 2.6, fat_g: 0, created_by_user_id: null,
      nutrient_basis: 'PER_100G', serving_size_grams: 100, serving_description: '100 g',
      tags: ['usda:174837', 'basic-food'], word_match: 0,
    };
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => stub<Response>({
      ok: true, status: 200, json: async () => new URL(String(input)).hostname === 'api.nal.usda.gov'
        ? { foods: [{
          fdcId: 174837, description: held.name, dataType: 'SR Legacy', foodNutrients: [
            { nutrientName: 'Energy', unitName: 'KCAL', value: 85 },
            { nutrientName: 'Protein', unitName: 'G', value: 0.1 },
            { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 2.6 },
            { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0 },
            { nutrientName: 'Alcohol, ethyl', unitName: 'G', value: 10.6 },
          ],
        }] } : { products: [] },
    }));
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [held] : []),
    }));
    expect((await service.search('red wine', 50, 'viewer')).results.map((r) => r.id)).toEqual(['usda_174837']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(held.tags).toEqual(['usda:174837', 'basic-food']);
  });
});
