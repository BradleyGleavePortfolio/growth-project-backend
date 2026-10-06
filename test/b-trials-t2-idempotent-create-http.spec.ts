/**
 * B-TR-117 (agent 117) — trials T2 x coach M2 (#675) composed behaviour.
 *
 * #675 (merged into main) made POST /v1/coach/packages idempotent per
 * `Idempotency-Key` (createIdempotent, createData, request fingerprint).
 * Trials T2 adds `trial_days` to the same create path (DTO, controller input,
 * createData, trial rules inside assertValidPricing). Both changed
 * packages.controller.ts and packages.service.ts; the second to merge
 * carries both behaviours. This spec pins the composition over real HTTP:
 * the production ValidationPipe options and global HttpExceptionFilter (as
 * src/main.ts registers them), the real CoachPackagesController with its own
 * filters, and the real PackagesService on an in-memory CoachPackage table
 * and idempotency ledger (unique on user_id + route_key + idempotency_key; a
 * failed transaction rolls back).
 *
 * It fails on either one-sided resolution: without #675 the key is ignored
 * (no replay, a second package); without the T2 create wiring the trial is
 * refused by the DTO or never stored.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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
// A paid monthly plan: the only shape a free trial is allowed on.
const PLAN = {
  name: 'North coaching',
  description: 'Coaching for strength.',
  amount_cents: 4900,
  currency: 'usd',
  billing_type: 'recurring',
  billing_interval: 'month',
  billing_interval_count: 1,
};

describe('B-TR-117 trials x #675: an Idempotency-Key create carries the free trial (HTTP)', () => {
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

  const post = (key: string | undefined, body: unknown, user?: string) =>
    call('POST', PATH, { key, body, user });

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

  it('a keyed create stores the trial, and the retry replays that same package with its trial', async () => {
    const a = await post('key-trial-http-01', { ...PLAN, trial_days: 7 });
    expect(a.status).toBe(201);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(a.body).toMatchObject({ trial_days: 7, billing_type: 'recurring', coach_id: 'coach-1' });
    const b = await post('key-trial-http-01', { ...PLAN, trial_days: 7 });
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toMatchObject({ id: a.body.id, trial_days: 7 });
    expect(db.packages()).toHaveLength(1);
    expect(db.packages()[0].trial_days).toBe(7);
    expect(db.ledger()).toHaveLength(1);
    expect(db.ledger()[0]).toMatchObject({
      status: 'completed',
      response_json: { package_id: a.body.id },
    });
  });

  it('the same key with another trial length is different details: 422 names the package, which the app PATCHes', async () => {
    const first = await post('key-trial-http-02', { ...PLAN, trial_days: 7 });
    expect(first.status).toBe(201);
    const r = await post('key-trial-http-02', { ...PLAN, trial_days: 14 });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      statusCode: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: first.body.id,
    });
    expect(db.packages()).toHaveLength(1);
    expect(db.packages()[0].trial_days).toBe(7);
    // The app adopts the named package and saves the coach's current trial.
    const patched = await call('PATCH', `${PATH}/${String(r.body.package_id)}`, {
      body: { trial_days: 14 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: first.body.id, trial_days: 14 });
    expect(db.packages()).toHaveLength(1);
  });

  it('adding or removing a trial on a key that already made a package is different details, never a second package', async () => {
    const plain = await post('key-trial-http-03', PLAN);
    expect(plain.status).toBe(201);
    expect(plain.body.trial_days).toBe(0);
    const added = await post('key-trial-http-03', { ...PLAN, trial_days: 7 });
    expect(added.status).toBe(422);
    expect(added.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', package_id: plain.body.id });

    const trial = await post('key-trial-http-04', { ...PLAN, trial_days: 30 });
    expect(trial.status).toBe(201);
    const removed = await post('key-trial-http-04', PLAN);
    expect(removed.status).toBe(422);
    expect(removed.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: trial.body.id,
    });
    expect(db.packages()).toHaveLength(2);
  });

  it('no trial, trial_days 0 and trial_days null are one normalised row: one key replays across all three', async () => {
    const a = await post('key-trial-http-05', PLAN);
    expect(a.status).toBe(201);
    for (const body of [{ ...PLAN, trial_days: 0 }, { ...PLAN, trial_days: null }, PLAN]) {
      const r = await post('key-trial-http-05', body);
      expect(r.status).toBe(201);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(r.body).toMatchObject({ id: a.body.id, trial_days: 0 });
    }
    expect(db.packages()).toHaveLength(1);
  });

  it('C-675-2 with the real column: a key the pre-trials server claimed still replays after the trials deploy', async () => {
    // The pre-trials server (main with #675, before this stack) built the
    // same create data without the trial column. Reproduce it exactly by
    // removing that one column, claim a key, then restore the real builder.
    const real = Reflect.get(svc, 'createData') as (coach: string, input: Row) => Row;
    expect(typeof real).toBe('function');
    Reflect.set(svc, 'createData', function (this: PackagesService, coach: string, input: Row) {
      const { trial_days: _dropped, ...preTrials } = real.call(this, coach, input);
      return preTrials;
    });
    const before = await post('key-trial-http-06', PLAN);
    expect(before.status).toBe(201);
    expect(before.body).not.toHaveProperty('trial_days');
    Reflect.deleteProperty(svc, 'createData');
    expect(Reflect.get(svc, 'createData')).toBe(real);

    for (const body of [PLAN, { ...PLAN, trial_days: 0 }]) {
      const r = await post('key-trial-http-06', body);
      expect(r.status).toBe(201);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(r.body.id).toBe(before.body.id);
    }
    // A real trial is a different package than the one that key made.
    const trial = await post('key-trial-http-06', { ...PLAN, trial_days: 7 });
    expect(trial.status).toBe(422);
    expect(trial.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      package_id: before.body.id,
    });
    expect(db.packages()).toHaveLength(1);
  });

  it('the trial rules refuse before the key is claimed: a refused trial burns no key', async () => {
    const r = await post('key-trial-http-07', { ...PLAN, trial_days: 45 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ statusCode: 400, code: 'PACKAGE_TRIAL_DAYS_OUT_OF_RANGE' });
    expect(String(r.body.message)).toMatch(/1 to 30/);
    expect(db.packages()).toHaveLength(0);
    expect(db.ledger()).toHaveLength(0);
    // The coach fixes the length and saves with the SAME key: a fresh create.
    const fixed = await post('key-trial-http-07', { ...PLAN, trial_days: 14 });
    expect(fixed.status).toBe(201);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
    expect(fixed.body.trial_days).toBe(14);
    expect(db.packages()).toHaveLength(1);
  });

  it('a keyed trial on a one-time or a free package is refused with its own code and writes nothing', async () => {
    const oneTime = await post('key-trial-http-08', {
      name: 'Single session',
      amount_cents: 4900,
      billing_type: 'one_time',
      trial_days: 7,
    });
    expect(oneTime.status).toBe(400);
    expect(oneTime.body).toMatchObject({ code: 'PACKAGE_TRIAL_REQUIRES_RECURRING' });
    // A free package is one-time by rule (S-FEE); the trial is what is refused.
    const free = await post('key-trial-http-09', {
      name: 'Free intro call',
      amount_cents: 0,
      billing_type: 'one_time',
      trial_days: 7,
    });
    expect(free.status).toBe(400);
    expect(free.body).toMatchObject({ code: 'PACKAGE_TRIAL_NOT_ON_FREE' });
    for (const r of [oneTime, free]) {
      expect(String(r.body.message)).not.toMatch(/\b(we|our|us)\b/i);
      expect(String(r.body.message)).not.toContain('!');
    }
    expect(db.packages()).toHaveLength(0);
    expect(db.ledger()).toHaveLength(0);
  });

  it('a fractional trial is a PACKAGE_INVALID 400 that names trial_days (the DTO accepts the field) and burns no key', async () => {
    const r = await post('key-trial-http-10', { ...PLAN, trial_days: 7.5 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'PACKAGE_INVALID' });
    expect(String(r.body.message)).toMatch(/trial_days must be a whole number/);
    expect(String(r.body.message)).not.toMatch(/Remove trial_days/);
    expect(db.ledger()).toHaveLength(0);
  });

  it('without a key (older clients) the trial is stored and no key is written', async () => {
    const r = await post(undefined, { ...PLAN, trial_days: 3 });
    expect(r.status).toBe(201);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(r.body.trial_days).toBe(3);
    expect(db.ledger()).toHaveLength(0);
  });

  it("a sub-coach's keyed trial create lands on the head coach's catalog; the key stays the sub-coach's", async () => {
    heads['sub-1'] = 'coach-1';
    const a = await post('key-trial-http-11', { ...PLAN, trial_days: 7 }, 'sub-1');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ coach_id: 'coach-1', trial_days: 7 });
    expect(db.ledger()[0]).toMatchObject({ user_id: 'sub-1' });
    // The head coach's own key space is separate: the same key is a new create.
    const head = await post('key-trial-http-11', { ...PLAN, trial_days: 7 }, 'coach-1');
    expect(head.status).toBe(201);
    expect(head.headers['idempotent-replayed']).toBeUndefined();
    expect(head.body.id).not.toBe(a.body.id);
    const again = await post('key-trial-http-11', { ...PLAN, trial_days: 7 }, 'sub-1');
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(a.body.id);
  });
});
