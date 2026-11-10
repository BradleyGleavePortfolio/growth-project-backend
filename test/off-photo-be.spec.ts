/**
 * OFF-PHOTO-BE: an Open Food Facts product a client picks from the server's search and logs by its id becomes the one
 * shared food row for its code, with the product's photo, and every id search lists can be logged. DB-free: the real
 * FoodService and LogService over a small in-memory FoodItem and LoggedFoodEntry store (shaped like
 * test/lo-1222-b1222-b1.spec.ts:14-26), fetch spied as in test/fix-1222-held-sources.spec.ts:24-39. Live twins of
 * cases 3 and 4 on a real database: test/rls/off-photo-be-rls.spec.ts.
 *
 * Every Open Food Facts answer is built key for key from what the mappers and filters read (food.service.ts at
 * 647c671): code and _id (:963), product_name (:938, :964), brands (:965), nutriments energy-kcal_100g (:952),
 * proteins_100g (:970), carbohydrates_100g (:971), fat_100g (:972), image_front_small_url (:978); offNumbersUsable
 * (:517-524) needs the energy and the three macros listed and 4/4/9 numbers that can be true. Codes and names are
 * made up.
 */
import { NotFoundException } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import type { CreateFoodDto } from '../src/food/food.dto';
import { LogService } from '../src/log/log.service';
import type { LogFoodDto } from '../src/log/log.dto';
import type { PrismaService } from '../src/prisma.service';

const stub = <T>(v: unknown) => v as T;
type Row = Record<string, unknown>;

const A = 'offbe-client-a';
const B = 'offbe-client-b';
const DAY = '2026-11-10';
const IMG = 'https://images.example.test/offbe/granola/front_small.jpg';
// 250 kcal = 4 * 10 + 4 * 30 + 9 * 10, so the numbers can be true (offNumbersUsable :517-524).
const nutriments = { 'energy-kcal_100g': 250, proteins_100g: 10, carbohydrates_100g: 30, fat_100g: 10 };

/** A product with a code (:963), a name (:938), a brand (:965), full numbers (:952, :970-972) and a photo (:978). */
const granola = { code: '4000000000011', product_name: 'Offbe granola', brands: 'Offbe Farm, Other',
  nutriments, image_front_small_url: IMG };
/** No code, but the _id Open Food Facts sends (:963). */
const idOnly = { _id: 'offbe-id-0000000002', product_name: 'Offbe oat bar', nutriments };
/** A name and full numbers, but neither a code nor an _id. */
const codeless = { product_name: 'Offbe codeless crisps', nutriments };

/** Open Food Facts as fetch sees it: search.pl lists `products`; /api/v2/product/<code>.json answers by code or _id. */
function openFoodFacts(products: Row[], productStatus = 200) {
  const byCode = new Map(products.map((p) => [String(p.code ?? p._id ?? ''), p]));
  const productFetches: string[] = [];
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const answer = (body: unknown, status = 200) => stub<Response>({ ok: status < 400, status, json: async () => body });
    if (u.hostname !== 'world.openfoodfacts.org') return answer({ foods: [] });
    if (u.pathname === '/cgi/search.pl') return answer({ products });
    const code = decodeURIComponent(u.pathname.replace('/api/v2/product/', '').replace(/\.json$/, ''));
    productFetches.push(code);
    if (productStatus !== 200) return answer({}, productStatus);
    const product = byCode.get(code);
    return product ? answer({ product }) : answer({ status: 0, status_verbose: 'product not found' }, 404);
  });
  return { fetchMock, productFetches };
}

