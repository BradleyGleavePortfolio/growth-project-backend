/**
 * FIX-1222R2 (b#1222 fix round 2): one table over every path that reads a stored shared row.
 *  R1 Held numbers (LS-1222R2 B1 = LO-1222R2 B1 + B2): a stored row whose numbers cannot be true is refused on every
 *     new use (saved id, saved meal, favourite, usda_, off_, barcode), even when its source's own numbers are true;
 *     a stored wine passes when its source lists the alcohol that makes the stored numbers true.
 *  R2 Legacy zeros (LS-1222R2 B2): a packaged row stored before FIX-1222 (USDA Branded as well as Open Food Facts)
 *     with a 0 g macro is left out of lists, and on a new use passes only when its source lists that macro as 0.
 *  R3 Kept: own custom foods, a keyed resend of an accepted log, a generic USDA row missing a macro (0 g).
 *  R4 LO-1222R2 C1: fibre may sit outside carbohydrate (EU and UK labels): these true foods pass again; the impossible
 *     ones the lenses named stay refused.
 */
import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import { numbersCanBeTrue } from '../src/food/food-truth';
import { LogService } from '../src/log/log.service';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }
const viewer = 'fix-1222r2-viewer';
const code = '1222900000001';

type Row = Record<string, unknown>;
const stored = (numbers: Row, tags: string[], extra: Row = {}): Row => ({
  id: 'stored-row', name: 'Stored food', brand_or_restaurant: null, category: 'generic', created_by_user_id: null,
  nutrient_basis: 'PER_100G', serving_size_grams: 100, serving_description: '100 g', fiber_g: null, sugar_g: null,
  sodium_mg: null, search_aliases: [], image_url: null, word_match: 0, barcode: code, tags, ...numbers, ...extra,
});

/** What the source lists now: its own numbers (true), plus alcohol when given. */
const usdaRecord = (n: Row, dataType = 'Branded') => ({
  fdcId: 1222900, description: 'Source food', dataType, foodNutrients: [
    { nutrientName: 'Energy', unitName: 'KCAL', value: n.calories },
    ...(n.protein_g === undefined ? [] : [{ nutrientName: 'Protein', unitName: 'G', value: n.protein_g }]),
    { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: n.carbs_g },
    { nutrientName: 'Total lipid (fat)', unitName: 'G', value: n.fat_g },
    ...(n.alcohol ? [{ nutrientName: 'Alcohol, ethyl', unitName: 'G', value: n.alcohol }] : []),
  ],
});
const offProduct = (n: Row) => ({
  code, product_name: 'Source food', nutriments: {
    'energy-kcal_100g': n.calories, proteins_100g: n.protein_g, carbohydrates_100g: n.carbs_g, fat_100g: n.fat_g,
    ...(n.alcohol ? { alcohol_100g: Number(n.alcohol) / 0.789 } : {}),
  },
});

function world(row: Row, source: Row | null) {
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const usda = url.hostname === 'api.nal.usda.gov';
    if (url.pathname.includes('/food/') || url.pathname.includes('/product/')) {
      if (source === null) return stub<Response>({ ok: false, status: 404, json: async () => ({}) });
      return stub<Response>({ ok: true, status: 200,
        json: async () => (usda ? usdaRecord(source, String(source.dataType ?? 'Branded')) : { product: offProduct(source) }) });
    }
    return stub<Response>({ ok: true, status: 200, json: async () => ({ foods: [], products: [] }) });
  });
  const create = jest.fn(async ({ data }: { data: Row }) => ({ id: 'new-entry', ...data, quantity_multiplier: 1, food_item: row }));
  const prisma = stub<PrismaService>({
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).sql.includes('IS NULL') ? [row] : []),
    foodItem: {
      findMany: jest.fn().mockResolvedValue([row]),
      findFirst: jest.fn().mockResolvedValue(row), findUnique: jest.fn().mockResolvedValue(row),
    },
    savedMeal: {
      findFirst: jest.fn().mockResolvedValue({ id: 'meal', user_id: viewer,
        items: [{ position: 0, food_item_id: row.id, quantity_multiplier: 1 }] }),
      create: jest.fn(async () => ({ id: 'meal', items: [] })), count: jest.fn().mockResolvedValue(0),
    },
    loggedFoodEntry: { create, upsert: create, findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (writes: Array<Promise<unknown>>) => Promise.all(writes)),
  });
  const food = new FoodService(prisma);
  const deps = [stub({ capture: jest.fn() }), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() })] as const;
  return {
    fetchMock, create, food, prisma,
    log: new LogService(prisma, food, ...(deps as unknown as [never, never, never])),
    saved: new SavedFoodsService(prisma, food, ...(deps as unknown as [never, never, never])),
  };
}

