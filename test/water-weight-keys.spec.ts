/**
 * WATER-WEIGHT-KEYS-BE (agent 192; #191-D3 op 1): a water or weight save sent
 * twice counts once.
 *
 * The phone saves water (POST /nutrition/water) or a weigh-in (POST /weight),
 * the answer is lost, and the phone sends the same save again. With the
 * one-time key food already has (client_uuid), the second send stores nothing
 * and answers with the first row. Without a key, every save is a new row, as
 * at main, so phones already in members' hands keep working.
 *
 * The fake store models the tables after the migration: client_uuid is a
 * nullable column with a unique index across all members (NULLs never
 * collide), so a second insert of a stored key throws Prisma P2002. The
 * setImmediate tick lets two sends at once both pass the lookup before
 * either insert lands. The real controllers and services run; guards are
 * covered by the guard-chain suites.
 */
import 'reflect-metadata';
import { NotFoundException, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { WaterController } from '../src/water/water.controller';
import { WaterService } from '../src/water/water.service';
import { LogWaterDto } from '../src/water/water.dto';
import { WeightController } from '../src/weight/weight.controller';
import { WeightService } from '../src/weight/weight.service';
import { LogWeightDto } from '../src/weight/weight.dto';

// R75: the repo's typed test double (as in test/wk-1-be-workout-client-key.spec.ts), in place of inline casts.
function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown> & { id: string; user_id: string; client_uuid: string | null };
type Args = { data: Record<string, unknown> & { user_id: string; client_uuid?: string }; omit?: { client_uuid?: boolean } };

const tick = () => new Promise((r) => setImmediate(r));

/** One table: the columns a create fills in, plus the new nullable unique client_uuid. */
function fakeTable(prefix: string, defaults: () => Record<string, unknown>) {
  const rows: Row[] = [];
  let n = 0;
  const shown = (row: Row, omit?: { client_uuid?: boolean }) => {
    const copy: Record<string, unknown> = { ...row };
    if (omit?.client_uuid) delete copy.client_uuid;
    return copy;
  };
  return {
    rows,
    findUnique: jest.fn(async ({ where, omit }: { where: { client_uuid: string }; omit?: { client_uuid?: boolean } }) => {
      await tick();
      const row = rows.find((r) => r.client_uuid === where.client_uuid);
      return row ? shown(row, omit) : null;
    }),
    findFirst: jest.fn(async ({ where }: { where: { user_id: string } }) => {
      const mine = rows.filter((r) => r.user_id === where.user_id);
      return mine.length ? { ...mine[mine.length - 1] } : null;
    }),
    create: jest.fn(async ({ data, omit }: Args) => {
      await tick();
      if (data.client_uuid != null && rows.some((r) => r.client_uuid === data.client_uuid)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`client_uuid`)', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      n += 1;
      const row: Row = { id: `${prefix}-${n}`, ...defaults(), ...data, client_uuid: data.client_uuid ?? null };
      rows.push(row);
      return shown(row, omit);
    }),
    // The reads every view uses (today's total, the chart, the coach's views): rows by member.
    findMany: jest.fn(async ({ where }: { where: { user_id: string } }) => rows.filter((r) => r.user_id === where.user_id)),
  };
}

const NOW = new Date('2026-11-02T18:00:00.000Z');

function setup() {
  const waterLog = fakeTable('water', () => ({ created_at: NOW }));
  const weightLog = fakeTable('weight', () => ({ notes: null, logged_at: NOW }));
  const prisma = stub<PrismaService>({ waterLog, weightLog });
  const emit = jest.fn();
  const invalidateForUser = jest.fn();
  const water = new WaterController(new WaterService(prisma));
  const weight = new WeightController(
    new WeightService(prisma, stub<PtmService>({ emit }), stub<ClientAIContextService>({ invalidateForUser })),
  );
  const req = (userId: string) => stub<AuthedRequest>({ user: { id: userId, role: 'student' } });
  return { waterLog, weightLog, water, weight, req, emit, invalidateForUser };
}

type Kit = ReturnType<typeof setup>;

/** The two saves, driven the same way: post a body as a member; read that member's rows. */
const KINDS: Array<{
  name: string;
  table: (k: Kit) => ReturnType<typeof fakeTable>;
  post: (k: Kit, userId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  body: Record<string, unknown>;
  other: Record<string, unknown>;
  amount: string;
  /** The response's fields at main, before the column existed. */
  mainShape: string[];
}> = [
  {
    name: 'water (POST /nutrition/water)',
    table: (k) => k.waterLog,
    post: (k, userId, body) => k.water.logWater(k.req(userId), stub<LogWaterDto>(body)),
    body: { amount_ml: 250, date: '2026-11-02T17:00:00.000Z' },
    other: { amount_ml: 500, date: '2026-11-02T17:00:00.000Z' },
    amount: 'amount_ml',
    mainShape: ['amount_ml', 'created_at', 'id', 'logged_at', 'user_id'],
  },
  {
    name: 'weight (POST /weight)',
    table: (k) => k.weightLog,
    post: (k, userId, body) => k.weight.logWeight(k.req(userId), stub<LogWeightDto>(body)),
    body: { weight_lbs: 181.4, date: '2026-11-02' },
    other: { weight_lbs: 179.0, date: '2026-11-02' },
    amount: 'weight_lbs',
    mainShape: ['date', 'id', 'logged_at', 'notes', 'user_id', 'weight_lbs'],
  },
];

const KEY = 'q-7f3c2a10-5b1e-4c8a-9d2f-0a1b2c3d4e5f';
const A = 'client-a';
const B = 'client-b';

describe.each(KINDS)('WATER-WEIGHT-KEYS-BE $name', (kind) => {
  it('K2: the same key sent again stores one row and answers with the first row', async () => {
    const k = setup();
    const first = await kind.post(k, A, { ...kind.body, client_uuid: KEY });
    // The answer to `first` never reached the phone; the phone sends it again.
    const again = await kind.post(k, A, { ...kind.body, client_uuid: KEY });
    expect(await kind.table(k).findMany({ where: { user_id: A } })).toHaveLength(1);
    expect(again).toEqual(first);
    expect(again.client_uuid).toBe(KEY);
  });

  it('K2: the first save wins, even if the resend carries a different amount', async () => {
    const k = setup();
    const first = await kind.post(k, A, { ...kind.body, client_uuid: KEY });
    const again = await kind.post(k, A, { ...kind.other, client_uuid: KEY });
    expect(again.id).toBe(first.id);
    expect(again[kind.amount]).toBe(kind.body[kind.amount]);
    const rows = await kind.table(k).findMany({ where: { user_id: A } });
    expect(rows).toHaveLength(1);
    expect(rows[0][kind.amount]).toBe(kind.body[kind.amount]);
  });

  it('K2: two sends of one key at the same moment store one row (the unique index decides)', async () => {
    const k = setup();
    const [a, b] = await Promise.all([
      kind.post(k, A, { ...kind.body, client_uuid: KEY }),
      kind.post(k, A, { ...kind.body, client_uuid: KEY }),
    ]);
    expect(await kind.table(k).findMany({ where: { user_id: A } })).toHaveLength(1);
    expect(b.id).toBe(a.id);
  });

  it('a different key stores a second row', async () => {
    const k = setup();
    await kind.post(k, A, { ...kind.body, client_uuid: KEY });
    await kind.post(k, A, { ...kind.body, client_uuid: `${KEY}-2` });
    expect(await kind.table(k).findMany({ where: { user_id: A } })).toHaveLength(2);
  });

  it("K3: another member's key answers 404 and never returns, changes or reveals that row", async () => {
    const k = setup();
    const owner = await kind.post(k, A, { ...kind.body, client_uuid: KEY });
    const err = await kind.post(k, B, { ...kind.other, client_uuid: KEY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    // Food's AUTHB-03 answer, word for word: nothing about the stored row.
    expect((err as NotFoundException).message).toBe('Entry not found');
    expect(JSON.stringify((err as NotFoundException).getResponse())).not.toContain(String(owner.id));
    const table = kind.table(k);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ id: owner.id, user_id: A, [kind.amount]: kind.body[kind.amount] });
    expect(await table.findMany({ where: { user_id: B } })).toHaveLength(0);
  });

  it("K3: another member's key at the same moment as the owner's still never returns the owner's row", async () => {
    const k = setup();
    const [a, b] = await Promise.allSettled([
      kind.post(k, A, { ...kind.body, client_uuid: KEY }),
      kind.post(k, B, { ...kind.other, client_uuid: KEY }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(b.status === 'rejected' && b.reason).toBeInstanceOf(NotFoundException);
    expect(kind.table(k).rows).toHaveLength(1);
    expect(kind.table(k).rows[0].user_id).toBe(A);
  });

  it('K3: no key is a plain create, as at main: each send is a new row and the answer keeps its shape', async () => {
    const k = setup();
    const first = await kind.post(k, A, { ...kind.body });
    await kind.post(k, A, { ...kind.body });
    expect(await kind.table(k).findMany({ where: { user_id: A } })).toHaveLength(2);
    expect(kind.table(k).findUnique).not.toHaveBeenCalled();
    // The new column never appears in the answer to a save without a key.
    expect(Object.keys(first).sort()).toEqual(kind.mainShape);
  });

  it('K1: the body accepts client_uuid in food\'s form (a string of at most 128) and nothing looser', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const metatype = kind.name.startsWith('water') ? LogWaterDto : LogWeightDto;
    const validate = (body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype });
    await expect(validate({ ...kind.body, client_uuid: KEY })).resolves.toMatchObject({ client_uuid: KEY });
    await expect(validate({ ...kind.body, client_uuid: 'k'.repeat(128) })).resolves.toMatchObject({
      client_uuid: 'k'.repeat(128),
    });
    await expect(validate({ ...kind.body })).resolves.not.toHaveProperty('client_uuid');
    await expect(validate({ ...kind.body, client_uuid: 'k'.repeat(129) })).rejects.toThrow();
    await expect(validate({ ...kind.body, client_uuid: 12345 })).rejects.toThrow();
  });
});

describe('WATER-WEIGHT-KEYS-BE: a repeated weigh-in counts once everywhere', () => {
  it("K2: a repeat does not emit 'weight_logged' again or bust the AI context again", async () => {
    const k = setup();
    await k.weight.logWeight(k.req(A), stub<LogWeightDto>({ weight_lbs: 181.4, date: '2026-11-02', client_uuid: KEY }));
    await k.weight.logWeight(k.req(A), stub<LogWeightDto>({ weight_lbs: 181.4, date: '2026-11-02', client_uuid: KEY }));
    expect(k.emit).toHaveBeenCalledTimes(1);
    expect(k.emit).toHaveBeenCalledWith(A, 'weight_logged', 0, { weight_lbs: 181.4, prior_weight_lbs: null });
    expect(k.invalidateForUser).toHaveBeenCalledTimes(1);
  });

  it('K2: two sends at once emit once (the loser of the insert race has no effects)', async () => {
    const k = setup();
    const body = stub<LogWeightDto>({ weight_lbs: 181.4, date: '2026-11-02', client_uuid: KEY });
    await Promise.all([k.weight.logWeight(k.req(A), body), k.weight.logWeight(k.req(A), body)]);
    expect(k.emit).toHaveBeenCalledTimes(1);
    expect(k.invalidateForUser).toHaveBeenCalledTimes(1);
  });

  it("K3: another member's key emits nothing for them", async () => {
    const k = setup();
    await k.weight.logWeight(k.req(A), stub<LogWeightDto>({ weight_lbs: 181.4, date: '2026-11-02', client_uuid: KEY }));
    k.emit.mockClear();
    k.invalidateForUser.mockClear();
    await expect(
      k.weight.logWeight(k.req(B), stub<LogWeightDto>({ weight_lbs: 150, date: '2026-11-02', client_uuid: KEY })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(k.emit).not.toHaveBeenCalled();
    expect(k.invalidateForUser).not.toHaveBeenCalled();
  });

  it('no key: every weigh-in emits and busts, as at main', async () => {
    const k = setup();
    await k.weight.logWeight(k.req(A), stub<LogWeightDto>({ weight_lbs: 181.5, date: '2026-11-01' }));
    await k.weight.logWeight(k.req(A), stub<LogWeightDto>({ weight_lbs: 180.5, date: '2026-11-02' }));
    expect(k.emit).toHaveBeenCalledTimes(2);
    expect(k.emit).toHaveBeenLastCalledWith(A, 'weight_logged', -1, { weight_lbs: 180.5, prior_weight_lbs: 181.5 });
    expect(k.invalidateForUser).toHaveBeenCalledTimes(2);
  });
});
