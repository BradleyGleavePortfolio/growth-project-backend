/**
 * S-FEE #629 — package pricing over real HTTP (Express adapter, the production
 * ValidationPipe options and HttpExceptionFilter), with PackagesService on an
 * in-memory CoachPackage table.
 *
 * Sol B-629-1: the DTOs rejected amount_cents 0 before the service ran, so a
 * free package could not be created or set through the API. These requests go
 * through the same pipe and filter as production:
 *   - exactly $0 one-time: created / updated (free);
 *   - $0 recurring or with a recurring price: 400 PACKAGE_FREE_MUST_BE_ONE_TIME;
 *   - $0.01 - $19.98: 400 PACKAGE_PRICE_BELOW_MINIMUM (a code, not a generic
 *     validation message), $19.99 accepted;
 *   - fractional or negative cents: 400 from the DTO with a specific message.
 * Sol B-629-2: publish -> unpublish -> republish of an unchanged legacy offer.
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
import { Test } from '@nestjs/testing';
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

function packagesDb() {
  const rows: Row[] = [];
  const matches = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v);
  const coachPackage = {
    findFirst: async ({ where }: { where: Row }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findUnique: async ({ where }: { where: Row }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    create: async ({ data }: { data: Row }) => {
      const now = new Date();
      const row: Row = {
        id: `pkg-${rows.length + 1}`,
        description: null,
        interval: null,
        interval_count: 1,
        duration_periods: null,
        stripe_price_id: null,
        stripe_product_id: null,
        is_active: true,
        archived_at: null,
        published_at: null,
        first_published_at: null,
        recurring_amount_cents: null,
        recurring_interval: null,
        recurring_interval_count: null,
        recurring_stripe_price_id: null,
        created_at: now,
        updated_at: now,
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((x) => matches(x, where));
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updated_at: new Date() });
      return { ...row };
    },
  };
  const db = {
    rows,
    coachPackage,
    clientPurchase: { count: async () => 0 },
    $queryRaw: async () => [],
    $transaction: async (cb: (tx: object) => Promise<unknown>) => cb(db),
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
  body: Record<string, unknown> | null;
}

describe('S-FEE #629 package pricing over HTTP (production pipe + filter)', () => {
  let app: INestApplication;
  let db: ReturnType<typeof packagesDb>;
  let baseUrl: string;

  function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { [H_USER]: 'coach-1' };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data.length ? JSON.parse(data) : null }),
        );
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const base = { name: 'Intro', currency: 'usd', billing_type: 'one_time' };

  beforeEach(async () => {
    db = packagesDb();
    const svc = new PackagesService(
      asPrisma(db),
      asScope({ getHeadCoachIdForSubCoach: async () => null }),
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

  it('B-629-1: POST exactly $0 one-time creates a free package', async () => {
    const r = await call('POST', '/v1/coach/packages', { ...base, amount_cents: 0 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ amount_cents: 0, billing_type: 'one_time', published_at: null });
  });

  it('B-629-1: POST $0 recurring is refused with PACKAGE_FREE_MUST_BE_ONE_TIME, not a generic 400', async () => {
    const r = await call('POST', '/v1/coach/packages', {
      ...base,
      amount_cents: 0,
      billing_type: 'recurring',
      billing_interval: 'month',
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      statusCode: 400,
      code: 'PACKAGE_FREE_MUST_BE_ONE_TIME',
      error: 'PACKAGE_FREE_MUST_BE_ONE_TIME',
      message:
        'Free packages are one-time. Switch the package to one-time, or set a price of $19.99 or more.',
    });
    const combo = await call('POST', '/v1/coach/packages', {
      ...base,
      amount_cents: 0,
      recurring_amount_cents: 4900,
      recurring_interval: 'month',
    });
    expect(combo.status).toBe(400);
    expect(combo.body).toMatchObject({ code: 'PACKAGE_FREE_MUST_BE_ONE_TIME' });
    expect(db.rows).toHaveLength(0);
  });

  it('paid floor: $0.01 and $19.98 refused with PACKAGE_PRICE_BELOW_MINIMUM; $19.99 accepted', async () => {
    for (const amount_cents of [1, 49, 1998]) {
      const r = await call('POST', '/v1/coach/packages', { ...base, amount_cents });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        code: 'PACKAGE_PRICE_BELOW_MINIMUM',
        message: 'Paid packages start at $19.99, or make it free.',
      });
    }
    const ok = await call('POST', '/v1/coach/packages', { ...base, amount_cents: 1999 });
    expect(ok.status).toBe(201);
    const rec = await call('POST', '/v1/coach/packages', {
      ...base,
      amount_cents: 5000,
      recurring_amount_cents: 1500,
      recurring_interval: 'month',
    });
    expect(rec.status).toBe(400);
    expect(rec.body).toMatchObject({ code: 'PACKAGE_RECURRING_PRICE_BELOW_MINIMUM' });
  });

  it('fractional or negative cents are refused by the DTO with a specific message', async () => {
    const frac = await call('POST', '/v1/coach/packages', { ...base, amount_cents: 19.99 });
    expect(frac.status).toBe(400);
    expect(JSON.stringify(frac.body?.message)).toContain('whole number of cents, for example 1999');
    const neg = await call('POST', '/v1/coach/packages', { ...base, amount_cents: -1 });
    expect(neg.status).toBe(400);
    expect(JSON.stringify(neg.body?.message)).toContain('0 (free) or a positive number of cents');
  });

  it('B-629-1: PATCH a paid one-time package to exactly $0 makes it free; a recurring one is refused with a code', async () => {
    const paid = await call('POST', '/v1/coach/packages', { ...base, amount_cents: 2500 });
    const free = await call('PATCH', `/v1/coach/packages/${paid.body?.id}`, { amount_cents: 0 });
    expect(free.status).toBe(200);
    expect(free.body).toMatchObject({ amount_cents: 0 });

    const monthly = await call('POST', '/v1/coach/packages', {
      ...base,
      amount_cents: 4900,
      billing_type: 'recurring',
      billing_interval: 'month',
    });
    const zero = await call('PATCH', `/v1/coach/packages/${monthly.body?.id}`, { amount_cents: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body).toMatchObject({ code: 'PACKAGE_FREE_MUST_BE_ONE_TIME' });
  });

  it('B-629-2: publish -> unpublish -> republish an unchanged legacy $10 offer; a cadence change hits the floor', async () => {
    const created = await call('POST', '/v1/coach/packages', {
      ...base,
      amount_cents: 2500,
      billing_type: 'recurring',
      billing_interval: 'month',
    });
    const id = String(created.body?.id);
    const first = await call('POST', `/v1/coach/packages/${id}/publish`);
    expect(first.status).toBe(200);
    // The offer was sold at $10 before the floor existed.
    db.rows[0].amount_cents = 1000;

    const off = await call('POST', `/v1/coach/packages/${id}/unpublish`);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ published_at: null, first_published_at: first.body?.first_published_at });
    const back = await call('POST', `/v1/coach/packages/${id}/publish`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ amount_cents: 1000 });

    const cadence = await call('PATCH', `/v1/coach/packages/${id}`, { billing_interval: 'week' });
    expect(cadence.status).toBe(400);
    expect(cadence.body).toMatchObject({ code: 'PACKAGE_PRICE_BELOW_MINIMUM' });
  });

  it('a never-published draft below $19.99 cannot be published (draft floor unchanged)', async () => {
    const created = await call('POST', '/v1/coach/packages', { ...base, amount_cents: 2500 });
    db.rows[0].amount_cents = 1000; // pre-floor draft
    const r = await call('POST', `/v1/coach/packages/${created.body?.id}/publish`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'PACKAGE_PRICE_BELOW_MINIMUM' });
  });
});
