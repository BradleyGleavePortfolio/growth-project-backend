/**
 * Seed the local FoodItem catalog from a curated static fixture.
 *
 * Why static instead of a live USDA fetch? Two reasons:
 *
 *  1. Reproducibility. Live USDA pulls drift over time (their server-side
 *     reformulations occasionally adjust per-100g values for branded items);
 *     a JSON fixture is auditable and diff-able.
 *  2. Boot-time independence. `npm run seed:foods` works in CI / Fly preview
 *     deploys / contributor laptops that have no USDA_API_KEY configured
 *     (free key takes ~1 minute at https://api.data.gov/signup).
 *
 * All values are per 100g (nutrient_basis = PER_100G). Hand-verified against
 * USDA FDC for the entries included; quantity (~50-100) was chosen over
 * volume to avoid hallucinating per-100g numbers we cannot vouch for.
 *
 * Usage:
 *   npm run seed:foods                 # fresh insert
 *   npm run seed:foods -- --refresh    # update existing rows with the seed values
 *
 * Idempotent: keyed on (name, brand_or_restaurant). Re-runs are safe — they
 * either no-op or refresh existing rows in --refresh mode.
 */

import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';

interface SeedFood {
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

async function main() {
  const prisma = new PrismaClient();
  const refresh = process.argv.includes('--refresh');
  const fixturePath = path.join(__dirname, 'data', 'seed-foods.json');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const foods = JSON.parse(raw) as SeedFood[];

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const food of foods) {
    const existing = await prisma.foodItem.findFirst({
      where: { name: food.name, brand_or_restaurant: food.brand },
    });

    const data = {
      name: food.name,
      brand_or_restaurant: food.brand,
      // food_category is the USDA-style human label (e.g. "Poultry Products");
      // we map it onto the local enum bucket "generic" — that enum is for
      // mobile UI grouping, not nutrition. The richer USDA label travels via
      // tags so density lookups (food-density.ts) can still hit.
      category: 'generic' as const,
      serving_description: food.serving_description,
      serving_size_grams: food.serving_size_grams,
      calories: food.calories,
      protein_g: food.protein_g,
      carbs_g: food.carbs_g,
      fat_g: food.fat_g,
      fiber_g: food.fiber_g,
      sugar_g: food.sugar_g,
      tags: [...(food.tags ?? []), `category:${food.food_category}`, 'seed:common-foods'],
      search_aliases: [],
      nutrient_basis: 'PER_100G' as const,
    };

    if (existing) {
      if (refresh) {
        await prisma.foodItem.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        skipped++;
      }
    } else {
      await prisma.foodItem.create({ data });
      inserted++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `seed-foods: ${inserted} inserted, ${updated} updated, ${skipped} skipped (${foods.length} total)`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed-foods failed:', err);
  process.exit(1);
});
