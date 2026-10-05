// B-RECUR — StripeConnectApiService wire format of the native subscription
// checkout (R1 code). Moved verbatim from test/b-recur-subscription-checkout.spec.ts
// (#679) to #678 by B-RECUR6A-118 (size move, no behavior change), except
// the trial-card write, which now names the trial-end lift (Opus B-678-2).
describe('StripeConnectApiService.createSubscription wire format (Stripe-Version 2024-09-30.acacia)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeConnectApiService } = require('../src/connect/stripe-connect-api.service');
  class Recording extends StripeConnectApiService {
    calls: Array<{ url: string; headers: Record<string, string>; form: URLSearchParams }> = [];
    protected fetchImpl: typeof fetch = async (input: any, init: any) => {
      this.calls.push({
        url: String(input),
        headers: init.headers,
        form: new URLSearchParams(init.body),
      });
      return new Response(JSON.stringify({ id: 'sub_x', status: 'incomplete' }), { status: 200 });
    };
  }
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('default_incomplete, save card on_subscription, expand first invoice PI, on_behalf_of, no fee / transfer_data', async () => {
    const api = new Recording();
    await api.createSubscription({
      customer: 'cus_1',
      recurringPriceId: 'price_r',
      oneTimePriceId: 'price_o',
      onBehalfOf: 'acct_coach',
      metadata: { tgp_package_id: 'p' },
      idempotencyKey: 'tgp-sub-k',
    });
    const { url, headers, form } = api.calls[0];
    expect(url).toMatch(/\/v1\/subscriptions$/);
    expect(headers['Stripe-Version']).toBe('2024-09-30.acacia');
    expect(headers['Idempotency-Key']).toBe('tgp-sub-k');
    expect(form.get('payment_behavior')).toBe('default_incomplete');
    expect(form.get('payment_settings[save_default_payment_method]')).toBe('on_subscription');
    expect(form.get('expand[0]')).toBe('latest_invoice.payment_intent');
    expect(form.get('on_behalf_of')).toBe('acct_coach');
    expect(form.get('items[0][price]')).toBe('price_r');
    expect(form.get('add_invoice_items[0][price]')).toBe('price_o');
    expect([...form.keys()].filter((k) => /transfer_data|application_fee/.test(k))).toEqual([]);
    expect(form.get('trial_period_days')).toBeNull();
  });

  it('trial: trial_period_days, cancel when the trial ends without a card, expand pending_setup_intent', async () => {
    const api = new Recording();
    await api.createSubscription({
      customer: 'cus_1',
      recurringPriceId: 'price_r',
      onBehalfOf: 'acct_coach',
      trialPeriodDays: 7,
      idempotencyKey: 'tgp-sub-t',
    });
    const { form } = api.calls[0];
    expect(form.get('trial_period_days')).toBe('7');
    expect(form.get('trial_settings[end_behavior][missing_payment_method]')).toBe('cancel');
    expect(form.get('expand[1]')).toBe('pending_setup_intent');
  });

  it('resume and trial-card writes carry their own idempotency keys', async () => {
    const api = new Recording();
    await api.resumeSubscription({ subscriptionId: 'sub_1', idempotencyKey: 'tgp-resume-1' });
    await api.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_1',
      paymentMethodId: 'pm_1',
      idempotencyKey: 'tgp-trial-card-1',
      liftTrialEnd: true,
    });
    expect(api.calls[0].form.get('cancel_at_period_end')).toBe('false');
    expect(api.calls[0].headers['Idempotency-Key']).toBe('tgp-resume-1');
    expect(api.calls[1].form.get('default_payment_method')).toBe('pm_1');
    expect(api.calls[1].headers['Idempotency-Key']).toBe('tgp-trial-card-1');
  });
});
