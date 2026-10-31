import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

// The real seed and the public food-read mapper must agree about a measured cup.
// This is not a demand for precision from a food with no known household measure.
const seeds = JSON.parse(readFileSync(join(__dirname, '../prisma/data/seed-foods.json'), 'utf8')) as Array<Record<string, unknown>>;

describe('LS-FOOD B1: known seeded household measures', () => {
  it.each([
    ['Oats, rolled, dry', 80],
    ['Rice, white, long-grain, cooked', 158],
  ])('%s keeps the cup weight implied by its own serving description', async (name, cupGrams) => {
    const seed = seeds.find((row) => row.name === name);
    expect(seed).toBeDefined();
    // Same category and category tag as prisma/seed-foods.ts, not a rewritten fixture.
    const row = {
      ...seed, id: 'seed-food', created_by_user_id: null,
      category: 'generic', tags: [`category:${String(seed?.food_category)}`],
      nutrient_basis: 'PER_100G', brand_or_restaurant: seed?.brand ?? null,
    };
    const prisma = { foodItem: { findUnique: jest.fn().mockResolvedValue(row) } };
    const service = new FoodService(prisma as unknown as PrismaService);
    const result = await service.getById('seed-food', 'viewer');
    expect(result?.supports_volume_units).toBe(true);
    // The picker uses cup_grams / 100 as its PER_100G multiplier.
    expect(result?.cup_grams).toBe(cupGrams);
  });
});
