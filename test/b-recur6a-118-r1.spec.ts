// B-RECUR6A-118 fix round 6, R1 (#678) half. Real Stripe client with HTTP
// recorded (no network) and small doubles; "(failed before)" cases failed at
// #678 b04ea692 in the CI lane before the fix.
//   Opus B-678-2  a plain default-card update never touches cancel_at_period_end.
//   B-679-10      a trial attempt's own SetupIntent (Stripe made no pending one).
//   Sol B-679-7   account deletion finds an unbound checkout subscription, fail closed.
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import * as plan from '../src/checkout/subscription-plan';
import * as trialCard from '../src/checkout/trial-card';

class Recording extends StripeConnectApiService {
  calls: Array<{ url: string; key: string; form: string }> = [];
  protected fetchImpl: typeof fetch = async (input: any, init: any) => {
    this.calls.push({
      url: String(input),
      key: init?.headers?.['Idempotency-Key'],
      form: decodeURIComponent(String(init?.body ?? '')),
    });
    const body = String(input).includes('/setup_intents')
      ? { id: 'seti_A', client_secret: 'seti_A_secret_x', status: 'requires_payment_method' }
      : { id: 'sub_x', status: 'active' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
const any = (v: unknown): any => v;

describe('Opus B-678-2 only the trial-card attach lifts the trial end', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('(failed before) a card update on a paid plan sends only default_payment_method', async () => {
    const api = new Recording();
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_paid',
      paymentMethodId: 'pm_new',
      idempotencyKey: 'tgp-card-default-sub-sub_paid-seti_x',
    });
    expect(api.calls.map((c) => c.form)).toEqual(['default_payment_method=pm_new']);
  });

  it('control: the trial-card attach sends the card and the lift in one keyed request', async () => {
    const api = new Recording();
    await trialCard.attachTrialCard(api, 'sub_t', 'pm_own');
    expect(api.calls).toEqual([
      expect.objectContaining({
        form: 'default_payment_method=pm_own&cancel_at_period_end=false',
        key: 'tgp-trial-card-sub_t-pm_own',
      }),
    ]);
  });

  it('(failed before) a trial default Stripe set itself (end still set) is not the attempt card', () => {
    const own = { status: 'trialing', default_payment_method: 'pm_x', cancel_at_period_end: false };
    const foreign = { ...own, cancel_at_period_end: true };
    expect(plan.classifyWithoutSheet(any(foreign))).toBe('unavailable');
    expect(plan.subscriptionUnpaid(any(foreign))).toBe(true);
    expect(plan.classifyWithoutSheet(any(own))).toBe('complete');
    expect(plan.subscriptionUnpaid(any(own))).toBe(false);
  });
});

describe('B-679-10 a trial attempt gets its own SetupIntent when Stripe made none', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });
  const args = {
    purchaseId: 'pur_1',
    subscriptionId: 'sub_1',
    customerId: 'cus_1',
    onBehalfOf: 'acct_coach',
    storedSecret: null,
    stored: null,
  };

  it('(failed before) creates one off-session SetupIntent per attempt, named by metadata', async () => {
    const api = new Recording();
    const own = any(trialCard).ownTrialSetupSecret;
    expect(await own(api, args)).toBe('seti_A_secret_x');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toMatch(/\/v1\/setup_intents$/);
    expect(api.calls[0].key).toBe('tgp-trial-setup-pur_1');
    for (const part of [
      'customer=cus_1',
      'usage=off_session',
      'on_behalf_of=acct_coach',
      'metadata[tgp_purchase_id]=pur_1',
      'metadata[tgp_subscription_id]=sub_1',
    ]) {
      expect(api.calls[0].form.split('&')).toContain(part);
    }
  });

  it('(failed before) reuses the stored own secret while the sheet can finish it, never a canceled one', async () => {
    const api = new Recording();
    const own = any(trialCard).ownTrialSetupSecret;
    const stored = 'seti_A_secret_x';
    const open = { status: 'requires_payment_method', payment_method: null };
    const dead = { status: 'canceled', payment_method: null };
    expect(await own(api, { ...args, storedSecret: stored, stored: open })).toBe(stored);
    expect(await own(api, { ...args, storedSecret: stored, stored: dead })).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

describe('Sol B-679-7 account deletion finds an unbound checkout subscription', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const old = new Date(Date.now() - 10 * 60_000);
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'pur_1',
    stripe_customer_id: 'cus_1',
    created_at: old,
    updated_at: old,
    ...over,
  });
  const tx = (rows: unknown[]) => any({ clientPurchase: { findMany: jest.fn(async () => rows) } });
  const lister = (data: unknown[], hasMore = false) => ({
    listSubscriptionsForCustomer: jest.fn(async () => ({ data, has_more: hasMore })),
  });
  const collect = (svc: AccountDeletionBillingService, t: unknown) =>
    any(svc).collectUnboundAttemptSubscriptionIds(t, USER);
  const billing = (stripe: unknown): AccountDeletionBillingService =>
    new (AccountDeletionBillingService as any)({}, stripe);

  it('(failed before) returns the attempt’s own live subscription found by metadata', async () => {
    const stripe = lister([
      { id: 'sub_own', status: 'incomplete', metadata: { tgp_purchase_id: 'pur_1' } },
      { id: 'sub_gone', status: 'canceled', metadata: { tgp_purchase_id: 'pur_1' } },
      { id: 'sub_other', status: 'active', metadata: { tgp_purchase_id: 'pur_9' } },
    ]);
    const svc = billing(stripe);
    const t = tx([row()]);
    expect(await collect(svc, t)).toEqual(['sub_own']);
    expect(t.clientPurchase.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        client_user_id: USER,
        status: 'pending',
        stripe_subscription_id: null,
        idempotency_key: { startsWith: `sub-${USER}-` },
      }),
    );
    expect(stripe.listSubscriptionsForCustomer).toHaveBeenCalledWith('cus_1', {
      createdGte: Math.floor(old.getTime() / 1000) - 300,
    });
  });

  it('(failed before) fails closed: a just-touched attempt or an incomplete list stops the deletion', async () => {
    const fresh = billing(lister([]));
    await expect(collect(fresh, tx([row({ updated_at: new Date() })]))).rejects.toThrow(
      /still finishing/,
    );
    const partial = billing(lister([], true));
    await expect(collect(partial, tx([row()]))).rejects.toThrow(/incomplete/);
  });

  it('(failed before) no unbound attempt -> no Stripe read', async () => {
    const stripe = lister([]);
    const svc = billing(stripe);
    expect(await collect(svc, tx([]))).toEqual([]);
    expect(stripe.listSubscriptionsForCustomer).not.toHaveBeenCalled();
  });
});
