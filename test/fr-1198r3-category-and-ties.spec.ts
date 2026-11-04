/**
 * FR-1198R3 (b#1198 fix round 3), on real USDA answers (FoodData Central
 * search, first 20 rows, read 2026-11-02 for the LO-1198R2 and LO-1198R3
 * probes, trimmed to the fields the mapper reads), fresh and cached, with no
 * built-in foods (production today) and with the 65 built-in foods
 * (prisma/data/seed-foods.json, stored as prisma/seed-foods.ts stores them,
 * matched like pg_trgm similarity > 0.08, best 10; FOOD-SEED-BE loads them at
 * every deploy).
 *
 * F1 (LO-1198R3 B1): a head that names another food later in the row
 *   ("Beef, cured, corned beef, ...") is USDA's group-first form for it.
 * F2 (LO-1198R3 C1, owner #192-D2 op 1): USDA's food category. Among the rows
 *   that name the food, a row filed under another category than the food's own
 *   rows (in the same USDA category system) ranks after them.
 * F3 (LO-1198R3 C2): a built-in row before a USDA row at the same level, tier,
 *   match and plain form; a whole-name match before a head match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type UsdaRow = { description: string; dataType: string; foodCategory?: string } & Record<string, unknown>;
const answers: Record<string, UsdaRow[]> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'fr-1198r3', 'usda-words.json'), 'utf8'),
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

function serviceFor(seeded: boolean, own: unknown[] = []): FoodService {
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    if (!sql.sql.includes('"created_by_user_id" IS NULL')) return own;
    if (!seeded) return [];
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

/** The USDA answer each query gets (by default the word's own frozen answer). */
let answerFor: (query: string) => UsdaRow[] = (query) => answers[query] ?? [];

async function namesFor(word: string, seeded: boolean): Promise<{ fresh: string[]; cached: string[] }> {
  const s = serviceFor(seeded);
  const fresh = (await s.search(word, 25, 'member-a')).results.map((r) => r.name);
  const cached = (await s.search(word, 25, 'member-a')).results.map((r) => r.name);
  return { fresh, cached };
}

