// B-RECUR-BE fix round 1 (agent 114) — the card a native trial saves, and
// the two audit Cs on reuse / replay. Every case marked (failed before)
// failed at 486164688 src:
//   B-654-1 a trial started only if Stripe itself set the subscription's
//           default card after the SetupIntent. Stripe does not promise that
//           for a $0 trial, and nulls `pending_setup_intent` once the
//           SetupIntent succeeds, so: no webhook set the default, the plan
//           read backstop could not see the card, and both the stale-trial
//           cleanup and the open-attempt reuse CANCELED a trial whose card
//           was saved;
//   C-654-2 an open trial attempt was reused after the coach changed or
//           removed the trial;
//   C-654-3 a same-key replay handed back a spent SetupIntent / PaymentIntent
//           secret.
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { setupIntentIdOf } from '../src/checkout/trial-card';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOUR = 3600 * 1000;
const DAY = 86400;

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
      head_coach_id: null,
    })),
  };
  const checkout: any = helpers;
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, state, feePolicy, checkout);
  return { prisma, stripe, svc };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err: any) {
    return { status: err.getStatus?.(), body: err.getResponse?.() };
  }
  throw new Error('expected a coded error');
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});

describe('setupIntentIdOf', () => {
  it('reads the SetupIntent id from its client secret only', () => {
    expect(setupIntentIdOf('seti_1Abc_secret_xyz')).toBe('seti_1Abc');
    expect(setupIntentIdOf('pi_1Abc_secret_xyz')).toBeNull();
    expect(setupIntentIdOf(null)).toBeNull();
  });
});

describe('B-654-1 setup_intent.succeeded makes the saved card the default', () => {
  function webhookSetup(rowOver: Record<string, unknown> = {}) {
    const prisma = makeFakePrisma();
    prisma._purchases.push({
      id: 'cp_trial',
      client_user_id: 'client',
      coach_user_id: 'coach',
      package_id: 'pkg',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      stripe_checkout_session_id: 'sub_t',
      stripe_subscription_id: 'sub_t',
      stripe_customer_id: 'cus_1',
      stripe_client_secret: 'seti_T1_secret_abc',
      status: 'trialing',
      entitlement_active: false,
      trial_days: 7,
      trial_started_at: null,
      idempotency_key: 'sub-client-k',
      created_at: new Date(),
      ...rowOver,
    });
    const liveSub = {
      id: 'sub_t',
      status: 'trialing',
      default_payment_method: null as string | null,
      pending_setup_intent: null,
      current_period_end: Math.floor(Date.now() / 1000) + 7 * DAY,
    };
    const stripe: any = {
      retrieveSubscription: jest.fn(),
      retrieveSubscriptionForCheckout: jest.fn(async () => liveSub),
      setSubscriptionDefaultPaymentMethod: jest.fn(async (a: any) => {
        liveSub.default_payment_method = a.paymentMethodId;
        return liveSub;
      }),
    };
    const fanout: any = {
      onPurchaseEntitled: jest.fn(async () => undefined),
      cancelPendingForPurchase: jest.fn(async () => 0),
    };
    const splits: any = { onChargeSucceeded: jest.fn() };
    const dunning: any = {
      recordFailure: jest.fn(),
      recordResolution: jest.fn(async () => null),
      terminate: jest.fn(),
    };
    const svc = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout);
    return { svc, prisma, stripe, liveSub, row: () => prisma._purchases[0] };
  }
  const siEvent = (over: Record<string, unknown> = {}) => ({
    id: `evt_${Math.random()}`,
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: 'seti_T1',
        status: 'succeeded',
        payment_method: 'pm_card',
        customer: 'cus_1',
        ...over,
      },
    },
  });

  it('(failed before) sets default_payment_method out-of-tx, idempotently; the next subscription.updated grants the trial', async () => {
    const { svc, prisma, stripe, liveSub, row } = webhookSetup();
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith({
      subscriptionId: 'sub_t',
      paymentMethodId: 'pm_card',
      idempotencyKey: 'tgp-trial-card-sub_t-pm_card',
    });
    const r = await svc.handle(ev, prisma, pre);
    expect(r.claimed).toBe(true);
    // Stripe's answer to the write: customer.subscription.updated with the default.
    await svc.handle(
      { id: 'evt_su', type: 'customer.subscription.updated', data: { object: { ...liveSub } } },
      prisma,
    );
    expect(row().entitlement_active).toBe(true);
    expect(row().trial_started_at).toBeInstanceOf(Date);
  });

  it('(failed before) a failed Stripe write throws in handle so Stripe redelivers', async () => {
    const { svc, prisma, stripe } = webhookSetup();
    stripe.setSubscriptionDefaultPaymentMethod.mockRejectedValueOnce(new Error('stripe down'));
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    await expect(svc.handle(ev, prisma, pre)).rejects.toThrow(/redeliver/);
  });

  it('a SetupIntent that is not a native trial attempt is not claimed and writes nothing', async () => {
    const { svc, prisma, stripe } = webhookSetup();
    const ev = siEvent({ id: 'seti_OTHER' });
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(false);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it("another customer's SetupIntent never touches the attempt", async () => {
    const { svc, prisma, stripe } = webhookSetup();
    const ev = siEvent({ customer: 'cus_other' });
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(false);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('an already granted trial is claimed without another Stripe write', async () => {
    const { svc, prisma, stripe } = webhookSetup({
      entitlement_active: true,
      trial_started_at: new Date(),
    });
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(true);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});

describe('B-654-1 checkout paths read the SetupIntent itself', () => {
  it('(failed before) plan read backstop: card saved, pending_setup_intent already null -> default set', async () => {
    const { svc, stripe } = setup({ trial_days: 7 });
    const out = await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._saveTrialCard('sub_1', 'pm_card');
    const view = await svc.getPlan(CLIENT, out.purchase_id);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', paymentMethodId: 'pm_card' }),
    );
    expect(view.entitlement_active).toBe(false);
  });

  it('(failed before) stale-trial cleanup never cancels a trial whose card was saved; it sets the default and answers ALREADY_ACTIVE', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const row = prisma._purchases[0];
    row.status = 'trialing';
    row.created_at = new Date(Date.now() - 30 * HOUR);
    stripe._saveTrialCard('sub_1', 'pm_card');
    const r = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    );
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(r.body.purchase_id).toBe(row.id);
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', paymentMethodId: 'pm_card' }),
    );
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('trialing');
  });

  it('stale-trial cleanup still cancels a trial whose SetupIntent never got a card', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const row = prisma._purchases[0];
    row.created_at = new Date(Date.now() - 30 * HOUR);
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 });
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(row.status).toBe('expired');
  });

  it('stale-trial cleanup keeps a trial whose SetupIntent cannot be read', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const row = prisma._purchases[0];
    row.created_at = new Date(Date.now() - 30 * HOUR);
    stripe._subs.get('sub_1').pending_setup_intent = null;
    stripe.retrieveSetupIntent.mockRejectedValueOnce(new Error('stripe down'));
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 });
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith('sub_1');
    expect(row.status).not.toBe('expired');
  });

  it('(failed before) reuse of an open trial whose card was saved: no cancel, no second subscription, ALREADY_ACTIVE', async () => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    prisma._purchases[0].status = 'trialing';
    stripe._saveTrialCard('sub_1', 'pm_card');
    const r = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY2 }),
    );
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
  });
});

