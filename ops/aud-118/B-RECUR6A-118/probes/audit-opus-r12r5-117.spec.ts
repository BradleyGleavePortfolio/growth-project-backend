// AUD-OPUS-R12R5-117 (Opus lens, agent 117) — probes at #679 6760ee6a (R1 #678 b04ea692 inside).
// Synthetic stateful doubles only (test/support/b-recur-fakes.ts) plus the real Stripe client with
// HTTP recorded. "(should fail at head)" cases encode the acceptance rule; "evidence" cases pin the
// exact head behavior and pass.
import { HttpException } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup() {
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
    trial_days: 7,
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
type F = ReturnType<typeof setup>;

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

/**
 * Stripe (docs.stripe.com/billing/subscriptions/deferred-payment): "Stripe automatically creates
 * SetupIntents for subscriptions that don't require an initial payment. The authentication and
 * authorization process also completes at this point, if required. If both succeed or aren't
 * required, ... the subscription.pending_setup_intent field is null." A customer whose
 * invoice_settings.default_payment_method is set (billing portal; dunning D3 #689
 * setCustomerDefaultPaymentMethod) is set up off-session at create: no pending_setup_intent.
 * `alsoSubDefault` models the variant where Stripe also writes the subscription default.
 */
function customerHasDefaultCard(f: F, alsoSubDefault: boolean) {
  const orig = f.stripe.createSubscription.getMockImplementation();
  f.stripe.createSubscription.mockImplementation(async (args: any) => {
    const sub = await orig(args);
    if ((args.trialPeriodDays ?? 0) > 0 && sub.pending_setup_intent) {
      const si = f.stripe._setups.get(sub.pending_setup_intent.id);
      if (si) Object.assign(si, { status: 'succeeded', payment_method: 'pm_customer_default' });
      sub.pending_setup_intent = null;
      if (alsoSubDefault) sub.default_payment_method = 'pm_customer_default';
    }
    return sub;
  });
}

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});
afterEach(() => jest.restoreAllMocks());

describe('Opus B-679-10 a client whose customer already has a default card and a trial package', () => {
  it('(should fail at head) can start the plan: no SETUP_UNAVAILABLE on a first or a later attempt', async () => {
    const f = setup();
    customerHasDefaultCard(f, false);
    const first = await resultOf(intent(f.svc, KEY1));
    const second = await resultOf(intent(f.svc, KEY2));
    expect(first.body?.code).not.toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
    expect(second.body?.code).not.toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
  });

  it('evidence: every attempt is canceled with SETUP_UNAVAILABLE "Try again in a minute"; the trial is re-offered each time', async () => {
    const f = setup();
    customerHasDefaultCard(f, false);
    const first = await resultOf(intent(f.svc, KEY1));
    const second = await resultOf(intent(f.svc, KEY2));
    for (const r of [first, second]) {
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('SUBSCRIPTION_SETUP_UNAVAILABLE');
      expect(String(r.body.message)).toMatch(/Try again in a minute/);
    }
    expect([...f.stripe._subs.values()].map((s: any) => s.status)).toEqual(['canceled', 'canceled']);
    expect(f.prisma._purchases.map((p: any) => [p.status, p.trial_days])).toEqual([
      ['expired', 7],
      ['expired', 7],
    ]);
  });

  it('evidence (variant: Stripe also sets the subscription default): the app is told the plan needs no sheet, yet the trial still ends at trial end and nothing lifts it', async () => {
    const f = setup();
    customerHasDefaultCard(f, true);
    const first = await resultOf(intent(f.svc, KEY1));
    expect(first.value?.mode).toBe('none');
    const plan = await f.svc.getPlan(CLIENT, first.value.purchase_id);
    const sub = f.stripe._subs.get(first.value.subscription_id);
    expect(sub.cancel_at_period_end).toBe(true);
    expect(plan.checkout_state).toBe('unknown');
    expect(f.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});

class Recording extends StripeConnectApiService {
  forms: string[] = [];
  protected fetchImpl: typeof fetch = async (_input: any, init: any) => {
    this.forms.push(decodeURIComponent(String(init?.body ?? '')));
    return new Response(JSON.stringify({ id: 'sub_paid', status: 'active' }), { status: 200 });
  };
}

describe('Opus B-678-2 the generic default-card update carries the trial-end lift', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  // Dunning D3 #689 (client-billing.service.ts:513 @ bb992fed) calls setSubscriptionDefaultPaymentMethod
  // for EVERY live subscription on an in-app card update; D1 #687 adds a same-named method that sends
  // only default_payment_method. Shown here: R1's method on a PAID plan the client set to cancel.
  it('(should fail at head) a default-card update on a paid plan never touches cancel_at_period_end', async () => {
    const api = new Recording();
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_paid',
      paymentMethodId: 'pm_new',
      idempotencyKey: 'tgp-card-default-sub-sub_paid-seti_x',
    });
    expect(api.forms[0]).toContain('default_payment_method=pm_new');
    expect(api.forms[0]).not.toContain('cancel_at_period_end');
  });

  it('evidence: the request sent is default_payment_method + cancel_at_period_end=false', async () => {
    const api = new Recording();
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_paid',
      paymentMethodId: 'pm_new',
      idempotencyKey: 'k',
    });
    expect(api.forms).toEqual([
      expect.stringMatching(/^(?=.*default_payment_method=pm_new)(?=.*cancel_at_period_end=false)/),
    ]);
  });
});
