// Independent GPT-6.1 Sol probes. Candidate source is #679 @ 958806d1.
// Synthetic, stateful DB/provider boundaries; no production credentials or calls.
import { HttpException, Logger } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { errorLabel } from '../src/checkout/error-label';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const PKG2 = '44444444-4444-4444-8444-444444444444';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 25 * 3600 * 1000;
const CANARY = 'private_person_example_test';

function packageRow(over: Record<string, unknown> = {}) {
  return {
    id: PKG, coach_id: COACH, name: 'Plan A', description: null,
    amount_cents: 4900, currency: 'usd', billing_type: 'recurring',
    interval: 'month', interval_count: 1, stripe_price_id: 'price_A',
    recurring_amount_cents: null, recurring_interval: null,
    recurring_interval_count: null, recurring_stripe_price_id: null,
    is_active: true, published_at: new Date('2026-09-01'), archived_at: null,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const checkout = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'synthetic@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(packageRow(over));
  prisma._accounts.push({
    coach_user_id: COACH, stripe_account_id: 'acct_coach',
    charges_enabled: true, deauthorized_at: null,
  });
  const packages: any = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
  };
  const state: any = { ready: true };
  const feePolicy: any = { planFor: jest.fn(async () => ({ head_coach_id: null })) };
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
  return { svc, prisma, stripe, checkout };
}

async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (error) {
    if (error instanceof HttpException) return { body: error.getResponse(), status: error.getStatus() };
    return { error };
  }
}

function intent(svc: SubscriptionCheckoutService, key = KEY1, pkg = PKG) {
  return svc.createSubscriptionIntent(CLIENT, { package_id: pkg, idempotency_key: key });
}

async function uncertainCreate(f: ReturnType<typeof setup>, makeOnProvider = true) {
  const original = f.stripe.createSubscription.getMockImplementation();
  f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
    if (makeOnProvider) await original(args);
    throw new StripeConnectApiError('synthetic lost response', 503, 'request_timeout', 'api_connection_error');
  });
  const first = await resultOf(intent(f.svc));
  expect(first.status).toBe(503);
  expect(f.prisma._purchases).toHaveLength(1);
  expect(f.prisma._purchases[0].stripe_subscription_id).toBeNull();
  expect(f.prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
}

function age(f: ReturnType<typeof setup>) {
  Object.assign(f.prisma._purchases[0], {
    created_at: new Date(Date.now() - OLD), updated_at: new Date(Date.now() - OLD),
  });
}

