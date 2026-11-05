import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

describe('LS-1222 B3: held USDA imports cannot bypass truth rules on a new log', () => {
  it.each([
    ['over-calorie', { calories: 950, protein_g: 0, carbs_g: 0, fat_g: 100 }],
    ['over-macro', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0 }],
    ['energy gap', { calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1 }],
  ])('an existing USDA %s row is refused before creating a new log entry', async (_name, nums) => {
    const held = {
      id: 'held-usda', name: 'Packaged cereal', ...nums, nutrient_basis: 'PER_100G',
      serving_size_grams: 100, created_by_user_id: null, tags: ['usda:1222003'],
    };
    const food = new FoodService(stub<PrismaService>({ foodItem: {
      findFirst: jest.fn().mockResolvedValue(held),
    } }));
    const loggedFoodEntry = { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ({ id: 'new-log', ...data, food_item: held })) };
    const log = new LogService(
      stub<PrismaService>({ loggedFoodEntry }), food,
      stub({ capture: jest.fn() }), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }),
    );
    await expect(log.logFood('viewer', {
      food_item_id: 'usda_1222003', date: '2026-11-04', meal_type: 'breakfast',
    })).rejects.toThrow(/not found/);
    expect(loggedFoodEntry.create).not.toHaveBeenCalled();
  });
});
