/**
 * UX-FOOD-PRIV-124: a custom food is private to the person who created it.
 *
 * Client A types in "Grandma Rosa's lasagne" (with a barcode). Client B must
 * not find it by search (including a search A's request already cached), by
 * id, by barcode, or by logging its id; A can do all of these, and A's
 * logged entry still works. Shared catalog rows (no creator) and USDA /
 * OpenFoodFacts imports stay visible to everyone and are never owned.
 *
 * The real FoodService, FoodController and LogService run against an
 * in-memory FoodItem table. Local search reads the composed SQL the service
 * sends ($queryRaw), so a missing owner filter returns A's row to B here.
 */
import { Prisma } from '@prisma/client';
import { FoodController } from '../src/food/food.controller';
import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const A = 'client-a';
const B = 'client-b';

type Row = Record<string, unknown> & { id: string; name: string };

const food = (id: string, name: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  name,
  brand_or_restaurant: null,
  category: 'generic',
  serving_description: '1 portion',
  serving_size_grams: 0,
  nutrient_basis: 'PER_SERVING',
  calories: 520,
  protein_g: 30,
  carbs_g: 45,
  fat_g: 22,
  fiber_g: null,
  sugar_g: null,
  sodium_mg: null,
  tags: [],
  search_aliases: [],
  image_url: null,
  barcode: null,
  created_by_user_id: null,
  ...extra,
});

