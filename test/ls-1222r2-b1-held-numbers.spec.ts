import { NotFoundException } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import { numbersCanBeTrue } from '../src/food/food-truth';
import { LogService } from '../src/log/log.service';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
const viewer = 'review-viewer';
const date = '2026-11-05';
const base = {
  id: 'held-food', name: 'Cereal', created_by_user_id: null, nutrient_basis: 'PER_100G' as const,
  serving_size_grams: 100, serving_description: '100 g', fiber_g: null,
  tags: ['usda:1222201'], calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1,
};
const validProduct = {
  code: '1222201', product_name: 'Cereal', nutriments: {
    'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 4.4,
  },
};
const validUSDA = {
  fdcId: 1222201, description: 'Cereal', dataType: 'SR Legacy', foodNutrients: [
    { nutrientName: 'Energy', unitName: 'KCAL', value: 100 },
    { nutrientName: 'Protein', unitName: 'G', value: 5 },
    { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 10 },
    { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 4.4 },
  ],
};

function world(row: Record<string, unknown>) {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
    ({ id: 'new-entry', ...data, quantity_multiplier: 1, food_item: row }));
  const prisma = stub<PrismaService>({
    foodItem: {
      findUnique: jest.fn().mockResolvedValue(row), findFirst: jest.fn().mockResolvedValue(row),
    },
    savedMeal: { findFirst: jest.fn().mockResolvedValue({
      id: 'meal', user_id: viewer, items: [{ position: 0, food_item_id: row.id, quantity_multiplier: 1 }],
    }) },
    loggedFoodEntry: { create },
    $transaction: jest.fn(async (writes: Array<Promise<unknown>>) => Promise.all(writes)),
  });
  const food = new FoodService(prisma);
  const analytics = stub<ConstructorParameters<typeof LogService>[2]>({ capture: jest.fn() });
  const ptm = stub<ConstructorParameters<typeof LogService>[3]>({ emit: jest.fn() });
  const context = stub<ConstructorParameters<typeof LogService>[4]>({ invalidateForUser: jest.fn() });
  return {
    food, create,
    log: new LogService(prisma, food, analytics, ptm, context),
    saved: new SavedFoodsService(prisma, food, analytics, ptm, context),
  };
}

describe('LS-1222R2 B1: validate the numbers actually used for a new entry', () => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => {
    process.env.USDA_API_KEY = 'fixture-key';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => stub<Response>({
      ok: true, status: 200, json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
        ? validUSDA : { product: validProduct },
    }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it.each([
    ['hard calorie cap', { calories: 950, protein_g: 1, carbs_g: 1, fat_g: 100 }],
    ['hard macro cap', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0 }],
    ['energy gap', { calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1 }],
  ])('saved UUID rejects %s before logging, not only during synthetic import', async (_label, numbers) => {
    const row = { ...base, ...numbers };
    expect(numbersCanBeTrue(row)).toBe(false);
    const w = world(row);
    await expect(w.log.logFood(viewer, {
      food_item_id: row.id, date, meal_type: 'breakfast',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(w.create).not.toHaveBeenCalled();
  });

  it('an existing saved meal also refuses impossible held numbers before its transaction', async () => {
    const w = world(base);
    await expect(w.saved.logSavedMeal(viewer, 'meal', { date, meal_type: 'breakfast' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(w.create).not.toHaveBeenCalled();
  });

  it.each(['usda_', 'off_', 'barcode'] as const)(
    '%s cannot approve impossible stored numbers merely because a different source payload is valid',
    async (path) => {
      const row = { ...base, barcode: '1222201',
        tags: path === 'usda_' ? ['usda:1222201', 'basic-food'] : ['off:1222201'] };
      const w = world(row);
      expect(numbersCanBeTrue(row)).toBe(false);
      const request = path === 'barcode' ? w.food.lookupByBarcode('1222201', viewer)
        : w.food.resolveOrImportId(`${path}1222201`, viewer);
      await expect(request).rejects.toThrow(/not found/i);
    },
  );

  it('control: a source alcohol amount that makes the stored wine true may still admit that row', async () => {
    const row = { ...base, calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0,
      barcode: '1222201', tags: ['off:1222201'] };
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ product: {
        code: '1222201', product_name: 'Wine', nutriments: {
          'energy-kcal_100g': 83, proteins_100g: 0.1, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13,
        },
      } }),
    }));
    await expect(world(row).food.lookupByBarcode('1222201', viewer)).resolves.toBe(row.id);
  });
});
