import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

// Typed test double without a banned cast (repo pattern, see food-custom-privacy.spec.ts).
function stub<T>(value: unknown): T {
  return value as T;
}

// LO-FOOD B2 (audit of backend main 1f88b354): a USDA row with no package
// serving (Survey/FNDDS, SR Legacy, Foundation) is sent as
// serving_description '1 serving' with serving_size_grams 100
// (food.service.ts mapUSDAFood). The phone's portion sheet then reads
// "1 serving = 1 serving" and saves 100 g. USDA's own portion for this row is
// "1 McDonald's Big Mac" = 205 g, so 1 serving saves 261 kcal for a Big Mac.
// Row: fdcId 2706916 "Big Mac (McDonalds)", read 2026-10-30.
const BIG_MAC = {
  fdcId: 2706916,
  description: 'Big Mac (McDonalds)',
  dataType: 'Survey (FNDDS)',
  foodCategory: 'Burgers',
  foodNutrients: [
    { nutrientName: 'Protein', unitName: 'G', value: 11.94 },
    { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 14.1 },
    { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 21.53 },
    { nutrientName: 'Energy', unitName: 'KCAL', value: 261 },
  ],
};

describe('LO-FOOD B2 serving label', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => stub<Response>({
      ok: true,
      json: async () => (String(url).includes('api.nal.usda.gov') ? { foods: [BIG_MAC] } : { products: [] }),
    }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it("a USDA food with no package serving is not called '1 serving' while it counts 100 g", async () => {
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new FoodService(stub<PrismaService>(prisma));

    const res = await service.search('big mac', 50, 'user-a');
    const row = res.results.find((r) => r.id === 'usda_2706916');

    expect(row).toBeDefined();
    const hidden100g = row!.serving_description === '1 serving' && row!.serving_size_grams === 100;
    expect(hidden100g).toBe(false);
  });
});
