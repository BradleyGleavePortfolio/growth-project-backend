/**
 * LS-1203 independent catalog identity probes. Test-only PostgreSQL, guarded
 * by liveTestDatabaseUrl; upstream HTTP is a fixture, never a live API call.
 * The RED expectations exercise the public USDA import path before step 5.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { FoodService } from '../../src/food/food.service';
import type { PrismaService } from '../../src/prisma.service';
import { parseSeedFoods, seedBuiltInFoods, seedFoodRow } from '../../scripts/seed-built-in-foods';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl({ required: true });
const prisma = new PrismaClient({ datasourceUrl: url });
const foods = parseSeedFoods(readFileSync(join(__dirname, '../../prisma/data/seed-foods.json'), 'utf8'));
const banana = foods.find((f) => f.name === 'Banana, raw');
if (!banana) throw new Error('banana fixture missing');
const fixture = banana;
const normalize = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
function serviceView(p: unknown): PrismaService { return p as PrismaService; }
let fetchSpy: jest.SpyInstance;
let oldKey: string | undefined;

beforeAll(() => {
  oldKey = process.env.USDA_API_KEY;
  process.env.USDA_API_KEY = 'synthetic-test-key';
});
beforeEach(async () => {
  await prisma.foodItem.deleteMany({});
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ foods: [], products: [] }),
  } as Response);
});
afterEach(() => fetchSpy.mockRestore());
afterAll(async () => {
  if (oldKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = oldKey;
  await prisma.$disconnect();
});

async function importBanana(description: string) {
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      fdcId: 123456,
      description,
      foodCategory: 'Fruits and Fruit Juices',
      foodNutrients: [
        { nutrientName: 'Energy', unitName: 'KCAL', value: fixture.calories },
        { nutrientName: 'Protein', unitName: 'G', value: fixture.protein_g },
        { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: fixture.carbs_g },
        { nutrientName: 'Total lipid (fat)', unitName: 'G', value: fixture.fat_g },
        { nutrientName: 'Fiber, total dietary', unitName: 'G', value: fixture.fiber_g },
        { nutrientName: 'Sugars, total', unitName: 'G', value: fixture.sugar_g },
      ],
    }),
  } as Response);
  return new FoodService(serviceView(prisma)).resolveOrImportId('usda_123456', 'synthetic-viewer');
}

it('control: an exact USDA import satisfies the shared presence check without changing it', async () => {
  const id = await importBanana(fixture.name);
  const before = await prisma.foodItem.findUniqueOrThrow({ where: { id } });
  expect(await seedBuiltInFoods(prisma, [fixture])).toEqual({ total: 1, present: 1, added: 0, missing: 0 });
  expect(await prisma.foodItem.findUniqueOrThrow({ where: { id } })).toEqual(before);
  expect(await prisma.foodItem.count()).toBe(1);
});

it.each(['BANANA, RAW', 'Banana,  raw'])(
  'LS-1203 B1: normal USDA import %s must not make step 5 add the same normalized food again',
  async (description) => {
    const id = await importBanana(description);
    const imported = await prisma.foodItem.findUniqueOrThrow({ where: { id } });
    expect(imported.name).toBe(description);
    expect(imported.created_by_user_id).toBeNull();
    expect(imported.brand_or_restaurant).toBeNull();
    expect(normalize(imported.name)).toBe(normalize(fixture.name));
    const result = await seedBuiltInFoods(prisma, [fixture]);
    const rows = await prisma.foodItem.findMany();
    const visible = await new FoodService(serviceView(prisma)).search('', 20, 'synthetic-viewer');
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id } })).toEqual(imported);
    console.log(JSON.stringify({
      probe: 'LS-1203-B1',
      description,
      result,
      normalizedCopies: rows.filter((r) => normalize(r.name) === normalize(fixture.name)).length,
      defaultPickerNames: visible.results.map((r) => r.name),
    }));
    expect(result.added).toBe(0);
    expect(rows).toHaveLength(1);
  },
);

it.each(['', ' ', '   '])('diagnostic only: exact NULL brand differs from legacy blank brand %j', async (brand) => {
  const old = await prisma.foodItem.create({
    data: { ...seedFoodRow(fixture), brand_or_restaurant: brand, tags: ['legacy-diagnostic'] },
  });
  const r = await seedBuiltInFoods(prisma, [fixture]);
  expect(r.added).toBe(1);
  expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
  expect(await prisma.foodItem.count()).toBe(2);
  console.log(JSON.stringify({ probe: 'blank-brand-limitation', brand, added: r.added }));
});
