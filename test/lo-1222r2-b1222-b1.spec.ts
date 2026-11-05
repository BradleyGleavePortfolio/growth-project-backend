import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

// LO-1222R2 B1: a stored shared row read by its saved id (Recents, favourites, saved meals) must pass the same
// numbers check that the same row passes when read through its usda_/off_ id (LS-1222 B3 class).
describe('LO-1222R2 B1: a held row read by its saved id passes the same numbers check', () => {
  const rows: Array<[string, Record<string, unknown>]> = [
    ['over-calorie USDA', { calories: 950, protein_g: 0, carbs_g: 0, fat_g: 100, tags: ['usda:1222003'] }],
    ['over-macro USDA', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0, tags: ['usda:1222003'] }],
    ['energy-gap USDA', { calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1, tags: ['usda:1222003'] }],
    ['kJ-as-kcal Open Food Facts', { calories: 418, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.6, barcode: '1222000000001', tags: ['off:1222000000001'] }],
  ];

  const realFetch = global.fetch;
  beforeEach(() => {
    // The source has no better record (404), so a stored row that fails stays refused.
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = realFetch; });

  it.each(rows)('a shared %s row is refused on a new log by its id', async (_name, nums) => {
    const held = {
      id: '11111111-2222-4333-8444-555555555555', name: 'Stored food', nutrient_basis: 'PER_100G',
      serving_size_grams: 100, created_by_user_id: null, barcode: null, ...nums,
    };
    const food = new FoodService(stub<PrismaService>({ foodItem: {
      findUnique: jest.fn().mockResolvedValue(held),
      findFirst: jest.fn().mockResolvedValue(held),
    } }));
    const loggedFoodEntry = { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
      ({ id: 'new-log', ...data, food_item: held })) };
    const log = new LogService(
      stub<PrismaService>({ loggedFoodEntry }), food,
      stub({ capture: jest.fn() }), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }),
    );
    await expect(log.logFood('viewer', {
      food_item_id: held.id, date: '2026-11-04', meal_type: 'breakfast',
    })).rejects.toThrow(/not found/);
    expect(loggedFoodEntry.create).not.toHaveBeenCalled();
  });

  it('control: a shared row whose numbers can be true still logs by its id', async () => {
    const held = {
      id: '11111111-2222-4333-8444-555555555556', name: 'Stored oats', nutrient_basis: 'PER_100G', serving_size_grams: 100,
      created_by_user_id: null, barcode: null, calories: 389, protein_g: 16.9, carbs_g: 66.3, fat_g: 6.9, tags: ['usda:1222004'],
    };
    const food = new FoodService(stub<PrismaService>({ foodItem: { findUnique: jest.fn().mockResolvedValue(held) } }));
    await expect(food.resolveOrImportId(held.id, 'viewer')).resolves.toBe(held.id);
  });
});
