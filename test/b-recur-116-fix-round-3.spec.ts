// B-RECUR-116 fix round 3 (agent 116) — the GPT-6.1 Sol draft at #654
// 02c48de7 (B-654-5 narrowed, B-654-8, B-654-9) and the Claude Opus 5.5
// APPROVE Cs C-654-8 and C-654-10, on the split pieces #679 (service) and
// #680 (webhook handler). Every case marked (failed before) failed at #680
// 7e55cfcb6d573d2a0095ef9f459f37c389cb7117:
//   B-654-5 / C-654-8  a retry of an uncertain create resent the pinned
//           request blindly; once Stripe's 24 h idempotency retention had
//           passed, Stripe ran it as a new request and the attempt got a
//           second subscription (the first one stayed trialing/incomplete);
//   B-654-8  a failed or unavailable cancellation still marked the attempt
//           expired (and a new key then minted a second subscription) while
//           the first subscription could still charge;
//   B-654-9 / C-654-10  errorLabel logged an arbitrary Error.name and any
//           identifier-shaped code; other new log lines logged the message.
import { Logger } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOURS_25 = 25 * 3600 * 1000;
/** A value that must never reach a log line (canary). */
const CANARY = 'a.person@example.test';

function setup(pkgOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const helpers = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
    id: PKG,
    coach_id: COACH,
    name: 'Coaching',
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
    ...pkgOver,
  });
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const packages: any = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null),
  };
  const feePolicy: any = {
    planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_id: null })),
  };
  const state: any = { ready: true };
  const checkout: any = helpers;
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
  const realCreate = stripe.createSubscription.getMockImplementation();
  /** Stripe creates the subscription, then the answer is lost (timeout). */
  const createThenTimeout = () =>
    stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      await realCreate(a);
      throw new StripeConnectApiError('Stripe request timed out', 503, 'request_timeout', null);
    });
  /** Stripe's idempotency retention passed: every create now runs as a new request. */
  let pruned = 0;
  const pruneStripeKeys = () =>
    stripe.createSubscription.mockImplementation(async (a: any) => {
      pruned += 1;
      return realCreate({ ...a, idempotencyKey: `${a.idempotencyKey}-after-retention-${pruned}` });
    });
  const ageAttempt = (ms: number) => {
    prisma._purchases[0].created_at = new Date(Date.now() - ms);
  };
  return { prisma, stripe, svc, createThenTimeout, pruneStripeKeys, ageAttempt };
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

const unavailable = () => new StripeConnectApiError('Stripe unavailable', 503, null, 'api_error');

function spyLogs() {
  const spies = (['log', 'warn', 'error'] as const).map((m) =>
    jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
  );
  return {
    text: () => JSON.stringify(spies.map((s) => s.mock.calls)),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});

