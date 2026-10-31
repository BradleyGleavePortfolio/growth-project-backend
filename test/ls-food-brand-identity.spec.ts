import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

// Typed test double without a banned cast (repo pattern, see food-custom-privacy.spec.ts).
function stub<T>(value: unknown): T {
  return value as T;
}

const product = (id: string, brand: string) => ({
  id, name: 'Protein bar', brand, category: 'packaged',
  calories: brand === 'Alpha' ? 350 : 420, protein: 20, carbs: 30, fat: 10,
  serving_size_description: '1 bar', serving_size_grams: 60,
  nutrient_basis: 'PER_100G', tags: [], search_aliases: [],
});

describe('LS-FOOD B5: branded catalog identity', () => {
  it.each(['OFF products', 'USDA and OFF products'])('keeps distinct branded %s with the same display name selectable', async (path) => {
    const service = new FoodService(stub<PrismaService>({ $queryRaw: jest.fn().mockResolvedValue([]) }));
    const upstream = stub<{
      searchUSDA: () => Promise<unknown[]>;
      searchOpenFoodFacts: () => Promise<unknown[]>;
    }>(service);
    const alpha = product(path === 'OFF products' ? 'off_111' : 'usda_111', 'Alpha');
    const beta = product('off_222', 'Beta');
    jest.spyOn(upstream, 'searchUSDA').mockResolvedValue(path === 'OFF products' ? [] : [alpha]);
    jest.spyOn(upstream, 'searchOpenFoodFacts').mockResolvedValue(path === 'OFF products' ? [alpha, beta] : [beta]);
    const result = await service.search('protein bar', 50, 'viewer');
    expect(result.results.map((row) => row.brand)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
  });
});