describe('FR-1198R3: category and ties on real USDA answers', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    answerFor = (query) => answers[query] ?? [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const foods = u.hostname === 'api.nal.usda.gov' ? answerFor(u.searchParams.get('query') ?? '') : [];
      return stub<Response>({ ok: true, status: 200, json: async () => ({ foods, products: [] }) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  const both = [false, true];

  describe('F1: a head that names another food later is the group-first form', () => {
    it.each(
      both.flatMap((seeded) => [
        ['beef', seeded, 'Beef, NFS', 'Beef, cured, corned beef, brisket, raw'],
        ['turkey', seeded, 'Turkey, NFS', 'Turkey, mechanically deboned, from turkey frames, raw'],
      ]) as [string, boolean, string, string][],
    )('%s (built-in foods %s): "%s" first, before "%s", fresh and cached', async (word, seeded, first, other) => {
      const { fresh, cached } = await namesFor(word, seeded);
      expect(fresh).toContain(other);
      expect({ first: fresh[0], otherAfter: fresh.indexOf(other) > 0 }).toEqual({ first, otherAfter: true });
      expect(cached).toEqual(fresh);
    });
  });

  describe("F2: a row filed under another category than the food's own rows ranks after them", () => {
    it.each(both)('sausage (built-in foods %s): "Sausage, NFS" before "Sausage, meatless", fresh and cached', async (seeded) => {
      const { fresh, cached } = await namesFor('sausage', seeded);
      expect(fresh).toContain('Sausage, meatless');
      expect({ first: fresh[0], meatlessAfter: fresh.indexOf('Sausage, meatless') > 0 }).toEqual({
        first: 'Sausage, NFS',
        meatlessAfter: true,
      });
      expect(cached).toEqual(fresh);
    });

    it.each(both)('the substitute\'s own words (built-in foods %s): "meatless sausage" still leads with "Sausage, meatless"', async (seeded) => {
      // The sausage answer, asked with the substitute's own words.
      answerFor = (query) => (query === 'meatless sausage' ? answers.sausage : []);
      const { fresh, cached } = await namesFor('meatless sausage', seeded);
      expect(fresh[0]).toBe('Sausage, meatless');
      expect(cached).toEqual(fresh);
    });

    it('a row with no category ranks as before: the same answer without its category leads as it did', async () => {
      answerFor = (query) =>
        query === 'sausage'
          ? answers.sausage.map((row) => (row.description === 'Sausage, meatless' ? { ...row, foodCategory: undefined } : row))
          : [];
      const { fresh, cached } = await namesFor('sausage', false);
      expect(fresh[0]).toBe('Sausage, meatless');
      expect(cached).toEqual(fresh);
    });

    it('the cached shared list keeps the category, so a member\'s own food is ranked the same fresh and cached', async () => {
      const own = {
        id: 'own-sausage', name: 'Sausage, my recipe', brand_or_restaurant: null, category: 'generic',
        serving_description: '100\u00a0g', serving_size_grams: 100, calories: 250, protein_g: 14, carbs_g: 2, fat_g: 20,
        fiber_g: null, sugar_g: null, sodium_mg: null, image_url: null, nutrient_basis: 'PER_100G', search_aliases: [],
        tags: [], created_by_user_id: 'member-a',
      };
      const s = serviceFor(false, [own]);
      const fresh = (await s.search('sausage', 25, 'member-a')).results;
      expect(fresh.map((r) => r.id)).toContain('own-sausage');
      const cached = (await s.search('sausage', 25, 'member-a')).results;
      expect(cached.map((r) => r.id)).toEqual(fresh.map((r) => r.id));
      expect(cached.find((r) => r.name === 'Sausage, meatless')?.category).toBe('Legumes and Legume Products');
      expect(fresh.map((r) => r.name).indexOf('Sausage, NFS')).toBeLessThan(fresh.map((r) => r.name).indexOf('Sausage, meatless'));
    });
  });

  describe('F3: a built-in row before a USDA row at the same level, tier, match and plain form', () => {
    it.each([
      ['bacon', 'Bacon, pan-fried', 'Bacon, meatless'],
      ['white rice', 'Rice, white, long-grain, cooked', 'Rice, white, puffed'],
      // Ruling R-1198R3-1 (a): the one earlier control that moves, to the same food.
      ['butter peanut', 'Peanut butter, smooth', 'Peanut butter, creamy'],
    ])('%s (built-in foods): "%s" first, before "%s", fresh and cached', async (word, first, other) => {
      const { fresh, cached } = await namesFor(word, true);
      expect(fresh).toContain(other);
      expect({ first: fresh[0], otherAfter: fresh.indexOf(other) > 0 }).toEqual({ first, otherAfter: true });
      expect(cached).toEqual(fresh);
    });

    it('a whole-name match before a head match at the same tier: "Bacon bits" before the plain form "Bacon bits, raw"', async () => {
      answerFor = (query) =>
        query === 'bacon bits'
          ? [
              { fdcId: 1, description: 'Bacon bits, raw', dataType: 'Survey (FNDDS)', foodCategory: 'Bacon', foodNutrients: [] },
              { fdcId: 2, description: 'Bacon bits', dataType: 'Survey (FNDDS)', foodCategory: 'Bacon', foodNutrients: [] },
            ]
          : [];
      const { fresh, cached } = await namesFor('bacon bits', false);
      expect(fresh[0]).toBe('Bacon bits');
      expect(cached).toEqual(fresh);
    });

    it.each([['peanut butter', 'Peanut butter, smooth']])('control (built-in foods): %s keeps "%s" first', async (word, first) => {
      const { fresh, cached } = await namesFor(word, true);
      expect(fresh[0]).toBe(first);
      expect(cached).toEqual(fresh);
    });
  });
});
