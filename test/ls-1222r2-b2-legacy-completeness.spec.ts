import { Prisma } from '@prisma/client';
import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
const row = {
  id: 'legacy-cereal', name: 'Packaged cereal', brand_or_restaurant: 'Acme', category: 'generic',
  serving_description: '100 g', serving_size_grams: 100, nutrient_basis: 'PER_100G',
  calories: 60, protein_g: 0, carbs_g: 15, fat_g: 0, fiber_g: null,
  created_by_user_id: null, word_match: 0, search_aliases: [], image_url: null,
  tags: ['usda:1222202'],
};
const source = (protein: number) => ({
  fdcId: 1222202, description: row.name, dataType: 'Branded', foodNutrients: [
    { nutrientName: 'Energy', unitName: 'KCAL', value: 60 + 4 * protein },
    { nutrientName: 'Protein', unitName: 'G', value: protein },
    { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 15 },
    { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0 },
  ],
});
const product = (protein: number) => ({
  code: '1222202', product_name: row.name, nutriments: {
    'energy-kcal_100g': 60 + 4 * protein, proteins_100g: protein, carbohydrates_100g: 15, fat_100g: 0,
  },
});
function world(tags: string[]) {
  const held = { ...row, tags };
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
    ({ id: 'new-log', ...data, food_item: held }));
  const prisma = stub<PrismaService>({
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [held] : []),
    foodItem: {
      findMany: jest.fn().mockResolvedValue([held]),
      findFirst: jest.fn().mockResolvedValue(held), findUnique: jest.fn().mockResolvedValue(held),
    },
    loggedFoodEntry: { create },
  });
  const food = new FoodService(prisma);
  const log = new LogService(prisma, food, stub({ capture: jest.fn() }),
    stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }));
  return { food, log, create };
}

describe('LS-1222R2 B2: legacy completeness evidence must support the stored zero', () => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it.each(['typed search', 'short list'] as const)(
    '%s cannot expose an unverified USDA Branded macro as zero',
    async (path) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
        ok: true, status: 200, json: async () => ({ foods: [], products: [] }),
      }));
      const { food } = world(row.tags);
      expect((await food.search(path === 'short list' ? '' : row.name, 50, 'viewer')).results).toEqual([]);
    },
  );

  it.each(['usda_', 'off_', 'uuid-usda', 'uuid-off'] as const)(
    '%s does not turn a source-confirmed 3 g protein into its old missing-macro zero',
    async (path) => {
      jest.spyOn(global, 'fetch').mockImplementation(async (url) => stub<Response>({
        ok: true, status: 200, json: async () => new URL(String(url)).hostname === 'api.nal.usda.gov'
          ? source(3) : { product: product(3) },
      }));
      const { log, create } = world(path.includes('off') ? ['off:1222202'] : row.tags);
      await expect(log.logFood('viewer', {
        food_item_id: path.startsWith('uuid') ? row.id : `${path}1222202`,
        date: '2026-11-05', meal_type: 'breakfast',
      })).rejects.toThrow(/not found/i);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(['usda_', 'off_'] as const)('control: %s may use a zero the source really lists as zero', async (path) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => path === 'usda_' ? source(0) : { product: product(0) },
    }));
    await expect(world(path === 'off_' ? ['off:1222202'] : row.tags).food.resolveOrImportId(`${path}1222202`, 'viewer'))
      .resolves.toBe(row.id);
  });
});
