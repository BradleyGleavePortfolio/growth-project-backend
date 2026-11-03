/**
 * LO-1198R4B B1 (audit of b#1198 @ 30205a21): FR-1198R3's own category of a
 * tier is the category most of that tier's whole-word rows are filed under,
 * so dishes that only mention the food can outvote the food's own rows. In
 * USDA's first 20 rows for "crab", five FNDDS rows are "Seafood mixed dishes"
 * ("Crab, cake", "Crab salad", "Crab salad made with imitation crab",
 * "Flounder with crab stuffing", "Shrimp with crab stuffing") and three are
 * "Shellfish" ("Crab", "Crab, canned", "Crab, soft shell"). The row named
 * exactly the food, "Crab" (83 kcal per 100 g), is then ranked as filed under
 * another category and "Crab, cake" (214 kcal per 100 g) leads. At 698d0725
 * "Crab" led. Real USDA answer (FoodData Central search, first 20 rows, read
 * 2026-11-03, trimmed to the fields the mapper reads); none of the 65
 * built-in foods is a crab, so this holds with or without them; fresh and
 * cached.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const answers: Record<string, unknown[]> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'lo-1198r4b', 'b1-usda-crab.json'), 'utf8'),
);

function service(): FoodService {
  const prisma = { foodItem: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) };
  return new FoodService(stub<PrismaService>(prisma));
}

describe('LO-1198R4B B1: dishes that mention the food do not outvote the food itself', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const foods = u.hostname === 'api.nal.usda.gov' ? answers[u.searchParams.get('query') ?? ''] ?? [] : [];
      return stub<Response>({ ok: true, status: 200, json: async () => ({ foods, products: [] }) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('crab leads with "Crab", not "Crab, cake", fresh and cached', async () => {
    const s = service();
    for (const pass of ['fresh', 'cached']) {
      const names = (await s.search('crab', 50, 'member-a')).results.map((r) => r.name);
      expect(names).toContain('Crab');
      expect(names).toContain('Crab, cake');
      expect({ pass, first: names[0], crabBeforeCake: names.indexOf('Crab') < names.indexOf('Crab, cake') }).toEqual({
        pass,
        first: 'Crab',
        crabBeforeCake: true,
      });
    }
  });
});
