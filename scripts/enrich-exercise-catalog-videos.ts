#!/usr/bin/env ts-node
/**
 * scripts/enrich-exercise-catalog-videos.ts
 *
 * Enrichment script: for every ExerciseCatalogItem where video_url IS NULL,
 * tries YMove → MuscleWiki in order and writes the winning URL (and provider)
 * back to the row.
 *
 * IMPORTANT — YMove URL storage:
 *   YMove v2 pre-signed URLs expire after 48 hours and MUST NOT be stored
 *   long-term. This script stores the MuscleWiki URL when available, and
 *   for YMove it stores the *normalised exercise slug* (prefix: "ymove:")
 *   so the live endpoint knows the exercise is covered and can always
 *   fetch a fresh signed URL on demand.
 *
 * Usage:
 *   npx ts-node scripts/enrich-exercise-catalog-videos.ts
 *   npx ts-node scripts/enrich-exercise-catalog-videos.ts --dry-run
 *   npx ts-node scripts/enrich-exercise-catalog-videos.ts --limit=100
 *   npx ts-node scripts/enrich-exercise-catalog-videos.ts --invalidate-cache
 *
 * Environment variables required:
 *   DATABASE_URL          — Postgres connection string
 *   REDIS_URL             — Redis connection (optional; skips cache when absent)
 *   YMOVE_API_KEY         — YMove API key (optional)
 *   MUSCLEWIKI_API_KEY    — MuscleWiki API key (optional)
 *
 * Exits with code 0 on success, 1 on fatal error.
 */

import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

// ─── Inline normalise (avoids importing NestJS module graph) ─────────────────

function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INVALIDATE_CACHE = args.includes('--invalidate-cache');
const LIMIT_ARG = args.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : undefined;
const BATCH_SIZE = 50;

// ─── Provider fetch helpers (standalone, no NestJS DI) ────────────────────────

