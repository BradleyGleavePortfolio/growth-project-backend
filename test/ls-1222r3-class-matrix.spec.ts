import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  heldRowConfirmed, numbersCanBeTrue, storedNumbersCanBeTrue,
} from '../src/food/food-truth';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import { Prisma } from '@prisma/client';

const stub = <T>(value: unknown) => value as T;
const fdc = [167602, 168581, 168998, 168999, 169045, 172243];
interface LoadedFood {
  fdc_id?: number;
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
}
const lines = gunzipSync(readFileSync(join(__dirname, '../prisma/data/usda-foods.jsonl.gz')))
  .toString('utf8').trim().split('\n');
const loaded: LoadedFood[] = lines.map((line) => JSON.parse(line)).filter((row) => row.fdc_id);
const seed: LoadedFood[] = JSON.parse(readFileSync(join(__dirname, '../prisma/data/seed-foods.json'), 'utf8'));

describe('LS-1222R3 catalog and per-serving consistency controls', () => {
  it('keeps every seed food and each named restored USDA food using the actual shipped data', () => {
    expect(seed.filter((row) => !storedNumbersCanBeTrue(row)).map((row) => row.name)).toEqual([]);
    expect(loaded).toHaveLength(7980);
    expect(loaded.filter((row) => fdc.includes(row.fdc_id ?? 0))).toHaveLength(fdc.length);
    expect(loaded.filter((row) => fdc.includes(row.fdc_id ?? 0) && !storedNumbersCanBeTrue(row))).toEqual([]);
    const rejected = loaded.filter((row) => !storedNumbersCanBeTrue(row));
    console.log('LS-1222R3 actual catalog sweep', {
      seed: seed.length, loaded: loaded.length, accepted: loaded.length - rejected.length,
      rejected: rejected.map((row) => ({ id: row.fdc_id, name: row.name })),
    });
  });

  it.each([1, 28, 100, 250])('keeps the same verdict when represented per %s g serving', (grams) => {
    const cases = [
      { calories: 333.5, protein_g: 14, carbs_g: 48, fat_g: 3.5, fiber_g: 27 },
      { calories: 902, protein_g: 0, carbs_g: 0, fat_g: 100 },
      { calories: 0, protein_g: 0, carbs_g: 100, fat_g: 0 },
      { calories: 941, protein_g: 0, carbs_g: 0, fat_g: 100 },
      { calories: 400, protein_g: 101, carbs_g: 0, fat_g: 0 },
      { calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1 },
    ];
    for (const row of cases) {
      const serving = {
        ...row, nutrient_basis: 'PER_SERVING' as const, serving_size_grams: grams,
        calories: row.calories * grams / 100,
        protein_g: row.protein_g * grams / 100,
        carbs_g: row.carbs_g * grams / 100,
        fat_g: row.fat_g * grams / 100,
        fiber_g: (row.fiber_g ?? 0) * grams / 100,
      };
      expect(numbersCanBeTrue(serving)).toBe(numbersCanBeTrue(row));
    }
  });

  it.each([
    [null, false], [0, true], [0.49, true], [0.5, false], [3, false],
  ] as const)('a source protein of %s supports a held 0 only with compatible evidence: %s', (protein, result) => {
    const row = Object.freeze({
      calories: 60, protein_g: 0, carbs_g: 15, fat_g: 0, tags: ['off:1222301'],
    });
    const before = JSON.stringify(row);
    expect(heldRowConfirmed(row, {
      protein_g: protein, carbs_g: 15, fat_g: 0, alcoholG: 0, polyolsG: 0,
    }, 'basic-food')).toBe(result);
    expect(JSON.stringify(row)).toBe(before);
  });
});

