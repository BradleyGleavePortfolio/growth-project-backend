import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
type Row = Record<string, unknown>;

describe('LS-1222 B2: a validated alcoholic food survives storage', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['wine', 83, 2.7, 13],
    ['spirit', 231, 0, 40],
  ])('%s remains findable and scannable after its first successful import', async (name, kcal, carbs, alcohol) => {
    let held: Row | null = null;
    const foodItem = {
      findUnique: jest.fn(async () => held),
      findMany: jest.fn(async () => held ? [held] : []),
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        held = { id: 'stored-alcohol', nutrient_basis: 'PER_100G', created_by_user_id: null, ...create };
        return held;
      }),
    };
    const service = new FoodService(stub<PrismaService>({ foodItem }));
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ product: {
        code: '1222002', product_name: name, nutriments: {
          'energy-kcal_100g': kcal, proteins_100g: 0, carbohydrates_100g: carbs,
          fat_100g: 0, alcohol_100g: alcohol,
        },
      } }),
    }));
    await expect(service.lookupByBarcode('1222002', 'viewer')).resolves.toBe('stored-alcohol');
    await expect(service.lookupByBarcode('1222002', 'viewer')).resolves.toBe('stored-alcohol');
  });

  it('validated wine stays in the short list after import', async () => {
    let held: Row | null = null;
    const service = new FoodService(stub<PrismaService>({ foodItem: {
      findUnique: jest.fn(async () => held),
      findMany: jest.fn(async () => held ? [held] : []),
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        held = { id: 'stored-wine', nutrient_basis: 'PER_100G', created_by_user_id: null, ...create };
        return held;
      }),
    } }));
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ product: {
        code: '1222002', product_name: 'Red wine', nutriments: {
          'energy-kcal_100g': 83, proteins_100g: 0, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13,
        },
      } }),
    }));
    await service.resolveOrImportId('off_1222002', 'viewer');
    expect((await service.search('', 50, 'viewer')).results.map((r) => r.id)).toContain('stored-wine');
  });
});