describe('C-654-2 reuse re-checks the trial', () => {
  it.each([
    ['changed', 14],
    ['removed', 0],
  ])('(failed before) trial %s by the coach -> old attempt retired, new one minted with the current trial', async (_n, days) => {
    const { svc, stripe, prisma } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    prisma._packages[0].trial_days = days;
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(out.reused).toBe(false);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(stripe.createSubscription).toHaveBeenCalledTimes(2);
    expect(stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBe(days || undefined);
  });

  it('an unchanged trial is still reused', async () => {
    const { svc, stripe } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const out = await svc.createSubscriptionIntent(CLIENT, {
      package_id: PKG,
      idempotency_key: KEY2,
    });
    expect(out.reused).toBe(true);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('C-654-3 a same-key replay never returns a spent secret', () => {
  it('(failed before) SetupIntent succeeded before the webhook -> ALREADY_ACTIVE, default set', async () => {
    const { svc, stripe } = setup({ trial_days: 7 });
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._saveTrialCard('sub_1', 'pm_card');
    const r = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(JSON.stringify(r.body)).not.toMatch(/seti_/);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
  });

  it('(failed before) first invoice PaymentIntent succeeded before the webhook -> ALREADY_ACTIVE', async () => {
    const { svc, stripe } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'succeeded';
    const r = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(r.body.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(JSON.stringify(r.body)).not.toMatch(/pi_/);
  });

  it('(failed before) a canceled intent -> SUBSCRIPTION_ATTEMPT_EXPIRED', async () => {
    const { svc, stripe } = setup();
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    stripe._subs.get('sub_1').latest_invoice.payment_intent.status = 'canceled';
    const r = await codeOf(
      svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
  });

  it('a still-payable attempt replays the same secret; a Stripe read error keeps the old answer', async () => {
    const { svc, stripe } = setup();
    const first = await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    const again = await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(again.client_secret).toBe(first.client_secret);
    stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(new Error('stripe down'));
    const third = await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(third.client_secret).toBe(first.client_secret);
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});
