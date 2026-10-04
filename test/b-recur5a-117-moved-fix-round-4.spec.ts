// B-RECUR2-116 fix round 4 (#679). Acceptance cases from the GPT-6.1 Sol
// R12 probe (ops/aud-116/AUD-SOL-R12-116/679-authority-probe.spec.ts, run
// 37174065131) for B-679-1..7, plus Opus C-679-1 / C-679-2. Each case failed
// before this round. Synthetic stateful doubles only.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { PackagesService } from '../src/packages/packages.service';
import {
  makeCheckoutHelpers,
  makeFakePrisma,
  makeFakeStripe,
  matchWhere,
} from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const PKG2 = '44444444-4444-4444-8444-444444444444';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 25 * 3600 * 1000;

function packageRow(over: Record<string, unknown> = {}) {
  return {
    id: PKG,
    coach_id: COACH,
    name: 'Plan A',
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    stripe_price_id: 'price_A',
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    is_active: true,
    published_at: new Date('2026-09-01'),
    archived_at: null,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const checkout: any = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'synthetic@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(packageRow(over));
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const packages: any = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
  };
  const feePolicy: any = { planFor: jest.fn(async () => ({ head_coach_id: null })) };
  const svc = new SubscriptionCheckoutService(
    prisma,
    stripe,
    packages,
    { ready: true } as any,
    feePolicy,
    checkout,
  );
  return { svc, prisma, stripe };
}
type F = ReturnType<typeof setup>;

async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (error) {
    if (error instanceof HttpException)
      return { body: error.getResponse(), status: error.getStatus() };
    return { error };
  }
}

const intent = (svc: SubscriptionCheckoutService, key = KEY1, pkg = PKG) =>
  svc.createSubscriptionIntent(CLIENT, { package_id: pkg, idempotency_key: key });
const timeout = () =>
  new StripeConnectApiError(
    'synthetic lost response',
    503,
    'request_timeout',
    'api_connection_error',
  );

async function uncertainCreate(f: F, makeOnProvider = true) {
  const original = f.stripe.createSubscription.getMockImplementation();
  f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
    if (makeOnProvider) await original(args);
    throw timeout();
  });
  const first = await resultOf(intent(f.svc));
  expect(first.status).toBe(503);
  expect(f.prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
}

function age(f: F) {
  Object.assign(f.prisma._purchases[0], {
    created_at: new Date(Date.now() - OLD),
    updated_at: new Date(Date.now() - OLD),
  });
}

/** Stripe answers the read, then the client's payment (or card) lands before the cancel. */
function landsAfterRead(f: F, land: (sub: any) => void) {
  const real = f.stripe.retrieveSubscriptionForCheckout.getMockImplementation();
  f.stripe.retrieveSubscriptionForCheckout.mockImplementationOnce(async (id: string) => {
    const snapshot = structuredClone(await real(id));
    land(f.stripe._subs.get(id));
    return snapshot;
  });
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});
afterEach(() => jest.restoreAllMocks());

describe('B-679-1 an unresolved attempt excludes a second subscription at any age', () => {
  it('(failed before) a NEW key cannot bypass an old unbound uncertain trial', async () => {
    const f = setup({ trial_days: 7 });
    await uncertainCreate(f);
    age(f);
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
    expect(f.stripe.listSubscriptionsForCustomer).toHaveBeenCalled();
  });

  it('(failed before) an unreadable old bound trial cannot be bypassed with a NEW key', async () => {
    const f = setup({ trial_days: 7 });
    await intent(f.svc);
    age(f);
    f.stripe._saveTrialCard('sub_1');
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(
      new Error('synthetic Stripe outage'),
    );
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
  });

  it('(failed before) a stale trial whose cancel failed holds its attempt and its one-trial reservation', async () => {
    const f = setup({ trial_days: 7 });
    await intent(f.svc);
    age(f);
    f.stripe.cancelSubscription.mockRejectedValue(new Error('synthetic cancel outage'));
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
  });

  it('control: an old trial attempt of another plan that Stripe never created is released, so the new plan keeps its trial', async () => {
    const f = setup({ trial_days: 7 });
    f.prisma._packages.push(
      packageRow({ id: PKG2, name: 'Plan B', stripe_price_id: 'price_B', trial_days: 7 }),
    );
    await uncertainCreate(f, false);
    age(f);
    const out = await intent(f.svc, KEY2, PKG2);
    expect(out.plan.trial_days).toBe(7);
    expect(f.prisma._purchases[0].status).toBe('expired');
  });
});

