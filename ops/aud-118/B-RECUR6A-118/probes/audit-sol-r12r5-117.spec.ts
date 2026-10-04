// AUD-SOL-R12R5-117: independent acceptance probes at #679 6760ee6a.
// Synthetic provider/DB state; no live payment operation.
import { HttpException } from '@nestjs/common';
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(trialDays = 0) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  prisma._users.push(
    { id: CLIENT, email: 'client@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
    id: PKG, coach_id: COACH, name: 'Plan', amount_cents: 4900, currency: 'usd',
    billing_type: 'recurring', interval: 'month', interval_count: 1,
    stripe_price_id: 'price_plan', recurring_amount_cents: null, recurring_interval: null,
    recurring_interval_count: null, recurring_stripe_price_id: null,
    is_active: true, published_at: new Date('2026-09-01'), archived_at: null,
    trial_days: trialDays,
  });
  prisma._accounts.push({
    coach_user_id: COACH, stripe_account_id: 'acct_coach',
    charges_enabled: true, deauthorized_at: null,
  });
  const packages: any = {
    getById: async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null,
  };
  const svc = new SubscriptionCheckoutService(
    prisma, stripe, packages, { ready: true } as any,
    { planFor: async () => ({ head_coach_id: null }) } as any,
    makeCheckoutHelpers(prisma) as any,
  );
  return { prisma, stripe, svc };
}
async function resultOf(p: Promise<unknown>): Promise<any> {
  try { return { value: await p }; }
  catch (err) {
    if (err instanceof HttpException) return { body: err.getResponse(), status: err.getStatus() };
    throw err;
  }
}
const intent = (f: ReturnType<typeof setup>, key = KEY1) =>
  f.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: key });
const timeout = () => new StripeConnectApiError(
  'synthetic unconfirmed request', 503, 'request_timeout', 'api_connection_error',
);
const liveSubs = (f: ReturnType<typeof setup>) =>
  [...f.stripe._subs.values()].filter((s: any) => !['canceled', 'incomplete_expired'].includes(s.status));

