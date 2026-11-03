/**
 * FR-1203 (LS-1203 B1) — live proof that release step 5 decides "same food" with one folding: lower case, each
 * whitespace run as one space, no space at either end. Its SQL filter, its in-memory key and its after-insert
 * "still missing" count all fold alike, so a shared row that names a seed food in other case or spacing (a normal
 * USDA import such as "EGG, WHOLE, RAW") counts as present and is never changed, while a different brand, a different
 * spelling or a member's own food does not make the seed food present (and the member's row is never changed).
 * Each case goes end to end through seedBuiltInFoods on this suite's copy of rls_replay. Runs in rls-live-tests.
 * Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { FoodService } from '../../src/food/food.service';
import type { PrismaService } from '../../src/prisma.service';
import { parseSeedFoods, seedBuiltInFoods, seedFoodRow, type SeedFood } from '../../scripts/seed-built-in-foods';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-seed-fold-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const foods = parseSeedFoods(readFileSync(join(__dirname, '../../prisma/data/seed-foods.json'), 'utf8'));
function seedFood(name: string): SeedFood {
  const f = foods.find((x) => x.name === name);
  if (!f) throw new Error(`seed food ${name} missing`);
  return f;
}
const egg = seedFood('Egg, whole, raw');
const breast = seedFood('Chicken breast, raw, skinless');
const N = foods.length;
function serviceView(p: unknown): PrismaService {
  return p as PrismaService;
}

(DB_URL ? describe : describe.skip)('FR-1203: step 5 folds names one way in SQL, in its key and in its after-check', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const member = randomUUID();
  let fetchSpy: jest.SpyInstance | undefined;
  let oldKey: string | undefined;

  const sharedRow = (name: string, brand: string | null = null) =>
    prisma.foodItem.create({
      data: { name, brand_or_restaurant: brand, serving_description: '100 g', serving_size_grams: 100, calories: 3,
        protein_g: 0, carbs_g: 0, fat_g: 0, tags: ['usda:999'], search_aliases: [] },
    });

  // A normal USDA import through the app's own path; the FDC answer is a fixture, never a live call.
  async function importUsda(fdcId: number, description: string, f: SeedFood) {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        fdcId,
        description,
        foodCategory: 'Synthetic',
        foodNutrients: [
          { nutrientName: 'Energy', unitName: 'KCAL', value: f.calories },
          { nutrientName: 'Protein', unitName: 'G', value: f.protein_g },
          { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: f.carbs_g },
          { nutrientName: 'Total lipid (fat)', unitName: 'G', value: f.fat_g },
        ],
      }),
    } as Response);
    const id = await new FoodService(serviceView(prisma)).resolveOrImportId(`usda_${fdcId}`, 'synthetic-viewer');
    fetchSpy.mockRestore();
    fetchSpy = undefined;
    return prisma.foodItem.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(async () => {
    oldKey = process.env.USDA_API_KEY;
    process.env.USDA_API_KEY = 'synthetic-test-key';
    await prisma.user.create({
      data: { id: member, supabase_id: randomUUID(), email: `${member}@example.test`, name: 'Fold member', role: 'student' },
    });
  });
  beforeEach(async () => {
    await prisma.foodItem.deleteMany({});
  });
  afterEach(() => fetchSpy?.mockRestore());
  afterAll(async () => {
    if (oldKey === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = oldKey;
    await prisma.foodItem.deleteMany({});
    await prisma.user.deleteMany({ where: { id: member } });
    await prisma.$disconnect();
  });

  it.each([
    ['Egg, whole, raw'],
    ['EGG, WHOLE, RAW'],
    ['Egg, Whole, Raw'],
    ['  egg,   whole,\traw '],
    ['Egg,\nwhole,\r\nraw'],
    ['Egg,\u00a0whole,\u3000raw\u00a0'],
  ])('a shared row named %j is the seed food: present, not added, not changed', async (name) => {
    const row = await sharedRow(name);
    expect(await seedBuiltInFoods(prisma, [egg])).toEqual({ total: 1, present: 1, added: 0, missing: 0 });
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.foodItem.count()).toBe(1);
  });

  it.each([['Egg,whole,raw'], ['Eggs, whole, raw'], ['Egg, whole, raw, organic'], ['Egg-whole-raw']])(
    'a shared row named %j is another food: the seed food is added once, the row is not changed',
    async (name) => {
      const row = await sharedRow(name);
      expect(await seedBuiltInFoods(prisma, [egg])).toEqual({ total: 1, present: 1, added: 1, missing: 0 });
      expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
      expect(await prisma.foodItem.count()).toBe(2);
    },
  );

  it('a different brand is a different food, in any case or spacing of the name', async () => {
    const row = await sharedRow('EGG,  WHOLE, RAW', 'Acme Farms');
    expect(await seedBuiltInFoods(prisma, [egg])).toEqual({ total: 1, present: 1, added: 1, missing: 0 });
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it('brands fold too: a branded seed food matches its shared row in other case or spacing', async () => {
    const branded: SeedFood = { ...egg, brand: 'Acme Farms' };
    const row = await sharedRow('egg, whole, raw', '  ACME   farms ');
    expect(await seedBuiltInFoods(prisma, [branded])).toEqual({ total: 1, present: 1, added: 0, missing: 0 });
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it("a member's own food named like a seed food in other case is not read for presence and not changed", async () => {
    const mine = await prisma.foodItem.create({
      data: { name: 'EGG, WHOLE, RAW', serving_description: 'my egg', serving_size_grams: 50, calories: 1, protein_g: 0,
        carbs_g: 0, fat_g: 0, tags: ['mine'], search_aliases: [], created_by_user_id: member },
    });
    expect(await seedBuiltInFoods(prisma, [egg])).toEqual({ total: 1, present: 1, added: 1, missing: 0 });
    expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: mine.id } })).toEqual(mine);
    const added = await prisma.foodItem.findFirstOrThrow({ where: { created_by_user_id: null } });
    expect(added.name).toBe(egg.name);
  });

  it('the whole file, twice, with normal USDA imports already there (one names a seed food in other case)', async () => {
    const usdaEgg = await importUsda(171287, 'EGG, WHOLE, RAW', egg);
    const usdaBreast = await importUsda(171477, 'Chicken  breast, raw, skinless', breast);
    const usdaOther = await importUsda(168153, 'Kiwifruit, green, raw', egg);
    const mine = await prisma.foodItem.create({
      data: { ...seedFoodRow(egg), name: 'egg, whole, raw', created_by_user_id: member, tags: ['mine'] },
    });
    const kept = [usdaEgg, usdaBreast, usdaOther, mine];
    expect(usdaEgg.created_by_user_id).toBeNull();
    // A normal USDA import: it carries its usda:<fdcId> tag (main also adds a category:<USDA category> tag, allowed).
    expect(usdaEgg.tags).toContain('usda:171287');

    const first = await seedBuiltInFoods(prisma, foods);
    const second = await seedBuiltInFoods(prisma, foods);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ probe: 'FR-1203 fold, whole file twice', first, second }));
    expect(first).toEqual({ total: N, present: N, added: N - 2, missing: 0 });
    expect(second).toEqual({ total: N, present: N, added: 0, missing: 0 });
    for (const row of kept) expect(await prisma.foodItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: null } })).toBe(N + 1);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: null, name: egg.name } })).toBe(0);
    expect(await prisma.foodItem.count({ where: { created_by_user_id: null, name: breast.name } })).toBe(0);
  });
});
