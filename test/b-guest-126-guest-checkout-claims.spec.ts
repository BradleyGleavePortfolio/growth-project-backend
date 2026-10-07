import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { LostWebhookReconcileService } from '../src/storefront/lost-webhook-reconcile.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

// B-GUEST-126 — guest checkout money path.
//
// (1) A guest PaymentIntent is created unconfirmed, before the buyer types
//     a card. A card decline (payment_intent.payment_failed) or the
//     lost-webhook poller (intent still waiting for a card after 30 s)
//     marks the row 'failed'; the buyer can still pay on the SAME intent.
//     On main the success claim only accepted 'pending', so that buyer was
//     charged and never got an account.
// (2) The paid -> converted write was unconditional, so two conversions of
//     one paid checkout (webhook + reconciler, or a retry) both sent the
//     welcome/receipt email. Only the copy that wins the write may send.
//
// The fake Prisma below applies `where` filters for real, so a status
// guard that does not match leaves the row alone, as Postgres would.

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond instanceof Date || cond === null || typeof cond !== 'object') {
      return value === cond;
    }
    const c = cond as { in?: unknown[]; gt?: Date; lt?: Date; not?: unknown };
    if (c.in !== undefined && !c.in.includes(value)) return false;
    if (c.gt !== undefined && !(value instanceof Date && value > c.gt)) return false;
    if (c.lt !== undefined && !(value instanceof Date && value < c.lt)) return false;
    return true;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) {
      row[key] = Number(row[key] ?? 0) + Number((v as { increment: number }).increment);
    } else {
      row[key] = v;
    }
  }
}

const PKG = {
  id: 'pkg-1',
  coach_id: 'coach-1',
  name: 'Strength 12',
  amount_cents: 29700,
  currency: 'usd',
  billing_type: 'one_time',
  coach: { id: 'coach-1', name: 'Coach One' },
};

function makeWorld(initialStatus: string) {
  const checkout: Row = {
    id: 'gc-1',
    package_id: PKG.id,
    package: PKG,
    idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    guest_email: 'jane@example.com',
    guest_name: 'Jane',
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
    created_at: new Date(Date.now() - 2 * 60_000),
    expires_at: new Date(Date.now() + 60 * 60_000),
  };
  const purchases: Row[] = [];
  const prisma = {
    guestCheckout: {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        matches(checkout, where) ? { ...checkout } : null,
      ),
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        checkout.status === where.status ? [{ ...checkout }] : [],
      ),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(checkout, where)) throw new Error('P2025 record not found');
        applyData(checkout, data);
        return { ...checkout };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(checkout, where)) return { count: 0 };
        applyData(checkout, data);
        return { count: 1 };
      }),
    },
    user: {
      upsert: jest.fn(async () => ({ id: 'usr-1', coach_id: 'coach-1', role: 'student' })),
      update: jest.fn(async () => ({ id: 'usr-1', coach_id: 'coach-1', role: 'student' })),
    },
    clientPurchase: {
      findFirst: jest.fn(async ({ where }: { where: Row }) =>
        purchases.find((p) => matches(p, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (purchases.some((p) => p.idempotency_key === data.idempotency_key)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `cp-${purchases.length + 1}`, ...data };
        purchases.push(row);
        return row;
      }),
    },
    connectAccount: {
      findUnique: jest.fn(async () => ({ stripe_account_id: 'acct_x' })),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
  );
  return { checkout, purchases, prisma };
}

