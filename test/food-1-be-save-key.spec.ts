/**
 * FOOD-1-BE, owner ruling R6 (LO-FOOD B6, LS-FOOD B3 server half), class-first
 * over every route that creates a food log:
 *   POST /log/food                      (online save, offline queue flush)
 *   POST /me/foods/saved-meals/:id/log  (a saved meal, one entry per item)
 * Each takes a save key — body client_uuid as the offline queue sends it, or
 * the Idempotency-Key header when the body has none. A repeat with the same
 * key returns the stored log and creates nothing (no entry, no food import, no
 * analytics event, no meal_logged signal). No key: a new entry, as at main.
 */
import { LogController } from '../src/log/log.controller';
import { LogService } from '../src/log/log.service';
import { withClientKey } from '../src/log/log.dto';
import { SavedFoodsController } from '../src/log/saved-foods.controller';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown> & { id: string; client_uuid: string | null; user_id: string };

const A = 'client-a';
const B = 'client-b';
const asUser = (id: string) => stub<AuthedRequest>({ user: { id } });
const food = { id: 'food-1', name: 'Oats', calories: 380 };

function world() {
  const rows: Row[] = [];
  let seq = 0;
  const insert = (data: Record<string, unknown>) => {
    if (data.client_uuid && rows.some((r) => r.client_uuid === data.client_uuid)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const row: Row = {
      quantity_multiplier: 1, ...data, id: `entry-${++seq}`,
      client_uuid: typeof data.client_uuid === 'string' ? data.client_uuid : null, user_id: String(data.user_id),
    };
    rows.push(row);
    return { ...row, food_item: food };
  };
  const loggedFoodEntry = {
    findUnique: jest.fn(async ({ where }: { where: { client_uuid: string } }) => {
      const found = rows.find((r) => r.client_uuid === where.client_uuid);
      return found ? { ...found, food_item: food } : null;
    }),
    findMany: jest.fn(async ({ where }: { where: { client_uuid: { in: string[] } } }) =>
      rows.filter((r) => r.client_uuid !== null && where.client_uuid.in.includes(r.client_uuid)).map((r) => ({ ...r, food_item: food }))),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => insert(data)),
    upsert: jest.fn(async ({ where, create }: { where: { client_uuid: string }; create: Record<string, unknown> }) => {
      const found = rows.find((r) => r.client_uuid === where.client_uuid);
      return found ? { ...found, food_item: food } : insert(create);
    }),
  };
  const savedMeal = {
    // Each person has their own saved meal 'meal-1' of two items.
    findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => ({
      id: where.id, user_id: where.user_id,
      items: [0, 1].map((position) => ({ position, food_item_id: 'food-1', quantity_multiplier: 1, food_item: food })),
    })),
  };
  const prisma = stub<PrismaService>({
    loggedFoodEntry,
    savedMeal,
    $transaction: jest.fn(async (writes: Promise<unknown>[]) => Promise.all(writes)),
  });
  const foodService = { resolveOrImportId: jest.fn(async (id: string) => id) };
  const analytics = { capture: jest.fn() };
  const ptm = { emit: jest.fn() };
  const aiContext = { invalidateForUser: jest.fn() };
  const log = new LogService(prisma, stub<FoodService>(foodService), stub(analytics), stub(ptm), stub(aiContext));
  const saved = new SavedFoodsService(prisma, stub<FoodService>(foodService), stub(analytics), stub(ptm), stub(aiContext));
  const sideEffects = () =>
    foodService.resolveOrImportId.mock.calls.length + analytics.capture.mock.calls.length + ptm.emit.mock.calls.length;
  return {
    rows, loggedFoodEntry, sideEffects, ptm,
    logController: new LogController(log),
    savedController: new SavedFoodsController(saved),
  };
}

const entry = (extra: Record<string, unknown> = {}) => ({
  food_item_id: 'usda_173904', date: '2026-10-30', meal_type: 'breakfast' as const, ...extra,
});
const meal = (extra: Record<string, unknown> = {}) => ({ date: '2026-10-30', meal_type: 'lunch' as const, ...extra });

describe('R6: one stored log per intended save, on every route that creates one', () => {
  type Send = (w: ReturnType<typeof world>, user: string, key: string | undefined, header: string | undefined) => Promise<unknown>;
  const routes: Array<{ route: string; send: Send; perSave: number }> = [
    {
      route: 'POST /log/food',
      send: (w, user, key, header) =>
        w.logController.logFood(asUser(user), entry(key ? { client_uuid: key } : {}), header),
      perSave: 1,
    },
    {
      route: 'POST /me/foods/saved-meals/:id/log',
      send: (w, user, key, header) =>
        w.savedController.logSavedMeal(asUser(user), 'meal-1', meal(key ? { client_uuid: key } : {}), header),
      perSave: 2,
    },
  ];

  describe.each(routes)('$route', ({ send, perSave }) => {
    it.each([
      ['the body key (as the offline queue sends it)', 'save-1', undefined],
      ['the Idempotency-Key header', undefined, 'save-1'],
    ])('a repeat with %s returns the stored log and creates nothing', async (_how, key, header) => {
      const w = world();
      const first = await send(w, A, key, header);
      const effects = w.sideEffects();
      const writes = w.loggedFoodEntry.create.mock.calls.length + w.loggedFoodEntry.upsert.mock.calls.length;

      const again = await send(w, A, key, header);

      expect(again).toEqual(first);
      expect(w.rows).toHaveLength(perSave);
      expect(w.sideEffects()).toBe(effects);
      expect(w.loggedFoodEntry.create.mock.calls.length + w.loggedFoodEntry.upsert.mock.calls.length).toBe(writes);
    });

    it('the body key wins over a different header', async () => {
      const w = world();
      await send(w, A, 'body-key', 'header-key');
      await send(w, A, 'body-key', 'other-header');
      expect(w.rows).toHaveLength(perSave);
      expect(w.rows.every((r) => String(r.client_uuid).startsWith('body-key'))).toBe(true);
    });

    it('no key: each save is a new log, as at main', async () => {
      const w = world();
      await send(w, A, undefined, undefined);
      await send(w, A, undefined, undefined);
      expect(w.rows).toHaveLength(2 * perSave);
    });

    it("another person's key reads as not found and creates nothing", async () => {
      const w = world();
      await send(w, A, 'a-key', undefined);
      const effects = w.sideEffects();
      w.ptm.emit.mockClear();
      await expect(send(w, B, undefined, 'a-key')).rejects.toThrow(/not found/i);
      expect(w.rows).toHaveLength(perSave);
      expect(w.ptm.emit).not.toHaveBeenCalled();
      expect(w.sideEffects()).toBeLessThanOrEqual(effects);
    });
  });
});

describe('withClientKey', () => {
  it.each([
    [{ client_uuid: 'b' }, 'h', 'b'],
    [{}, 'h', 'h'],
    [{}, '  h  ', 'h'],
    [{}, '', undefined],
    [{}, undefined, undefined],
    [{}, 'x'.repeat(129), undefined], // longer than the body field allows: no key, as at main
  ])('%j + header %j -> %j', (body, header, key) => {
    expect(withClientKey<{ client_uuid?: string }>(body, header).client_uuid).toBe(key);
  });
});
