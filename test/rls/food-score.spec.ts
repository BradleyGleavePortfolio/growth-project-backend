// FOOD-SCORE-BE (agent 192): a food accuracy score over the foods clients log most (test/food-score/foods.json).
// It runs the real FoodService.search against this job's Postgres copy (the full migration chain) holding the 65
// built-in foods, inserted the way the release step does (FOOD-SEED-BE, b#1203: one createMany of seedFoodRow for
// each food the shared catalog lacks). Every outside call (USDA FoodData Central, Open Food Facts) is served from
// answers recorded once with curl under test/food-score/answers/; nothing reaches the network. A request with no
// saved answer is a failure that names the URL.
//
// A row scores when the first result meets the row's name rule and its kcal for the row's portion is within 10% of
// the row's source. v1 rows (v11 false) must score at least test/food-score/floor.json; v1.1 rows (chain
// restaurants) are printed and never fail. Rows marked recorded=false have no saved answers yet: printed as
// "not recorded" and left out of the score and the floor. Lives under test/rls/ because rls-live-tests is the
// required job with a Postgres service and the whole migration chain (build-and-test has no database).
import { createHash, randomUUID } from 'crypto';
import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { brotliDecompressSync } from 'zlib';
import { PrismaClient } from '@prisma/client';
import { FoodService, type FoodResult } from '../../src/food/food.service';
import type { PrismaService } from '../../src/prisma.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('food-score: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', 'food-score');
const SEARCH_LIMIT = 50; // GET /foods/search's default (food.controller.ts)
const TOLERANCE = 0.1;

interface Row {
  typed: string;
  v11: boolean;
  recorded: boolean;
  name_rule: { all: string[]; none: string[] };
  portion: { grams: number; text: string };
  kcal: number;
  source: { url: string };
}
interface Answer {
  url: string;
  status: number;
  content_type: string | null;
  body_file: string;
  body_encoding: 'br';
  body_sha256: string;
}
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

const rows: Row[] = JSON.parse(readFileSync(join(DIR, 'foods.json'), 'utf8')).rows;
const floor: { v1_floor: number } = JSON.parse(readFileSync(join(DIR, 'floor.json'), 'utf8'));
const answers: Record<string, Answer> = JSON.parse(readFileSync(join(DIR, 'answers', 'index.json'), 'utf8'));
const seedFoods: SeedFood[] = JSON.parse(readFileSync(join(__dirname, '..', '..', 'prisma', 'data', 'seed-foods.json'), 'utf8'));

// The row prisma/seed-foods.ts and b#1203's seedFoodRow create for one seed food, field for field.
function seedFoodRow(food: SeedFood) {
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
    tags: [...(food.tags ?? []), `category:${food.food_category}`, 'seed:common-foods'],
    search_aliases: [],
    nutrient_basis: 'PER_100G' as const,
  };
}

/** The saved-answer key: the request URL with any api_key removed, left otherwise byte for byte. */
function answerKey(url: string): string {
  return url.replace(/&api_key=[^&]*/g, '').replace(/\?api_key=[^&]*&?/, '?');
}

/** The recorded body, byte for byte: stored brotli-compressed for size, checked against the sha256 taken at recording. */
function savedBody(a: Answer): Buffer {
  const body = brotliDecompressSync(readFileSync(join(DIR, 'answers', a.body_file)));
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== a.body_sha256) throw new Error(`food-score: saved answer ${a.body_file} does not match its sha256`);
  return body;
}

function kcalForPortion(r: FoodResult, grams: number): number {
  const per = Number(r.calories);
  if (r.nutrient_basis === 'PER_SERVING') return (per * grams) / Number(r.serving_size_grams);
  return (per * grams) / 100;
}

function meetsNameRule(r: FoodResult, rule: Row['name_rule']): boolean {
  const text = `${r.name} ${r.brand_or_restaurant ?? ''}`;
  return rule.all.every((p) => new RegExp(p, 'i').test(text)) && !rule.none.some((p) => new RegExp(p, 'i').test(text));
}

interface Outcome {
  row: Row;
  first: FoodResult | undefined;
  firstKcal: number | null;
  nameOk: boolean;
  kcalOk: boolean;
}

function grade(row: Row, first: FoodResult | undefined): Outcome {
  const firstKcal = first ? Math.round(kcalForPortion(first, row.portion.grams) * 10) / 10 : null;
  const nameOk = !!first && meetsNameRule(first, row.name_rule);
  const kcalOk = firstKcal !== null && Math.abs(firstKcal - row.kcal) <= TOLERANCE * row.kcal;
  return { row, first, firstKcal, nameOk, kcalOk };
}

