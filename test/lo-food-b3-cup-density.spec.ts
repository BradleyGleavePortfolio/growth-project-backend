import { FoodService } from '../src/food/food.service';

// LO-FOOD B3 (audit of backend main 1f88b354): every Open Food Facts row gets
// category 'generic' (food.service.ts mapOpenFoodFactsProduct), and
// food-density.ts maps 'generic' to 1.00 g/ml, the density of water. So the
// phone offers "1 cup" = 240 g for any packaged food. Quaker Old Fashioned
// rolled oats (OFF 0030000010204, 375 kcal/100 g, label serving 40 g = 1/2 cup)
// logged as 1 cup saves 900 kcal instead of about 300. food-density.ts itself
// says an unknown category must not fall back to a wrong default.
const QUAKER_OATS = {
  code: '0030000010204',
  product_name: 'Old Fashioned 100% Whole Grain Rolled Oats',
  brands: 'Quaker Oats',
  nutriments: { 'energy-kcal_100g': 375, proteins_100g: 12.5, carbohydrates_100g: 67.5, fat_100g: 7.5 },
};

describe('LO-FOOD B3 cup weight', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => ({
      ok: true,
      json: async () => (String(url).includes('openfoodfacts.org') ? { products: [QUAKER_OATS] } : { foods: [] }),
    }) as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('a cup of dry rolled oats from Open Food Facts is not counted as 240 g', async () => {
    const prisma = {
      foodItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as any;
    const service = new FoodService(prisma);

    const res = await service.search('rolled oats', 50, 'user-a');
    const row = res.results.find((r) => r.id === 'off_0030000010204');

    expect(row).toBeDefined();
    expect(row!.cup_grams ?? 0).toBeLessThan(120);
  });
});
