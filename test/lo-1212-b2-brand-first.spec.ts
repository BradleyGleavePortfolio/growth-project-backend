/**
 * LO-1212 B2 (audit of b#1212 @ 8f5ca0fd): a search for "yogurt" shows "Yogurt, Greek, whole, plain, CHOBANI", a
 * brand, first, above the built-in "Yogurt, plain, whole milk" and the plain USDA yogurts. The loaded Foundation and
 * SR Legacy rows write the brand inside the name in capitals (CHOBANI, QUAKER, McDONALD'S) with no brand_or_restaurant,
 * so rankFoodResults counts them as basic, unbranded foods, and "whole" as its own comma part makes it the "plain
 * form". The catalog answers alone (40 whole-word rows), so nothing else decides. Main's answer from USDA for
 * "yogurt" (FoodData Central, read 2026-11-04) leads with "Yogurt, plain, nonfat".
 *
 * The catalog rows are the ones the shared word search returns, built from the shipped data file and built-in foods
 * (the SQL order in searchCatalog). USDA and Open Food Facts are stubbed to fail: the catalog answers alone anyway.
 */
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService, LOCAL_SEARCH_TAKE } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import { parseUsdaFoods, usdaFoodRow } from '../scripts/load-usda-foods';
import { parseSeedFoods, seedFoodRow } from '../scripts/seed-built-in-foods';

const ROOT = join(__dirname, '..');
const stub = <T>(v: unknown) => v as T;

function catalogRows(word: string) {
  const loaded = parseUsdaFoods(readFileSync(join(ROOT, 'prisma/data/usda-foods.jsonl.gz'))).map((f) => ({
    id: `usda-row-${f.fdc_id}`, ...usdaFoodRow(f),
  }));
  const builtIn = parseSeedFoods(readFileSync(join(ROOT, 'prisma/data/seed-foods.json'), 'utf8')).map((f, i) => ({
    id: `built-in-${i}`, ...seedFoodRow(f), sodium_mg: null, image_url: null,
  }));
  const has = new RegExp(`\\b${word}s?\\b`, 'i');
  const lead = new RegExp(`\\b${word}`, 'i');
  return [...loaded, ...builtIn]
    .filter((r) => has.test(r.name))
    .map((r) => ({ r, lead: lead.test(r.name.split(',')[0]) ? 0 : 1, seed: r.tags.includes('seed:common-foods') ? 0 : 1 }))
    .sort((a, b) => a.lead - b.lead || a.seed - b.seed || a.r.name.length - b.r.name.length || a.r.name.localeCompare(b.r.name))
    .slice(0, LOCAL_SEARCH_TAKE)
    .map(({ r }) => ({ ...r, word_match: 0 }));
}

describe('LO-1212 B2: a brand written in a loaded USDA name', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('USDA and Open Food Facts stubbed to fail'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('yogurt: the first row is a plain yogurt, not a brand', async () => {
    const rows = catalogRows('yogurt');
    expect(rows.some((r) => /CHOBANI/.test(r.name))).toBe(true);
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? rows : [],
      ),
    };
    const { results } = await new FoodService(stub<PrismaService>(prisma)).search('yogurt', 25, 'member-a');
    expect(results[0].name).toMatch(/^yogurt/i);
    expect(results[0].name).not.toMatch(/\b[A-Z]{3,}\b/);
  });
});
