import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

describe('LS-FOOD B4: retry after a catalog outage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not remember a transient upstream failure as a day-long successful empty search', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = new FoodService(prisma as unknown as PrismaService);
    // Isolate the OFF recovery path, without setting or reading a USDA credential.
    jest.spyOn(service as unknown as { searchUSDA: () => Promise<unknown[]> }, 'searchUSDA').mockResolvedValue([]);
    const request = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ products: [{
          code: 'catalog-banana', product_name: 'Banana',
          nutriments: { 'energy-kcal_100g': 89, proteins_100g: 1.1, carbohydrates_100g: 23, fat_100g: 0.3 },
        }] }),
      } as Response);
    expect((await service.search('banana', 50, 'viewer')).results).toEqual([]);
    // The service is healthy again before the person retries the same query.
    const retry = await service.search('banana', 50, 'viewer');
    expect(retry.results.some((food) => food.name === 'Banana')).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
