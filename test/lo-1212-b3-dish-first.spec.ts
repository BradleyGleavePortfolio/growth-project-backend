/**
 * LO-1212 B3 (audit of b#1212 @ 8f5ca0fd): with the loaded USDA rows the catalog answers "2% milk" and "green beans"
 * alone, and a dish or product made with the food comes first: "Egg custards, dry mix, prepared with 2% milk" above
 * the built-in "Milk, 2% fat" and USDA's own 2% milk; "Babyfood, green beans, dices, toddler" above "Beans, snap,
 * green, raw". rankFoodResults scores a name holding the words in a row (60) above one holding them apart (40), and
 * reads "Babyfood, green beans" as USDA's group-first form for green beans. The brief's search check: a dish never
 * outranks the plain food the catalog holds (main's answer for these two words is not recorded).
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

function catalogRows(...typed: RegExp[]) {
  const loaded = parseUsdaFoods(readFileSync(join(ROOT, 'prisma/data/usda-foods.jsonl.gz'))).map((f) => ({
    id: `usda-row-${f.fdc_id}`, ...usdaFoodRow(f),
  }));
  const builtIn = parseSeedFoods(readFileSync(join(ROOT, 'prisma/data/seed-foods.json'), 'utf8')).map((f, i) => ({
    id: `built-in-${i}`, ...seedFoodRow(f), sodium_mg: null, image_url: null,
  }));
  const [lead] = typed;
  return [...loaded, ...builtIn]
    .filter((r) => typed.every((t) => t.test(r.name)))
    .map((r) => ({ r, lead: lead.test(r.name.split(',')[0]) ? 0 : 1, seed: r.tags.includes('seed:common-foods') ? 0 : 1 }))
    .sort((a, b) => a.lead - b.lead || a.seed - b.seed || a.r.name.length - b.r.name.length || a.r.name.localeCompare(b.r.name))
    .slice(0, LOCAL_SEARCH_TAKE)
    .map(({ r }) => ({ ...r, word_match: 0 }));
}

describe('LO-1212 B3: a dish made with the food ranks above the food', () => {
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

  async function first(typed: string, rows: ReturnType<typeof catalogRows>) {
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? rows : [],
      ),
    };
    const { results } = await new FoodService(stub<PrismaService>(prisma)).search(typed, 25, 'member-a');
    return results[0].name;
  }

  it('2% milk: the first row is 2% milk, not a dish prepared with it', async () => {
    const rows = catalogRows(/\b2%/, /\bmilk\b/i);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(await first('2% milk', rows)).toMatch(/^milk\b/i);
  });

  it('green beans: the first row is green beans, not baby food', async () => {
    const rows = catalogRows(/\bgreen\b/i, /\bbeans?\b/i);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(await first('green beans', rows)).not.toMatch(/^babyfood/i);
  });
});
