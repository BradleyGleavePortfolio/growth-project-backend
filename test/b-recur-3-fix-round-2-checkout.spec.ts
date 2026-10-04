// B-RECUR-3 fix round 2 (agent 115) — Sol's B-654-1 (narrowed), B-654-5,
// B-654-6, B-654-7 on backend#654 @795110b7, plus the plan read the app
// needs for mobile#334 B-334-3. Every case marked (failed before) failed at
// 795110b717b1554045d13bf596eeacb0c38f19c6:
//   B-654-5 a failure after Stripe created the subscription dropped the
//           reservation; the same-key retry minted a new row id, so the
//           pinned Stripe request changed (metadata.tgp_purchase_id) under
//           the SAME Stripe Idempotency-Key, which Stripe rejects
//           (idempotency_error) — the paid-for plan could not be finished;
//   B-654-6 a first invoice that needed no sheet (zero due, credit balance,
//           a payment already processing) was canceled as "missing sheet";
//   B-654-7 a same-key replay returned the old intent labelled with the
//           package's NEW terms.
// B-RECUR5B-117 (agent 117) — moved unchanged from
// test/b-recur-3-fix-round-2.spec.ts (#680) for size; the B-654-1 webhook
// case stays there.
import { Logger } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { pickErrorDetails } from '../src/filters/error-details';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const HEAD = '55555555-5555-4555-8555-555555555555';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function recurringPkg(over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

function setup(pkgOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const helpers = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(recurringPkg(pkgOver));
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
  const feePolicy: any = {
    planFor: jest.fn(async () => ({
      application_fee_cents: 98,
      head_coach_split_cents: 0,
      head_coach_id: null as string | null,
    })),
  };
  const checkout: any = helpers;
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
  const realCreate = stripe.createSubscription.getMockImplementation();
  /** Stripe creates the subscription, then the answer is lost (timeout). */
  const createThenTimeout = () =>
    stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      await realCreate(a);
      throw new StripeConnectApiError('Stripe request timed out', 503, 'request_timeout', null);
    });
  return { prisma, stripe, helpers, svc, feePolicy, createThenTimeout };
}

/** The plan read's checkout_state (read structurally: the field is new). */
async function checkoutStateOf(svc: SubscriptionCheckoutService, id: string): Promise<unknown> {
  const view: Record<string, unknown> = { ...(await svc.getPlan(CLIENT, id)) };
  return view.checkout_state;
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err: any) {
    return { status: err.getStatus?.(), body: err.getResponse?.() };
  }
  throw new Error('expected a coded error');
}

const buy = (svc: SubscriptionCheckoutService, key: string, over: Record<string, unknown> = {}) =>
  svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: key, ...over });

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});


