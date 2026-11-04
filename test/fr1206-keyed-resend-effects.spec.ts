/**
 * FR-1206 (b#1206 fix round 1, LS-1206 B1): a keyed resend that stores nothing
 * new runs none of the side effects a first save runs.
 *
 * The phone saves water (POST /nutrition/water) or a weigh-in (POST /weight),
 * the answer is lost, and it sends the same save again with the same
 * client_uuid. The first save runs every effect: the global Roman context bust
 * (RomanContextInvalidationInterceptor, as RomanModule registers it), and for a
 * weigh-in the 'weight_logged' PTM emit and the direct AI reset. The resend
 * answers with the stored row, exactly as the first answer, and runs none of
 * them. A save with no key, and a request after a resend, run them as before.
 *
 * Real Nest HTTP app: the real controllers, services, global interceptor and
 * whitelist pipe; a fake table with the unique client_uuid index (a second
 * insert of a stored key throws P2002; setImmediate lets two sends at once both
 * miss the lookup).
 */
import 'reflect-metadata';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WaterController } from '../src/water/water.controller';
import { WaterService } from '../src/water/water.service';
import { WeightController } from '../src/weight/weight.controller';
import { WeightService } from '../src/weight/weight.service';
import {
  _resetRomanContextListeners,
  onRomanContextInvalidate,
  RomanContextInvalidationInterceptor,
} from '../src/roman/context/roman-context-invalidation';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown> & { id: string; user_id: string; client_uuid: string | null };
type CreateArgs = {
  data: Record<string, unknown> & { user_id: string; client_uuid?: string };
  omit?: { client_uuid?: boolean };
};

const tick = () => new Promise((r) => setImmediate(r));

function fakeTable(prefix: string) {
  const rows: Row[] = [];
  let n = 0;
  return {
    rows,
    findUnique: jest.fn(async ({ where }: { where: { client_uuid: string } }) => {
      await tick();
      const row = rows.find((r) => r.client_uuid === where.client_uuid);
      return row ? { ...row } : null;
    }),
    findFirst: jest.fn(async () => null),
    create: jest.fn(async ({ data, omit }: CreateArgs) => {
      await tick();
      const key = data.client_uuid ?? null;
      if (key !== null && rows.some((r) => r.client_uuid === key)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      n += 1;
      const row: Row = { id: `${prefix}-${n}`, created_at: new Date('2026-11-03T18:00:00.000Z'), ...data, client_uuid: key };
      rows.push(row);
      const copy: Record<string, unknown> = { ...row };
      if (omit?.client_uuid) delete copy.client_uuid;
      return copy;
    }),
  };
}

const MEMBER = 'fr1206-member';
const OTHER = 'fr1206-other-member';

let app: INestApplication;
let base: string;
const water = fakeTable('water');
const weight = fakeTable('weigh-in');
const busts = jest.fn();
const emit = jest.fn();
const aiReset = jest.fn();

beforeAll(async () => {
  _resetRomanContextListeners();
  onRomanContextInvalidate(busts);
  const prisma = stub<PrismaService>({ waterLog: water, weightLog: weight });
  const mod = await Test.createTestingModule({
    controllers: [WaterController, WeightController],
    providers: [
      { provide: WaterService, useValue: new WaterService(prisma) },
      {
        provide: WeightService,
        useValue: new WeightService(
          prisma,
          stub<PtmService>({ emit }),
          stub<ClientAIContextService>({ invalidateForUser: aiReset }),
        ),
      },
      // The production binding from RomanModule.
      { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest<{
          headers: Record<string, string>;
          user: { id: string; role: string };
        }>();
        req.user = { id: req.headers['x-test-member'] ?? MEMBER, role: 'student' };
        return true;
      },
    })
    .compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  _resetRomanContextListeners();
});

async function post(path: string, body: object, member = MEMBER) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-member': member },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface RouteCase {
  name: string;
  path: string;
  table: ReturnType<typeof fakeTable>;
  body: (n: number) => Record<string, unknown>;
  /** PTM emits and direct AI resets one stored row runs (0 for water: it has neither). */
  directEffects: number;
}

const ROUTES: RouteCase[] = [
  {
    name: 'water',
    path: '/nutrition/water',
    table: water,
    body: (n) => ({ amount_ml: 250 * n, date: '2026-11-03' }),
    directEffects: 0,
  },
  {
    name: 'weight',
    path: '/weight',
    table: weight,
    body: (n) => ({ weight_lbs: 170 + n, date: '2026-11-03', notes: `n${n}` }),
    directEffects: 1,
  },
];

const effects = () => ({ busts: busts.mock.calls.length, emits: emit.mock.calls.length, aiResets: aiReset.mock.calls.length });

beforeEach(() => {
  busts.mockClear();
  emit.mockClear();
  aiReset.mockClear();
});

describe.each(ROUTES)('FR-1206: keyed $name save, then its resend', (route) => {
  const key = `fr1206-${route.name}-key`;
  const d = route.directEffects;

  it('the first keyed save runs every effect; the resend answers the stored row and runs none', async () => {
    const before = route.table.rows.length;
    const first = await post(route.path, { ...route.body(1), client_uuid: key });
    expect(first.status).toBe(201);
    expect(first.body.client_uuid).toBe(key);
    expect(route.table.rows.length).toBe(before + 1);
    expect(effects()).toEqual({ busts: 1, emits: d, aiResets: d });

    busts.mockClear();
    emit.mockClear();
    aiReset.mockClear();
    const resend = await post(route.path, { ...route.body(2), client_uuid: key });
    // The answer a resend gets is exactly the first answer: the stored row, no mark in it.
    expect(resend).toEqual(first);
    expect(Object.keys(resend.body).sort()).toEqual(Object.keys(first.body).sort());
    expect(route.table.rows.length).toBe(before + 1);
    expect(effects()).toEqual({ busts: 0, emits: 0, aiResets: 0 });
  });

  it('the mark is for that one request: the next new save on the route still runs every effect', async () => {
    const next = await post(route.path, { ...route.body(3), client_uuid: `${key}-next` });
    expect(next.status).toBe(201);
    expect(effects()).toEqual({ busts: 1, emits: d, aiResets: d });
  });

  it('two sends at once: one row, and only the winner runs the effects', async () => {
    const raceKey = `${key}-race`;
    const before = route.table.rows.length;
    const [a, b] = await Promise.all([
      post(route.path, { ...route.body(4), client_uuid: raceKey }),
      post(route.path, { ...route.body(5), client_uuid: raceKey }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect(route.table.rows.length).toBe(before + 1);
    expect(effects()).toEqual({ busts: 1, emits: d, aiResets: d });
  });

  it('no key: every save is a new row with every effect, and the answer keeps its old shape', async () => {
    const before = route.table.rows.length;
    const one = await post(route.path, route.body(6));
    const two = await post(route.path, route.body(6));
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(one.body).not.toHaveProperty('client_uuid');
    expect(two.body.id).not.toBe(one.body.id);
    expect(route.table.rows.length).toBe(before + 2);
    expect(effects()).toEqual({ busts: 2, emits: 2 * d, aiResets: 2 * d });
  });

  it("another member's key: 404, nothing stored, no effect", async () => {
    const before = route.table.rows.length;
    const theirs = await post(route.path, { ...route.body(7), client_uuid: key }, OTHER);
    expect(theirs.status).toBe(404);
    expect(theirs.body.message).toBe('Entry not found');
    expect(route.table.rows.length).toBe(before);
    expect(effects()).toEqual({ busts: 0, emits: 0, aiResets: 0 });
  });
});
