/**
 * LO-1212 B1 (audit of b#1212 @ 8f5ca0fd): with the 8,056 loaded USDA rows in the catalog, a search for "oatmeal"
 * shows "Bread, oatmeal" first again, the LO-1198 B1 case b#1198 fixed. The catalog holds 40+ rows with "oatmeal" as a
 * whole word (oatmeal bread, oatmeal cookies, ...) and none named for oatmeal, so searchShared answers from the catalog
 * alone (LOCAL_ENOUGH_WHOLE) and never asks USDA, whose answer leads with "Oatmeal, NFS". test/lo-1198-b1-oatmeal-
 * first.spec.ts still passes only because its catalog is empty.
 *
 * The catalog rows are the ones the shared word search returns, built from the shipped data file and built-in foods:
 * every shared row holding the word, the name's first part first, built-in foods next, shorter names next, at most
 * LOCAL_SEARCH_TAKE (the SQL order in searchCatalog). The USDA answer is the recorded one b#1198 used.
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
const usda: unknown[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lo-1198-usda-oatmeal.json'), 'utf8'));

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

describe('LO-1212 B1: oatmeal with the loaded catalog', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods: usda } : { products: [] }),
      }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('oatmeal: the first row is oatmeal, not oatmeal bread, with the loaded USDA rows in the catalog', async () => {
    const rows = catalogRows('oatmeal');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? rows : [],
      ),
    };
    const { results } = await new FoodService(stub<PrismaService>(prisma)).search('oatmeal', 25, 'member-a');
    expect(results[0].name).toMatch(/^oatmeal/i);
  });
});