/** In-memory FoodItem and LoggedFoodEntry rows: barcode unique, an upsert's create shared unless it names an owner. */
function store() {
  const foods: Row[] = [];
  const entries: Row[] = [];
  let n = 0;
  const withFood = (e: Row) => ({ ...e, food_item: foods.find((f) => f.id === e.food_item_id) ?? null });
  const foodItem = {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; barcode?: string } }) =>
      foods.find((f) => (where.id !== undefined ? f.id === where.id : f.barcode === where.barcode)) ?? null),
    upsert: jest.fn(async ({ where, create }: { where: { barcode: string }; create: Row }) => {
      const held = foods.find((f) => f.barcode === where.barcode);
      if (held) return held;
      const row = { id: `food-${++n}`, created_by_user_id: null, nutrient_basis: 'PER_100G', ...create };
      foods.push(row);
      return row;
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      const row = { id: `food-${++n}`, ...data };
      foods.push(row);
      return row;
    }),
  };
  const loggedFoodEntry = {
    findUnique: jest.fn(async ({ where }: { where: { client_uuid: string } }) => {
      const e = entries.find((x) => x.client_uuid === where.client_uuid);
      return e ? withFood(e) : null;
    }),
    upsert: jest.fn(async ({ where, create }: { where: { client_uuid: string }; create: Row }) => {
      const e = entries.find((x) => x.client_uuid === where.client_uuid);
      if (e) return withFood(e);
      const row = { id: `entry-${++n}`, ...create };
      entries.push(row);
      return withFood(row);
    }),
    create: jest.fn(async ({ data }: { data: Row }) => {
      const row = { id: `entry-${++n}`, ...data };
      entries.push(row);
      return withFood(row);
    }),
  };
  const prisma = stub<PrismaService>({ foodItem, loggedFoodEntry });
  const food = new FoodService(prisma);
  const log = new LogService(prisma, food, stub({ capture: jest.fn() }), stub({ emit: jest.fn() }),
    stub({ invalidateForUser: jest.fn() }));
  const searchOpenFoodFacts = (q: string, limit = 20) =>
    (food as unknown as { searchOpenFoodFacts(q: string, limit: number): Promise<Array<{ id: string; name: string }>> })
      .searchOpenFoodFacts(q, limit);
  const logFood = (userId: string, food_item_id: string, client_uuid?: string) =>
    log.logFood(userId, stub<LogFoodDto>({ food_item_id, date: DAY, meal_type: 'lunch', client_uuid }));
  return { foods, entries, foodItem, food, log, searchOpenFoodFacts, logFood };
}

