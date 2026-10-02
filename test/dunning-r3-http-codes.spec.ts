import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { ClientBillingController } from '../src/checkout/client-billing.controller';
import { ClientBillingService } from '../src/checkout/client-billing.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PrismaService } from '../src/prisma.service';

/**
 * S-DUNNING-R3 (B-628-10, C-628-2, C-628-3): every failure on the billing
 * routes reaches the app over real HTTP, through the app-wide
 * ValidationPipe and the production HttpExceptionFilter (which keeps only
 * statusCode / code / message / error / requestId), with a stable machine
 * code and a specific next step. The mobile mapper keys on these codes.
 */

const SETUP_UUID = '00000000-0000-4000-8000-000000000001';

describe('S-DUNNING-R3 billing routes over real HTTP (production filter)', () => {
  const prevPk = process.env['STRIPE_PUBLISHABLE_KEY'];
  let app: INestApplication;
  let base: string;
  let svc: ClientBillingService;
  const stripe = {
    createSetupIntent: jest.fn(),
  };

  beforeAll(async () => {
    const prisma = {
      connectCustomer: {
        findUnique: jest.fn(async () => ({
          client_user_id: 'client-1',
          stripe_customer_id: 'cus_1',
        })),
      },
    };
    const mod = await Test.createTestingModule({
      controllers: [ClientBillingController],
      providers: [
        ClientBillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeConnectApiService, useValue: stripe },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'client-1', role: 'student' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication({ logger: false });
    svc = mod.get(ClientBillingService);
    // Exactly as src/main.ts wires them.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    if (prevPk === undefined) delete process.env['STRIPE_PUBLISHABLE_KEY'];
    else process.env['STRIPE_PUBLISHABLE_KEY'] = prevPk;
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('C-628-3: an invalid confirm body is a 400 with INVALID_BILLING_REQUEST naming the field', async () => {
    const r = await post('/v1/checkout/payment-method/confirm', {
      setup_intent_id: 'seti_1',
      approved_invoices: [{ invoice_id: 'in_1', amount_cents: 1.5, currency: 'usd' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_BILLING_REQUEST');
    expect(String(r.body.message)).toContain('approved_invoices.0.amount_cents');
    expect(String(r.body.message)).toMatch(/nothing was charged or changed/);
  });

  it('C-628-3: an unknown field and a bad SetupIntent id are coded too', async () => {
    const extra = await post('/v1/checkout/payment-method/confirm', {
      setup_intent_id: 'seti_1',
      surprise: true,
    });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('INVALID_BILLING_REQUEST');
    const bad = await post('/v1/checkout/payment-method/confirm', { setup_intent_id: 'pi_1' });
    expect(bad.body.code).toBe('INVALID_BILLING_REQUEST');
    const setup = await post('/v1/checkout/payment-method/setup-intent', { idempotency_key: 'x' });
    expect(setup.status).toBe(400);
    expect(setup.body.code).toBe('INVALID_BILLING_REQUEST');
  });

  it('C-628-3: a malformed plan id is a 400 with INVALID_PLAN_ID', async () => {
    const r = await post('/v1/checkout/subscriptions/not-a-uuid/cancel', {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'INVALID_PLAN_ID' });
    expect(String(r.body.message)).toMatch(/Pull down to refresh your plans/);
  });

  it('C-628-2: an empty or mode-mismatched publishable key is a 503 PAYMENTS_NOT_CONFIGURED before any Stripe call', async () => {
    process.env['STRIPE_PUBLISHABLE_KEY'] = '';
    const empty = await post('/v1/checkout/payment-method/setup-intent', {
      idempotency_key: SETUP_UUID,
    });
    expect(empty.status).toBe(503);
    expect(empty.body.code).toBe('PAYMENTS_NOT_CONFIGURED');
    process.env['STRIPE_PUBLISHABLE_KEY'] = 'not-a-key';
    const junk = await post('/v1/checkout/payment-method/setup-intent', {
      idempotency_key: SETUP_UUID,
    });
    expect(junk.body.code).toBe('PAYMENTS_NOT_CONFIGURED');
    expect(stripe.createSetupIntent).not.toHaveBeenCalled();
    for (const r of [empty, junk]) {
      expect(String(r.body.message)).not.toMatch(/something went wrong/i);
      expect(Object.keys(r.body).sort()).toEqual(
        expect.arrayContaining(['code', 'message', 'statusCode']),
      );
    }
  });

  it('B-628-10: the phase survives the production filter as a stable code (never "nothing changed")', async () => {
    const pay = svc['stripeFailure'](new TypeError('fetch failed'), 'invoice_pay');
    const confirmSpy = jest.spyOn(svc, 'confirmCardUpdate').mockRejectedValueOnce(pay);
    const r1 = await post('/v1/checkout/payment-method/confirm', { setup_intent_id: 'seti_123' });
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe('PAYMENT_RESULT_UNKNOWN');
    expect(String(r1.body.message)).toContain(
      'could not confirm whether your payment went through',
    );
    expect(String(r1.body.message)).not.toMatch(/nothing (changed|was charged)/i);

    const plan = svc['stripeFailure'](new TypeError('fetch failed'), 'invoice_void');
    const cancelSpy = jest.spyOn(svc, 'cancelPlan').mockRejectedValueOnce(plan);
    const r2 = await post(`/v1/checkout/subscriptions/${SETUP_UUID}/cancel`, {});
    expect(r2.status).toBe(503);
    expect(r2.body.code).toBe('PLAN_CHANGE_RESULT_UNKNOWN');
    expect(String(r2.body.message)).not.toMatch(/nothing changed/i);
    confirmSpy.mockRestore();
    cancelSpy.mockRestore();
  });
});
