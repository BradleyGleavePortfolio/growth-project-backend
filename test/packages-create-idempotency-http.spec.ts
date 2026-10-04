/**
 * B-675-1 / C-675-2 / C-675-3 (B-675-116): idempotent package create over
 * real HTTP. Express adapter, the production ValidationPipe options and the
 * global HttpExceptionFilter registered exactly as src/main.ts does, the real
 * CoachPackagesController (with its own @UseFilters) and the real
 * PackagesService on an in-memory CoachPackage table and idempotency ledger
 * (unique on user_id + route_key + idempotency_key; a failed transaction
 * rolls back).
 *
 * Grown from the AUD-OPUS-CM2-116 probe (CI-lane run 37172560549): the service
 * put `package_id` on the 422 exception, but the client only ever receives the
 * error envelope, which dropped it. The mobile create path adopts a package
 * only through that field, so without it the coach was told to tap Create
 * package again and got the same 422 forever.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { SubscriptionGuard } from '../src/billing/subscription.guard';
import { CoachOrOwnerGuard } from '../src/common/guards/coach-or-owner.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { CoachPackagesController } from '../src/packages/packages.controller';
import { PackagesService } from '../src/packages/packages.service';
import type { PrismaService } from '../src/prisma.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

type Row = Record<string, unknown>;

const asPrisma = (m: object): PrismaService => m as PrismaService;
const asScope = (m: object): SubCoachScopeService => m as SubCoachScopeService;

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makeDb() {
  let packages: Row[] = [];
  let ledger: Row[] = [];
  const matches = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v);
  const sameKey = (a: Row, b: Row) =>
    a.user_id === b.user_id &&
    a.route_key === b.route_key &&
    a.idempotency_key === b.idempotency_key;
  const db = {
    packages: () => packages,
    ledger: () => ledger,
    coachPackage: {
      findFirst: async ({ where }: { where: Row }) => {
        const r = packages.find((x) => matches(x, where));
        return r ? { ...r } : null;
      },
      create: async ({ data }: { data: Row }) => {
        const now = new Date();
        const row: Row = {
          id: randomUUID(),
          is_active: true,
          archived_at: null,
          first_published_at: null,
          stripe_price_id: null,
          stripe_product_id: null,
          recurring_stripe_price_id: null,
          created_at: now,
          updated_at: now,
          ...data,
        };
        packages.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = packages.find((x) => matches(x, where));
        if (!row) throw new Error('package row not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      },
    },
    // Live buyers the archive guard and the pricing lock count (none here).
    clientPurchase: { count: async () => 0 },
    // The pricing lock's row lock (SELECT ... FOR UPDATE).
    $queryRaw: async () => [],
    workoutBuilderIdempotencyKey: {
      create: async ({ data }: { data: Row }) => {
        if (ledger.some((r) => sameKey(r, data))) throw p2002();
        const row: Row = { ...data, id: randomUUID() };
        ledger.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = ledger.find((x) => x.id === where.id);
        if (!r) throw new Error('ledger row not found');
        Object.assign(r, data);
        return { ...r };
      },
      findUnique: async ({
        where,
      }: {
        where: { WorkoutBuilderIdempotencyKey_user_route_key_key: Row };
      }) => {
        const r = ledger.find((x) =>
          sameKey(x, where.WorkoutBuilderIdempotencyKey_user_route_key_key),
        );
        return r ? { ...r } : null;
      },
    },
    // Sequential requests only: a failed callback restores both tables.
    $transaction: async <T>(cb: (tx: object) => Promise<T>): Promise<T> => {
      const pkgs = packages.map((r) => ({ ...r }));
      const led = ledger.map((r) => ({ ...r }));
      try {
        return await cb(db);
      } catch (err) {
        packages = pkgs;
        ledger = led;
        throw err;
      }
    },
  };
  return db;
}

const H_USER = 'x-test-user';

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'coach' };
    return true;
  }
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Row;
}

const PATH = '/v1/coach/packages';
// The wire DTO names the cadence billing_interval / billing_interval_count.
const BODY = {
  name: 'North coaching',
  description: 'Coaching for strength.',
  amount_cents: 4900,
  currency: 'usd',
  billing_type: 'recurring',
  billing_interval: 'month',
  billing_interval_count: 1,
};

describe('B-675 idempotent package create over HTTP (production pipe + global filter)', () => {
  let app: INestApplication;
  let db: ReturnType<typeof makeDb>;
  let svc: PackagesService;
  let baseUrl: string;
  // sub-coach id -> head coach id (what SubCoachScopeService answers).
  let heads: Record<string, string>;

  function call(
    method: string,
    path: string,
    opts: { user?: string; key?: string; body?: unknown } = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const headers: Record<string, string> = { [H_USER]: opts.user ?? 'coach-1' };
      if (opts.key) headers['idempotency-key'] = opts.key;
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data.length ? JSON.parse(data) : {},
          }),
        );
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  beforeEach(async () => {
    db = makeDb();
    heads = {};
    svc = new PackagesService(
      asPrisma(db),
      asScope({ getHeadCoachIdForSubCoach: async (id: string) => heads[id] ?? null }),
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
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('control: main.ts registers HttpExceptionFilter globally, as this harness does', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toMatch(/useGlobalFilters\(new HttpExceptionFilter\(\)/);
  });

  it('control: the same key and body replays the same package with Idempotent-Replayed', async () => {
    const a = await call('POST', PATH, { key: 'key-http-replay-01', body: BODY });
    const b = await call('POST', PATH, { key: 'key-http-replay-01', body: BODY });
    expect(a.status).toBe(201);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(db.packages()).toHaveLength(1);
  });

  it('B-675-1: the 422 IDEMPOTENCY_KEY_REUSED body on the wire names the package the key made', async () => {
    const first = await call('POST', PATH, { key: 'key-http-reused-01', body: BODY });
    expect(first.status).toBe(201);
    const r = await call('POST', PATH, {
      key: 'key-http-reused-01',
      body: { ...BODY, amount_cents: 5900 },
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      statusCode: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: first.body.id,
      path: PATH,
    });
    expect(typeof r.body.message).toBe('string');
    expect(typeof r.body.timestamp).toBe('string');
    // The standard envelope plus exactly one allow-listed field.
    expect(Object.keys(r.body).sort()).toEqual(
      ['code', 'error', 'message', 'package_id', 'path', 'statusCode', 'timestamp'].sort(),
    );
    expect(db.packages()).toHaveLength(1);
  });

  it('B-675-1: the adopted id is real: PATCHing it with the current details updates that one package', async () => {
    const first = await call('POST', PATH, { key: 'key-http-adopt-001', body: BODY });
    const r = await call('POST', PATH, {
      key: 'key-http-adopt-001',
      body: { ...BODY, amount_cents: 5900 },
    });
    expect(r.status).toBe(422);
    const patched = await call('PATCH', `${PATH}/${String(r.body.package_id)}`, {
      body: { amount_cents: 5900 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: first.body.id, amount_cents: 5900 });
    expect(db.packages()).toHaveLength(1);
  });

  it('B-675-1: a sub-coach who moved to another head coach never receives the old catalog package id', async () => {
    heads['sub-1'] = 'coach-1';
    const first = await call('POST', PATH, { user: 'sub-1', key: 'key-http-moved-01', body: BODY });
    expect(first.status).toBe(201);
    expect(first.body.coach_id).toBe('coach-1');
    heads['sub-1'] = 'coach-2';
    for (const body of [{ ...BODY, amount_cents: 5900 }, BODY]) {
      const r = await call('POST', PATH, { user: 'sub-1', key: 'key-http-moved-01', body });
      expect(r.status).toBe(410);
      expect(r.body).toMatchObject({ statusCode: 410, code: 'IDEMPOTENT_PACKAGE_REMOVED' });
      expect(r.body).not.toHaveProperty('package_id');
      expect(JSON.stringify(r.body)).not.toContain(String(first.body.id));
      expect(r.headers['idempotent-replayed']).toBeUndefined();
    }
    // The fresh create the app then sends lands on the new catalog.
    const fresh = await call('POST', PATH, { user: 'sub-1', key: 'key-http-moved-02', body: BODY });
    expect(fresh.status).toBe(201);
    expect(fresh.body.coach_id).toBe('coach-2');
  });

  it('C-675-3: a retry after the coach archived the package is 410 with a next action, not a 201 replay', async () => {
    const first = await call('POST', PATH, { key: 'key-http-archive-1', body: BODY });
    const del = await call('DELETE', `${PATH}/${String(first.body.id)}`);
    expect(del.status).toBe(200);
    expect(del.body.archived_at).toBeTruthy();
    const r = await call('POST', PATH, { key: 'key-http-archive-1', body: BODY });
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ statusCode: 410, code: 'IDEMPOTENT_PACKAGE_REMOVED' });
    expect(String(r.body.message)).toMatch(/archived/);
    expect(String(r.body.message)).toMatch(/new request/);
    expect(String(r.body.message)).not.toMatch(/\b(we|our|us)\b/i);
    expect(r.body).not.toHaveProperty('package_id');
    expect(r.headers['idempotent-replayed']).toBeUndefined();
  });

  it('C-675-3: an archived package is not adopted through the 422 either', async () => {
    const first = await call('POST', PATH, { key: 'key-http-archive-2', body: BODY });
    await call('DELETE', `${PATH}/${String(first.body.id)}`);
    const r = await call('POST', PATH, {
      key: 'key-http-archive-2',
      body: { ...BODY, amount_cents: 5900 },
    });
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ code: 'IDEMPOTENT_PACKAGE_REMOVED' });
    expect(r.body).not.toHaveProperty('package_id');
  });

  it('C-675-2: a key claimed before the server added a defaulted column still replays the same package', async () => {
    const first = await call('POST', PATH, { key: 'key-http-default-1', body: BODY });
    expect(first.status).toBe(201);
    // A later deploy adds a column the server fills with a default when the
    // client leaves it out (the trials piece adds `trial_days ?? 0`).
    const original = Reflect.get(svc, 'createData') as (coach: string, input: Row) => Row;
    Reflect.set(svc, 'createData', function (this: PackagesService, coach: string, input: Row) {
      return { ...original.call(this, coach, input), trial_days: input.trial_days ?? 0 };
    });
    const r = await call('POST', PATH, { key: 'key-http-default-1', body: BODY });
    expect(r.status).toBe(201);
    expect(r.headers['idempotent-replayed']).toBe('true');
    expect(r.body.id).toBe(first.body.id);
    expect(db.packages()).toHaveLength(1);
  });
});
