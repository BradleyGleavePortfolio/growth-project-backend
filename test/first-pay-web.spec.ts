import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { StorefrontModule } from '../src/storefront/storefront.module';

// FIRST-PAY-WEB (agent 182, b#1169 AUDIT 6486460217): a sale through the web
// pay page (guest checkout) is the coach's first payment, under the same rule
// as an in-app sale (CheckoutWebhookHandlerService.maybeEmitFirstPayment):
// flag FEATURE_ROMAN_FIRST_PAYMENT, the purchase row's amount and currency,
// the paying client, inside the transaction that writes the purchase and
// claims the conversion. Every route to the conversion (webhook, lost-webhook
// sweep, paid-checkout reconciler) goes through the one claim.
// Before the fix the web path never claimed, so the coach's next in-app sale
// was announced as the first. The live Postgres twin is
// test/rls/first-pay-web-rls.spec.ts.

type Row = Record<string, unknown>;
const FLAG = 'FEATURE_ROMAN_FIRST_PAYMENT';
const AT = '\u0040';

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond instanceof Date || cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as { in?: unknown[]; gt?: Date; lt?: Date };
    if (c.in !== undefined && !c.in.includes(value)) return false;
    if (c.gt !== undefined && !(value instanceof Date && value > c.gt)) return false;
    if (c.lt !== undefined && !(value instanceof Date && value < c.lt)) return false;
    return true;
  });
}

async function build(initialStatus: string, amountCents = 29700) {
  const order: string[] = [];
  const pkg = {
    id: 'pkg-1',
    coach_id: 'coach-1',
    name: 'Strength 12',
    amount_cents: amountCents,
    currency: 'usd',
    billing_type: 'one_time',
    coach: { id: 'coach-1', name: 'Coach One' },
  };
  const checkout: Row = {
    id: 'gc-1',
    package_id: pkg.id,
    package: pkg,
    idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    guest_email: `buyer${AT}example.test`,
    guest_name: 'Buyer',
    stripe_payment_intent_id: 'pi_1',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    landing_page_id: null,
    status: initialStatus,
    created_user_id: null,
    receipt_url: null,
    retry_count: 0,
    reconcile_attempts: 0,
    last_reconciled_at: null,
    created_at: new Date(Date.now() - 5 * 60_000),
    expires_at: new Date(Date.now() + 60 * 60_000),
  };
  const purchases: Row[] = [];
  const prisma = {
    guestCheckout: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => (matches(checkout, where) ? { ...checkout } : null)),
      findMany: jest.fn(async ({ where }: { where: Row }) => (checkout.status === where.status ? [{ ...checkout }] : [])),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(checkout, where)) throw new Error('P2025 record not found');
        Object.assign(checkout, data);
        return { ...checkout };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(checkout, where)) return { count: 0 };
        Object.assign(checkout, data);
        if (data.status === 'converted') order.push('converted');
        return { count: 1 };
      }),
    },
    user: {
      upsert: jest.fn(async () => ({ id: 'usr-1', coach_id: 'coach-1', role: 'student' })),
      update: jest.fn(async () => ({ id: 'usr-1', coach_id: 'coach-1', role: 'student' })),
    },
    clientPurchase: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => purchases.find((p) => matches(p, where)) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (purchases.some((p) => p.idempotency_key === data.idempotency_key)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `cp-${purchases.length + 1}`, ...data };
        purchases.push(row);
        return row;
      }),
    },
    connectAccount: { findUnique: jest.fn(async () => ({ stripe_account_id: 'acct_x' })) },
    $transaction: jest.fn(),
  };
  // The conversion transaction: a distinct client object, so the test can
  // tell the claim rode it (not the root client).
  const tx = { ...prisma, txMarker: true };
  prisma.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const firstPayment = {
    tryEmitFirstPayment: jest.fn(async () => {
      order.push('first-payment');
    }),
  };
  const stripe = {
    retrievePaymentIntent: jest.fn(async () => ({ id: 'pi_1', status: 'succeeded', latest_charge: null })),
    retrieveCharge: jest.fn(async () => ({ id: 'ch_1', receipt_url: null })),
    retrieveSubscription: jest.fn(),
  };
  const auth = {
    admin: {
      createUser: jest.fn(async () => ({ data: { user: { id: 'sb-1' } }, error: null })),
      listUsers: jest.fn(),
      generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.com/verify' } }, error: null })),
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      { provide: PrismaService, useValue: prisma },
      { provide: StripeConnectApiService, useValue: stripe },
      { provide: SupabaseService, useValue: { getClient: () => ({ auth }) } },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
      { provide: CheckoutService, useValue: {} },
      { provide: FeePolicyService, useValue: {} },
      {
        provide: PurchaseFanoutService,
        useValue: { onPurchaseEntitled: jest.fn(async () => undefined), flushAlerts: jest.fn(), discardPendingAlerts: jest.fn() },
      },
      { provide: CoachFirstPaymentService, useValue: firstPayment },
    ],
  }).compile();
  return { checkout, purchases, tx, order, firstPayment, service: moduleRef.get(GuestCheckoutService) };
}