describe('B-654-5 one attempt, one pinned Stripe request', () => {
  it('(failed before) ephemeral key fails after the create -> the attempt stays bound; same key finishes it', async () => {
    const { svc, stripe, prisma } = setup();
    stripe.createEphemeralKey.mockRejectedValueOnce(
      new StripeConnectApiError('Stripe unavailable', 503, null, 'api_error'),
    );
    const r = await codeOf(buy(svc, KEY1));
    expect(r.status).toBe(503);
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(out.client_secret).toBe('pi_1_secret_x');
    expect(stripe._subs.size).toBe(1);
    // No second Subscription create; the retry used the bound subscription.
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('(failed before) the create times out after Stripe made it -> same key binds that subscription (found by metadata, never re-created)', async () => {
    const { svc, stripe, prisma, createThenTimeout } = setup();
    createThenTimeout();
    const r = await codeOf(buy(svc, KEY1));
    expect(r.status).toBe(503);
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
    expect(prisma._purchases[0].checkout_terms).toEqual(
      expect.objectContaining({ recurring_price_id: 'price_rec_4900', amount_cents: 4900 }),
    );
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(out.client_secret).toBe('pi_1_secret_x');
    expect(stripe._subs.size).toBe(1);
    // C-654-8 (fix round 3): the retry reads Stripe first and binds; the
    // identical-resend case is in test/b-recur-116-fix-round-3.spec.ts.
    const calls = stripe.createSubscription.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata.tgp_purchase_id).toBe(prisma._purchases[0].id);
  });

  it('(failed before) a different key after an uncertain create finishes the SAME attempt (no second subscription)', async () => {
    const { svc, stripe, prisma, createThenTimeout } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    const out = await buy(svc, KEY2);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe._subs.size).toBe(1);
    expect(prisma._purchases).toHaveLength(1);
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it('(failed before) inputs drift between tries (head coach changed): the retry still sends the pinned request; a key conflict is resolved by metadata', async () => {
    const { svc, stripe, prisma, feePolicy, createThenTimeout } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    // The fee policy now names a head coach: metadata would differ.
    feePolicy.planFor.mockImplementation(async () => ({
      application_fee_cents: 98,
      head_coach_split_cents: 10,
      head_coach_id: HEAD,
    }));
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe._subs.size).toBe(1);
    expect(stripe.listSubscriptionsForCustomer).toHaveBeenCalledWith(
      prisma._purchases[0].stripe_customer_id,
    );
    expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
  });

  it('a key conflict with no subscription for the attempt ends it: SUBSCRIPTION_ATTEMPT_EXPIRED, nothing charged', async () => {
    const { svc, stripe, prisma } = setup();
    stripe.createSubscription.mockRejectedValueOnce(
      new StripeConnectApiError('Stripe request timed out', 503, 'request_timeout', null),
    );
    await codeOf(buy(svc, KEY1));
    stripe.createSubscription.mockRejectedValueOnce(
      new StripeConnectApiError('Keys for idempotent requests ...', 400, null, 'idempotency_error'),
    );
    const r = await codeOf(buy(svc, KEY1));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(
      expect.objectContaining({ code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', reason: 'timed_out' }),
    );
    expect(prisma._purchases[0].status).toBe('expired');
    // A new key starts a fresh attempt.
    const out = await buy(svc, KEY2);
    expect(out.subscription_id).toBe('sub_1');
    expect(prisma._purchases).toHaveLength(2);
  });

  it('a definitive Stripe refusal ends the attempt; the same key answers ATTEMPT_EXPIRED, a new key works', async () => {
    const { svc, stripe, prisma } = setup();
    stripe.createSubscription.mockRejectedValueOnce(
      new StripeConnectApiError('No such price', 400, 'resource_missing', 'invalid_request_error'),
    );
    const r = await codeOf(buy(svc, KEY1));
    expect(r.body.code).toBe('STRIPE_CHECKOUT_ERROR');
    expect(prisma._purchases[0].status).toBe('expired');
    const again = await codeOf(buy(svc, KEY1));
    expect(again.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    const out = await buy(svc, KEY2);
    expect(out.subscription_id).toBe('sub_1');
  });

  it('a failure before Stripe saw the key (price setup) frees the reservation', async () => {
    const { svc, prisma, helpers } = setup({ stripe_price_id: null });
    helpers.ensurePriceForPackage.mockRejectedValueOnce(
      new StripeConnectApiError('Stripe unavailable', 503, null, 'api_error'),
    );
    await codeOf(buy(svc, KEY1));
    expect(prisma._purchases).toHaveLength(0);
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
  });

  it('a request that died mid-create is taken over once its marker is stale', async () => {
    const { svc, stripe, prisma } = setup();
    // A reservation left in flight by a request that never came back.
    stripe.createSubscription.mockImplementationOnce(async () => {
      throw new Error('process killed');
    });
    await expect(buy(svc, KEY1)).rejects.toThrow('process killed');
    const row = prisma._purchases[0];
    row.stripe_checkout_session_id = `sub-reserved-${row.idempotency_key}`;
    // Fresh in-flight marker: the same key waits instead of a second create.
    const fresh = await codeOf(buy(svc, KEY1));
    expect(fresh.body.code).toBe('PAYMENT_IN_PROGRESS');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    row.updated_at = new Date(Date.now() - 10 * 60_000);
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe._subs.size).toBe(1);
  }, 20_000);
});

describe('B-654-6 a first invoice that needs no sheet is never canceled', () => {
  function paidWithoutSheet(
    stripe: any,
    shape: 'active_zero' | 'incomplete_processing' | 'paid_invoice',
  ) {
    const realCreate = stripe.createSubscription.getMockImplementation();
    stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      const sub = await realCreate(a);
      if (shape === 'active_zero') {
        sub.status = 'active';
        sub.latest_invoice = { id: 'in_1', amount_due: 0, status: 'paid', payment_intent: null };
      } else if (shape === 'paid_invoice') {
        sub.latest_invoice = { id: 'in_1', amount_due: 0, status: 'paid', payment_intent: null };
      } else {
        sub.latest_invoice.payment_intent.status = 'processing';
      }
      return sub;
    });
  }

  it.each(['active_zero', 'paid_invoice', 'incomplete_processing'] as const)(
    '(failed before) %s -> kept and bound, mode none, no secret, no cancel',
    async (shape) => {
      const { svc, stripe, prisma } = setup();
      paidWithoutSheet(stripe, shape);
      const out = await buy(svc, KEY1);
      expect(out.mode).toBe('none');
      expect(out.client_secret).toBe('');
      expect(out.ephemeral_key).toBe('');
      expect(out.subscription_id).toBe('sub_1');
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
      expect(prisma._purchases[0].status).toBe('pending');
      // A same-key replay answers the same (no second create, no cancel).
      const again = await buy(svc, KEY1);
      expect(again.mode).toBe('none');
      expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
      expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    },
  );

  it('control: an open invoice with no PaymentIntent is canceled and the attempt ended (nothing charged)', async () => {
    const { svc, stripe, prisma } = setup();
    const realCreate = stripe.createSubscription.getMockImplementation();
    stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      const sub = await realCreate(a);
      sub.latest_invoice = { id: 'in_1', amount_due: 4900, status: 'open', payment_intent: null };
      return sub;
    });
    const r = await codeOf(buy(svc, KEY1));
    expect(r.body.code).toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
    expect(r.body.message).toMatch(/Nothing was charged/);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(prisma._purchases[0].status).toBe('expired');
  });

  it('(failed before) reuse by a new key of an attempt whose first payment is processing -> ALREADY_ACTIVE, never canceled', async () => {
    const { svc, stripe } = setup();
    await buy(svc, KEY1);
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'processing';
    const r = await codeOf(buy(svc, KEY2));
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe('B-654-7 a same-key replay answers the terms of its own subscription', () => {
  it('(failed before) package repriced 4900 -> 5900: same key with the new price -> ATTEMPT_EXPIRED terms_changed; old attempt canceled; a new key mints 5900', async () => {
    const { svc, stripe, prisma } = setup();
    const first = await buy(svc, KEY1, { expected_amount_cents: 4900 });
    expect(first.plan.amount_cents).toBe(4900);
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(
      expect.objectContaining({ code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', reason: 'terms_changed' }),
    );
    expect(r.body.message).toMatch(/terms of this plan changed/);
    expect(r.body.message).toMatch(/Nothing was charged/);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(prisma._purchases[0].status).toBe('expired');
    const fresh = await buy(svc, KEY2, { expected_amount_cents: 5900 });
    expect(fresh.subscription_id).toBe('sub_2');
    expect(fresh.plan.amount_cents).toBe(5900);
    expect(stripe._subs.get('sub_2').items.data[0].price.id).toBe('price_rec_5900');
  });

  it('(failed before) the coach changes the trial 7 -> 14 days: same key -> terms_changed, never a 7-day intent labelled 14', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    const first = await buy(svc, KEY1);
    expect(first.mode).toBe('setup');
    expect(first.plan.trial_days).toBe(7);
    prisma._packages[0].trial_days = 14;
    const r = await codeOf(buy(svc, KEY1));
    expect(r.body).toEqual(
      expect.objectContaining({ code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', reason: 'terms_changed' }),
    );
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
  });

  it('a repriced package whose old attempt was already paid -> ALREADY_ACTIVE, nothing canceled', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'succeeded';
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it('a repriced package while Stripe cannot be read -> retryable error, nothing canceled or ended', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(
      new StripeConnectApiError('Stripe unavailable', 503, null, 'api_error'),
    );
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.status).toBe(503);
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(prisma._purchases[0].status).toBe('pending');
  });

  it('an unchanged package: the replay answers the pinned terms (renamed package keeps the old money terms)', async () => {
    const { svc, prisma } = setup();
    const first = await buy(svc, KEY1);
    prisma._packages[0].name = 'Coaching, renamed';
    const again = await buy(svc, KEY1);
    expect(again.client_secret).toBe(first.client_secret);
    expect(again.plan).toEqual(
      expect.objectContaining({ amount_cents: 4900, first_charge_cents: 4900 }),
    );
  });

  it('an uncertain create whose terms changed before the retry is retired, never resent at the new price', async () => {
    const { svc, stripe, prisma, createThenTimeout } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.body).toEqual(expect.objectContaining({ reason: 'terms_changed' }));
    // The subscription Stripe made for the attempt was found by metadata and canceled.
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    const out = await buy(svc, KEY3, { expected_amount_cents: 5900 });
    expect(out.plan.amount_cents).toBe(5900);
    expect(out.subscription_id).toBe('sub_2');
  });

  it('error details allowlist carries only the coded reason', () => {
    expect(
      pickErrorDetails(409, 'SUBSCRIPTION_ATTEMPT_EXPIRED', {
        reason: 'terms_changed',
        extra: 'x',
      }),
    ).toEqual({ reason: 'terms_changed' });
    expect(pickErrorDetails(409, 'SUBSCRIPTION_ATTEMPT_EXPIRED', { reason: 'other' })).toEqual({});
  });
});

describe('B-334-3 support: the plan read reports what Stripe shows for a confirming plan', () => {
  it('awaiting_payment -> processing -> paid as the first PaymentIntent moves', async () => {
    const { svc, stripe } = setup();
    const out = await buy(svc, KEY1);
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('awaiting_payment');
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'processing';
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('processing');
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'succeeded';
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('paid');
  });

  it('trial: awaiting_card until the card is saved, then card_saved (and the default is set)', async () => {
    const { svc, stripe } = setup({ trial_days: 7 });
    const out = await buy(svc, KEY1);
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('awaiting_card');
    stripe._saveTrialCard('sub_1');
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('card_saved');
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalled();
  });

  it('Stripe unreadable -> unknown (never a no-charge claim); entitled plan and list -> null', async () => {
    const { svc, stripe, prisma } = setup();
    const out = await buy(svc, KEY1);
    stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(new Error('stripe down'));
    expect(await checkoutStateOf(svc, out.purchase_id)).toBe('unknown');
    Object.assign(prisma._purchases[0], { status: 'active', entitlement_active: true });
    expect(await checkoutStateOf(svc, out.purchase_id)).toBeNull();
    const list: Array<Record<string, unknown>> = (await svc.listPlans(CLIENT)).map((v) => ({
      ...v,
    }));
    expect(list[0].checkout_state).toBeNull();
  });

  it('(failed before) checklist (a): a caught error is logged by its code, never by its message', async () => {
    const { svc, stripe } = setup();
    const out = await buy(svc, KEY1);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(
        new StripeConnectApiError(
          'No such customer for client a.person@example.test',
          404,
          'resource_missing',
          'invalid_request_error',
        ),
      );
      expect(await checkoutStateOf(svc, out.purchase_id)).toBe('unknown');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain(out.purchase_id);
      expect(logged).not.toContain('example.test');
      expect(logged).not.toContain('No such customer');
      expect(logged).toContain('resource_missing');
    } finally {
      warn.mockRestore();
    }
  });
});