describe('OFF-PHOTO-BE: every Open Food Facts id search lists logs as one shared food with its photo', () => {
  afterEach(() => jest.restoreAllMocks());

  it('case 1: a product with no code and no _id is not listed, and every off_ id listed logs', async () => {
    openFoodFacts([granola, codeless, idOnly]);
    const { searchOpenFoodFacts, logFood } = store();
    const listed = await searchOpenFoodFacts('offbe');
    for (const row of listed) {
      expect(row.id).toMatch(/^off_/);
      const entry = await logFood(A, row.id);
      expect(entry.food_item).toMatchObject({ barcode: row.id.slice(4), name: row.name });
    }
    expect(listed.map((r) => r.name)).toEqual(['Offbe granola', 'Offbe oat bar']);
  });

  it('case 2: no code but an _id is listed as off_<_id>; logging it imports one row whose barcode is that value', async () => {
    const { productFetches } = openFoodFacts([idOnly]);
    const { searchOpenFoodFacts, logFood, foods } = store();
    expect((await searchOpenFoodFacts('offbe oat')).map((r) => r.id)).toEqual(['off_offbe-id-0000000002']);
    const entry = await logFood(A, 'off_offbe-id-0000000002');
    expect(productFetches).toEqual(['offbe-id-0000000002']);
    expect(foods).toHaveLength(1);
    expect(entry.food_item).toMatchObject({ barcode: 'offbe-id-0000000002', tags: expect.arrayContaining(['off:offbe-id-0000000002']) });
  });

  it('case 3u: two logs by one client (two keys) get one shared row with the photo; Open Food Facts is fetched once', async () => {
    const { productFetches } = openFoodFacts([granola]);
    const { logFood, foods, foodItem } = store();
    const first = await logFood(A, `off_${granola.code}`, 'offbe-key-1');
    const second = await logFood(A, `off_${granola.code}`, 'offbe-key-2');
    expect(second.id).not.toBe(first.id);
    expect(second.food_item_id).toBe(first.food_item_id);
    expect(foods).toHaveLength(1);
    expect(productFetches).toEqual([granola.code]);
    expect(foodItem.upsert).toHaveBeenCalledTimes(1);
    const create = foodItem.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ image_url: IMG, barcode: granola.code, name: 'Offbe granola', brand_or_restaurant: 'Offbe Farm' });
    expect(create).not.toHaveProperty('created_by_user_id');
    expect(foodItem.create).not.toHaveBeenCalled();
    expect(first.food_item).toMatchObject({ id: first.food_item_id, image_url: IMG, created_by_user_id: null });
  });

  it('case 4u: another client logging the same off_ id gets the same row; nothing new is stored or fetched', async () => {
    const { productFetches } = openFoodFacts([granola]);
    const { logFood, foods, foodItem } = store();
    const a = await logFood(A, `off_${granola.code}`, 'offbe-key-a');
    const b = await logFood(B, `off_${granola.code}`, 'offbe-key-b');
    expect(b.food_item_id).toBe(a.food_item_id);
    expect(b.food_item).toMatchObject({ image_url: IMG, created_by_user_id: null });
    expect(foods).toHaveLength(1);
    expect(productFetches).toHaveLength(1);
    expect(foodItem.upsert.mock.calls[0][0].create).not.toHaveProperty('created_by_user_id');
  });

  it('case 7u: a keyed resend returns the stored entry and fetches nothing', async () => {
    const { productFetches } = openFoodFacts([granola]);
    const { logFood, entries, foodItem } = store();
    const first = await logFood(A, `off_${granola.code}`, 'offbe-key-r');
    const again = await logFood(A, `off_${granola.code}`, 'offbe-key-r');
    expect(again.id).toBe(first.id);
    expect(entries).toHaveLength(1);
    expect(productFetches).toHaveLength(1);
    expect(foodItem.findUnique).toHaveBeenCalledTimes(1);
  });

  it('case 9: Open Food Facts not reached on a first log is retryable and stores nothing; a 404 is "Food not found"', async () => {
    openFoodFacts([granola], 503);
    const outage = store();
    const err = await outage.logFood(A, `off_${granola.code}`, 'offbe-key-503').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NotFoundException);
    expect(String(err)).toMatch(/fetch failed: 503/);
    expect(outage.foodItem.upsert).not.toHaveBeenCalled();
    expect(outage.foods).toHaveLength(0);
    expect(outage.entries).toHaveLength(0);

    jest.restoreAllMocks();
    openFoodFacts([granola], 404);
    const gone = store();
    const missing = await gone.logFood(A, `off_${granola.code}`, 'offbe-key-404').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((missing as NotFoundException).message).toBe('Food not found');
    expect(gone.foodItem.upsert).not.toHaveBeenCalled();
    expect(gone.foods).toHaveLength(0);
  });

  it("case 11: POST /foods with the phone's payload (buildFoodPayload's keys) still makes a private food for its caller", async () => {
    openFoodFacts([]);
    const { food, foodItem, foods, logFood } = store();
    // logSubmit.ts:68-84 at mobile 93de2cbd: no image_url, no barcode.
    const phonePayload = { name: 'Offbe granola', brand_or_restaurant: 'Offbe Farm', category: 'generic',
      serving_description: '100g', serving_size_grams: 100, nutrient_basis: 'PER_100G', calories: 250, protein_g: 10,
      carbs_g: 30, fat_g: 10, tags: [], search_aliases: [] };
    const made = await food.create(stub<CreateFoodDto>(phonePayload), A);
    const data = foodItem.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ ...phonePayload, created_by_user_id: A });
    expect(data.image_url).toBeUndefined();
    expect(data.barcode).toBeUndefined();
    expect(foods).toHaveLength(1);
    expect((await logFood(A, String(made.id))).food_item_id).toBe(made.id);
    await expect(logFood(B, String(made.id))).rejects.toBeInstanceOf(NotFoundException);
  });
});