/** Flat equality plus `OR` and `tags: { has }`, the filters FoodService sends. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR' && Array.isArray(want)) return want.some((w) => matches(row, w));
    if (key === 'tags' && want && typeof want === 'object' && 'has' in want) {
      return Array.isArray(row.tags) && row.tags.includes(Reflect.get(want, 'has'));
    }
    return (row[key] ?? null) === want;
  });
}

function setup(opts: { trigram?: boolean } = {}) {
  const rows: Row[] = [
    food('shared-lasagne', 'Lasagne', { calories: 135, nutrient_basis: 'PER_100G', serving_size_grams: 100 }),
  ];
  let created = 0;
  const sqlTexts: string[] = [];
  const createRow = async ({ data }: { data: Record<string, unknown> }) => {
    const row = food(`food-${(created += 1)}`, String(data.name), { created_by_user_id: null, ...data });
    rows.push(row);
    return row;
  };
  const foodItem = {
    findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, where)) ?? null,
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) =>
      rows.filter((r) => matches(r, where)).slice(0, take),
    ),
    create: jest.fn(createRow),
    upsert: jest.fn(async ({ where, create }: { where: Record<string, unknown>; create: Record<string, unknown> }) =>
      rows.find((r) => matches(r, where)) ?? createRow({ data: create }),
    ),
  };
  // Local search: the owner condition the service composed decides the rows.
  const $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    sqlTexts.push(sql.sql);
    if (opts.trigram === false && sql.sql.includes('similarity(')) throw new Error('no pg_trgm');
    const term = String(sql.values.find((v) => v !== A && v !== B))
      .replace(/%/g, '')
      .toLowerCase();
    const sharedOnly = sql.sql.includes('"created_by_user_id" IS NULL');
    const owner = sql.values.find((v) => v === A || v === B);
    if (!sharedOnly && owner === undefined) throw new Error('local search sent without an owner condition');
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(term) &&
        (sharedOnly ? r.created_by_user_id === null : r.created_by_user_id === owner),
    );
  });
  const prisma = stub<PrismaService>({ foodItem, $queryRaw });
  const service = new FoodService(prisma);
  return { rows, foodItem, service, sqlTexts };
}

const asUser = (id: string) => stub<AuthedRequest>({ user: { id } });

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  // USDA + OpenFoodFacts answer with nothing and an unknown barcode.
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
    stub<Response>({ ok: false, status: 404, json: async () => ({}) }),
  );
});
afterEach(() => fetchSpy.mockRestore());

async function createAsA(service: FoodService) {
  const controller = new FoodController(service);
  return controller.create(asUser(A), {
    name: "Grandma Rosa's lasagne",
    category: 'generic',
    serving_description: '1 portion',
    serving_size_grams: 0,
    nutrient_basis: 'PER_SERVING',
    calories: 520,
    protein_g: 30,
    carbs_g: 45,
    fat_g: 22,
    barcode: '4006381333931',
  });
}

describe('custom foods are private to their creator (UX-FOOD-PRIV-124)', () => {
  it('records the creator on the custom-food create path', async () => {
    const { service, foodItem } = setup();
    const createdFood = await createAsA(service);
    expect(foodItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Grandma Rosa's lasagne", created_by_user_id: A }),
    });
    expect(createdFood).toMatchObject({ created_by_user_id: A });
  });

  it.each([true, false])('search: B never sees A food, A does (pg_trgm %s), even from the cache A filled', async (trigram) => {
    const { service, sqlTexts } = setup({ trigram });
    await createAsA(service);
    const controller = new FoodController(service);

    const forA = await controller.search(asUser(A), 'lasagne');
    expect(forA.results.map((r) => r.name)).toEqual(['Lasagne', "Grandma Rosa's lasagne"]);
    const upstreamCalls = fetchSpy.mock.calls.length;

    // Same query from B: the shared part now comes from the cache A filled.
    const forB = await controller.search(asUser(B), 'lasagne');
    expect(fetchSpy.mock.calls.length).toBe(upstreamCalls);
    expect(forB.results.map((r) => r.name)).toEqual(['Lasagne']);
    expect(JSON.stringify(forB)).not.toContain('Grandma');
    expect(sqlTexts.every((t) => t.includes('"created_by_user_id"'))).toBe(true);

    // A again, also from the cache, still has their own food.
    const againA = await controller.search(asUser(A), 'lasagne');
    expect(fetchSpy.mock.calls.length).toBe(upstreamCalls);
    expect(againA.results.map((r) => r.name)).toEqual(['Lasagne', "Grandma Rosa's lasagne"]);
  });

  it('search with an empty query lists the catalog plus only the caller own foods', async () => {
    const { service } = setup();
    await createAsA(service);
    const controller = new FoodController(service);
    expect((await controller.search(asUser(B), '')).results.map((r) => r.id)).toEqual(['shared-lasagne']);
    expect((await controller.search(asUser(A), '')).results).toHaveLength(2);
  });

  it('by id: B reads nothing (like a missing id), A reads the food, everyone reads the catalog', async () => {
    const { service } = setup();
    const { id } = await createAsA(service);
    const controller = new FoodController(service);
    expect(await controller.getById(asUser(B), id)).toBeNull();
    expect(await controller.getById(asUser(A), id)).toMatchObject({ name: "Grandma Rosa's lasagne", calories: 520 });
    expect(await controller.getById(asUser(B), 'shared-lasagne')).toMatchObject({ name: 'Lasagne' });
  });

  it('by barcode: B gets not found and no lookup reaches the catalog, A gets the food', async () => {
    const { service, foodItem } = setup();
    await createAsA(service);
    const controller = new FoodController(service);
    await expect(controller.getByBarcode(asUser(B), '4006381333931')).rejects.toThrow('not found');
    expect(foodItem.upsert).not.toHaveBeenCalled();
    expect(await controller.getByBarcode(asUser(A), '4006381333931')).toMatchObject({
      name: "Grandma Rosa's lasagne",
    });
  });

  it('logging: B cannot log A food by id or barcode id; A logs it and the entry carries its nutrition', async () => {
    const { service } = setup();
    const { id } = await createAsA(service);
    const loggedFoodEntry = {
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'entry-1',
        ...create,
        food_item: await service.getById(String(create.food_item_id), String(create.user_id)),
      })),
    };
    const log = new LogService(
      stub<PrismaService>({ loggedFoodEntry }),
      service,
      stub({ capture: jest.fn() }),
      stub({ emit: jest.fn() }),
      stub({ invalidateForUser: jest.fn() }),
    );
    const entry = (food_item_id: string) => ({ food_item_id, date: '2026-10-06', meal_type: 'dinner' as const });

    await expect(log.logFood(B, entry(id))).rejects.toThrow('not found');
    await expect(log.logFood(B, entry('off_4006381333931'))).rejects.toThrow('not found');
    expect(loggedFoodEntry.upsert).not.toHaveBeenCalled();

    const logged = await log.logFood(A, entry(id));
    expect(loggedFoodEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ user_id: A, food_item_id: id }) }),
    );
    expect(logged).toMatchObject({ food_item: { name: "Grandma Rosa's lasagne", calories: 520 } });
  });

  it('a custom food tagged like a USDA import never stands in for that import', async () => {
    const { service, foodItem, rows } = setup();
    rows.push(food('a-fake-usda', 'Not really oats', { created_by_user_id: A, tags: ['usda:168872'] }));
    const previousKey = process.env.USDA_API_KEY;
    process.env.USDA_API_KEY = 'fixture-key';
    fetchSpy.mockResolvedValue(
      stub<Response>({
        ok: true,
        json: async () => ({
          fdcId: 168872,
          description: 'Oats',
          foodNutrients: [{ nutrientName: 'Energy', unitName: 'KCAL', value: 379 }],
        }),
      }),
    );
    try {
      const resolved = await service.resolveOrImportId('usda_168872', B);
      expect(resolved).not.toBe('a-fake-usda');
      expect(foodItem.findFirst).toHaveBeenCalledWith({
        where: { tags: { has: 'usda:168872' }, created_by_user_id: null },
      });
      // The import itself is shared catalog data: no owner.
      expect(rows.find((r) => r.id === resolved)).toMatchObject({ created_by_user_id: null });
    } finally {
      if (previousKey === undefined) delete process.env.USDA_API_KEY;
      else process.env.USDA_API_KEY = previousKey;
    }
  });
});