beforeAll(() => { process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic'; });

describe('Sol B-679-7: the pre-send claim must coordinate with account deletion', () => {
  it('acceptance: deletion after the claim commits but before its reply prevents a later charge', async () => {
    const f = setup();
    const write = f.prisma.clientPurchase.updateMany.getMockImplementation();
    const collect = new AccountDeletionBillingService({} as any);
    let deleted = false;
    let collected: string[] = [];
    f.prisma.clientPurchase.updateMany.mockImplementation(async (args: any) => {
      const result = await write(args);
      if (
        !deleted && args.where.status === 'pending' &&
        args.where.stripe_subscription_id === null &&
        String(args.data.stripe_checkout_session_id).startsWith('sub-reserved-')
      ) {
        // The UPDATE has committed, but its response is delayed. The actual
        // billing collector sees no bound id, and does not inspect the marker.
        collected = await collect.collectSubscriptionIds({
          clientPurchase: f.prisma.clientPurchase,
          coachSubscription: { findMany: async () => [] },
          guestCheckout: { findMany: async () => [] },
        } as any, CLIENT);
        expect(collected).toEqual([]);
        // The manifest's documented terminal/de-identified purchase projection.
        Object.assign(f.prisma._purchases[0], {
          client_user_id: '__deleted_user_sentinel__', status: 'canceled',
          entitlement_active: false, stripe_client_secret: null, stripe_ephemeral_key: null,
        });
        deleted = true;
      }
      return result;
    });
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementation(async (args: any) => {
      expect(deleted).toBe(true);
      const sub = await create(args);
      Object.assign(sub, { status: 'active' });
      sub.latest_invoice.status = 'paid';
      sub.latest_invoice.payment_intent.status = 'succeeded';
      return structuredClone(sub);
    });
    const out = await resultOf(intent(f));
    // A post-deletion send is forbidden, even if the fallback later records its id.
    expect({ creates: f.stripe.createSubscription.mock.calls.length, collected, deleted })
      .toEqual({ creates: 0, collected: [], deleted: true });
    expect(out.body?.code).not.toBe('PAYMENT_RETRY');
  });

  it('control: an open attempt still creates exactly one subscription', async () => {
    const f = setup();
    expect((await intent(f)).mode).toBe('payment');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('Sol B-679-8: unresolved rejected-bind cleanup must retain admission exclusion', () => {
  function closeBeforeBind(f: ReturnType<typeof setup>) {
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
      const sub = await create(args);
      sub.latest_invoice.status = 'open';
      return structuredClone(sub);
    });
    const write = f.prisma.clientPurchase.updateMany.getMockImplementation();
    let once = false;
    f.prisma.clientPurchase.updateMany.mockImplementation(async (args: any) => {
      if (!once && args.data.stripe_subscription_id && args.data.stripe_checkout_session_id) {
        once = true;
        Object.assign(f.prisma._purchases[0], { status: 'expired' });
      }
      return write(args);
    });
  }

  it('acceptance: cleanup unknown on a closed row never permits a second payable subscription', async () => {
    const f = setup();
    closeBeforeBind(f);
    f.stripe.voidInvoice.mockRejectedValueOnce(timeout());
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(timeout());
    const first = await resultOf(intent(f));
    expect(first.body?.code).toBe('PAYMENT_RETRY');
    expect(f.prisma._purchases[0].stripe_subscription_id).toBe('sub_1');
    expect(f.stripe._subs.get('sub_1').status).toBe('incomplete');
    const next = await resultOf(intent(f, KEY2));
    expect({
      live: liveSubs(f).map((s: any) => s.id),
      creates: f.stripe.createSubscription.mock.calls.length,
      nextSubscription: next.value?.subscription_id,
    }).toEqual({ live: ['sub_1'], creates: 1, nextSubscription: undefined });
  });

  it('control: confirmed guarded cleanup allows a fresh key after the old subscription ends', async () => {
    const f = setup();
    closeBeforeBind(f);
    const first = await resultOf(intent(f));
    expect(first.body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    const next = await intent(f, KEY2);
    expect(next.subscription_id).toBe('sub_2');
    expect(liveSubs(f).map((s: any) => s.id)).toEqual(['sub_2']);
  });
});

describe('Native trial acceptance: the provider may return pending_setup_intent=null', () => {
  // https://docs.stripe.com/billing/subscriptions/deferred-payment:
  // if authentication/authorization succeed or are not required, it is null.
  it.each([null, 'pm_customer_default'])(
    'acceptance: a new eligible trial still collects its own consent/card when setup is null, sub default=%s',
    async (defaultPaymentMethod) => {
      const f = setup(7);
      const create = f.stripe.createSubscription.getMockImplementation();
      f.stripe.createSubscription.mockImplementationOnce(async (args: any) => {
        const sub = await create(args);
        Object.assign(sub, { pending_setup_intent: null, default_payment_method: defaultPaymentMethod });
        return structuredClone(sub);
      });
      const out = await resultOf(intent(f));
      expect({
        mode: out.value?.mode,
        trialDays: out.value?.plan.trial_days,
        error: out.body?.code,
      }).toEqual({ mode: 'setup', trialDays: 7, error: undefined });
    },
  );

  it('control: the ordinary own-SetupIntent path saves its card and lifts the trial end', async () => {
    const f = setup(7);
    const out = await intent(f);
    expect(out.mode).toBe('setup');
    expect(f.stripe._subs.get(out.subscription_id).cancel_at_period_end).toBe(true);
    f.stripe._saveTrialCard(out.subscription_id, 'pm_own');
    const view = await f.svc.getPlan(CLIENT, out.purchase_id);
    expect(view.checkout_state).toBe('card_saved');
    expect(f.stripe._subs.get(out.subscription_id).cancel_at_period_end).toBe(false);
    expect(f.stripe._subs.get(out.subscription_id).default_payment_method).toBe('pm_own');
  });
});

describe('C-679-3 follow-up: same-key trial replay after provider resource absence', () => {
  it('acceptance: a missing trial and SetupIntent never return their stored dead sheet secret', async () => {
    const f = setup(7);
    await intent(f);
    const missing = () => new StripeConnectApiError(
      'No such synthetic provider object', 404, 'resource_missing', 'invalid_request_error',
    );
    f.stripe.retrieveSetupIntent.mockRejectedValue(missing());
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValue(missing());
    const out = await resultOf(intent(f));
    expect({ error: out.body?.code, returnedSecret: out.value?.client_secret })
      .toEqual({ error: 'SUBSCRIPTION_ATTEMPT_EXPIRED', returnedSecret: undefined });
  });
});