describe('B-679-7 a closed attempt never sends its create', () => {
  it('(failed before) an attempt closed while the pin write reply is delayed sends no create', async () => {
    const f = setup();
    let release: () => void = () => undefined;
    let notify: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pinned = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const realUpdate = f.prisma.clientPurchase.update.getMockImplementation();
    f.prisma.clientPurchase.update.mockImplementation(async (args: any) => {
      const row = await realUpdate(args);
      if (args.data.checkout_terms) {
        notify();
        await hold;
      }
      return row;
    });
    const pending = resultOf(intent(f.svc));
    await pinned;
    Object.assign(f.prisma._purchases[0], {
      status: 'canceled',
      entitlement_active: false,
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
    });
    release();
    await pending;
    expect(f.stripe.createSubscription).not.toHaveBeenCalled();
  });
});

describe('B-679-2 a key belongs to one plan', () => {
  it('(failed before) the same key cannot return Plan A credentials relabelled as Plan B', async () => {
    const f = setup();
    const a = await intent(f.svc);
    f.prisma._packages.push(packageRow({ id: PKG2, name: 'Plan B', stripe_price_id: 'price_B' }));
    const b = await resultOf(intent(f.svc, KEY1, PKG2));
    if (b.value) {
      expect(b.value.plan.package_id).toBe(PKG);
      expect(b.value.purchase_id).toBe(a.purchase_id);
    } else {
      expect(b.status).toBe(409);
      expect(b.body.code).toBe('CHECKOUT_KEY_OTHER_PLAN');
      expect(JSON.stringify(b.body)).not.toMatch(/secret|pi_|sub_/);
    }
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('B-679-3 a late ephemeral key never brings credentials back', () => {
  it.each(['active', 'canceled', 'expired'])(
    '(failed before) first mint, the row turned %s meanwhile',
    async (status) => {
      const f = setup();
      f.stripe.createEphemeralKey.mockImplementation(async () => {
        Object.assign(f.prisma._purchases[0], {
          status,
          entitlement_active: status === 'active',
          stripe_client_secret: null,
          stripe_ephemeral_key: null,
        });
        return { secret: 'ek_synthetic' };
      });
      const out = await resultOf(intent(f.svc));
      expect(f.prisma._purchases[0].stripe_client_secret).toBeNull();
      expect(f.prisma._purchases[0].stripe_ephemeral_key).toBeNull();
      if (out.value) expect(out.value.client_secret).toBe('');
    },
  );

  it('(failed before) reuse, the row expired meanwhile', async () => {
    const f = setup();
    await intent(f.svc);
    f.stripe.createEphemeralKey.mockImplementationOnce(async () => {
      Object.assign(f.prisma._purchases[0], {
        status: 'expired',
        stripe_client_secret: null,
        stripe_ephemeral_key: null,
      });
      return { secret: 'ek_synthetic' };
    });
    await resultOf(intent(f.svc, KEY2));
    expect(f.prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(f.prisma._purchases[0].stripe_ephemeral_key).toBeNull();
  });
});

describe('B-679-4 / B-679-5 plan reads keep lifecycle order and the bought cadence', () => {
  it('(failed before) a resume answer from before a later cancel cannot undo that cancel', async () => {
    const f = setup();
    const out = await intent(f.svc);
    const row = f.prisma._purchases[0];
    Object.assign(row, { status: 'active', entitlement_active: true, cancel_at_period_end: true });
    f.stripe.resumeSubscription.mockImplementationOnce(async () => {
      f.stripe._subs.get('sub_1').cancel_at_period_end = true;
      Object.assign(row, { cancel_at_period_end: true, updated_at: new Date(Date.now() + 1) });
      return { id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 1 };
    });
    const view = await f.svc.resumePlan(CLIENT, out.purchase_id, KEY2);
    expect(row.cancel_at_period_end).toBe(true);
    expect(view.cancel_at_period_end).toBe(true);
  });

  it('(failed before) a permitted package edit during checkout does not change the bought cadence', async () => {
    const f = setup();
    const out = await intent(f.svc);
    f.prisma.coachPackage.findFirst = jest.fn(
      async ({ where }: any) => f.prisma._packages.find((p: any) => matchWhere(p, where)) ?? null,
    );
    f.prisma.coachPackage.update = jest.fn(async ({ where, data }: any) => {
      const pkg = f.prisma._packages.find((p: any) => p.id === where.id);
      Object.assign(pkg, data);
      return pkg;
    });
    f.prisma.clientPurchase.count = jest.fn(
      async ({ where }: any) => f.prisma._purchases.filter((p: any) => matchWhere(p, where)).length,
    );
    await new PackagesService(f.prisma, {} as any).update(COACH, PKG, {
      interval: 'year',
      amount_cents: 5900,
    } as any);
    expect(f.prisma._packages[0].interval).toBe('year');
    Object.assign(f.prisma._purchases[0], { status: 'active', entitlement_active: true });
    const view = await f.svc.getPlan(CLIENT, out.purchase_id);
    expect([view.amount_cents, view.interval, view.interval_count]).toEqual([4900, 'month', 1]);
  });
});

describe('B-679-6 an unknown outcome is never presented as no charge', () => {
  it('(failed before) a create that succeeded before its answer was lost', async () => {
    const f = setup();
    const original = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await original(args);
      Object.assign(sub, {
        status: 'active',
        latest_invoice: { id: 'in_paid', status: 'paid', amount_due: 4900 },
      });
      throw timeout();
    });
    const out = await resultOf(intent(f.svc));
    expect(out.status).toBe(503);
    expect(out.body.message).not.toMatch(/nothing was charged/i);
    expect(out.body.message).toMatch(/reference/);
  });

  it('(failed before) no sheet and the cancel is not confirmed: SETUP_UNAVAILABLE without a no-charge claim', async () => {
    const f = setup();
    const original = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await original(args);
      sub.latest_invoice = { id: 'in_1', amount_due: 4900, status: 'open', payment_intent: null };
      return sub;
    });
    f.stripe.cancelSubscription.mockRejectedValueOnce(timeout());
    const out = await resultOf(intent(f.svc));
    expect(out.body.code).toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
    expect(out.body.message).not.toMatch(/nothing was charged/i);
  });
});

describe('C-679-1 a payment that lands just before a cancel keeps the plan', () => {
  const reprice = (f: F) =>
    Object.assign(f.prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_new' });

  it('(failed before) incomplete: the first invoice is paid after the read; no cancel, ALREADY_ACTIVE', async () => {
    const f = setup();
    const original = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await original(args);
      sub.latest_invoice.status = 'open';
      return sub;
    });
    await intent(f.svc);
    reprice(f);
    landsAfterRead(f, (sub) => {
      sub.status = 'active';
      sub.latest_invoice.status = 'paid';
      sub.latest_invoice.payment_intent.status = 'succeeded';
    });
    const out = await resultOf(intent(f.svc, KEY2));
    expect(out.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(f.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(f.stripe._subs.get('sub_1').status).toBe('active');
    expect(f.stripe._subs.size).toBe(1);
  });

  it('(failed before) trial: the card is saved after the read; no cancel, ALREADY_ACTIVE', async () => {
    const f = setup({ trial_days: 7 });
    await intent(f.svc);
    reprice(f);
    landsAfterRead(f, (sub) => f.stripe._saveTrialCard(sub.id));
    const out = await resultOf(intent(f.svc, KEY2));
    expect(out.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(f.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(f.stripe._subs.get('sub_1').status).toBe('trialing');
  });

  it('(failed before) an unpaid stale attempt is voided, then canceled, and a new key starts the new price', async () => {
    const f = setup();
    const original = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await original(args);
      sub.latest_invoice.status = 'open';
      return sub;
    });
    await intent(f.svc);
    reprice(f);
    const out = await intent(f.svc, KEY2);
    expect(f.stripe.voidInvoice).toHaveBeenCalledWith('in_1', 'tgp-void-in_1');
    expect(f.stripe._subs.get('sub_1').status).toBe('canceled');
    expect(out.subscription_id).toBe('sub_2');
  });
});

describe('C-679-2 more than 100 subscriptions never make the lookup unreadable', () => {
  it('(failed before) 101 older subscriptions: the retry still resolves', async () => {
    const f = setup();
    for (let i = 0; i < 101; i += 1) {
      f.stripe._subs.set(`sub_old_${i}`, {
        id: `sub_old_${i}`,
        status: 'canceled',
        customer: 'cus_1111',
        created: 1_600_000_000,
        metadata: {},
      });
    }
    await uncertainCreate(f, false);
    const out = await intent(f.svc);
    expect(out.subscription_id).toBe('sub_1');
    expect(f.stripe.listSubscriptionsForCustomer).toHaveBeenLastCalledWith(
      'cus_1111',
      expect.objectContaining({ createdGte: expect.any(Number) }),
    );
  });
});
