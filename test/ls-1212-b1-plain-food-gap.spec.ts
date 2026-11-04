/**
 * LS-1212 B1: whole-word dish matches are not evidence that the catalog has
 * the requested plain food. The shipped oatmeal rows are bread/cookies/etc.;
 * the unchanged LO-1198 fixture contains the plain oatmeal that main ranks first.
 * These are real loader rows, not a fabricated catalog-ranking scenario.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import { parseUsdaFoods, usdaFoodRow } from '../scripts/load-usda-foods';

const plainResponse: unknown[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'lo-1198-usda-oatmeal.json'), 'utf8'),
);
const catalog = parseUsdaFoods(
  readFileSync(join(__dirname, '..', 'prisma', 'data', 'usda-foods.jsonl.gz')),
)
  .filter((f) => /\boatmeal\b/i.test(f.name))
  .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
  .slice(0, 40)
  .map((f) => ({ id: `local-usda-${f.fdc_id}`, ...usdaFoodRow(f), word_match: 0 }));

describe('LS-1212 B1: an abundant dish catalog must not hide a plain-food upstream gap', () => {
  const originalKey = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
        ? { foods: plainResponse } : { products: [] },
    } as Response));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = originalKey;
  });

  it('oatmeal still finds plain oatmeal, rather than treating oatmeal bread and cookies as a sufficient local answer', async () => {
    expect(catalog.length).toBeGreaterThanOrEqual(5);
    expect(catalog.some((f) => /^oatmeal\b/i.test(f.name))).toBe(false);
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? catalog : []),
    };
    const { results } = await new FoodService(prisma as unknown as PrismaService).search('oatmeal', 25, 'member-a');
    expect(results[0].name.toLowerCase().startsWith('oatmeal')).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('api.nal.usda.gov'))).toBe(true);
  });
});
