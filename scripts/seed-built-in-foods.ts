/**
 * FOOD-SEED-BE: scripts/release.sh step 5 — every deploy adds the built-in foods the shared catalog is missing.
 *
 * Reads prisma/data/seed-foods.json (the same file `npm run seed:foods` uses) and, for each food the shared catalog
 * lacks, inserts one FoodItem row exactly as prisma/seed-foods.ts would create it. "The shared catalog" is the rows
 * with created_by_user_id NULL; a food is present when a shared row has the same name and brand_or_restaurant (a NULL
 * brand matches only a NULL brand). A member's own food is never read, counted, changed or deleted, and no existing
 * row is ever updated or deleted: the only write is one INSERT of the missing rows, in one transaction.
 *
 * After the insert it reads the shared catalog again. If any seed food is still missing, or the database refused the
 * insert, it prints why and exits 1, so release.sh fails and Fly keeps serving the previous image.
 *
 * Runs in the runtime image as a compiled copy (tsconfig.food-seed.json → dist/food-seed/scripts/), with no ts-node,
 * on DIRECT_URL like the step 4 verifiers. Usage: node dist/food-seed/scripts/seed-built-in-foods.js <seed-foods.json>
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

export interface SeedFood {
  name: string;
  brand: string | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  serving_size_grams: number;
  serving_description: string;
  food_category: string;
  tags?: string[];
}

export const SEED_TAG = 'seed:common-foods';

/** The row `npm run seed:foods` (prisma/seed-foods.ts) creates for one seed food, field for field. */
export function seedFoodRow(food: SeedFood) {
  return {
    name: food.name,
    brand_or_restaurant: food.brand,
    category: 'generic' as const,
    serving_description: food.serving_description,
    serving_size_grams: food.serving_size_grams,
    calories: food.calories,
    protein_g: food.protein_g,
    carbs_g: food.carbs_g,
    fat_g: food.fat_g,
    fiber_g: food.fiber_g,
    sugar_g: food.sugar_g,
    tags: [...(food.tags ?? []), `category:${food.food_category}`, SEED_TAG],
    search_aliases: [],
    nutrient_basis: 'PER_100G' as const,
  };
}

/** name + brand as one key; JSON keeps a NULL brand distinct from any string brand. */
export function foodKey(name: string, brand: string | null): string {
  return JSON.stringify([name, brand]);
}

/** Parse the seed file; refuses an empty or malformed list so an empty catalog can never pass. */
export function parseSeedFoods(raw: string): SeedFood[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('seed file is not a non-empty JSON array of foods');
  }
  const foods: SeedFood[] = parsed;
  const seen = new Set<string>();
  for (const food of foods) {
    if (typeof food?.name !== 'string' || food.name === '' || !(food.brand === null || typeof food.brand === 'string')) {
      throw new Error('seed file has a food without a name or with a non-text brand');
    }
    const key = foodKey(food.name, food.brand);
    if (seen.has(key)) throw new Error(`seed file lists ${key} twice`);
    seen.add(key);
  }
  return foods;
}

export interface FoodSeedResult {
  total: number;
  present: number;
  added: number;
  missing: number;
}

async function sharedKeys(tx: Prisma.TransactionClient, foods: SeedFood[]): Promise<Set<string>> {
  const rows = await tx.foodItem.findMany({
    where: { created_by_user_id: null, name: { in: [...new Set(foods.map((f) => f.name))] } },
    select: { name: true, brand_or_restaurant: true },
  });
  return new Set(rows.map((r) => foodKey(r.name, r.brand_or_restaurant)));
}

/**
 * Insert the seed foods the shared catalog lacks, then count what is present. Never updates or deletes. One
 * transaction under a transaction-scoped advisory lock, so two release runs at once cannot both add the same food
 * (FoodItem has no unique key on name + brand), and a refused insert leaves nothing half-written.
 */
export async function seedBuiltInFoods(prisma: PrismaClient, foods: SeedFood[]): Promise<FoodSeedResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('food-seed-be:built-in-foods'))`;
      const before = await sharedKeys(tx, foods);
      const toAdd = foods.filter((f) => !before.has(foodKey(f.name, f.brand)));
      const added = toAdd.length > 0 ? (await tx.foodItem.createMany({ data: toAdd.map(seedFoodRow) })).count : 0;
      const after = await sharedKeys(tx, foods);
      const missing = foods.filter((f) => !after.has(foodKey(f.name, f.brand))).length;
      return { total: foods.length, present: foods.length - missing, added, missing };
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
}

/** An error as one deploy-log line (Prisma's messages span several lines and start with a blank one). */
export function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' | ');
  return line.length > 800 ? `${line.slice(0, 800)}…` : line;
}

export async function main(argv: string[]): Promise<number> {
  const file = argv[2];
  if (!file) throw new Error('usage: seed-built-in-foods <path to seed-foods.json>');
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is not set');
  const foods = parseSeedFoods(readFileSync(file, 'utf8'));
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const r = await seedBuiltInFoods(prisma, foods);
    // eslint-disable-next-line no-console
    console.log(`[release] built-in foods: ${r.present} present, ${r.added} added`);
    if (r.missing > 0) {
      // eslint-disable-next-line no-console
      console.log(`[release] built-in foods FAILED: ${r.missing} of ${r.total} still missing from the shared catalog`);
      return 1;
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.log(`[release] built-in foods FAILED: ${oneLine(err)}`);
      process.exit(1);
    },
  );
}
