// AUD-OPUS-R12-117 (lens Claude Opus 5.5) — independent probes of #679 @ f48fa8f0.
// Audit-only spec (never merged). Synthetic stateful doubles; no real Stripe.
// Cases marked (should fail at head) encode the correct behaviour and prove a
// finding by failing; (control) and (evidence) cases pass at the head.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD = 25 * 3600 * 1000;

function setup(over: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  const checkout: any = makeCheckoutHelpers(prisma);
  prisma._users.push(
    { id: CLIENT, email: 'synthetic@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
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

async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (error) {
    if (error instanceof HttpException) return { body: error.getResponse(), status: error.getStatus() };
    return { error };
  }
}

const intent = (svc: SubscriptionCheckoutService, key: string) =>
  svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: key });
const timeout = () =>
  new StripeConnectApiError('synthetic lost response', 503, 'request_timeout', 'api_connection_error');
const ENDED = new Set(['canceled', 'incomplete_expired']);
const liveSubs = (stripe: any) =>
  [...stripe._subs.values()].filter((s: any) => !ENDED.has(s.status)).map((s: any) => s.id);

function ageFirstRow(prisma: any) {
  Object.assign(prisma._purchases[0], {
    created_at: new Date(Date.now() - OLD),
    updated_at: new Date(Date.now() - OLD),
  });
}

describe('P1 — a canceled trial SetupIntent is treated as proof the attempt ended', () => {
  // Path: an abandoned trial attempt (card never saved) is retired 25 h later
  // by a NEW key; C-679-1's guard cancels its SetupIntent, then the DELETE
  // fails (one Stripe failure). The row stays open (correct). Later the
  // ORIGINAL key replays: replaySecretState reads the canceled SetupIntent as
  // 'dead' and expires the row although the trial subscription is still live.
  async function drive(deleteFails: boolean) {
    const f = setup({ trial_days: 7 });
    await intent(f.svc, KEY1); // sub_1 trialing, seti_1 stored, card never saved
    ageFirstRow(f.prisma);
    if (deleteFails) f.stripe.cancelSubscription.mockRejectedValue(timeout());
    const second = await resultOf(intent(f.svc, KEY2));
    const afterSecond = {
      status: second.status,
      row: f.prisma._purchases[0].status,
      sub1: f.stripe._subs.get('sub_1').status,
      seti1: f.stripe._setups.get('seti_1').status,
    };
    const replay = await resultOf(intent(f.svc, KEY1));
    const afterReplay = {
      status: replay.status,
      code: replay.body?.code,
      message: replay.body?.message,
      row: f.prisma._purchases[0].status,
      sub1: f.stripe._subs.get('sub_1').status,
    };
    const third = await resultOf(intent(f.svc, KEY3));
    return { f, afterSecond, afterReplay, third, live: liveSubs(f.stripe) };
  }

  it('(should fail at head) the row never ends while its trial subscription is still live', async () => {
    const { afterSecond, afterReplay } = await drive(true);
    // eslint-disable-next-line no-console
    console.log('P1 trace', JSON.stringify({ afterSecond, afterReplay }));
    expect(afterSecond.seti1).toBe('canceled');
    expect(afterSecond.sub1).toBe('trialing');
    expect(afterSecond.row).not.toBe('expired');
    if (afterReplay.row === 'expired' || afterReplay.row === 'canceled') {
      expect(ENDED.has(afterReplay.sub1)).toBe(true);
    }
  });

  it('(should fail at head) no "Nothing was charged" answer while the trial subscription is live', async () => {
    const { afterReplay } = await drive(true);
    if (afterReplay.sub1 === 'trialing') {
      expect(String(afterReplay.message ?? '')).not.toMatch(/nothing was charged/i);
    }
  });

  it('(should fail at head) a new key never starts a second live subscription for the same plan', async () => {
    const { live, third } = await drive(true);
    // eslint-disable-next-line no-console
    console.log('P1 live subs', JSON.stringify({ live, third: third.value?.subscription_id ?? third.body?.code }));
    expect(live.length).toBeLessThanOrEqual(1);
  });

  it('(control) when the DELETE succeeds the attempt ends with its subscription', async () => {
    const { afterSecond } = await drive(false);
    expect(afterSecond.sub1).toBe('canceled');
    expect(afterSecond.row).toBe('expired');
  });
});