beforeAll(() => { process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic'; });
afterEach(() => jest.restoreAllMocks());

describe('prior B-654-5 narrowed: exact-key replay', () => {
  it.each([0, 7])('lookup binds the old provider object after key retention (%i trial days)', async (trial_days) => {
    const f = setup({ trial_days });
    await uncertainCreate(f);
    age(f);
    // If a resend happens here it deliberately creates a fresh object, modeling key eviction.
    f.stripe.createSubscription.mockImplementation(async (args: any) => {
      const newProvider = makeFakeStripe();
      const duplicate = await newProvider.createSubscription(args);
      return { ...duplicate, id: 'sub_duplicate' };
    });
    const out = await intent(f.svc);
    expect(out.subscription_id).toBe('sub_1');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(f.stripe.listSubscriptionsForCustomer).toHaveBeenCalled();
  });

  it('a confirmed old miss expires without resending', async () => {
    const f = setup();
    await uncertainCreate(f, false);
    age(f);
    const out = await resultOf(intent(f.svc));
    expect(out.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(f.prisma._purchases[0].status).toBe('expired');
  });

  it('an unreadable replay leaves the pinned attempt retryable', async () => {
    const f = setup({ trial_days: 7 });
    await uncertainCreate(f);
    age(f);
    f.stripe.listSubscriptionsForCustomer.mockRejectedValueOnce(new Error('synthetic read down'));
    const out = await resultOf(intent(f.svc));
    expect(out.body.code).toBe('PAYMENT_RETRY');
    expect(f.prisma._purchases[0].status).toBe('pending');
    expect(f.prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('prior B-654-8: cancellation authority', () => {
  it('changed terms + rejected cancel keeps the row payable and retryable', async () => {
    const f = setup();
    await intent(f.svc);
    Object.assign(f.prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_new' });
    f.stripe.cancelSubscription.mockRejectedValue(new Error('synthetic cancel down'));
    const out = await resultOf(intent(f.svc));
    expect(out.body.code).toBe('PAYMENT_RETRY');
    expect(f.prisma._purchases[0].status).toBe('pending');
    expect(f.stripe._subs.get('sub_1').status).toBe('incomplete');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('changed terms + lost successful cancel answer reconciles before expiring', async () => {
    const f = setup();
    await intent(f.svc);
    Object.assign(f.prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_new' });
    f.stripe.cancelSubscription.mockImplementation(async (id: string) => {
      f.stripe._subs.get(id).status = 'canceled';
      throw new Error('synthetic lost cancel answer');
    });
    const out = await resultOf(intent(f.svc));
    expect(out.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(f.prisma._purchases[0].status).toBe('expired');
    expect(f.prisma._purchases[0].stripe_client_secret).toBeNull();
  });

  it.each(['past_due', 'unpaid'])('a still-billable %s plan cannot be replaced', async (status) => {
    const f = setup();
    await intent(f.svc);
    f.stripe._subs.get('sub_1').status = status;
    const out = await resultOf(intent(f.svc, KEY2));
    expect(out.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(f.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('prior B-654-9 / C-654-10: diagnostic allowlist', () => {
  it.each([
    Object.assign(new Error('synthetic message'), { name: CANARY }),
    Object.assign(new Error('synthetic message'), { code: CANARY }),
    new StripeConnectApiError(CANARY, 503, CANARY, CANARY),
  ])('unknown error data never reaches errorLabel', (error) => {
    expect(errorLabel(error)).not.toContain(CANARY);
  });
  it('the actual cancellation catch logs no canary name/code/message', async () => {
    const f = setup();
    await intent(f.svc);
    Object.assign(f.prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_new' });
    const log = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    f.stripe.cancelSubscription.mockRejectedValue(
      Object.assign(new Error(CANARY), { name: CANARY, code: CANARY }),
    );
    await resultOf(intent(f.svc));
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(CANARY);
    expect(errorLabel(Object.assign(new Error('synthetic'), { code: 'P2002' }))).toBe('P2002');
    expect(errorLabel(Object.assign(new Error('synthetic'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
  });
});

describe('adversarial: old attempts must still exclude a second create', () => {
  it('a NEW key cannot bypass an old unbound uncertain trial', async () => {
    const f = setup({ trial_days: 7 });
    await uncertainCreate(f);
    age(f);
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
    expect(f.stripe.listSubscriptionsForCustomer).toHaveBeenCalled();
  });

  it('an unreadable old bound trial cannot be bypassed with a NEW key', async () => {
    const f = setup({ trial_days: 7 });
    await intent(f.svc);
    age(f);
    // Card may have succeeded while the app was closed; provider truth is temporarily unavailable.
    f.stripe._saveTrialCard('sub_1');
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(new Error('synthetic Stripe outage'));
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
  });

  it('a stale trial whose cancel failed must hold its attempt and its one-trial reservation', async () => {
    const f = setup({ trial_days: 7 });
    await intent(f.svc);
    age(f);
    f.stripe.cancelSubscription.mockRejectedValue(new Error('synthetic cancel outage'));
    await resultOf(intent(f.svc, KEY2));
    expect(f.stripe._subs.size).toBe(1);
    expect(f.prisma._purchases).toHaveLength(1);
  });
});

describe('adversarial: immutable identity and lifecycle', () => {
  it('same key cannot return Plan A credentials relabelled as equally priced Plan B', async () => {
    const f = setup();
    const a = await intent(f.svc);
    f.prisma._packages.push(packageRow({ id: PKG2, name: 'Plan B', stripe_price_id: 'price_B' }));
    const b = await resultOf(intent(f.svc, KEY1, PKG2));
    // Either reject cross-package key reuse or return the original attempt's identity.
    if (b.value) {
      expect(b.value.plan.package_id).toBe(PKG);
      expect(b.value.plan.package_name).toBe('Plan A');
      expect(b.value.purchase_id).toBe(a.purchase_id);
    } else {
      expect(b.status).toBeGreaterThanOrEqual(400);
    }
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'expired'])('a first-mint ephemeral await cannot resurrect credentials after %s', async (status) => {
    const f = setup();
    f.stripe.createEphemeralKey.mockImplementation(async () => {
      Object.assign(f.prisma._purchases[0], {
        status, entitlement_active: status === 'active',
        stripe_client_secret: null, stripe_ephemeral_key: null,
      });
      return { secret: 'ek_synthetic' };
    });
    const out = await resultOf(intent(f.svc));
    expect(f.prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(f.prisma._purchases[0].stripe_ephemeral_key).toBeNull();
    if (out.value) expect(out.value.client_secret).toBe('');
  });

  it('a reuse ephemeral await cannot resurrect an expired attempt', async () => {
    const f = setup();
    await intent(f.svc);
    f.stripe.createEphemeralKey.mockImplementationOnce(async () => {
      Object.assign(f.prisma._purchases[0], {
        status: 'expired', stripe_client_secret: null, stripe_ephemeral_key: null,
      });
      return { secret: 'ek_synthetic' };
    });
    await resultOf(intent(f.svc, KEY2));
    expect(f.prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(f.prisma._purchases[0].stripe_ephemeral_key).toBeNull();
  });

  it('a resume response from BEFORE a later cancel cannot undo that cancel in the read model', async () => {
    const f = setup();
    const out = await intent(f.svc);
    const row = f.prisma._purchases[0];
    Object.assign(row, { status: 'active', entitlement_active: true, cancel_at_period_end: true });
    const authoritative = {
      id: 'sub_1', status: 'active', cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 10000,
    };
    f.stripe.resumeSubscription.mockImplementationOnce(async () => {
      // Resume completed, but its HTTP reply is delayed. A newer cancel and webhook finish first.
      f.stripe._subs.get('sub_1').cancel_at_period_end = true;
      Object.assign(row, { cancel_at_period_end: true, updated_at: new Date(Date.now() + 1) });
      return { ...authoritative };
    });
    await f.svc.resumePlan(CLIENT, out.purchase_id, KEY2);
    expect(row.cancel_at_period_end).toBe(true);
  });

  it('plan read preserves the bought cadence when the package is edited', async () => {
    const f = setup();
    const out = await intent(f.svc);
    Object.assign(f.prisma._purchases[0], { status: 'active', entitlement_active: true });
    Object.assign(f.prisma._packages[0], {
      interval: 'year', interval_count: 1, amount_cents: 5900, stripe_price_id: 'price_B',
    });
    const view = await f.svc.getPlan(CLIENT, out.purchase_id);
    expect(view.amount_cents).toBe(4900);
    expect(view.interval).toBe('month');
    expect(view.interval_count).toBe(1);
  });
});

describe('adversarial: money error copy is not a no-charge receipt', () => {
  it('a create that succeeded before timeout must not assert nothing was charged', async () => {
    const f = setup();
    const original = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await original(args);
      // A valid first invoice can already be paid without a client sheet.
      Object.assign(sub, {
        status: 'active', latest_invoice: { id: 'in_paid', status: 'paid', amount_due: 4900 },
      });
      throw new StripeConnectApiError('synthetic lost response', 503, 'request_timeout', 'api_connection_error');
    });
    const out = await resultOf(intent(f.svc));
    expect(out.status).toBe(503);
    expect(out.body.message).not.toMatch(/nothing was charged/i);
  });
});
