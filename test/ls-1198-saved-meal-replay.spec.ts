import { NotFoundException } from '@nestjs/common';
import { SavedFoodsController } from '../src/log/saved-foods.controller';
import { SavedFoodsService } from '../src/log/saved-foods.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Entry = {
  id: string;
  user_id: string;
  client_uuid?: string;
  quantity_multiplier: number;
  food_item: { calories: number };
};

function setup() {
  const rows: Entry[] = [];
  const analytics = { capture: jest.fn() };
  const ai = { invalidateForUser: jest.fn() };
  const ptm = { emit: jest.fn() };
  const service = new SavedFoodsService(
    stub({
      savedMeal: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => ({
          id: where.id, user_id: where.user_id,
          items: [
            { food_item_id: 'food-1', quantity_multiplier: 1, original_quantity: 100, original_unit: 'g' },
            { food_item_id: 'food-2', quantity_multiplier: 0.5, original_quantity: 50, original_unit: 'g' },
          ],
        })),
      },
      loggedFoodEntry: {
        findMany: jest.fn(async ({ where }: { where: { client_uuid: { in: string[] } } }) =>
          rows.filter((row) => row.client_uuid && where.client_uuid.in.includes(row.client_uuid))),
        create: jest.fn(async ({ data }: { data: Omit<Entry, 'id' | 'food_item'> }) => {
          const row = { ...data, id: `entry-${rows.length}`, food_item: { calories: 100 } };
          rows.push(row);
          return row;
        }),
      },
      $transaction: async (operations: Array<Promise<Entry>>) => Promise.all(operations),
    }),
    stub({ resolveOrImportId: jest.fn(async (id: string) => id) }),
    stub(analytics), stub(ptm), stub(ai),
  );
  const controller = new SavedFoodsController(service);
  const body = { date: '2026-10-30', meal_type: 'breakfast' };
  const request = (user: string) => stub<Parameters<SavedFoodsController['logSavedMeal']>[0]>({ user: { id: user } });
  const save = (key?: string, bodyKey?: string, user = 'member-a') =>
    controller.logSavedMeal(request(user), `${user}-meal`, stub({
      ...body, ...(bodyKey ? { client_uuid: bodyKey } : {}),
    }), key);
  return { rows, save, analytics, ptm, ai };
}

describe('LS-1198 independent saved-meal replay controls', () => {
  it('replays the first response without a second pair of rows or events', async () => {
    const h = setup();
    const first = await h.save('intent-a');
    const replay = await h.save('intent-a');
    expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(h.rows).toHaveLength(2);
    expect(h.analytics.capture).toHaveBeenCalledTimes(2);
    expect(h.ptm.emit).toHaveBeenCalledTimes(2);
    expect(h.ai.invalidateForUser).toHaveBeenCalledTimes(1);
  });

  it('does not merge two genuine saves of the same meal with different keys', async () => {
    const h = setup();
    await h.save('intent-a');
    await h.save('intent-b');
    expect(h.rows).toHaveLength(4);
  });

  it('does not silently deduplicate separate no-key saves', async () => {
    const h = setup();
    await h.save();
    await h.save();
    expect(h.rows).toHaveLength(4);
  });

  it('keeps the body key authoritative over a changing header', async () => {
    const h = setup();
    const first = await h.save('header-a', 'body-intent');
    const replay = await h.save('header-b', 'body-intent');
    expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(h.rows).toHaveLength(2);
  });

  it('does not return or modify another member entry when a key is copied', async () => {
    const h = setup();
    const first = await h.save('copied-key');
    await expect(h.save('copied-key', undefined, 'member-b')).rejects.toBeInstanceOf(NotFoundException);
    expect(h.rows).toHaveLength(2);
    expect(h.rows.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(h.rows.every((row) => row.user_id === 'member-a')).toBe(true);
    // This pins privacy, not a claim that member-b's independent row was saved.
  });
});
