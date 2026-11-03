/**
 * FOOD-USDA-BE: scripts/release.sh step 6 — every deploy adds the USDA foods the shared catalog is missing.
 *
 * Reads prisma/data/usda-foods.jsonl.gz (built from USDA's own SR Legacy and Foundation CSV files by
 * scripts/usda-foods/build.py) and, for each food the shared catalog lacks, inserts one FoodItem row exactly as the
 * live import (FoodService.upsertFromUSDA) stores one: brand NULL, category 'generic', the USDA nutrients per 100 g,
 * and the tags usda:<fdcId>, category:<USDA category> and basic-food. Two differences: the portion (the live import
 * says 100 g, this row says the food's first measured USDA portion, "1 large" 50 g, when USDA lists one) and the fat
 * kinds (saturated, mono, poly), which this row carries from USDA's file and the live import leaves empty.
 *
 * "The shared catalog" is the rows with created_by_user_id NULL; a food is present when a shared row carries its
 * usda:<fdcId> tag, which is also the key upsertFromUSDA reads, so a food the live import already stored is not added
 * again and a food this step added is the one the live import later finds. A member's own food is never read,
 * counted, changed or deleted, and no existing row is ever updated or deleted: the only write is INSERTs of the
 * missing rows, in one transaction under an advisory lock.
 *
 * After the insert it reads the shared catalog again. If any food is still missing, or the database refused the
 * insert, it prints why and exits 1, so release.sh fails and Fly keeps serving the previous image.
 *
 * Runs in the runtime image as a compiled copy (tsconfig.food-seed.json → dist/food-seed/scripts/), with no ts-node,
 * on DIRECT_URL like step 5. Usage: node dist/food-seed/scripts/load-usda-foods.js <usda-foods.jsonl.gz>
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { oneLine } from './seed-built-in-foods';

export interface UsdaFood {
  fdc_id: number;
  data_type: 'SR Legacy' | 'Foundation';
  name: string;
  usda_category: string | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  saturated_fat_g: number | null;
  mono_fat_g: number | null;
  poly_fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  serving_description: string | null;
  serving_size_grams: number | null;
  energy_from: string;
}

/** The tags upsertFromUSDA writes (FoodService: usda:<fdcId>, CATEGORY_TAG + category, BASIC_TAG). */
export const USDA_TAG = 'usda:';
export const CATEGORY_TAG = 'category:';
export const BASIC_TAG = 'basic-food';
/** FoodService's HUNDRED_GRAMS (FOOD-1-BE): a food with no USDA portion is 100 g. */
export const HUNDRED_GRAMS = '100\u00a0g';

