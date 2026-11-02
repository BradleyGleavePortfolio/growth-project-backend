/**
 * LS-1198R2 B1: a dish that starts with the food is not the plain food.
 * Frozen public USDA portal search responses captured 2026-11-02 UTC.
 * POST https://fdc.nal.usda.gov/portal-data/external/search
 * Body: { query, pageSize: 25, pageNumber: 1 }. No account or key used.
 * Only transport/Prisma are stubbed; the production ranking/cache run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

type Fixture = { query: string; foods: Array<Record<string, unknown>> };
const fixtures = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/ls-1198r2/prefix-dishes.json'), 'utf8',
)) as Fixture[];
const stub = <T>(v: unknown): T => v as T;
const originalKey = process.env.USDA_API_KEY;

beforeEach(() => { process.env.USDA_API_KEY = 'fixture-only'; });
afterEach(() => {
  jest.restoreAllMocks();
  if (originalKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = originalKey;
});

function world(query: string, local: unknown[] = []) {
  const fixture = fixtures.find((f) => f.query === query)!;
  const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
    stub<Response>({
      ok: true, status: 200,
      json: async () => String(url).includes('api.nal.usda.gov')
        ? { foods: fixture.foods } : { products: [] },
    }),
  );
  return {
    fetcher,
    service: new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue(local) })),
  };
}

describe('B1: prefix dishes do not jump ahead of plain foods', () => {
  it.each([false, true])('sardines, cached=%s: canned sardines before a sardine sandwich', async (cached) => {
    const { service, fetcher } = world('sardines');
    // No seed-food row contains sardine or sardines. This is the ordinary
    // source-backed path, not a made-up replacement for a matching seed.
    if (cached) await service.search('sardines', 50, 'viewer');
    const { results } = await service.search('sardines', 50, 'viewer');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.some((r) => r.id === 'usda_175139')).toBe(true);
    expect(results[0].id).toBe('usda_175139');
  });

  it.each([false, true])('control: pancakes, cached=%s: pancakes before pancake syrup', async (cached) => {
    const { service, fetcher } = world('pancakes');
    if (cached) await service.search('pancakes', 50, 'viewer');
    const { results } = await service.search('pancakes', 50, 'viewer');
    expect(fetcher).toHaveBeenCalledTimes(2);
    // searchShared asks USDA for 20 rows. The SR Legacy reduced-fat row
    // is number 22 in the frozen response, so it is not an available choice.
    expect(results.some((r) => r.id === 'usda_2708304')).toBe(true);
    expect(results[0].name).toMatch(/^Pancakes,/);
  });

  it('source-only salmon: plain fish before salmon salad', async () => {
    const { service } = world('salmon');
    const { results } = await service.search('salmon', 50, 'viewer');
    expect(results.some((r) => r.id === 'usda_173688')).toBe(true);
    expect(results[0].name).toMatch(/^Fish, salmon,/);
  });

  it('control: a matching salmon seed masks the source-only failure', async () => {
    const { service } = world('salmon', [{
      id: 'seed-salmon', name: 'Salmon, Atlantic, cooked', category: 'generic',
      brand_or_restaurant: null, created_by_user_id: null, search_aliases: [],
      serving_description: '4 oz (113g)', serving_size_grams: 113,
      calories: 206, protein_g: 22.1, carbs_g: 0, fat_g: 12.4,
      nutrient_basis: 'PER_100G',
      tags: ['seed:common-foods', 'category:Finfish and Shellfish Products'],
    }]);
    expect((await service.search('salmon', 50, 'viewer')).results[0].id).toBe('seed-salmon');
  });

  it('control: the shipped seed has neither sardines nor pancakes', () => {
    const seeds = JSON.parse(readFileSync(
      join(__dirname, '../prisma/data/seed-foods.json'), 'utf8',
    )) as Array<{ name: string; search_aliases?: string[] }>;
    expect(seeds.some((s) => /sardine|pancake/i.test([s.name, ...(s.search_aliases ?? [])].join(' ')))).toBe(false);
  });
});
