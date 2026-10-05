/**
 * B-RECUR-BE fix round 1 (agent 114) — the subscription checkout over real
 * HTTP: the production ValidationPipe options, the real global
 * HttpExceptionFilter, the real SubscriptionCheckoutController and
 * SubscriptionCheckoutService on in-memory Prisma / Stripe doubles.
 *
 *   R1-9  the filter used to drop every field but the envelope, so the app
 *         never received the current price on PACKAGE_PRICE_CHANGED or the
 *         existing plan on SUBSCRIPTION_ALREADY_ACTIVE. Allowlisted,
 *         shape-checked details now pass; everything else is still dropped.
 *   R1-10 a client opening a share link of a coach they are not connected
 *         with got a bare PACKAGE_NOT_FOUND. With the live share token the
 *         refusal is PACKAGE_COACH_NOT_CONNECTED (+ reason); without it the
 *         answer stays the non-leaking 404.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { SubscriptionCheckoutController } from '../src/checkout/subscription-checkout.controller';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { pickErrorDetails } from '../src/filters/error-details';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const OTHER_COACH = '55555555-5555-4555-8555-555555555555';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStU';
const H_USER = 'x-test-user';

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'student' };
    return true;
  }
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

function pkgRow(over: Record<string, unknown> = {}) {
  return {
    id: PKG,
    coach_id: COACH,
    name: 'Coaching',
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    stripe_price_id: 'price_rec_4900',
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    share_token: TOKEN,
    share_link_enabled: true,
    share_link_revoked_at: null,
    share_link_expires_at: null,
    ...over,
  };
}

describe('subscription checkout over HTTP (production pipe + filter)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: ReturnType<typeof makeFakePrisma>;
  let stripe: ReturnType<typeof makeFakeStripe>;

  function call(path: string, body: unknown, user = CLIENT): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            [H_USER]: user,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async function boot(pkgOver: Record<string, unknown> = {}, clientCoach: string | null = COACH) {
    prisma = makeFakePrisma();
    stripe = makeFakeStripe();
    const helpers = makeCheckoutHelpers(prisma);
    prisma._users.push(
      { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: clientCoach },
      { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
    );
    prisma._packages.push(pkgRow(pkgOver));
    prisma._accounts.push({
      coach_user_id: COACH,
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    const packages: any = {
      getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
    };
    const state: any = { ready: true };
    const feePolicy: any = { planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_split_cents: 0, head_coach_id: null })) };
    const checkout: any = helpers;
    const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
    const moduleRef = await Test.createTestingModule({
      controllers: [SubscriptionCheckoutController],
      providers: [{ provide: SubscriptionCheckoutService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  beforeAll(() => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
  });

  afterEach(async () => {
    await app?.close();
  });

  const intent = '/v1/checkout/subscription-intent';

  describe('R1-9 allowlisted error details reach the client', () => {
    it('PACKAGE_PRICE_CHANGED carries the current price and terms', async () => {
      await boot();
      const r = await call(intent, {
        package_id: PKG,
        idempotency_key: KEY1,
        expected_amount_cents: 3900,
      });
      expect(r.status).toBe(409);
      expect(r.body).toEqual(
        expect.objectContaining({
          statusCode: 409,
          code: 'PACKAGE_PRICE_CHANGED',
          error: 'PACKAGE_PRICE_CHANGED',
          amount_cents: 4900,
          one_time_cents: 0,
          first_charge_cents: 4900,
          currency: 'usd',
          interval: 'month',
          interval_count: 1,
          path: intent,
        }),
      );
      expect(typeof r.body.message).toBe('string');
      expect(stripe.createSubscription).not.toHaveBeenCalled();
    });

    it('SUBSCRIPTION_ALREADY_ACTIVE carries the existing plan', async () => {
      await boot();
      const first = await call(intent, { package_id: PKG, idempotency_key: KEY1 });
      expect(first.status).toBe(200);
      Object.assign(prisma._purchases[0], {
        status: 'active',
        entitlement_active: true,
        cancel_at_period_end: true,
      });
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY2 });
      expect(r.status).toBe(409);
      expect(r.body).toEqual(
        expect.objectContaining({
          code: 'SUBSCRIPTION_ALREADY_ACTIVE',
          purchase_id: prisma._purchases[0].id,
          cancel_at_period_end: true,
          current_period_end: prisma._purchases[0].current_period_end.toISOString(),
        }),
      );
      expect(JSON.stringify(r.body)).not.toMatch(/secret|ek_|pi_|sub_/);
    });

    it('PACKAGE_ALREADY_INCLUDED carries the grant that includes it', async () => {
      await boot();
      prisma._purchases.push({
        id: '66666666-6666-4666-8666-666666666666',
        client_user_id: CLIENT,
        coach_user_id: COACH,
        package_id: PKG,
        amount_cents: 0,
        billing_type: 'recurring',
        status: 'active',
        entitlement_active: true,
        stripe_subscription_id: null,
        access_expires_at: null,
        source: 'invite_grant:free',
        idempotency_key: 'grant-x',
        stripe_checkout_session_id: 'grant_x',
        created_at: new Date(),
      });
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY1 });
      expect(r.status).toBe(409);
      expect(r.body).toEqual(
        expect.objectContaining({
          code: 'PACKAGE_ALREADY_INCLUDED',
          purchase_id: '66666666-6666-4666-8666-666666666666',
          included_by: 'invite',
          access_expires_at: null,
        }),
      );
    });
  });

  describe('R1-10 share link of a coach the client is not connected with', () => {
    it('client of another coach + live token -> 409 PACKAGE_COACH_NOT_CONNECTED (other_coach)', async () => {
      await boot({}, OTHER_COACH);
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY1, share_token: TOKEN });
      expect(r.status).toBe(409);
      expect(r.body).toEqual(
        expect.objectContaining({ code: 'PACKAGE_COACH_NOT_CONNECTED', reason: 'other_coach' }),
      );
      expect(r.body.message).toMatch(/Nothing was charged/);
      expect(stripe.createSubscription).not.toHaveBeenCalled();
      expect(prisma._purchases).toHaveLength(0);
    });

    it('client without a coach + live token -> 409 PACKAGE_COACH_NOT_CONNECTED (no_coach)', async () => {
      await boot({}, null);
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY1, share_token: TOKEN });
      expect(r.status).toBe(409);
      expect(r.body).toEqual(
        expect.objectContaining({ code: 'PACKAGE_COACH_NOT_CONNECTED', reason: 'no_coach' }),
      );
      expect(r.body.message).toMatch(/invite code/);
    });

    it.each([
      ['no token', {}, undefined],
      ['another token', {}, 'ZZZZZZZZZZZZZZZZZZZZZ'],
      ['revoked link', { share_link_revoked_at: new Date() }, TOKEN],
      ['paused link', { share_link_enabled: false }, TOKEN],
      ['expired link', { share_link_expires_at: new Date(Date.now() - 1000) }, TOKEN],
    ])('%s -> non-leaking 404 PACKAGE_NOT_FOUND, no reason', async (_n, over, token) => {
      await boot(over, OTHER_COACH);
      const r = await call(intent, {
        package_id: PKG,
        idempotency_key: KEY1,
        ...(token ? { share_token: token } : {}),
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('PACKAGE_NOT_FOUND');
      expect(r.body).not.toHaveProperty('reason');
    });

    it('the own coach\'s client with a token buys normally (the token never changes access)', async () => {
      await boot();
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY1, share_token: TOKEN });
      expect(r.status).toBe(200);
      expect(r.body.subscription_id).toBe('sub_1');
    });

    it('a malformed share_token is a 400 from the DTO', async () => {
      await boot();
      const r = await call(intent, { package_id: PKG, idempotency_key: KEY1, share_token: '../x' });
      expect(r.status).toBe(400);
    });
  });
});

describe('R1-9 pickErrorDetails is a narrow allowlist', () => {
  it('drops fields of codes that are not listed', () => {
    expect(pickErrorDetails(409, 'PAYMENT_RETRY', { amount_cents: 1 })).toEqual({});
    expect(pickErrorDetails(409, undefined, { amount_cents: 1 })).toEqual({});
  });

  it('drops unlisted fields and values of the wrong shape', () => {
    expect(
      pickErrorDetails(409, 'PACKAGE_PRICE_CHANGED', {
        amount_cents: '4900',
        currency: 'usd',
        interval: 'decade',
        stripeCode: 'card_declined',
        internal: { id: 'x' },
      }),
    ).toEqual({ currency: 'usd' });
    expect(
      pickErrorDetails(409, 'SUBSCRIPTION_ALREADY_ACTIVE', {
        purchase_id: 'not-a-uuid',
        cancel_at_period_end: 'yes',
        current_period_end: 'tomorrow',
      }),
    ).toEqual({});
  });

  it('never applies to 5xx answers', () => {
    expect(pickErrorDetails(503, 'PACKAGE_PRICE_CHANGED', { amount_cents: 4900 })).toEqual({});
  });

  it('the real filter keeps the envelope authoritative and drops 5xx internals', () => {
    const filter = new HttpExceptionFilter();
    const json = jest.fn();
    const host: any = {
      switchToHttp: () => ({
        getResponse: () => ({ status: jest.fn().mockReturnThis(), json }),
        getRequest: () => ({ url: '/v1/checkout/subscription-intent', method: 'POST' }),
      }),
    };
    filter.catch(
      new HttpException(
        {
          code: 'STRIPE_CHECKOUT_ERROR',
          error: 'STRIPE_CHECKOUT_ERROR',
          message: 'The payment service did not answer as expected.',
          stripeCode: 'api_key_expired',
        },
        502,
      ),
      host,
    );
    expect(json.mock.calls[0][0]).not.toHaveProperty('stripeCode');
    expect(Object.keys(json.mock.calls[0][0]).sort()).toEqual(
      ['code', 'error', 'message', 'path', 'statusCode', 'timestamp'].sort(),
    );
  });
});