describe('B-654-5 narrowed / C-654-8 an uncertain create is never resent blindly', () => {
  it('(failed before) trial create uncertain, retried after Stripe dropped the key: the attempt binds its own subscription, no second one', async () => {
    const { svc, stripe, prisma, createThenTimeout, pruneStripeKeys, ageAttempt } = setup({
      trial_days: 7,
    });
    createThenTimeout();
    expect((await codeOf(buy(svc, KEY1))).status).toBe(503);
    pruneStripeKeys();
    ageAttempt(HOURS_25);
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(out.mode).toBe('setup');
    expect(stripe._subs.size).toBe(1);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
  });

  it('(failed before) paid plan, same: found by metadata.tgp_purchase_id and bound, never re-created', async () => {
    const { svc, stripe, createThenTimeout, pruneStripeKeys } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    pruneStripeKeys();
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(out.client_secret).toBe('pi_1_secret_x');
    expect(stripe._subs.size).toBe(1);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('(failed before) past the key window with nothing on Stripe: the attempt ends (timed_out), nothing is created; a new key starts fresh', async () => {
    const { svc, stripe, prisma, ageAttempt } = setup({ trial_days: 7 });
    stripe.createSubscription.mockRejectedValueOnce(unavailable());
    await codeOf(buy(svc, KEY1));
    ageAttempt(HOURS_25);
    const r = await codeOf(buy(svc, KEY1));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(
      expect.objectContaining({ code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', reason: 'timed_out' }),
    );
    expect(r.body.message).toMatch(/Nothing was charged/);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(prisma._purchases[0].status).toBe('expired');
    const fresh = await buy(svc, KEY2);
    expect(fresh.subscription_id).toBe('sub_1');
    expect(prisma._purchases).toHaveLength(2);
  });

  it('(failed before) inside the key window a lookup miss resends the pinned request, after the lookup', async () => {
    const { svc, stripe } = setup();
    stripe.createSubscription.mockRejectedValueOnce(unavailable());
    await codeOf(buy(svc, KEY1));
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe.listSubscriptionsForCustomer).toHaveBeenCalledTimes(1);
    const lookedUp = stripe.listSubscriptionsForCustomer.mock.invocationCallOrder[0];
    const resent = stripe.createSubscription.mock.invocationCallOrder[1];
    expect(lookedUp).toBeLessThan(resent);
    const calls = stripe.createSubscription.mock.calls.map((c: any[]) => c[0]);
    expect(calls[1]).toEqual(calls[0]);
  });

  it('(failed before) Stripe unreadable before a resend: PAYMENT_RETRY, nothing sent, the attempt stays retryable', async () => {
    const { svc, stripe, prisma, createThenTimeout } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    stripe.listSubscriptionsForCustomer.mockRejectedValueOnce(unavailable());
    const r = await codeOf(buy(svc, KEY1));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('PAYMENT_RETRY');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
    const out = await buy(svc, KEY1);
    expect(out.subscription_id).toBe('sub_1');
    expect(stripe._subs.size).toBe(1);
  });

  it('(failed before) a found subscription that Stripe already ended ends the attempt, never re-created', async () => {
    const { svc, stripe, prisma, createThenTimeout, pruneStripeKeys } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    // Stripe expired it after 23 h: status incomplete_expired, its PaymentIntent canceled.
    stripe._subs.get('sub_1').status = 'incomplete_expired';
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'canceled';
    pruneStripeKeys();
    const r = await codeOf(buy(svc, KEY1));
    expect(r.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect(stripe._subs.size).toBe(1);
    expect(prisma._purchases[0].status).toBe('expired');
  });
});

describe('B-654-8 an attempt is never ended while its subscription may still charge', () => {
  const reprice = (prisma: any) =>
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });

  it('(failed before) same key, terms changed, the cancel fails: PAYMENT_RETRY and the attempt stays open; the retry cancels, then terms_changed', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    reprice(prisma);
    stripe.cancelSubscription.mockRejectedValueOnce(unavailable());
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('PAYMENT_RETRY');
    expect(prisma._purchases[0].status).toBe('pending');
    expect(stripe._subs.get('sub_1').status).toBe('incomplete');
    const again = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(again.body).toEqual(expect.objectContaining({ reason: 'terms_changed' }));
    expect(stripe._subs.get('sub_1').status).toBe('canceled');
    expect(prisma._purchases[0].status).toBe('expired');
  });

  it('(failed before) uncertain create, terms changed, the cancel fails: retryable, never expired', async () => {
    const { svc, stripe, prisma, createThenTimeout } = setup();
    createThenTimeout();
    await codeOf(buy(svc, KEY1));
    reprice(prisma);
    stripe.cancelSubscription.mockRejectedValueOnce(unavailable());
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.body.code).toBe('PAYMENT_RETRY');
    expect(prisma._purchases[0].status).toBe('pending');
    expect(prisma._purchases[0].stripe_checkout_session_id).toMatch(/^sub-retry-/);
    const again = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(again.body).toEqual(expect.objectContaining({ reason: 'terms_changed' }));
    expect(stripe._subs.get('sub_1').status).toBe('canceled');
  });

  it('(failed before) a new key while the stale attempt cannot be canceled: no second subscription is minted', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    reprice(prisma);
    stripe.cancelSubscription.mockRejectedValueOnce(unavailable());
    const r = await codeOf(buy(svc, KEY2, { expected_amount_cents: 5900 }));
    expect(r.body.code).toBe('PAYMENT_RETRY');
    expect(stripe._subs.size).toBe(1);
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0].status).toBe('pending');
    const out = await buy(svc, KEY2, { expected_amount_cents: 5900 });
    expect(out.subscription_id).toBe('sub_2');
    expect(stripe._subs.get('sub_1').status).toBe('canceled');
  });

  it('(failed before) an open attempt whose subscription is past_due on Stripe is the plan: ALREADY_ACTIVE, never expired', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    stripe._subs.get('sub_1').status = 'past_due';
    const r = await codeOf(buy(svc, KEY2));
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(stripe._subs.size).toBe(1);
    expect(prisma._purchases[0].status).toBe('pending');
  });

  it('(failed before) no sheet and the cancel fails: SETUP_UNAVAILABLE without ending it; the same key cancels, then ends it', async () => {
    const { svc, stripe, prisma } = setup();
    const realCreate = stripe.createSubscription.getMockImplementation();
    stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      const sub = await realCreate(a);
      sub.latest_invoice = { id: 'in_1', amount_due: 4900, status: 'open', payment_intent: null };
      return sub;
    });
    stripe.cancelSubscription.mockRejectedValueOnce(unavailable());
    const r = await codeOf(buy(svc, KEY1));
    expect(r.body.code).toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
    expect(prisma._purchases[0].status).toBe('pending');
    expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
    const again = await codeOf(buy(svc, KEY1));
    expect(again.body.code).toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
    expect(stripe._subs.get('sub_1').status).toBe('canceled');
    expect(prisma._purchases[0].status).toBe('expired');
  });

  it('control: the cancel answer is lost after Stripe canceled it: reconciled from Stripe, the attempt ends', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    reprice(prisma);
    stripe.cancelSubscription.mockImplementationOnce(async (id: string) => {
      stripe._subs.get(id).status = 'canceled';
      throw unavailable();
    });
    const r = await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
    expect(r.body).toEqual(expect.objectContaining({ reason: 'terms_changed' }));
    expect(prisma._purchases[0].status).toBe('expired');
  });
});