describe('FIRST-PAY-WEB: a web pay page sale counts as the coach\'s first payment', () => {
  const before = process.env[FLAG];
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });
  afterAll(() => {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  });

  it('(failed before) the web sale claims the first payment inside the conversion transaction, after it wins the claim', async () => {
    const w = await build('pending');
    await w.service.handlePaymentSucceeded('pi_1');

    expect(w.checkout.status).toBe('converted');
    expect(w.purchases).toHaveLength(1);
    expect(w.firstPayment.tryEmitFirstPayment).toHaveBeenCalledTimes(1);
    expect(w.firstPayment.tryEmitFirstPayment).toHaveBeenCalledWith(w.tx, {
      coachId: 'coach-1',
      amount: 29700,
      currency: 'usd',
      clientId: 'usr-1',
      correlationId: 'gc-1',
    });
    expect(w.order).toEqual(['converted', 'first-payment']);
  });

  it('(failed before) the reconciler route claims it too; two conversions of one sale claim once', async () => {
    const w = await build('paid');
    await Promise.all([w.service.reconcilePaidCheckout('gc-1'), w.service.reconcilePaidCheckout('gc-1')]);
    await w.service.handlePaymentSucceeded('pi_1'); // a late webhook for the same sale

    expect(w.checkout.status).toBe('converted');
    expect(w.purchases).toHaveLength(1);
    expect(w.firstPayment.tryEmitFirstPayment).toHaveBeenCalledTimes(1);
  });

  it('(failed before) a first web purchase of 0 follows the in-app rule: the row amount is passed, no amount check (owner call 1)', async () => {
    const w = await build('pending', 0);
    await w.service.handlePaymentSucceeded('pi_1');
    expect(w.firstPayment.tryEmitFirstPayment).toHaveBeenCalledWith(w.tx, expect.objectContaining({ amount: 0 }));
  });

  it('flag off: the web sale converts and claims nothing, as the in-app path', async () => {
    process.env[FLAG] = 'false';
    const w = await build('pending');
    await w.service.handlePaymentSucceeded('pi_1');
    expect(w.checkout.status).toBe('converted');
    expect(w.firstPayment.tryEmitFirstPayment).not.toHaveBeenCalled();
  });

  it('wiring: the app injects the first-payment service into the web sale path', () => {
    // GuestCheckoutService is provided only by StorefrontModule, which imports
    // NotificationsModule, which exports CoachFirstPaymentService.
    expect(Reflect.getMetadata('providers', StorefrontModule)).toContain(GuestCheckoutService);
    expect(Reflect.getMetadata('imports', StorefrontModule)).toContain(NotificationsModule);
    expect(Reflect.getMetadata('exports', NotificationsModule)).toContain(CoachFirstPaymentService);
  });

  it('a conversion that lost the claim (already converted) claims nothing', async () => {
    const w = await build('converted');
    await w.service.reconcilePaidCheckout('gc-1');
    expect(w.firstPayment.tryEmitFirstPayment).not.toHaveBeenCalled();
  });
});