describe('P2 — an abandoned trial attempt is left to Stripe trial-end rules', () => {
  // Stripe (docs.stripe.com/billing/subscriptions/trials/free-trials): "We check
  // default_source and default_payment_method on the subscription and customer
  // to determine whether a subscription is missing a payment method at the end
  // of a trial." The customer portal sets customer.invoice_settings.
  // default_payment_method (docs.stripe.com/customer-management/portal-deep-links).
  // Model of Stripe's documented trial-end outcome:
  function trialEndOutcome(
    createArgs: Record<string, unknown>,
    sub: any,
    customerDefaultPm: string | null,
  ): 'charged' | 'canceled' {
    if (ENDED.has(sub.status)) return 'canceled';
    const endsAtTrialEnd =
      createArgs.cancelAtPeriodEnd === true || typeof createArgs.cancelAt === 'number';
    if (endsAtTrialEnd || sub.cancel_at_period_end === true) return 'canceled';
    if (sub.default_payment_method || customerDefaultPm) return 'charged';
    return 'canceled'; // missing_payment_method=cancel
  }

  it('(evidence, passes at head) the trial create carries only missing_payment_method=cancel', async () => {
    class Recording extends StripeConnectApiService {
      bodies: string[] = [];
      protected fetchImpl: typeof fetch = async (_input: any, init: any) => {
        this.bodies.push(String(init.body ?? ''));
        return new Response(JSON.stringify({ id: 'sub_x', status: 'trialing' }), { status: 200 });
      };
    }
    const prev = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    try {
      const api = new Recording();
      await api.createSubscription({
        customer: 'cus_A',
        recurringPriceId: 'price_A',
        onBehalfOf: 'acct_coach',
        trialPeriodDays: 7,
        idempotencyKey: 'tgp-k',
      });
      const form = decodeURIComponent(api.bodies[0]);
      // eslint-disable-next-line no-console
      console.log('P2 trial create form', form);
      expect(form).toContain('trial_settings[end_behavior][missing_payment_method]=cancel');
      expect(form).not.toMatch(/cancel_at/);
    } finally {
      process.env.STRIPE_SECRET_KEY = prev;
    }
  });

  it('(should fail at head) an abandoned trial attempt never charges the customer default card at trial end', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc, KEY1); // the client opens the setup sheet, then leaves
    expect(out.mode).toBe('setup');
    // Every read the app makes afterwards (plan list, plan read) and nothing else.
    await f.svc.listPlans(CLIENT);
    await resultOf(f.svc.getPlan(CLIENT, out.purchase_id));
    const createArgs = f.stripe.createSubscription.mock.calls[0][0];
    const sub = f.stripe._subs.get(out.subscription_id);
    // eslint-disable-next-line no-console
    console.log('P2 abandoned', JSON.stringify({ sub: sub.status, args: Object.keys(createArgs) }));
    // The client once updated a card in the billing portal (main: POST
    // /v1/checkout/billing-portal -> customer default payment method).
    expect(trialEndOutcome(createArgs, sub, 'pm_portal_default')).not.toBe('charged');
  });

  it('(control) without a customer default card the trial cancels at trial end', async () => {
    const f = setup({ trial_days: 7 });
    const out = await intent(f.svc, KEY1);
    const createArgs = f.stripe.createSubscription.mock.calls[0][0];
    expect(trialEndOutcome(createArgs, f.stripe._subs.get(out.subscription_id), null)).toBe('canceled');
  });
});

describe('P3 — an attempt whose subscription Stripe no longer has blocks the plan at any age', () => {
  it('(should fail at head) resource_missing on the attempt subscription lets a new key start the plan (25 h old)', async () => {
    const f = setup();
    await intent(f.svc, KEY1);
    ageFirstRow(f.prisma);
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(
      new StripeConnectApiError('No such subscription', 404, 'resource_missing', 'invalid_request_error'),
    );
    const out = await resultOf(intent(f.svc, KEY2));
    // eslint-disable-next-line no-console
    console.log('P3', JSON.stringify({ status: out.status, code: out.body?.code, row: f.prisma._purchases[0].status }));
    expect(out.value?.subscription_id).toBeTruthy();
  });
});
