import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

// LO-1222R2 B2: a held row whose stored numbers cannot be true is confirmed by its source's *current* numbers, not by
// its own. A stored kJ-as-kcal milk (418 "kcal" for 3.5/4.7/3.6 g) whose Open Food Facts record now reads 64 kcal
// is still handed out with its stored 418.
describe('LO-1222R2 B2: a source confirms the stored numbers, not its own', () => {
  afterEach(() => jest.restoreAllMocks());

  const held = {
    id: 'held-milk', name: 'Whole milk', serving_size_grams: 100, serving_description: '100 g', nutrient_basis: 'PER_100G',
    created_by_user_id: null, barcode: '1222000000002', fiber_g: null, tags: ['off:1222000000002'],
    calories: 418, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.6,
  };
  const corrected = {
    code: '1222000000002', product_name: 'Whole milk',
    nutriments: { 'energy-kcal_100g': 64, proteins_100g: 3.5, carbohydrates_100g: 4.7, fat_100g: 3.6 },
  };

  it('a held barcode row with impossible stored numbers is refused even when the source now reads true', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ status: 1, product: corrected }),
    }));
    const food = new FoodService(stub<PrismaService>({ foodItem: {
      findUnique: jest.fn().mockResolvedValue(held),
      findFirst: jest.fn().mockResolvedValue(held),
    } }));
    await expect(food.resolveOrImportId('off_1222000000002', 'viewer')).rejects.toThrow(/not found/);
  });

  it('control: a held wine (no stored alcohol) still passes when its source lists the alcohol', async () => {
    const wine = { ...held, id: 'held-wine', name: 'Red wine', barcode: '1222000000003', tags: ['off:1222000000003'],
      calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0 };
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
      ok: true, status: 200, json: async () => ({ status: 1, product: { code: '1222000000003', product_name: 'Red wine',
        nutriments: { 'energy-kcal_100g': 83, proteins_100g: 0.1, carbohydrates_100g: 2.7, fat_100g: 0, alcohol_100g: 13.5 } } }),
    }));
    const food = new FoodService(stub<PrismaService>({ foodItem: { findUnique: jest.fn().mockResolvedValue(wine) } }));
    await expect(food.resolveOrImportId('off_1222000000003', 'viewer')).resolves.toBe('held-wine');
  });
});
