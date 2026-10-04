// B-RECUR6A-118 fix round 6 (#679; R1 half in test/b-recur6a-118-r1.spec.ts).
// Sol B-679-7 send authority vs account deletion and retirement, Sol B-679-8
// admission exclusion after an unresolved rejected bind, Sol/Opus B-679-10
// trials when Stripe returns no pending SetupIntent. "(failed before)" cases
// failed at #679 6760ee6a in the CI lane. Synthetic stateful doubles only.
import { HttpException } from '@nestjs/common';
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
    ...{ id: PKG, coach_id: COACH, name: 'Plan', amount_cents: 4900, currency: 'usd' },
    ...{ billing_type: 'recurring', interval: 'month', interval_count: 1 },
    ...{ stripe_price_id: 'price_plan', recurring_amount_cents: null, recurring_interval: null },
    ...{ recurring_interval_count: null, recurring_stripe_price_id: null, is_active: true },
    ...{ published_at: new Date('2026-09-01'), archived_at: null, trial_days: trialDays },
  });
  prisma._accounts.push({
    ...{ coach_user_id: COACH, stripe_account_id: 'acct_coach' },
    ...{ charges_enabled: true, deauthorized_at: null },
  });
  const packages: any = { getById: async (id: string) => prisma._packages.find((p: any) => p.id === id) };
  const fees: any = { planFor: async () => ({ head_coach_id: null }) };
  const helpers: any = makeCheckoutHelpers(prisma);
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, { ready: true } as any, fees, helpers);
  return { prisma, stripe, svc };
}
type F = ReturnType<typeof setup>;
async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (err) {
    if (err instanceof HttpException) return { body: err.getResponse(), status: err.getStatus() };
    throw err;
  }
}
const intent = (f: F, key = KEY1) =>
  f.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: key });
const timeout = () => new StripeConnectApiError('synthetic', 503, 'request_timeout', 'api_connection_error');
const live = (f: F) =>
  [...f.stripe._subs.values()].filter((s: any) => !['canceled', 'incomplete_expired'].includes(s.status));
/** Runs `fn` once, right after the write that matches `when` (its reply delayed). */
function afterWrite(f: F, when: (args: any) => boolean, fn: () => void) {
  const write = f.prisma.clientPurchase.updateMany.getMockImplementation();
  let done = false;
  f.prisma.clientPurchase.updateMany.mockImplementation(async (args: any) => {
    const out = await write(args);
    if (!done && when(args)) {
      done = true;
      fn();
    }
    return out;
  });
}
const isClaim = (a: any) => String(a.data?.stripe_checkout_session_id).startsWith('sub-reserved-');
const deleteAccount = (f: F) =>
  Object.assign(f.prisma._purchases[0], { client_user_id: 'deleted', status: 'canceled' });

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});

describe('Sol B-679-7 a create is sent only under authority shared with account deletion', () => {
  it('(failed before) deletion committed after the claim: nothing is sent', async () => {
    const f = setup();
    afterWrite(f, isClaim, () => deleteAccount(f));
    const out = await resultOf(intent(f));
    expect(f.stripe.createSubscription).not.toHaveBeenCalled();
    expect(out.body?.code).toBe('CLIENT_NOT_FOUND');
  });

  it('(failed before) an account deleted during the pin write: nothing is sent', async () => {
    const f = setup();
    const pin = f.prisma.clientPurchase.update.getMockImplementation();
    f.prisma.clientPurchase.update.mockImplementation(async (a: any) => {
      Object.assign(f.prisma._users[0], { deleted_at: new Date() });
      return pin(a);
    });
    const out = await resultOf(intent(f));
    expect(f.stripe.createSubscription).not.toHaveBeenCalled();
    expect(out.body?.code).toBe('CLIENT_NOT_FOUND');
  });

  it('(failed before) the create and its bind run inside the transaction that holds the client FOR KEY SHARE', async () => {
    const f = setup();
    const tx = f.prisma.$transaction.getMockImplementation();
    let depth = 0;
    f.prisma.$transaction.mockImplementation(async (cb: any, o: any) =>
      tx(async (t: any) => {
        depth += 1;
        try {
          return await cb(t);
        } finally {
          depth -= 1;
        }
      }, o),
    );
    const seen: number[] = [];
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementation(async (a: any) => {
      seen.push(depth);
      return create(a);
    });
    expect((await intent(f)).mode).toBe('payment');
    expect(seen).toEqual([1]);
    const sql = f.prisma.$queryRaw.mock.calls.map((c: any) => [c[0].join('?'), c[1]]);
    expect(sql).toContainEqual([expect.stringMatching(/FROM "User".*FOR KEY SHARE/s), CLIENT]);
  });

  it('(failed before) a stale-trial release never expires an attempt another request claimed meanwhile', async () => {
    const f = setup(7);
    f.stripe.createSubscription.mockRejectedValueOnce(timeout());
    await resultOf(intent(f));
    const row = f.prisma._purchases[0];
    Object.assign(row, { created_at: new Date(Date.now() - 25 * 3600e3), updated_at: new Date(0) });
    const list = f.stripe.listSubscriptionsForCustomer.getMockImplementation();
    f.stripe.listSubscriptionsForCustomer.mockImplementationOnce(async (...a: any[]) => {
      Object.assign(row, { stripe_checkout_session_id: `sub-reserved-x`, updated_at: new Date() });
      return list(...a);
    });
    await resultOf(intent(f, KEY2));
    expect(row.status).toBe('pending');
  });
});