/** The row upsertFromUSDA stores for one USDA food, field for field, with the food's own first portion. */
export function usdaFoodRow(food: UsdaFood) {
  return {
    name: food.name,
    brand_or_restaurant: null,
    category: 'generic' as const,
    serving_description: food.serving_description ?? HUNDRED_GRAMS,
    serving_size_grams: food.serving_size_grams ?? 100,
    calories: food.calories,
    protein_g: food.protein_g,
    carbs_g: food.carbs_g,
    fat_g: food.fat_g,
    saturated_fat_g: food.saturated_fat_g,
    mono_fat_g: food.mono_fat_g,
    poly_fat_g: food.poly_fat_g,
    fiber_g: food.fiber_g,
    sugar_g: food.sugar_g,
    sodium_mg: food.sodium_mg,
    tags: [
      `${USDA_TAG}${food.fdc_id}`,
      ...(food.usda_category ? [`${CATEGORY_TAG}${food.usda_category}`] : []),
      BASIC_TAG,
    ],
    search_aliases: [],
    image_url: null,
    nutrient_basis: 'PER_100G' as const,
  };
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNumberOrNull = (v: unknown) => v === null || isNumber(v);

/**
 * Parse the data file: gzip of JSON lines, line 1 the build description, every other line one food. Refuses an
 * empty list, a count that disagrees with line 1, a food twice, or a row with a missing or non-numeric figure.
 */
export function parseUsdaFoods(gz: Buffer): UsdaFood[] {
  const lines = gunzipSync(gz).toString('utf8').split('\n').filter((l) => l !== '');
  const header = JSON.parse(lines[0] ?? 'null') as { foods?: unknown } | null;
  const foods = lines.slice(1).map((l) => JSON.parse(l) as UsdaFood);
  if (foods.length === 0) throw new Error('USDA food file has no foods');
  if (header?.foods !== foods.length) {
    throw new Error(`USDA food file says ${String(header?.foods)} foods but holds ${foods.length}`);
  }
  const seen = new Set<number>();
  for (const f of foods) {
    const ok =
      Number.isSafeInteger(f?.fdc_id) && f.fdc_id > 0 &&
      typeof f.name === 'string' && f.name.trim() !== '' &&
      (f.usda_category === null || typeof f.usda_category === 'string') &&
      [f.calories, f.protein_g, f.carbs_g, f.fat_g].every(isNumber) &&
      [f.saturated_fat_g, f.mono_fat_g, f.poly_fat_g, f.fiber_g, f.sugar_g, f.sodium_mg].every(isNumberOrNull) &&
      ((f.serving_description === null && f.serving_size_grams === null) ||
        (typeof f.serving_description === 'string' && f.serving_description !== '' &&
          isNumber(f.serving_size_grams) && f.serving_size_grams > 0));
    if (!ok) throw new Error(`USDA food file has a bad row: ${JSON.stringify(f).slice(0, 200)}`);
    if (seen.has(f.fdc_id)) throw new Error(`USDA food file lists fdc_id ${f.fdc_id} twice`);
    seen.add(f.fdc_id);
  }
  return foods;
}

export interface UsdaLoadResult {
  total: number;
  present: number;
  added: number;
  missing: number;
}

/** The usda:<fdcId> tags of the file's foods that a shared row already carries. */
async function sharedTags(tx: Prisma.TransactionClient, tags: string[]): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ tag: string }[]>`
    SELECT DISTINCT t AS tag
    FROM "FoodItem", unnest(tags) AS t
    WHERE created_by_user_id IS NULL AND tags && ${tags}::text[] AND t = ANY(${tags}::text[])
  `;
  return new Set(rows.map((r) => r.tag));
}

const INSERT_BATCH = 1000;

/**
 * Insert the USDA foods the shared catalog lacks, then count what is present. Never updates or deletes. One
 * transaction under a transaction-scoped advisory lock (its own key, not step 5's), so two release runs at once
 * cannot both add the same food, and a refused insert leaves nothing half-written.
 */
export async function loadUsdaFoods(prisma: PrismaClient, foods: UsdaFood[]): Promise<UsdaLoadResult> {
  const tagOf = (f: UsdaFood) => `${USDA_TAG}${f.fdc_id}`;
  const tags = foods.map(tagOf);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('food-usda-be:usda-foods'))`;
      const before = await sharedTags(tx, tags);
      const toAdd = foods.filter((f) => !before.has(tagOf(f)));
      let added = 0;
      for (let i = 0; i < toAdd.length; i += INSERT_BATCH) {
        added += (await tx.foodItem.createMany({ data: toAdd.slice(i, i + INSERT_BATCH).map(usdaFoodRow) })).count;
      }
      const after = await sharedTags(tx, tags);
      const missing = tags.filter((t) => !after.has(t)).length;
      return { total: foods.length, present: foods.length - missing, added, missing };
    },
    { maxWait: 30_000, timeout: 300_000 },
  );
}

export async function main(argv: string[]): Promise<number> {
  const file = argv[2];
  if (!file) throw new Error('usage: load-usda-foods <path to usda-foods.jsonl.gz>');
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is not set');
  const foods = parseUsdaFoods(readFileSync(file));
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const started = Date.now();
    const r = await loadUsdaFoods(prisma, foods);
    // eslint-disable-next-line no-console
    console.log(`[release] USDA foods: ${r.present} present, ${r.added} added (${Date.now() - started} ms)`);
    if (r.missing > 0) {
      // eslint-disable-next-line no-console
      console.log(`[release] USDA foods FAILED: ${r.missing} of ${r.total} still missing from the shared catalog`);
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
      console.log(`[release] USDA foods FAILED: ${oneLine(err)}`);
      process.exit(1);
    },
  );
}
