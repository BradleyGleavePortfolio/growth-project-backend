/**
 * LO-1198R2 probe (audit of b#1198 @ 9ed8e4c3): what a member sees first for
 * the job's search words, with the real USDA answer for each word (FoodData
 * Central search, 20 rows, read 2026-11-02, trimmed to the fields the mapper
 * reads), fresh and cached, with the shared catalog holding the 65 seeded rows
 * (prisma/data/seed-foods.json, stored as prisma/seed-foods.ts stores them,
 * matched like pg_trgm similarity > 0.08, best 10) and with no seeded rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const words: Record<string, unknown[]> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'lo-1198r2-usda-words.json'), 'utf8'),
);
type Seed = {
  name: string; brand: string | null; calories: number; protein_g: number; carbs_g: number; fat_g: number;
  fiber_g: number; sugar_g: number; serving_size_grams: number; serving_description: string; food_category: string;
  tags?: string[];
};
const seeds: Seed[] = JSON.parse(readFileSync(join(__dirname, '..', 'prisma', 'data', 'seed-foods.json'), 'utf8'));
const seedRows = seeds.map((s, i) => ({
  id: `seed-${i}`, name: s.name, brand_or_restaurant: s.brand ?? null, category: 'generic',
  serving_description: s.serving_description, serving_size_grams: s.serving_size_grams, calories: s.calories,
  protein_g: s.protein_g, carbs_g: s.carbs_g, fat_g: s.fat_g, fiber_g: s.fiber_g, sugar_g: s.sugar_g, sodium_mg: null,
  image_url: null, nutrient_basis: 'PER_100G', search_aliases: [],
  tags: [...(s.tags ?? []), `category:${s.food_category}`, 'seed:common-foods'],
}));

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}
function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  const both = [...A].filter((t) => B.has(t)).length;
  const any = new Set([...A, ...B]).size;
  return any ? both / any : 0;
}

function serviceFor(seeded: boolean): FoodService {
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    if (!seeded || !sql.sql.includes('"created_by_user_id" IS NULL')) return [];
    const q = String(sql.values.find((v) => typeof v === 'string'));
    return seedRows
      .map((r) => ({ r, s: similarity(`${r.name}  `, q) }))
      .filter((x) => x.s > 0.08)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.r);
  });
  const prisma = { foodItem: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw };
  return new FoodService(stub<PrismaService>(prisma));
}

describe('LO-1198R2 real search words', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const foods = u.hostname === 'api.nal.usda.gov' ? words[u.searchParams.get('query') ?? ''] ?? [] : [];
      return stub<Response>({ ok: true, status: 200, json: async () => ({ foods, products: [] }) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it.each(Object.keys(words).flatMap((w) => [[w, true], [w, false]] as [string, boolean][]))(
    '%s (seeded catalog %s): first rows, fresh = cached',
    async (word, seeded) => {
      const service = serviceFor(seeded);
      const fresh = await service.search(word, 25, 'member-a');
      const cached = await service.search(word, 25, 'member-a');
      const show = (r: (typeof fresh.results)[number]) =>
        `${r.name}${r.brand_or_restaurant ? ` [${r.brand_or_restaurant}]` : ''} ${r.calories}kcal "${r.serving_description}" ${r.serving_size_grams}g cup=${r.supports_volume_units ? r.cup_grams : '-'}`;
      process.stdout.write(
        `LO98R2|${word}|seeded=${seeded}|${fresh.results.slice(0, 4).map(show).join(' || ')}\n`,
      );
      expect(cached.results.map((r) => r.id)).toEqual(fresh.results.map((r) => r.id));
      expect(fresh.results.length).toBeGreaterThan(0);
    },
  );
});
