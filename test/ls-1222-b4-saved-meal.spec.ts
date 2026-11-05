import { FoodService } from '../src/food/food.service';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

describe('LS-1222 B4 saved-meal consumer: no new fabricated-zero entry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('newly logging an existing meal verifies its legacy packaged food first', async () => {
    const held = {
      id: 'held-packaged', name: 'Packaged cereal', calories: 60, protein_g: 0, carbs_g: 15, fat_g: 0,
      serving_size_grams: 100, nutrient_basis: 'PER_100G', created_by_user_id: null, tags: ['off:1222004'],
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ product: {
        code: '1222004', product_name: held.name, nutriments: {
          'energy-kcal_100g': 60, carbohydrates_100g: 15, fat_100g: 0,
        },
      } }),
    }));
    const entry = { id: 'new-entry', food_item: held, quantity_multiplier: 1 };
    const create = jest.fn().mockResolvedValue(entry);
    const prisma = stub<PrismaService>({
      foodItem: { findUnique: jest.fn().mockResolvedValue(held), findFirst: jest.fn().mockResolvedValue(held) },
      savedMeal: { findFirst: jest.fn().mockResolvedValue({
        id: 'saved-meal', user_id: 'viewer', items: [
          { position: 0, food_item_id: held.id, food_item: held, quantity_multiplier: 1 },
        ],
      }) },
      loggedFoodEntry: { create },
      $transaction: jest.fn(async (writes: Array<Promise<typeof entry>>) => Promise.all(writes)),
    });
    const service = new SavedFoodsService(
      prisma, new FoodService(prisma), stub({ capture: jest.fn() }),
      stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }),
    );
    await expect(service.logSavedMeal('viewer', 'saved-meal', {
      date: '2026-11-04', meal_type: 'breakfast',
    })).rejects.toThrow(/not found/i);
    expect(create).not.toHaveBeenCalled();
  });
});