const controls = [
  { title: 'fibre outside carbohydrate', calories: 333.5, protein_g: 14, carbs_g: 48, fat_g: 3.5, fiber_g: 27, ok: true },
  { title: 'true complete 0 kcal', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, ok: true },
  { title: '940 kcal margin boundary', calories: 940, protein_g: 0, carbs_g: 0, fat_g: 100, fiber_g: 0, ok: true },
  { title: 'over 940 kcal', calories: 941, protein_g: 0, carbs_g: 0, fat_g: 100, fiber_g: 0, ok: false },
  { title: 'energy gap not repaired by source', calories: 418, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.6, fiber_g: 0, ok: false },
];
const paths = ['saved uuid', 'usda_', 'off_', 'barcode'] as const;
const oldKey = process.env.USDA_API_KEY;
beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
afterEach(() => {
  jest.restoreAllMocks();
  if (oldKey === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = oldKey;
});

describe.each(controls)('LS-1222R3 held-source parity: $title', (food) => {
  it.each(paths)('%s checks the same stored vector without a row write', async (path) => {
    const row = Object.freeze({
      ...food, id: 'held-r3', name: food.title, created_by_user_id: null,
      nutrient_basis: 'PER_100G', serving_size_grams: 100,
      tags: [path === 'usda_' ? 'usda:1222301' : 'off:1222301'], barcode: '1222301',
    });
    // The source has a corrected, complete plausible vector for the energy-gap
    // control. That must not validate the incompatible held 418-kcal vector.
    const source = food.ok ? food : { calories: 64, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.6, fiber_g: 0 };
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const usda = new URL(String(input)).hostname === 'api.nal.usda.gov';
      return stub<Response>({
        ok: true, status: 200, json: async () => usda ? {
          fdcId: 1222301, description: food.title, dataType: 'Branded', foodNutrients: [
            { nutrientName: 'Energy', unitName: 'KCAL', value: source.calories },
            { nutrientName: 'Protein', unitName: 'G', value: source.protein_g },
            { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: source.carbs_g },
            { nutrientName: 'Total lipid (fat)', unitName: 'G', value: source.fat_g },
          ],
        } : { product: { code: '1222301', product_name: food.title, nutriments: {
          'energy-kcal_100g': source.calories, proteins_100g: source.protein_g,
          carbohydrates_100g: source.carbs_g, fat_100g: source.fat_g,
        } } },
      });
    });
    const create = jest.fn();
    const upsert = jest.fn();
    const service = new FoodService(stub<PrismaService>({
      foodItem: { findUnique: jest.fn().mockResolvedValue(row), findFirst: jest.fn().mockResolvedValue(row), create, upsert },
    }));
    const before = JSON.stringify(row);
    const promise = path === 'barcode' ? service.lookupByBarcode('1222301', 'viewer')
      : service.resolveOrImportId(path === 'saved uuid' ? row.id : `${path}1222301`, 'viewer');
    if (food.ok) await expect(promise).resolves.toBe(row.id);
    else await expect(promise).rejects.toThrow(/not found/i);
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe.each(loaded.filter((food) => fdc.includes(food.fdc_id ?? 0)))(
  'LS-1222R3 restored catalog import round trip: $name', (food) => {
    it.each(['usda', 'off'])('%s maps, stores, lists and reuses the actual fibre-outside record', async (transport) => {
      type Row = Record<string, unknown>;
      let held: Row | null = null;
      const source = {
        fdcId: food.fdc_id, description: food.name, dataType: 'SR Legacy', foodNutrients: [
          { nutrientName: 'Energy', unitName: 'KCAL', value: food.calories },
          { nutrientName: 'Protein', unitName: 'G', value: food.protein_g },
          { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: food.carbs_g },
          { nutrientName: 'Total lipid (fat)', unitName: 'G', value: food.fat_g },
          { nutrientName: 'Fiber, total dietary', unitName: 'G', value: food.fiber_g },
        ],
      };
      const product = { code: String(food.fdc_id), product_name: food.name, nutriments: {
        'energy-kcal_100g': food.calories, proteins_100g: food.protein_g,
        carbohydrates_100g: food.carbs_g, fat_100g: food.fat_g, fiber_100g: food.fiber_g,
      } };
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        return stub<Response>({
          ok: true, status: 200, json: async () =>
            url.pathname.includes('/food/') ? source
              : url.pathname.includes('/product/') ? { product }
                : url.hostname === 'api.nal.usda.gov' ? { foods: [] } : { products: [] },
        });
      });
      const store = (data: Row) => {
        held = {
          id: `restored-${transport}`, created_by_user_id: null, nutrient_basis: 'PER_100G',
          word_match: 0, ...data,
        };
        return held;
      };
      const create = jest.fn(async ({ data }: { data: Row }) => store(data));
      const upsert = jest.fn(async ({ create: data }: { create: Row }) => store(data));
      const service = new FoodService(stub<PrismaService>({
        $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
          Prisma.sql(strings, ...values).sql.includes('IS NULL') && held ? [held] : []),
        foodItem: {
          findFirst: jest.fn(async () => held), findUnique: jest.fn(async () => held),
          create, upsert,
        },
      }));
      const id = await service.resolveOrImportId(`${transport}_${food.fdc_id}`, 'viewer');
      expect(held).toEqual(expect.objectContaining({
        id, calories: food.calories, protein_g: food.protein_g, carbs_g: food.carbs_g,
        fat_g: food.fat_g, fiber_g: food.fiber_g,
      }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(service.resolveOrImportId(id, 'viewer')).resolves.toBe(id);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await service.search(food.name, 50, 'viewer')).results.map((row) => row.id)).toContain(id);
      expect(create.mock.calls.length + upsert.mock.calls.length).toBe(1);
    });
  },
);
