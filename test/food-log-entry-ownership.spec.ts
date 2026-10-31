/**
 * D2 (AUTHB-03) — each food log entry belongs to the person who logged it.
 *
 * The real LogService runs against an in-memory LoggedFoodEntry table that
 * keeps the schema's one rule that matters here: client_uuid is unique
 * across ALL users. Before the fix, an entry logged without a client_uuid
 * was looked up under the shared key '__none__', so once anyone stored that
 * key, every later log by every other person returned that person's entry
 * and saved nothing.
 */
import { LogService } from '../src/log/log.service';
import type { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const A = 'client-a';
const B = 'client-b';
type Entry = Record<string, unknown> & { id: string; user_id: string; client_uuid: string | null };

function setup() {
  const rows: Entry[] = [];
  const foodItem = {
    id: 'food-1',
    name: 'Oats',
    calories: 300,
    protein_g: 10,
    carbs_g: 50,
    fat_g: 5,
  };
  const withFood = (e: Entry) => ({ ...e, food_item: foodItem });
  const insert = (data: Record<string, unknown>) => {
    const key = typeof data.client_uuid === 'string' ? data.client_uuid : null;
    if (key !== null && rows.some((r) => r.client_uuid === key))
      throw new Error('P2002 client_uuid');
    const row: Entry = {
      quantity_multiplier: 1,
      ...data,
      id: `entry-${rows.length + 1}`,
      user_id: String(data.user_id),
      client_uuid: key,
    };
    rows.push(row);
    return row;
  };
  const loggedFoodEntry = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => withFood(insert(data))),
    upsert: jest.fn(
      async ({
        where,
        create,
      }: {
        where: { client_uuid: string };
        create: Record<string, unknown>;
      }) => {
        const found = rows.find((r) => r.client_uuid === where.client_uuid);
        return withFood(found ?? insert(create));
      },
    ),
    // By id, or (FOOD-1-BE R6: logFood looks a key up first) by client_uuid.
    findUnique: jest.fn(async ({ where }: { where: { id?: string; client_uuid?: string } }) => {
      if (where.client_uuid === undefined) return rows.find((r) => r.id === where.id) ?? null;
      const found = rows.find((r) => r.client_uuid === where.client_uuid);
      return found ? withFood(found) : null;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(
          rows.find((r) => r.id === where.id)!,
          data,
        ),
    ),
    delete: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1,
        )[0],
    ),
  };
  const ptm = { emit: jest.fn() };
  const log = new LogService(
    stub<PrismaService>({ loggedFoodEntry }),
    stub<FoodService>({ resolveOrImportId: jest.fn(async (id: string) => id) }),
    stub({ capture: jest.fn() }),
    stub(ptm),
    stub({ invalidateForUser: jest.fn() }),
  );
  const entry = (extra: Record<string, unknown> = {}) => ({
    food_item_id: 'food-1',
    date: '2026-10-11',
    meal_type: 'lunch' as const,
    ...extra,
  });
  return { log, rows, entry, ptm };
}

describe('D2 — a food log entry belongs to the person who logged it', () => {
  it("a stored '__none__' key never swallows another person's log", async () => {
    const { log, rows, entry } = setup();
    await log.logFood(A, entry({ client_uuid: '__none__', notes: 'private note' }));

    const mine = await log.logFood(B, entry());

    expect(mine.user_id).toBe(B);
    expect(mine.notes).toBeUndefined();
    expect(rows.filter((r) => r.user_id === B)).toHaveLength(1);
  });

  it('two people logging without a key each get their own entry', async () => {
    const { log, rows, entry } = setup();
    expect((await log.logFood(A, entry())).user_id).toBe(A);
    expect((await log.logFood(B, entry())).user_id).toBe(B);
    expect(rows).toHaveLength(2);
  });

  it("another person's key returns not found, never their entry", async () => {
    const { log, rows, entry, ptm } = setup();
    await log.logFood(A, entry({ client_uuid: 'pfl_a-1', notes: 'private note' }));
    ptm.emit.mockClear();

    await expect(log.logFood(B, entry({ client_uuid: 'pfl_a-1' }))).rejects.toThrow(
      'Entry not found',
    );
    expect(ptm.emit).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: A, notes: 'private note' });
  });

  it('an offline retry with the same key is still idempotent for its owner', async () => {
    const { log, rows, entry } = setup();
    const first = await log.logFood(A, entry({ client_uuid: 'pfl_a-2' }));
    const retry = await log.logFood(A, entry({ client_uuid: 'pfl_a-2' }));
    expect(retry.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });

  it("nobody can edit or delete another person's entry by id", async () => {
    const { log, rows, entry } = setup();
    const a = await log.logFood(A, entry({ notes: 'mine' }));
    await expect(log.updateEntry(B, a.id, { notes: 'changed' })).rejects.toThrow('Entry not found');
    await expect(log.deleteEntry(B, a.id)).rejects.toThrow('Entry not found');
    expect(rows).toEqual([expect.objectContaining({ id: a.id, user_id: A, notes: 'mine' })]);
  });
});
