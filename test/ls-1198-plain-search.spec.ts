import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Candidate = {
  fdcId: number;
  description: string;
  dataType: string;
  foodCategory: string;
  foodNutrients: Array<{ nutrientName: string; unitName: string; value: number }>;
};

const candidate = (fdcId: number, description: string, dataType: string, foodCategory: string, calories: number): Candidate => ({
  fdcId, description, dataType, foodCategory,
  foodNutrients: [{ nutrientName: 'Energy', unitName: 'KCAL', value: calories }],
});

describe('LS-1198 B1: a basic source is not necessarily the plain food', () => {
  const oldKey = process.env.USDA_API_KEY;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'fixture-only';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (oldKey === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = oldKey;
  });

  it('keeps plain oatmeal above an SR Legacy oatmeal cookie, fresh and cached', async () => {
    // Real descriptions and data types, not a live response capture.
    // USDA FNDDS current food code 56203056:
    // https://www.ars.usda.gov/ARSUserFiles/80400530/apps/WWEIA_August2021_August2023_foodcat_FNDDS.xlsx
    // USDA SR Legacy FDC 172725:
    // https://www.spacemelon.com/food/cookies-oatmeal-commercially-prepared-regular/
    // Transport IDs other than 172725 are fixture IDs, not claimed FDC IDs.
    const plain = candidate(1001, 'Oatmeal, regular or quick, made with water, no added fat', 'Survey (FNDDS)', 'Cooked cereals', 71);
    const cookie = candidate(172725, 'Cookies, oatmeal, commercially prepared, regular', 'SR Legacy', 'Baked Products', 450);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
          ? { foods: [plain, cookie] }
          : { products: [] },
      }),
    );
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn().mockResolvedValue([]),
    }));

    const fresh = await service.search('oatmeal', 50, 'viewer');
    const calls = fetchSpy.mock.calls.length;
    const cached = await service.search('oatmeal', 50, 'viewer');

    expect(cached.results.map((food) => food.id)).toEqual(fresh.results.map((food) => food.id));
    expect(fetchSpy.mock.calls.length).toBe(calls);
    expect(fresh.results[0].name).toBe(plain.description);
    expect(cached.results[0].name).toBe(plain.description);
  });

  it.each([
    ['milk', 'Milk, whole, 3.25% milkfat'],
    ['apple', 'Apples, raw, with skin'],
    ['salmon', 'Fish, salmon, Atlantic, wild, raw'],
    ['peanut butter', 'Peanut butter, smooth'],
    ['bread', 'Bread, white, commercially prepared'],
    ['apples', 'Apples, raw, with skin'],
    ['butter peanut', 'Peanut butter, smooth'],
  ])('everyday control %s has the same plain-first order fresh and cached', async (query, plainName) => {
    const plain = candidate(1, plainName, 'SR Legacy', 'Generic test category', 100);
    const branded = {
      ...candidate(2, query.toUpperCase(), 'Branded', 'Packaged Foods', 200),
      brandOwner: 'Acme',
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
          ? { foods: [branded, plain] }
          : { products: [] },
      }),
    );
    const service = new FoodService(stub<PrismaService>({
      $queryRaw: jest.fn().mockResolvedValue([]),
    }));
    const fresh = await service.search(query, 50, 'viewer');
    const calls = fetchSpy.mock.calls.length;
    const cached = await service.search(query, 50, 'viewer');
    expect(fresh.results[0].name).toBe(plainName);
    expect(cached.results).toEqual(fresh.results);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });
});