const NEW_USES = ['saved id', 'saved meal', 'usda_', 'off_', 'barcode'] as const;
type Use = (typeof NEW_USES)[number];

/** A new use of the row on one path: resolves to the row id, or rejects as not found. */
function use(w: ReturnType<typeof world>, path: Use, row: Row): Promise<unknown> {
  switch (path) {
    case 'saved id': return w.log.logFood(viewer, { food_item_id: String(row.id), date: '2026-11-05', meal_type: 'lunch' } as never);
    case 'saved meal': return w.saved.logSavedMeal(viewer, 'meal', { date: '2026-11-05', meal_type: 'lunch' } as never);
    case 'usda_': return w.food.resolveOrImportId('usda_1222900', viewer);
    case 'off_': return w.food.resolveOrImportId(`off_${code}`, viewer);
    case 'barcode': return w.food.lookupByBarcode(code, viewer);
  }
}
const tagsFor = (path: Use, kind: 'usda' | 'off') =>
  path === 'usda_' || (path !== 'off_' && path !== 'barcode' && kind === 'usda') ? ['usda:1222900'] : [`off:${code}`];

const key = process.env.USDA_API_KEY;
beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
afterEach(() => {
  jest.restoreAllMocks();
  if (key === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = key;
});

const milk = { calories: 64, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.6 };
const cereal = (protein: number) => ({ calories: 60 + 4 * protein, protein_g: protein, carbs_g: 15, fat_g: 0 });
const wine = { calories: 83, protein_g: 0.1, carbs_g: 2.7, fat_g: 0 };

// [case, stored numbers, extra stored tags, source lists now (null: no record), expected on a new use]
const HELD: Array<[string, Row, string[], Row | null, 'ok' | 'refused']> = [
  ['R1 kJ typed as kcal, source now true', { ...milk, calories: 418 }, [], milk, 'refused'],
  ['R1 energy gap, source true', { calories: 300, protein_g: 1, carbs_g: 1, fat_g: 1 }, [], { ...milk, dataType: 'SR Legacy' }, 'refused'],
  ['R1 over the calorie cap', { calories: 950, protein_g: 1, carbs_g: 1, fat_g: 100 }, [], milk, 'refused'],
  ['R1 over the macro cap', { calories: 480, protein_g: 120, carbs_g: 0, fat_g: 0 }, [], milk, 'refused'],
  ['R1 impossible, checked tag', { ...milk, calories: 418 }, ['truth:checked'], milk, 'refused'],
  ['R2 0 g protein, source lists 3 g', cereal(0), [], cereal(3), 'refused'],
  ['R2 0 g protein, source lists none', cereal(0), [], { ...cereal(3), protein_g: undefined }, 'refused'],
  ['R2 0 g protein, source has no record', cereal(0), [], null, 'refused'],
  ['R2 true zero, source lists 0 g', cereal(0), [], cereal(0), 'ok'],
  ['R2 true zero, source lists 0.3 g (a label 0)', cereal(0), [], { ...cereal(0), protein_g: 0.3 }, 'ok'],
  ['R2 checked row with a 0 (no source read)', cereal(0), ['truth:checked'], null, 'ok'],
  ['control: true numbers', milk, [], null, 'ok'],
];

describe('FIX-1222R2 R1/R2: every new use of a stored shared row reads the stored numbers', () => {
  describe.each(NEW_USES)('%s', (path) => {
    it.each(HELD)('%s', async (_name, numbers, extraTags, source, expected) => {
      const kind = path === 'saved meal' ? 'off' : 'usda';
      const row = stored(numbers, [...tagsFor(path, kind), ...extraTags]);
      const w = world(row, source);
      const result = use(w, path, row);
      if (expected === 'ok') {
        await expect(result).resolves.toBeDefined();
      } else {
        await expect(result).rejects.toThrow(/not found/i);
        expect(w.create).not.toHaveBeenCalled();
      }
    });
  });

  it.each(NEW_USES)('R1 %s: a stored wine passes when its source lists the alcohol that makes it true', async (path) => {
    const tags = path === 'usda_' || path === 'saved id' ? ['usda:1222900', 'basic-food'] : [`off:${code}`];
    const row = stored(wine, tags);
    const w = world(row, { ...wine, alcohol: 10.3, dataType: 'SR Legacy' });
    await expect(use(w, path, row)).resolves.toBeDefined();
  });

  it.each(NEW_USES)('R1 %s: a stored wine is refused when the source lists no alcohol', async (path) => {
    const tags = path === 'usda_' || path === 'saved id' ? ['usda:1222900', 'basic-food'] : [`off:${code}`];
    const row = stored(wine, tags);
    await expect(use(world(row, { ...wine, dataType: 'SR Legacy' }), path, row)).rejects.toThrow(/not found/i);
  });

  it('a refused saved id answers the existing 404 "Food not found"', async () => {
    const row = stored({ ...milk, calories: 418 }, ['usda:1222900']);
    const err = await use(world(row, milk), 'saved id', row).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('Food not found');
  });

  it('a favourite and a new saved meal refuse the same impossible stored row', async () => {
    const row = stored({ ...milk, calories: 418 }, ['usda:1222900']);
    const w = world(row, milk);
    await expect(w.saved.addFavorite(viewer, String(row.id))).rejects.toThrow(/not found/i);
    await expect(w.saved.createSavedMeal(viewer, { name: 'Lunch', items: [{ food_item_id: String(row.id), quantity_multiplier: 1 }] } as never))
      .rejects.toThrow(/not found/i);
  });
});

describe('FIX-1222R2 R2: lists leave out legacy packaged zeros, USDA Branded as well as Open Food Facts', () => {
  const LISTED: Array<[string, Row, string[], boolean]> = [
    ['USDA Branded 0 g protein, before FIX-1222', cereal(0), ['usda:1222900'], false],
    ['Open Food Facts 0 g protein, before FIX-1222', cereal(0), [`off:${code}`], false],
    ['USDA Branded 0 g protein, checked', cereal(0), ['usda:1222900', 'truth:checked'], true],
    ['USDA basic food 0 g fat (generic: 0 g)', cereal(0), ['usda:1222900', 'basic-food'], true],
    ['seed row 0 g fat', cereal(0), ['seed:common-foods'], true],
    ['USDA Branded impossible numbers', { ...milk, calories: 418 }, ['usda:1222900', 'truth:checked'], false],
  ];
  it.each(LISTED)('typed search: %s -> shown %s', async (_name, numbers, tags, shown) => {
    const row = stored(numbers, tags, { name: 'Packaged cereal', barcode: null });
    const { food } = world(row, null);
    expect((await food.search('Packaged cereal', 50, viewer)).results.map((r) => r.id)).toEqual(shown ? [row.id] : []);
  });
  it.each(LISTED.filter(([, , tags]) => !tags.includes('basic-food')))('short list: %s -> shown %s', async (_name, numbers, tags, shown) => {
    const row = stored(numbers, tags, { name: 'Packaged cereal', barcode: null });
    const { food } = world(row, null);
    expect((await food.search('', 50, viewer)).results.map((r) => r.id)).toEqual(shown ? [row.id] : []);
  });
});

describe('FIX-1222R2 R3: kept', () => {
  it('an own custom food with any numbers logs by its id with no source read', async () => {
    const row = stored({ ...milk, calories: 418 }, [], { created_by_user_id: viewer, barcode: null });
    const w = world(row, null);
    await expect(use(w, 'saved id', row)).resolves.toBeDefined();
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('a keyed resend of an accepted log returns the stored entry with no food check', async () => {
    const row = stored({ ...milk, calories: 418 }, ['usda:1222900']);
    const w = world(row, milk);
    const earlier = { id: 'earlier', user_id: viewer, food_item: row };
    (w.prisma.loggedFoodEntry.findUnique as jest.Mock).mockResolvedValue(earlier);
    await expect(w.log.logFood(viewer, { food_item_id: String(row.id), client_uuid: 'k1', date: '2026-11-05', meal_type: 'lunch' } as never))
      .resolves.toBe(earlier);
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('a generic USDA row missing fat logs as 0 g when its calories pass', async () => {
    const row = stored(cereal(0), ['usda:1222900']);
    const w = world(row, null);
    // A generic (non-Branded) USDA food that leaves fat out reads it as 0 g, as its import does.
    const record = usdaRecord(cereal(0), 'Survey (FNDDS)');
    w.fetchMock.mockResolvedValue(stub<Response>({ ok: true, status: 200, json: async () => ({ ...record,
      foodNutrients: record.foodNutrients.filter((n) => n.nutrientName !== 'Total lipid (fat)') }) }));
    await expect(w.food.resolveOrImportId('usda_1222900', viewer)).resolves.toBe(row.id);
  });
});

describe('FIX-1222R2 R4 (LO-1222R2 C1): fibre may sit outside carbohydrate', () => {
  // [name, kcal, protein, carbs, fat, fibre] per 100 g, from the source records the lens named.
  const TRUE_FOODS: Array<[string, number, number, number, number, number]> = [
    ["Kellogg's All-Bran Original (UK) 5000127142190", 333.5, 14, 48, 3.5, 27],
    ['Wheat bran (EU) 5056351406997', 271, 16, 20, 5.3, 40],
    ['USDA 167602 seaweed, dry', 259, 15.3, 46.2, 1.4, 36.7],
    ['USDA 168581 cloud ears, dried', 284, 9.3, 73, 0.7, 70.1],
    ['USDA 168998 rose hips, wild', 162, 1.6, 38.2, 0.3, 24.1],
    ['USDA 168999 chokecherries, raw', 162, 3, 33.6, 1.7, 20],
    ['USDA 169045 seed gums', 332, 4.6, 77.3, 0.5, 77.3],
    ['USDA 172243 taco seasoning, dry', 322, 4.5, 58, 0, 13.3],
  ];
  it.each(TRUE_FOODS)('%s passes', (_name, calories, protein_g, carbs_g, fat_g, fiber_g) => {
    expect(numbersCanBeTrue({ calories, protein_g, carbs_g, fat_g, fiber_g })).toBe(true);
  });

  it('All-Bran UK passes a fresh barcode scan', async () => {
    const upsert = jest.fn(async ({ create }: { create: Row }) => ({ id: 'all-bran', ...create }));
    jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({ ok: true, status: 200, json: async () => ({ product: {
      code: '5000127142190', product_name: 'All-Bran Original', nutriments: { 'energy-kcal_100g': 333.5, proteins_100g: 14,
        carbohydrates_100g: 48, fat_100g: 3.5, fiber_100g: 27 } } }) }));
    const food = new FoodService(stub<PrismaService>({ foodItem: { findUnique: jest.fn().mockResolvedValue(null), upsert } }));
    await expect(food.lookupByBarcode('5000127142190', viewer)).resolves.toBe('all-bran');
  });

  it.each([
    ['energy gap', 300, 1, 1, 1, null],
    ['kJ typed as kcal', 418, 3.5, 4.7, 3.6, null],
    ['over the calorie cap', 950, 1, 1, 100, null],
    ['fibre cannot lift the cap', 960, 0, 100, 0, 100],
    ['over the macro cap', 480, 120, 0, 0, null],
  ] as const)('%s stays refused', (_name, calories, protein_g, carbs_g, fat_g, fiber_g) => {
    expect(numbersCanBeTrue({ calories, protein_g, carbs_g, fat_g, fiber_g })).toBe(false);
  });
});
