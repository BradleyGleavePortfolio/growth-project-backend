import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

// A pre-change import of a packaged food with no protein amount.
// Its prior mapper wrote the absent amount as zero; 4/4/9 still agrees exactly.
const held = {
  id: 'legacy-packaged', name: 'Packaged cereal', calories: 60, protein_g: 0, carbs_g: 15, fat_g: 0,
  nutrient_basis: 'PER_100G', serving_size_grams: 100, serving_description: '100 g',
  created_by_user_id: null, tags: ['off:1222004'], barcode: '1222004', word_match: 0,
};

describe('LS-1222 B4: legacy absent packaged macros are not represented as real zero', () => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => {
    process.env.USDA_API_KEY = 'fixture-key';
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const usda = String(url).includes('api.nal.usda.gov');
      const food = {
        fdcId: 1222004, description: held.name, dataType: 'Branded', foodNutrients: [
          { nutrientName: 'Energy', unitName: 'KCAL', value: 60 },
          { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 15 },
          { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0 },
        ],
      };
      const product = { code: '1222004', product_name: held.name, nutriments: {
        'energy-kcal_100g': 60, carbohydrates_100g: 15, fat_100g: 0,
      } };
      return stub<Response>({ ok: true, status: 200, json: async () => String(url).includes('/food/')
        ? food : String(url).includes('/product/') ? { product }
          : usda ? { foods: [food] } : { products: [product] } });
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  const world = () => new FoodService(stub<PrismaService>({
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [held] : []),
    foodItem: {
      findMany: jest.fn().mockResolvedValue([held]),
      findUnique: jest.fn().mockResolvedValue(held),
      findFirst: jest.fn().mockResolvedValue({ ...held, tags: ['usda:1222004'] }),
    },
  }));

  it.each(['typed', 'short list'] as const)(
    '%s does not expose a legacy missing protein amount as 0 g',
    async (path) => {
      expect((await world().search(path === 'typed' ? 'packaged cereal' : '', 50, 'viewer')).results).toEqual([]);
    },
  );

  it.each(['barcode', 'off_', 'usda_', 'uuid'] as const)(
    '%s refuses unverified legacy missing macro rather than using its zero',
    async (path) => {
      const service = world();
      const result = path === 'barcode' ? service.lookupByBarcode('1222004', 'viewer')
        : service.resolveOrImportId(path === 'uuid' ? held.id : `${path}1222004`, 'viewer');
      await expect(result).rejects.toThrow(/not found/);
    },
  );

  it('a newly logged legacy packaged food cannot add a fabricated zero to daily totals', async () => {
    const entries: Array<{ food_item: typeof held; quantity_multiplier: number }> = [];
    const loggedFoodEntry = {
      create: jest.fn(async ({ data }: { data: { quantity_multiplier: number } & Record<string, unknown> }) => {
        const entry = { id: 'new-log', ...data, food_item: held };
        entries.push(entry);
        return entry;
      }),
      findMany: jest.fn(async () => entries),
    };
    const log = new LogService(
      stub<PrismaService>({
        loggedFoodEntry, userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
        macroTarget: { findFirst: jest.fn().mockResolvedValue(null) },
      }), world(), stub({ capture: jest.fn() }), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }),
    );
    const result = await log.logFood('viewer', {
      food_item_id: 'off_1222004', date: '2026-11-04', meal_type: 'breakfast',
    }).then(() => 'logged', () => 'refused');
    if (result === 'logged') {
      const daily = await log.getDaily('viewer', '2026-11-04');
      expect(daily.total_protein_g).toBe(0); // demonstrates the downstream value, not the acceptance condition
    }
    expect(result).toBe('refused');
    expect(loggedFoodEntry.create).not.toHaveBeenCalled();
  });
});
