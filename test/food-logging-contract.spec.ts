import { ValidationPipe } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import { CreateFoodDto } from '../src/food/food.dto';
import { PrismaService } from '../src/prisma.service';

const customFood = {
  name: 'Lunch from a label',
  category: 'generic',
  serving_description: '2 servings',
  serving_size_grams: 0,
  nutrient_basis: 'PER_SERVING',
  calories: 400,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  tags: [],
  search_aliases: [],
};

function setup() {
  const foodItem = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'created-food' }),
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype), { foodItem }) as PrismaService;
  return { foodItem, service: new FoodService(prisma) };
}

describe('food logging contract — ordinary client portions', () => {
  it('accepts the manual food nutrient basis through the real validation pipe', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validated = await pipe.transform(customFood, { type: 'body', metatype: CreateFoodDto });
    expect(validated.nutrient_basis).toBe('PER_SERVING');
    expect(validated.serving_size_grams).toBe(0);
  });

  it('persists the declared per-portion basis instead of relabelling it per 100g', async () => {
    const { service, foodItem } = setup();
    await service.create({ ...customFood, category: 'generic', nutrient_basis: 'PER_SERVING' });
    expect(foodItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        calories: 400,
        serving_size_grams: 0,
        nutrient_basis: 'PER_SERVING',
      }),
    });
  });

  it('keeps the existing per-100g default when a basis is not supplied', async () => {
    const { service, foodItem } = setup();
    const { nutrient_basis: _basis, ...payload } = customFood;
    await service.create({ ...payload, category: 'generic' });
    expect(foodItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ nutrient_basis: 'PER_100G' }),
    });
  });

  it('rejects an unsupported basis rather than accepting arbitrary catalog fields', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform(
      { ...customFood, nutrient_basis: 'UNKNOWN' },
      { type: 'body', metatype: CreateFoodDto },
    )).rejects.toThrow();
  });

  it('ships the volume weights that correspond to the server support flag', async () => {
    const { service, foodItem } = setup();
    foodItem.findUnique.mockResolvedValue({
      id: 'milk', name: 'Milk', category: 'generic', serving_description: '100g',
      serving_size_grams: 100, calories: 61, protein_g: 3.2, carbs_g: 4.8, fat_g: 3.3,
    });
    expect(await service.getById('milk')).toEqual(expect.objectContaining({
      supports_volume_units: true, cup_grams: 240, tbsp_grams: 15, tsp_grams: 5,
    }));
  });

  it('does not invent a volume weight for a category without density data', async () => {
    const { service, foodItem } = setup();
    foodItem.findUnique.mockResolvedValue({
      id: 'food', name: 'Food', category: 'unrecognised', serving_description: '100g',
      serving_size_grams: 100, calories: 100, protein_g: 10, carbs_g: 10, fat_g: 2,
    });
    expect(await service.getById('food')).toEqual(expect.objectContaining({
      supports_volume_units: false, cup_grams: undefined,
    }));
  });
});

describe('USDA search-to-log detail import', () => {
  let originalKey: string | undefined;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    originalKey = process.env.USDA_API_KEY;
    process.env.USDA_API_KEY = 'fixture-key';
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    if (originalKey === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = originalKey;
  });

  it('imports full-detail nutrient.amount and nested nutrient fields without losing macros', async () => {
    const { service, foodItem } = setup();
    // USDA full FoodNutrient schema, not the flattened search response.
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        fdcId: 123, description: 'Oats', servingSize: 40, servingSizeUnit: 'g',
        foodNutrients: [
          { amount: 379, nutrient: { name: 'Energy', unitName: 'kcal' } },
          { amount: 13, nutrient: { name: 'Protein', unitName: 'g' } },
          { amount: 67.7, nutrient: { name: 'Carbohydrate, by difference', unitName: 'g' } },
          { amount: 6.5, nutrient: { name: 'Total lipid (fat)', unitName: 'g' } },
        ],
      }),
    } as Response);
    await service.resolveOrImportId('usda_123');
    expect(foodItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ calories: 379, protein_g: 13, carbs_g: 67.7, fat_g: 6.5 }),
    });
  });

  it('continues to accept flat search-style nutrients and the prior plural carbohydrate label', async () => {
    const { service, foodItem } = setup();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        fdcId: 456, description: 'Rice',
        foodNutrients: [
          { nutrientName: 'Energy', unitName: 'KCAL', value: 130 },
          { nutrientName: 'Protein', unitName: 'G', value: 2.7 },
          { nutrientName: 'Carbohydrates, by difference', unitName: 'G', value: 28 },
          { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.3 },
        ],
      }),
    } as Response);
    await service.resolveOrImportId('usda_456');
    expect(foodItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ calories: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3 }),
    });
  });
});