describe('B-654-9 / C-654-10 a caught error reaches logs only as an allow-listed label', () => {
  async function loggedAfterStateRead(err: unknown): Promise<string> {
    const { svc, stripe } = setup();
    const out = await buy(svc, KEY1);
    const logs = spyLogs();
    try {
      stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(err);
      const view: Record<string, unknown> = { ...(await svc.getPlan(CLIENT, out.purchase_id)) };
      expect(view.checkout_state).toBe('unknown');
      return logs.text();
    } finally {
      logs.restore();
    }
  }

  it('(failed before) an Error whose name was set from data logs a fixed label', async () => {
    const err = new Error('boom');
    err.name = `client ${CANARY}`;
    const logged = await loggedAfterStateRead(err);
    expect(logged).not.toContain(CANARY);
    expect(logged).toContain('error=error');
  });

  it('(failed before) an identifier-shaped code outside the allow-list is never logged', async () => {
    const logged = await loggedAfterStateRead(
      Object.assign(new Error('boom'), { code: 'a.person-example.test' }),
    );
    expect(logged).not.toContain('a.person-example.test');
  });

  it('(failed before) a Stripe error with an unknown code and type logs only allow-listed parts', async () => {
    const logged = await loggedAfterStateRead(
      new StripeConnectApiError('m', 400, 'cus_canary.value', 'canary_type'),
    );
    expect(logged).not.toContain('canary');
    expect(logged).toContain('error=stripe:other:400:other');
  });

  it('controls: known Stripe, Prisma and network codes and class names stay readable', async () => {
    expect(
      await loggedAfterStateRead(
        new StripeConnectApiError('m', 404, 'resource_missing', 'invalid_request_error'),
      ),
    ).toContain('error=stripe:invalid_request_error:404:resource_missing');
    expect(
      await loggedAfterStateRead(Object.assign(new Error(CANARY), { code: 'P2002' })),
    ).toContain('error=P2002');
    expect(
      await loggedAfterStateRead(Object.assign(new Error(CANARY), { code: 'ECONNRESET' })),
    ).toContain('error=ECONNRESET');
    const typeError = await loggedAfterStateRead(new TypeError(CANARY));
    expect(typeError).toContain('error=TypeError');
    expect(typeError).not.toContain(CANARY);
  });

  it('(failed before) a same-key replay whose Stripe check fails logs no message', async () => {
    const { svc, stripe } = setup();
    await buy(svc, KEY1);
    const logs = spyLogs();
    try {
      stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(
        new Error(`No such customer for ${CANARY}`),
      );
      await buy(svc, KEY1);
      expect(logs.text()).toContain('replay secret check skipped');
      expect(logs.text()).not.toContain(CANARY);
    } finally {
      logs.restore();
    }
  });

  it('(failed before) a failed stale-trial cleanup logs no message', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await buy(svc, KEY1);
    prisma._purchases[0].created_at = new Date(Date.now() - HOURS_25);
    const logs = spyLogs();
    try {
      stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(new Error(`for ${CANARY}`));
      const out = await buy(svc, KEY2);
      // B-679-1: the open attempt is reused at any age (no second subscription).
      expect(out.subscription_id).toBe('sub_1');
      expect(logs.text()).toContain('stale trial attempt kept');
      expect(logs.text()).not.toContain(CANARY);
    } finally {
      logs.restore();
    }
  });

  it('(failed before) a failed cancel logs no message', async () => {
    const { svc, stripe, prisma } = setup();
    await buy(svc, KEY1);
    Object.assign(prisma._packages[0], { amount_cents: 5900, stripe_price_id: 'price_rec_5900' });
    const logs = spyLogs();
    try {
      stripe.cancelSubscription.mockRejectedValueOnce(new Error(`for ${CANARY}`));
      await codeOf(buy(svc, KEY1, { expected_amount_cents: 5900 }));
      expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
      expect(logs.text()).toContain('sub_1');
      expect(logs.text()).not.toContain(CANARY);
    } finally {
      logs.restore();
    }
  });

  it('(failed before) webhook: a failed setup_intent.succeeded lookup logs no message', async () => {
    const prisma = makeFakePrisma();
    const stub: any = {
      retrieveSubscriptionForCheckout: jest.fn(),
      onChargeSucceeded: jest.fn(),
      recordFailure: jest.fn(),
      onPurchaseEntitled: jest.fn(),
    };
    const handler = new CheckoutWebhookHandlerService(prisma, stub, stub, stub, undefined, stub);
    prisma.clientPurchase.findFirst.mockRejectedValueOnce(new Error(`reset for ${CANARY}`));
    const logs = spyLogs();
    try {
      const ev = {
        id: 'evt_canary',
        type: 'setup_intent.succeeded',
        data: { object: { id: 'seti_T1', status: 'succeeded', payment_method: 'pm_card' } },
      };
      const pre = await handler.prefetchForOuterTx(ev);
      await expect(handler.handle(ev, prisma, pre)).rejects.toThrow();
      expect(logs.text()).toContain('setup_intent.succeeded lookup failed');
      expect(logs.text()).not.toContain(CANARY);
    } finally {
      logs.restore();
    }
  });
});