(DB_URL ? describe : describe.skip)('food accuracy score (FOOD-SCORE-BE)', () => {
  let prisma: PrismaClient;
  const misses: string[] = [];
  const served: string[] = [];
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const before = await prisma.foodItem.findMany({
      where: { created_by_user_id: null, name: { in: seedFoods.map((f) => f.name) } },
      select: { name: true, brand_or_restaurant: true },
    });
    const have = new Set(before.map((r) => JSON.stringify([r.name, r.brand_or_restaurant])));
    const toAdd = seedFoods.filter((f) => !have.has(JSON.stringify([f.name, f.brand])));
    if (toAdd.length) await prisma.foodItem.createMany({ data: toAdd.map(seedFoodRow) });

    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const key = answerKey(url);
      const a = answers[key];
      if (!a) {
        misses.push(key);
        throw new Error(`food-score: no saved answer for ${key}`);
      }
      served.push(key);
      const body = savedBody(a);
      return new Response(new Uint8Array(body), { status: a.status, headers: a.content_type ? { 'content-type': a.content_type } : {} });
    });
  });

  afterAll(async () => {
    fetchSpy?.mockRestore();
    await prisma?.$disconnect();
  });

  async function scoreOnce(): Promise<Outcome[]> {
    // A fresh service per run: its in-memory search cache starts empty, so every run calls every source.
    const service = new FoodService(prisma as unknown as PrismaService);
    const viewer = randomUUID(); // a member with no foods of their own
    const out: Outcome[] = [];
    for (const row of rows.filter((r) => r.recorded)) {
      const res = await service.search(row.typed, SEARCH_LIMIT, viewer);
      out.push(grade(row, res.results[0]));
    }
    return out;
  }

  it('scores the recorded rows the same on two runs, never calls the network, and holds the v1 floor', async () => {
    const trgm = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`;
    const shared = await prisma.foodItem.count({ where: { created_by_user_id: null } });

    const run1 = await scoreOnce();
    const run2 = await scoreOnce();

    const sum = (o: Outcome[], v11: boolean) => {
      const of = o.filter((x) => x.row.v11 === v11);
      return { hit: of.filter((x) => x.nameOk && x.kcalOk).length, of: of.length };
    };
    const v1 = sum(run1, false);
    const v11 = sum(run1, true);
    const notRecorded = rows.filter((r) => !r.recorded);
    const line = `Food score: ${v1.hit} of ${v1.of} v1 rows, ${v11.hit} of ${v11.of} v1.1 rows`;
    const fmt = (x: Outcome) =>
      `  MISS${x.row.v11 ? ' (v1.1)' : ''} "${x.row.typed}" -> first: ${
        x.first ? `"${x.first.name}"${x.first.brand_or_restaurant ? ` (${x.first.brand_or_restaurant})` : ''}` : '(no result)'
      }, ${x.firstKcal ?? '-'} kcal for ${x.row.portion.grams} g (want ${x.row.kcal}; ${[
        x.nameOk ? null : 'name rule',
        x.kcalOk ? null : 'kcal',
      ]
        .filter(Boolean)
        .join(' + ')})`;
    const report = [
      line,
      `  floor (v1): ${floor.v1_floor}; not recorded: ${notRecorded.length} of ${rows.length} rows; local search path: ${
        trgm[0].n ? 'pg_trgm similarity' : 'ILIKE fallback (no pg_trgm)'
      }; shared catalog rows: ${shared}; saved answers served: ${served.length}`,
      ...run1.filter((x) => !(x.nameOk && x.kcalOk)).map(fmt),
      ...notRecorded.map((r) => `  not recorded "${r.typed}"${r.v11 ? ' (v1.1)' : ''}`),
    ].join('\n');
    process.stdout.write(`\n${report}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Food score\n\n\`\`\`\n${report}\n\`\`\`\n`);
    }

    // No request left the process: every one had a saved answer.
    expect(misses).toEqual([]);
    // Same answers, same score: run 2 picks the same first result and the same verdict for every row.
    const brief = (o: Outcome[]) => o.map((x) => [x.row.typed, x.first?.name ?? null, x.firstKcal, x.nameOk, x.kcalOk]);
    expect(brief(run2)).toEqual(brief(run1));
    // The score only goes up.
    expect(v1.hit).toBeGreaterThanOrEqual(floor.v1_floor);
  });

  it('serves a saved answer for every recorded row, and none for an unknown URL', async () => {
    for (const row of rows.filter((r) => r.recorded)) {
      const enc = encodeURIComponent(row.typed);
      for (const url of [
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=${enc}&pageSize=20`,
        `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${enc}&search_simple=1&action=process&json=1&page_size=20`,
      ]) {
        expect([row.typed, answers[url] ? url : `no saved answer: ${url}`]).toEqual([row.typed, url]);
      }
    }
    const before = misses.length;
    await expect(fetch('https://api.nal.usda.gov/fdc/v1/foods/search?query=not%20saved&pageSize=20&api_key=x')).rejects.toThrow(
      'no saved answer for https://api.nal.usda.gov/fdc/v1/foods/search?query=not%20saved&pageSize=20',
    );
    misses.splice(before); // the deliberate miss above is not a search miss
  });

  it('keeps every row sourced and every saved answer free of keys', () => {
    expect(rows).toHaveLength(100);
    for (const r of rows) {
      expect([r.typed, /^https:\/\//.test(r.source.url), r.portion.grams > 0, r.kcal > 0]).toEqual([r.typed, true, true, true]);
    }
    for (const [key, a] of Object.entries(answers)) {
      expect(key).toBe(a.url);
      expect(key).not.toMatch(/api_key/i);
      // USDA never echoes the key back. (Open Food Facts product data quotes public USDA links with USDA's
      // published DEMO_KEY; that is their content, saved unedited, and no key of ours was ever sent there.)
      if (key.startsWith('https://api.nal.usda.gov/')) expect([key, savedBody(a).includes('api_key')]).toEqual([key, false]);
    }
  });
});
