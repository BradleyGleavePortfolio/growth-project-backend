#!/usr/bin/env ts-node
/**
 * scripts/seed-exercise-catalog.ts
 *
 * One-shot upsert of the canonical exercise catalog rows from the
 * curated SEED_EXERCISES list in src/exercise-library/seed-catalog.ts.
 *
 * Idempotent: each row keys on slug (derived from the seed id) so a
 * second run is a no-op. Re-running after editing instructions or
 * metadata refreshes those fields without touching Mux state.
 *
 * Mux video state (`mux_asset_id`, `mux_playback_id`,
 * `mux_asset_status`) is NEVER overwritten by the seed — the seeder
 * only manages metadata. Owners attach videos via the admin API.
 *
 * Run:
 *   npx ts-node scripts/seed-exercise-catalog.ts
 *   (or `npm run seed:exercise-catalog` once added to package.json)
 */

import { PrismaClient } from '@prisma/client';
import { SEED_EXERCISES } from '../src/exercise-library/seed-catalog';

const prisma = new PrismaClient();

/**
 * Derive a stable URL slug from an Exercise row.
 *
 *   { id: "seed:push-001", name: "Barbell Bench Press" }
 *   → "barbell-bench-press"
 *
 * Falls back to the seed id (sans prefix) when the name slugifies to
 * an empty string — keeps slugs unique under all inputs.
 */
function deriveSlug(name: string, seedId: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (fromName) return fromName;
  return seedId.replace(/^seed:/, '');
}

/**
 * Map an ExerciseDB-style `bodyPart` to one of our canonical category
 * buckets. Mobile chip filters are hardcoded against these buckets, so
 * we normalise here rather than letting the raw bodyPart strings leak
 * into the API surface.
 */
function deriveCategory(bodyPart: string): string {
  const b = bodyPart.toLowerCase();
  if (['chest', 'shoulders', 'arms'].includes(b)) return 'push';
  if (['back'].includes(b)) return 'pull';
  if (b.includes('leg') || b === 'glutes') return 'legs';
  if (b === 'core' || b === 'waist') return 'core';
  if (b === 'cardio') return 'cardio';
  if (b === 'mobility') return 'mobility';
  return 'full_body';
}

async function main() {
  let upserted = 0;
  for (const seed of SEED_EXERCISES) {
    const slug = deriveSlug(seed.name, seed.id);
    const category = deriveCategory(seed.bodyPart);

    await prisma.exerciseCatalogItem.upsert({
      where: { slug },
      update: {
        name: seed.name,
        category,
        primary_muscle: seed.target,
        secondary_muscles: seed.secondaryMuscles,
        equipment: [seed.equipment],
        instructions: seed.instructions,
        source_ref: seed.id,
      },
      create: {
        slug,
        name: seed.name,
        category,
        primary_muscle: seed.target,
        secondary_muscles: seed.secondaryMuscles,
        equipment: [seed.equipment],
        difficulty: 'beginner',
        instructions: seed.instructions,
        source_ref: seed.id,
      },
    });
    upserted += 1;
  }
  console.log(`seeded ${upserted} exercise-catalog rows`);
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
