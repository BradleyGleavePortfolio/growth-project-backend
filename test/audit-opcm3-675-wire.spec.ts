/**
 * AUD-OPUS-CM3-116 (lens Claude Opus 5.5) probe for backend #675 @ e45b06f9.
 * Never merged. Real CoachPackagesController + real PackagesService over real
 * HTTP, with BOTH global filters exactly as src/main.ts registers them
 * (HttpExceptionFilter, ThrottlerExceptionFilter) and the production
 * ValidationPipe options.
 *
 * 1. Route filter changes nothing else: the same request battery runs against
 *    the head wiring (@UseFilters(PackageValidationFilter, PackageIdempotencyFilter))
 *    and the pre-PR wiring (@UseFilters(PackageValidationFilter) only, set by
 *    rewriting the class metadata before compile). Every status and body must
 *    be identical (timestamp aside) except the 422 IDEMPOTENCY_KEY_REUSED,
 *    which may differ ONLY by `package_id`.
 * 2. No cross-coach id leak: every response body (any status) is scanned for
 *    package ids outside the caller's current catalog.
 * 3. Hash literals: the request_hash this head stores for two fixed bodies, so
 *    the #672-merged probe can prove keys claimed now still replay later.
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
import { PackageValidationFilter } from '../src/packages/package-validation.filter';
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

const strip = ({ timestamp: _t, ...rest }: Row): Row => rest;

describe('AUD-OPUS-CM3-116 #675 @ e45b06f9: wire contract probe', () => {
  const dbHead = makeDb();
  const dbBase = makeDb();
  const heads: Record<string, string> = {};
  let head: Awaited<ReturnType<typeof makeApp>>;
  let pre: Awaited<ReturnType<typeof makeApp>>;

  beforeAll(async () => {
    pre = await makeApp([PackageValidationFilter], dbBase, heads);
    head = await makeApp(null, dbHead, heads);
  });
  afterAll(async () => {
    await head.app.close();
    await pre.app.close();
  });

  it('control: the head controller really carries two filters and the baseline one', () => {
    const meta = Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, CoachPackagesController) as Array<{ name: string }>;
    expect(meta.map((f) => f.name)).toEqual(['PackageValidationFilter', 'PackageIdempotencyFilter']);
  });

  async function battery(base: string, db: ReturnType<typeof makeDb>) {
    db.reset();
    const out: Array<{ label: string } & Res> = [];
    const rec = async (label: string, p: Promise<Res>) => out.push({ label, ...(await p) });
    await rec('401 no auth', call(base, 'POST', PATH, { user: null, key: 'key-k0-000001', body: BODY }));
    await rec('400 dto type', call(base, 'POST', PATH, { key: 'key-k0-000002', body: { name: 'x', amount_cents: 'abc' } }));
    await rec('400 unknown field', call(base, 'POST', PATH, { key: 'key-k0-000003', body: { ...BODY, hacker: 1 } }));
    await rec('400 bad key', call(base, 'POST', PATH, { key: 'bad key!', body: BODY }));
    await rec('400 below min', call(base, 'POST', PATH, { key: 'key-k0-000005', body: { ...BODY, amount_cents: 500 } }));
    await rec('400 free recurring', call(base, 'POST', PATH, { key: 'key-k0-000006', body: { ...BODY, amount_cents: 0 } }));
    await rec('201 create', call(base, 'POST', PATH, { key: 'key-k1-000001', body: BODY }));
    await rec('201 replay', call(base, 'POST', PATH, { key: 'key-k1-000001', body: BODY }));
    await rec('422 reused', call(base, 'POST', PATH, { key: 'key-k1-000001', body: { ...BODY, amount_cents: 5900 } }));
    db.st.ledger.push({ id: 'seed-ip', user_id: 'coach-1', route_key: 'packages:create', idempotency_key: 'key-k2-000001', status: 'in_progress', response_json: { request_hash: 'x' } });
    await rec('409 in progress', call(base, 'POST', PATH, { key: 'key-k2-000001', body: BODY }));
    const made = await call(base, 'POST', PATH, { key: 'key-k3-000001', body: BODY });
    db.st.packages = db.st.packages.filter((p) => p.id !== made.body.id);
    await rec('410 removed', call(base, 'POST', PATH, { key: 'key-k3-000001', body: BODY }));
    await rec('404 detail', call(base, 'GET', `${PATH}/${UNKNOWN_ID}`));
    await rec('404 patch', call(base, 'PATCH', `${PATH}/${UNKNOWN_ID}`, { body: { amount_cents: 5900 } }));
    const pid = String(out.find((r) => r.label === '201 create')?.body.id);
    await rec('400 patch dto', call(base, 'PATCH', `${PATH}/${pid}`, { body: { amount_cents: 'x' } }));
    await rec('400 patch below min', call(base, 'PATCH', `${PATH}/${pid}`, { body: { amount_cents: 500 } }));
    await rec('404 publish', call(base, 'POST', `${PATH}/${UNKNOWN_ID}/publish`));
    await rec('404 unpublish', call(base, 'POST', `${PATH}/${UNKNOWN_ID}/unpublish`));
    await rec('404 archive', call(base, 'DELETE', `${PATH}/${UNKNOWN_ID}`));
    await rec('404 subscribers', call(base, 'GET', `${PATH}/${UNKNOWN_ID}/subscribers`));
    await rec('500 db error', call(base, 'GET', `${PATH}/${BOOM_ID}`));
    db.st.failCreate = true;
    await rec('500 orm in create', call(base, 'POST', PATH, { key: 'key-k4-000001', body: BODY }));
    db.st.failCreate = false;
    return out;
  }

  it('every status and error body is identical to the pre-PR wiring; the 422 REUSED differs only by package_id', async () => {
    const a = await battery(pre.base, dbBase);
    const b = await battery(head.base, dbHead);
    expect(b.map((r) => r.label)).toEqual(a.map((r) => r.label));
    const expectedStatus = a.map((r) => [r.label, Number(r.label.slice(0, 3))]);
    expect(a.map((r) => [r.label, r.status])).toEqual(expectedStatus);
    for (let i = 0; i < a.length; i++) {
      const [x, y] = [a[i], b[i]];
      expect([y.label, y.status]).toEqual([x.label, x.status]);
      if (x.label === '422 reused') {
        expect(x.body).not.toHaveProperty('package_id');
        const pid = b.find((r) => r.label === '201 create')?.body.id;
        expect(strip(y.body)).toEqual({ ...strip(x.body), package_id: pid });
        expect(y.body.request_id).toBe('req-probe-1');
      } else {
        expect([y.label, strip(y.body)]).toEqual([x.label, strip(x.body)]);
      }
      if (x.status >= 400) {
        expect(JSON.stringify(y.body)).not.toContain('secret');
      }
    }
  });

  it('no response ever names a package outside the caller\'s current catalog', async () => {
    dbHead.reset();
    for (const k of Object.keys(heads)) delete heads[k];
    const seen: Array<{ user: string; catalog: string; res: Res }> = [];
    const post = async (user: string, key: string, body: Row) => {
      const catalog = heads[user] ?? user;
      const res = await call(head.base, 'POST', PATH, { user, key, body });
      seen.push({ user, catalog, res });
      return res;
    };
    const K = 'key-shared-0001';
    const other = { ...BODY, amount_cents: 5900 };
    const a1 = await post('coach-a', K, BODY);
    expect(a1.status).toBe(201);
    // Another coach with the SAME key: its own key space, never coach-a's package.
    const b1 = await post('coach-b', K, other);
    const b2 = await post('coach-b', K, BODY);
    expect([b1.status, b2.status]).toEqual([201, 422]);
    expect(b1.body.id).not.toBe(a1.body.id);
    expect(b2.body.package_id).toBe(b1.body.id);
    // A sub-coach of coach-a with the same key: own key space, coach-a's catalog.
    heads['sub-s'] = 'coach-a';
    const s1 = await post('sub-s', K, other);
    expect(s1.status).toBe(201);
    expect(s1.body.coach_id).toBe('coach-a');
    expect(s1.body.id).not.toBe(a1.body.id);
    // The head coach reusing its key with other details is named its own package.
    const a2 = await post('coach-a', K, other);
    expect(a2.status).toBe(422);
    expect(a2.body.package_id).toBe(a1.body.id);
    // The sub-coach moves to coach-b: 410 for both bodies, nothing named.
    heads['sub-s'] = 'coach-b';
    const s2 = await post('sub-s', K, other);
    const s3 = await post('sub-s', K, BODY);
    expect([s2.status, s3.status]).toEqual([410, 410]);
    expect(s2.body.code).toBe('IDEMPOTENT_PACKAGE_REMOVED');
    // ...and moves back: the package is in its catalog again, so it may be named.
    heads['sub-s'] = 'coach-a';
    const s4 = await post('sub-s', K, BODY);
    expect(s4.status).toBe(422);
    expect(s4.body.package_id).toBe(s1.body.id);
    // Scan: every package id that appears anywhere in a body belongs to the caller's catalog.
    const catalogOf = new Map<string, string>(
      dbHead.st.packages.map((p): [string, string] => [String(p.id), String(p.coach_id)]),
    );
    for (const { user, catalog, res } of seen) {
      const ids = JSON.stringify(res.body).match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}/g) ?? [];
      for (const id of ids) {
        if (!catalogOf.has(id)) continue; // ledger ids never appear; keep the scan to packages
        expect([user, id, catalogOf.get(id)]).toEqual([user, id, catalog]);
      }
    }
  });

  it('hash literals this head stores (input to the #672-merged probe)', async () => {
    dbHead.reset();
    const r0 = await call(head.base, 'POST', PATH, {
      user: 'coach-lit',
      key: 'key-literal-01',
      body: { name: 'Literal coaching', description: 'Strength.', amount_cents: 4900, currency: 'usd', billing_type: 'recurring', billing_interval: 'month', billing_interval_count: 1 },
    });
    const r1 = await call(head.base, 'POST', PATH, {
      user: 'coach-lit',
      key: 'key-literal-02',
      body: { name: 'Literal one-time', amount_cents: 2500 },
    });
    expect([r0.status, r1.status]).toEqual([201, 201]);
    const hashes = dbHead.st.ledger.map((r) => (r.response_json as Row).request_hash);
    expect(hashes).toEqual([
      '40d1e0108bbd1b7d1cd143f1c0636ca2a9e241e37128502c4ed7abbe707700f9',
      '765ae7c487c58adbfbd50f1ec32efc5ed7e14b3693789dadf2dd66d09bf8f0ae',
    ]);
  });
});
