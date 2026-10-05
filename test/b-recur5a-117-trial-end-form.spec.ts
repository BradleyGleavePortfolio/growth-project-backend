// B-RECUR5A-117 fix round 5 — Opus B-679-8 / C-678-1 in R1: a trial converts
// only on the attempt's own saved card. Both cases failed at #679 f48fa8f0
// (CI lane run 37183949652). The real Stripe client, HTTP recorded, no network.
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

class Recording extends StripeConnectApiService {
  forms: string[] = [];
  protected fetchImpl: typeof fetch = async (_input: any, init: any) => {
    this.forms.push(decodeURIComponent(String(init?.body ?? '')));
    return new Response(JSON.stringify({ id: 'sub_x', status: 'trialing' }), { status: 200 });
  };
}

describe('Opus B-679-8 a trial converts only on the attempt’s own saved card', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('(failed before) a trial create carries a Stripe-enforced end; a plan without a trial does not', async () => {
    const api = new Recording();
    const base = { customer: 'cus_A', recurringPriceId: 'price_A', onBehalfOf: 'acct_coach' };
    await api.createSubscription({ ...base, trialPeriodDays: 7, idempotencyKey: 'k1' });
    await api.createSubscription({ ...base, idempotencyKey: 'k2' });
    expect(api.forms[0]).toContain('trial_period_days=7');
    expect(api.forms[0]).toContain('cancel_at_period_end=true');
    expect(api.forms[1]).not.toContain('cancel_at_period_end');
  });

  it('(failed before) the saved-card attach lifts that end in the same request', async () => {
    const api = new Recording();
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_x',
      paymentMethodId: 'pm_own',
      idempotencyKey: 'k3',
      liftTrialEnd: true,
    });
    expect(api.forms).toEqual([
      expect.stringMatching(/^(?=.*default_payment_method=pm_own)(?=.*cancel_at_period_end=false)/),
    ]);
  });
});
