import * as fs from 'fs';
import * as path from 'path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

// Typed test double without a banned cast (repo pattern, see food-custom-privacy.spec.ts).
function stub<T>(value: unknown): T {
  return value as T;
}
// The first 20 USDA FoodData Central rows for "eggs" (fdc.nal.usda.gov search,
// relevance order, read 2026-10-30), cut to the fields FoodService reads.
const usdaEggs = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'lo-food-usda-eggs.json'), 'utf8'),
);

// LO-FOOD B1 (audit of backend main 1f88b354): a branded row whose name is
// exactly the query outranks the plain food, because scoreFoodResult gives an
// exact name 100 + 20 and ignores the brand and category. Searching "eggs"
// puts Mars chocolate EGGS (Candy, 525 kcal/100 g) first.
describe('LO-FOOD B1 food search order', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => stub<Response>({
      ok: true,
      json: async () => (String(url).includes('api.nal.usda.gov') ? { foods: usdaEggs } : { products: [] }),
    }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('a search for eggs lists a hen egg first, not a chocolate candy named EGGS', async () => {
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new FoodService(stub<PrismaService>(prisma));

    const res = await service.search('eggs', 50, 'user-a');

    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].category).not.toMatch(/candy|chocolate/i);
  });
});