describe('Sol B-679-8 an unresolved rejected bind keeps the one-subscription exclusion', () => {
  function closeBeforeBind(f: F, close = { status: 'expired' } as Record<string, unknown>) {
    const bind = f.prisma.clientPurchase.updateMany.getMockImplementation();
    let once = false;
    f.prisma.clientPurchase.updateMany.mockImplementation(async (a: any) => {
      if (!once && a.data.stripe_subscription_id && a.data.stripe_checkout_session_id) {
        once = true;
        Object.assign(f.prisma._purchases[0], close);
      }
      return bind(a);
    });
  }

  it('(failed before) cleanup unknown: the next key resumes the same subscription, never a second', async () => {
    const f = setup();
    closeBeforeBind(f);
    f.stripe.voidInvoice.mockRejectedValueOnce(timeout());
    f.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(timeout());
    expect((await resultOf(intent(f))).body?.code).toBe('PAYMENT_RETRY');
    const next = await resultOf(intent(f, KEY2));
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(live(f).map((s: any) => s.id)).toEqual(['sub_1']);
    expect(next.value?.subscription_id ?? next.body?.code).toBe('sub_1');
  });

  it('(failed before) paid before the cleanup: the next key answers already active', async () => {
    const f = setup();
    closeBeforeBind(f);
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementationOnce(async (a: any) => {
      const sub = await create(a);
      Object.assign(sub, { status: 'active' });
      sub.latest_invoice.status = 'paid';
      return sub;
    });
    expect((await resultOf(intent(f))).body?.code).toBe('PAYMENT_RETRY');
    expect((await resultOf(intent(f, KEY2))).body?.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
  });

  it('control: a deleted account’s row is never reopened; confirmed cleanup frees a fresh key', async () => {
    const gone = setup();
    closeBeforeBind(gone, { status: 'canceled', client_user_id: 'deleted' });
    gone.stripe.voidInvoice.mockRejectedValueOnce(timeout());
    gone.stripe.retrieveSubscriptionForCheckout.mockRejectedValueOnce(timeout());
    await resultOf(intent(gone));
    expect(gone.prisma._purchases[0]).toEqual(
      expect.objectContaining({ status: 'canceled', client_user_id: 'deleted' }),
    );
    const f = setup();
    closeBeforeBind(f);
    expect((await resultOf(intent(f))).body?.code).toBe('SUBSCRIPTION_ATTEMPT_EXPIRED');
    expect((await intent(f, KEY2)).subscription_id).toBe('sub_2');
    expect(live(f).map((s: any) => s.id)).toEqual(['sub_2']);
  });
});

describe('Sol/Opus B-679-10 a trial with no pending SetupIntent gets the attempt’s own', () => {
  /** Stripe set the trial up off-session (customer default card): no pending SetupIntent. */
  function noPendingSetup(f: F, subDefault: string | null) {
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementation(async (a: any) => {
      const sub = await create(a);
      sub.pending_setup_intent = null;
      if (subDefault) sub.default_payment_method = subDefault;
      return sub;
    });
  }

  it.each([null, 'pm_customer_default'])(
    '(failed before) subscription default %s: setup sheet of its own SetupIntent, trial kept, end still set',
    async (subDefault) => {
      const f = setup(7);
      noPendingSetup(f, subDefault);
      const out = await intent(f);
      expect([out.mode, out.plan.trial_days]).toEqual(['setup', 7]);
      expect(out.client_secret).toMatch(/^seti_own\w+_secret_/);
      expect(f.stripe._subs.get(out.subscription_id).cancel_at_period_end).toBe(true);
      expect((await f.svc.getPlan(CLIENT, out.purchase_id)).checkout_state).toBe('awaiting_card');
    },
  );

  it('(failed before) a later key resumes the same trial and the same SetupIntent', async () => {
    const f = setup(7);
    noPendingSetup(f, 'pm_customer_default');
    const first = await intent(f);
    const second = await intent(f, KEY2);
    expect([second.subscription_id, second.client_secret]).toEqual([first.subscription_id, first.client_secret]);
    expect(f.stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(f.stripe.createSetupIntent).toHaveBeenCalledTimes(1);
  });

  it('(failed before) only the own SetupIntent’s saved card lifts the trial end', async () => {
    const f = setup(7);
    noPendingSetup(f, 'pm_customer_default');
    const out = await intent(f);
    const sub = f.stripe._subs.get(out.subscription_id);
    const own = f.stripe._setups.get(out.client_secret.split('_secret_')[0]);
    Object.assign(own, { status: 'succeeded', payment_method: 'pm_own' });
    expect((await f.svc.getPlan(CLIENT, out.purchase_id)).checkout_state).toBe('card_saved');
    expect([sub.default_payment_method, sub.cancel_at_period_end]).toEqual(['pm_own', false]);
  });
});