async function build(initialStatus: string, piStatus = 'succeeded') {
  const world = makeWorld(initialStatus);
  const stripe = {
    retrievePaymentIntent: jest.fn(async () => ({ id: 'pi_1', status: piStatus, latest_charge: null })),
    retrieveCharge: jest.fn(async () => ({ id: 'ch_1', receipt_url: null })),
    retrieveSubscription: jest.fn(),
  };
  const fanout = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    flushAlerts: jest.fn(),
    discardPendingAlerts: jest.fn(),
  };
  const auth = {
    admin: {
      createUser: jest.fn(async () => ({ data: { user: { id: 'sb-1' } }, error: null })),
      listUsers: jest.fn(),
      generateLink: jest.fn(async () => ({
        data: { properties: { action_link: 'https://auth.example.com/verify?t=1' } },
        error: null,
      })),
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      LostWebhookReconcileService,
      { provide: PrismaService, useValue: world.prisma },
      { provide: StripeConnectApiService, useValue: stripe },
      { provide: SupabaseService, useValue: { getClient: () => ({ auth }) } },
      {
        provide: ConfigService,
        useValue: {
          get: (k: string): string | undefined =>
            k === 'RESEND_API_KEY' ? 're_test' : k === 'EMAIL_FROM_ADDRESS' ? 'noreply@example.test' : undefined,
        },
      },
      { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
      { provide: CheckoutService, useValue: {} },
      { provide: FeePolicyService, useValue: {} },
      { provide: PurchaseFanoutService, useValue: fanout },
    ],
  }).compile();
  return {
    ...world,
    fanout,
    service: moduleRef.get(GuestCheckoutService),
    poller: moduleRef.get(LostWebhookReconcileService),
  };
}

describe('B-GUEST-126 guest checkout claims', () => {
  let fetchSpy: jest.SpyInstance;
  const welcomeEmails = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url) === 'https://api.resend.com/emails').length;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('{}', { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('a buyer whose first card is declined and who pays on the same checkout gets an account', async () => {
    const w = await build('pending');
    await w.service.handlePaymentFailed('pi_1');
    expect(w.checkout.status).toBe('failed');

    await w.service.handlePaymentSucceeded('pi_1');

    expect(w.checkout.status).toBe('converted');
    expect(w.checkout.created_user_id).toBe('usr-1');
    expect(w.purchases).toHaveLength(1);
    expect(welcomeEmails()).toBe(1);
  });

  it('a buyer slower than the poller grace (row marked failed while typing the card) still gets an account', async () => {
    const w = await build('pending', 'requires_payment_method');
    await w.poller.runOnce(new Date());
    expect(w.checkout.status).toBe('failed');

    await w.service.handlePaymentSucceeded('pi_1');

    expect(w.checkout.status).toBe('converted');
    expect(w.purchases).toHaveLength(1);
  });

  it('a checkout the poller gave up on (3DS left open past the cap) still converts when Stripe reports success', async () => {
    const w = await build('conversion_failed_terminal');
    await w.service.handlePaymentSucceeded('pi_1');
    expect(w.checkout.status).toBe('converted');
    expect(w.purchases).toHaveLength(1);
  });

  it('never converts a refunded, disputed, already-converted or expired checkout', async () => {
    for (const status of ['refunded', 'disputed', 'converted']) {
      const w = await build(status);
      await w.service.handlePaymentSucceeded('pi_1');
      expect(w.checkout.status).toBe(status);
      expect(w.purchases).toHaveLength(0);
    }
    const expired = await build('failed');
    expired.checkout.expires_at = new Date(Date.now() - 1000);
    await expired.service.handlePaymentSucceeded('pi_1');
    expect(expired.checkout.status).toBe('failed');
    expect(expired.purchases).toHaveLength(0);
  });

  it('two conversions of one paid checkout send ONE welcome email and ONE fan-out', async () => {
    const w = await build('paid');

    await Promise.all([
      w.service.reconcilePaidCheckout('gc-1'),
      w.service.reconcilePaidCheckout('gc-1'),
    ]);

    expect(w.checkout.status).toBe('converted');
    expect(w.purchases).toHaveLength(1);
    expect(w.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(w.fanout.flushAlerts).toHaveBeenCalledTimes(1);
    expect(welcomeEmails()).toBe(1);
  });

  it('the converted write is conditional on the row still being paid', async () => {
    const w = await build('paid');
    await w.service.reconcilePaidCheckout('gc-1');
    const convertedWrite = w.prisma.guestCheckout.updateMany.mock.calls.find(
      ([args]) => args.data.status === 'converted',
    );
    expect(convertedWrite?.[0]).toEqual({
      where: { id: 'gc-1', status: 'paid' },
      data: { status: 'converted', created_user_id: 'usr-1' },
    });
    expect(w.prisma.guestCheckout.update).not.toHaveBeenCalled();
  });
});
