/**
 * AUD-OPUS-CM3-116 (lens Claude Opus 5.5) probe: backend #675 @ e45b06f9 MERGED with
 * trials #672 @ e06b5b13 (createData gains `trial_days: input.trial_days ?? 0`;
 * only conflict = two import lines in packages.controller.ts, both kept).
 * Question: does a key claimed by #675 BEFORE #672 deploys still replay after it?
 * The ledger is seeded with the exact request_hash values #675 @ e45b06f9 stores
 * for two fixed bodies (asserted literally by audit-opcm3-675-wire.spec.ts on
 * the unmerged head). Helpers below are copied from that probe.
 * Never merged. Real CoachPackagesController + real PackagesService over real HTTP,
 * both global filters as src/main.ts registers them, production ValidationPipe.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { CoachOrOwnerGuard } from '../src/common/guards/coach-or-owner.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from '../src/filters/throttler-exception.filter';
import { CoachPackagesController } from '../src/packages/packages.controller';
import { PackagesService } from '../src/packages/packages.service';
import type { PrismaService } from '../src/prisma.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

type Row = Record<string, unknown>;

const BOOM_ID = '00000000-0000-4000-8000-0000000b0000';
const UNKNOWN_ID = '00000000-0000-4000-8000-00000000dead';

function makeDb() {
  const st = { packages: [] as Row[], ledger: [] as Row[], n: 0, failCreate: false };
  const nextId = () => `00000000-0000-4000-8000-${String(++st.n).padStart(12, '0')}`;
  const matches = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v);
  const sameKey = (a: Row, b: Row) =>
    a.user_id === b.user_id && a.route_key === b.route_key && a.idempotency_key === b.idempotency_key;
  const db = {
    st,
    reset() {
      st.packages = [];
      st.ledger = [];
      st.n = 0;
      st.failCreate = false;
    },
    coachPackage: {
      findFirst: async ({ where }: { where: Row }) => {
        if (where.id === BOOM_ID) throw new Error('db exploded: secret-internal-text');
        const r = st.packages.find((x) => matches(x, where));
        return r ? { ...r } : null;
      },
      create: async ({ data }: { data: Row }) => {
        if (st.failCreate) {
          throw new Prisma.PrismaClientKnownRequestError('secret sql text', {
            code: 'P2010',
            clientVersion: 'test',
          });
        }
        const row: Row = {
          id: nextId(),
          is_active: true,
          archived_at: null,
          first_published_at: null,
          stripe_price_id: null,
          stripe_product_id: null,
          recurring_stripe_price_id: null,
          created_at: new Date(0),
          updated_at: new Date(0),
          ...data,
        };
        st.packages.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = st.packages.find((x) => matches(x, where));
        if (!row) throw new Error('package row not found');
        Object.assign(row, data, { updated_at: new Date(0) });
        return { ...row };
      },
    },
    clientPurchase: { count: async () => 0, findMany: async () => [] },
    coachPackageContent: { count: async () => 0 },
    $queryRaw: async () => [],
    workoutBuilderIdempotencyKey: {
      create: async ({ data }: { data: Row }) => {
        if (st.ledger.some((r) => sameKey(r, data))) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row: Row = { ...data, id: nextId() };
        st.ledger.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = st.ledger.find((x) => x.id === where.id);
        if (!r) throw new Error('ledger row not found');
        Object.assign(r, data);
        return { ...r };
      },
      findUnique: async ({ where }: { where: { WorkoutBuilderIdempotencyKey_user_route_key_key: Row } }) => {
        const r = st.ledger.find((x) => sameKey(x, where.WorkoutBuilderIdempotencyKey_user_route_key_key));
        return r ? { ...r } : null;
      },
    },
    $transaction: async <T>(cb: (tx: object) => Promise<T>): Promise<T> => {
      const pkgs = st.packages.map((r) => ({ ...r }));
      const led = st.ledger.map((r) => ({ ...r }));
      try {
        return await cb(db);
      } catch (err) {
        st.packages = pkgs;
        st.ledger = led;
        throw err;
      }
    },
  };
  return db;
}

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers['x-test-user'];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'coach' };
    // RequestIdMiddleware stand-in, so request_id is part of every envelope.
    req.requestId = 'req-probe-1';
    return true;
  }
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Row;
}

const PATH = '/v1/coach/packages';
const BODY = {
  name: 'North coaching',
  description: 'Coaching for strength.',
  amount_cents: 4900,
  currency: 'usd',
  billing_type: 'recurring',
  billing_interval: 'month',
  billing_interval_count: 1,
};

async function makeApp(filters: unknown[] | null, db: ReturnType<typeof makeDb>, heads: Record<string, string>) {
  const original = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, CoachPackagesController) as unknown[];
  if (filters) Reflect.defineMetadata(EXCEPTION_FILTERS_METADATA, filters, CoachPackagesController);
  try {
    const svc = new PackagesService(
      db as unknown as PrismaService,
      { getHeadCoachIdForSubCoach: async (id: string) => heads[id] ?? null } as unknown as SubCoachScopeService,
    );
    const allow: CanActivate = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [CoachPackagesController],
      providers: [{ provide: PackagesService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .overrideGuard(CoachOrOwnerGuard)
      .useValue(allow)
      .overrideGuard(SubscriptionGuard)
      .useValue(allow)
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter(), new ThrottlerExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return { app, svc, base: `http://127.0.0.1:${port}` };
  } finally {
    Reflect.defineMetadata(EXCEPTION_FILTERS_METADATA, original, CoachPackagesController);
  }
}

function call(base: string, method: string, path: string, o: { user?: string | null; key?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers: Record<string, string> = {};
    if (o.user !== null) headers['x-test-user'] = o.user ?? 'coach-1';
    if (o.key) headers['idempotency-key'] = o.key;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload).toString();
    }
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}



const H0 = '40d1e0108bbd1b7d1cd143f1c0636ca2a9e241e37128502c4ed7abbe707700f9';
const H1 = '765ae7c487c58adbfbd50f1ec32efc5ed7e14b3693789dadf2dd66d09bf8f0ae';
const P0 = '00000000-0000-4000-8000-0000000000a0';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const LIT0 = { name: 'Literal coaching', description: 'Strength.', amount_cents: 4900, currency: 'usd', billing_type: 'recurring', billing_interval: 'month', billing_interval_count: 1 };
const LIT1 = { name: 'Literal one-time', amount_cents: 2500 };

describe('AUD-OPUS-CM3-116 #675 + #672: keys claimed before trials still replay', () => {
  const db = makeDb();
  const heads: Record<string, string> = {};
  let head: Awaited<ReturnType<typeof makeApp>>;

  beforeAll(async () => {
    head = await makeApp(null, db, heads);
  });
  afterAll(async () => {
    await head.app.close();
  });

  function seed() {
    db.reset();
    const pkg = (id: string, extra: Row) => ({
      id, coach_id: 'coach-lit', is_active: true, archived_at: null, published_at: null, interval_count: 1,
      duration_periods: null, recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
      // A row written before #672's migration reads trial_days 0 (column default).
      trial_days: 0, ...extra,
    });
    db.st.packages.push(
      pkg(P0, { name: LIT0.name, description: LIT0.description, amount_cents: 4900, currency: 'usd', billing_type: 'recurring', interval: 'month' }),
      pkg(P1, { name: LIT1.name, description: null, amount_cents: 2500, currency: 'usd', billing_type: 'one_time', interval: null }),
    );
    const claim = (key: string, hash: string, pid: string) => ({
      id: `claim-${key}`, user_id: 'coach-lit', route_key: 'packages:create', idempotency_key: key,
      status: 'completed', status_code: 201, response_json: { request_hash: hash, package_id: pid },
    });
    db.st.ledger.push(claim('key-literal-01', H0, P0), claim('key-literal-02', H1, P1));
  }

  it('control: the merged createData really adds trial_days (else this probe proves nothing)', async () => {
    db.reset();
    const r = await call(head.base, 'POST', PATH, { user: 'coach-x', key: 'key-control-01', body: LIT0 });
    expect(r.status).toBe(201);
    expect(r.body).toHaveProperty('trial_days', 0);
  });

  it('the same body re-sent with a pre-#672 key replays its package (recurring and one-time)', async () => {
    seed();
    const a = await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-literal-01', body: LIT0 });
    const b = await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-literal-02', body: LIT1 });
    expect([a.status, a.headers['idempotent-replayed'], a.body.id]).toEqual([201, 'true', P0]);
    expect([b.status, b.headers['idempotent-replayed'], b.body.id]).toEqual([201, 'true', P1]);
    expect(db.st.packages).toHaveLength(2);
  });

  it('an app that now sends trial_days 0 (or null) explicitly still replays', async () => {
    seed();
    const a = await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-literal-01', body: { ...LIT0, trial_days: 0 } });
    const b = await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-literal-02', body: { ...LIT1, trial_days: null } });
    expect([a.status, a.body.id]).toEqual([201, P0]);
    expect([b.status, b.body.id]).toEqual([201, P1]);
    expect(db.st.packages).toHaveLength(2);
  });

  it('a real trial on the old key is different details: 422 naming the package on the wire (adoptable)', async () => {
    seed();
    const r = await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-literal-01', body: { ...LIT0, trial_days: 7 } });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', package_id: P0 });
    expect(db.st.packages).toHaveLength(2);
  });

  it('a key claimed after the merge stores the same hash as before it', async () => {
    db.reset();
    await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-after-0001', body: LIT0 });
    await call(head.base, 'POST', PATH, { user: 'coach-lit', key: 'key-after-0002', body: LIT1 });
    expect(db.st.ledger.map((r) => (r.response_json as Row).request_hash)).toEqual([H0, H1]);
  });
});