async function fetchYMoveCatalog(
  apiKey: string,
): Promise<Map<string, string>> {
  const url =
    'https://exercise-api.ymove.app/api/v2/exercises?includeVideos=true&limit=1000';
  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok)
    throw new Error(`YMove catalog: ${res.status} ${res.statusText}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any;
  const exercises = Array.isArray(data) ? data : (data.exercises ?? data.data ?? []);
  const map = new Map<string, string>();
  for (const ex of exercises) {
    const name: string = ex.title ?? ex.name ?? '';
    const hasVideo = !!(ex.videoHlsUrl ?? ex.videoUrl);
    if (!name || !hasVideo) continue;
    // Store the normalised slug, NOT the signed URL (expires in 48h).
    map.set(normaliseName(name), `ymove:${normaliseName(name)}`);
  }
  return map;
}

async function fetchMuscleWikiCatalog(
  apiKey: string,
): Promise<Map<string, string>> {
  const host = 'musclewiki.p.rapidapi.com';
  const url = `https://${host}/exercises`;
  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': host,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok)
    throw new Error(`MuscleWiki catalog: ${res.status} ${res.statusText}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exercises = (await res.json()) as any[];
  const map = new Map<string, string>();
  for (const ex of exercises) {
    const name: string = ex.name ?? '';
    const videoUrl: string | undefined =
      ex.video?.male ?? ex.video?.female ?? ex.video_url ?? undefined;
    if (!name || !videoUrl) continue;
    map.set(normaliseName(name), videoUrl);
  }
  return map;
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface Stats {
  total: number;
  ymove: number;
  musclewiki: number;
  none: number;
  errors: number;
  skipped: number;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any | null = null;

  console.log(
    `\n=== Exercise Catalog Video Enrichment${DRY_RUN ? ' (DRY RUN)' : ''} ===\n`,
  );

  // ── Connect Redis (optional) ────────────────────────────────────────────
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Redis } = await import('ioredis');
      redis = new Redis(redisUrl, { lazyConnect: true });
      await redis.connect();
      console.log('Redis connected');

      if (INVALIDATE_CACHE) {
        console.log('--invalidate-cache: flushing exercise_video:* keys...');
        const keys: string[] = await redis.keys('exercise_video:*');
        if (keys.length) {
          await redis.del(...keys);
          console.log(`  Deleted ${keys.length} cache keys`);
        }
      }
    } catch (err) {
      console.warn('Redis unavailable — proceeding without cache invalidation', err);
      redis = null;
    }
  }

  // ── Load provider catalogs ──────────────────────────────────────────────
  const ymoveKey = process.env.YMOVE_API_KEY ?? '';
  const musclewikiKey = process.env.MUSCLEWIKI_API_KEY ?? '';

  let ymoveCatalog = new Map<string, string>();
  let musclewikiCatalog = new Map<string, string>();

  if (ymoveKey) {
    try {
      console.log('Fetching YMove catalog...');
      ymoveCatalog = await fetchYMoveCatalog(ymoveKey);
      console.log(`  ✓ YMove: ${ymoveCatalog.size} exercises with video coverage`);
    } catch (err) {
      console.error('  ✗ YMove catalog fetch failed:', err);
    }
  } else {
    console.log('  ⚠ YMOVE_API_KEY not set — skipping YMove provider');
  }

  if (musclewikiKey) {
    try {
      console.log('Fetching MuscleWiki catalog...');
      musclewikiCatalog = await fetchMuscleWikiCatalog(musclewikiKey);
      console.log(
        `  ✓ MuscleWiki: ${musclewikiCatalog.size} exercises with video URLs`,
      );
    } catch (err) {
      console.error('  ✗ MuscleWiki catalog fetch failed:', err);
    }
  } else {
    console.log('  ⚠ MUSCLEWIKI_API_KEY not set — skipping MuscleWiki provider');
  }

  if (ymoveCatalog.size === 0 && musclewikiCatalog.size === 0) {
    console.error('\nNo provider catalogs loaded. Set at least one API key. Exiting.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // ── Fetch all catalog items needing enrichment ─────────────────────────
  const totalRows = await prisma.exerciseCatalogItem.count({
    where: { video_url: null },
  });
  const effectiveLimit = LIMIT ?? totalRows;
  console.log(
    `\nFound ${totalRows} rows with video_url IS NULL (processing up to ${effectiveLimit})`,
  );

  const stats: Stats = {
    total: 0,
    ymove: 0,
    musclewiki: 0,
    none: 0,
    errors: 0,
    skipped: 0,
  };

  let cursor = 0;
  while (stats.total < effectiveLimit) {
    const batchSize = Math.min(BATCH_SIZE, effectiveLimit - stats.total);
    const rows = await prisma.exerciseCatalogItem.findMany({
      where: { video_url: null },
      orderBy: { name: 'asc' },
      skip: cursor,
      take: batchSize,
      select: { id: true, name: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      stats.total++;
      const key = normaliseName(row.name);

      // Priority: YMove → MuscleWiki
      const ymoveUrl = ymoveCatalog.get(key);
      const musclewikiUrl = musclewikiCatalog.get(key);

      let video_url: string | null = null;
      let video_provider: string | null = null;

      if (ymoveUrl) {
        // Store the ymove slug sentinel, not the expiring signed URL.
        video_url = ymoveUrl;
        video_provider = 'ymove';
        stats.ymove++;
      } else if (musclewikiUrl) {
        video_url = musclewikiUrl;
        video_provider = 'musclewiki';
        stats.musclewiki++;
      } else {
        stats.none++;
      }

      const status =
        video_provider === 'ymove'
          ? '🎬 ymove'
          : video_provider === 'musclewiki'
          ? '📹 musclewiki'
          : '─ no match';

      console.log(`  [${stats.total}/${effectiveLimit}] ${row.name} → ${status}`);

      if (!DRY_RUN && video_url) {
        try {
          await prisma.exerciseCatalogItem.update({
            where: { id: row.id },
            data: { video_url, video_provider },
          });
        } catch (err) {
          console.error(`    ✗ DB update failed for "${row.name}":`, err);
          stats.errors++;
        }
      }
    }

    cursor += rows.length;
  }

  // ── Print summary ───────────────────────────────────────────────────────
  console.log(`
=== Summary ===
  Processed : ${stats.total}
  YMove     : ${stats.ymove}
  MuscleWiki: ${stats.musclewiki}
  No match  : ${stats.none}
  DB errors : ${stats.errors}
  Mode      : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}
`);

  await prisma.$disconnect();
  if (redis) await redis.quit().catch(() => undefined);

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
