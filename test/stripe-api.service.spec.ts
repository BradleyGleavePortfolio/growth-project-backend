import {
  StripeApiError,
  StripeApiService,
} from '../src/billing/stripe-api.service';

// Test subclass — overrides the protected fetchImpl member rather than
// monkey-patching globalThis.fetch. Each test installs a fresh stub.
class TestStripeApi extends StripeApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override fetchImpl: any = jest.fn();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function parseFormBody(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

describe('StripeApiService', () => {
  const ORIGINAL = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL;
  });

  it('isConfigured tracks the env var', () => {
    const svc = new TestStripeApi();
    expect(svc.isConfigured()).toBe(true);
    delete process.env.STRIPE_SECRET_KEY;
    expect(svc.isConfigured()).toBe(false);
  });

  it('createCustomer form-encodes body, sets headers, forwards idempotency key', async () => {
    const svc = new TestStripeApi();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { id: 'cus_abc', email: 'a@b.co' }),
    );
    const out = await svc.createCustomer({
      email: 'a@b.co',
      name: 'Coach A',
      metadata: { coach_id: 'coach-1' },
      idempotencyKey: 'coach_customer_coach-1',
    });
    expect(out.id).toBe('cus_abc');
    expect(svc.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/customers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_test_123');
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.headers['Stripe-Version']).toBe('2024-09-30.acacia');
    expect(init.headers['Idempotency-Key']).toBe('coach_customer_coach-1');
    const form = parseFormBody(init.body as string);
    expect(form.get('email')).toBe('a@b.co');
    expect(form.get('name')).toBe('Coach A');
    expect(form.get('metadata[coach_id]')).toBe('coach-1');
  });

  it('createSubscription with trial_period_days; expand[items]; idempotency key', async () => {
    const svc = new TestStripeApi();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'sub_x',
        status: 'trialing',
        items: { data: [{ price: { id: 'price_y' } }] },
      }),
    );
    const out = await svc.createSubscription({
      customer: 'cus_y',
      priceId: 'price_y',
      trialPeriodDays: 14,
      metadata: { coach_id: 'coach-1', plan_tier: 'flat_300' },
      idempotencyKey: 'coach_subscription_coach-1_price_y',
    });
    expect(out.id).toBe('sub_x');
    const [, init] = svc.fetchImpl.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe(
      'coach_subscription_coach-1_price_y',
    );
    const form = parseFormBody(init.body as string);
    expect(form.get('customer')).toBe('cus_y');
    expect(form.get('items[0][price]')).toBe('price_y');
    expect(form.get('trial_period_days')).toBe('14');
    expect(form.get('expand[0]')).toBe('items');
    expect(form.get('metadata[plan_tier]')).toBe('flat_300');
  });

  it('createSubscription omits trial_period_days when not provided', async () => {
    const svc = new TestStripeApi();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, { id: 'sub_x', status: 'active' }),
    );
    await svc.createSubscription({
      customer: 'cus_y',
      priceId: 'price_y',
      idempotencyKey: 'k',
    });
    const [, init] = svc.fetchImpl.mock.calls[0];
    const form = parseFormBody(init.body as string);
    expect(form.has('trial_period_days')).toBe(false);
  });

  it('createBillingPortalSession returns URL and sends no idempotency key', async () => {
    const svc = new TestStripeApi();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'bps_1',
        url: 'https://billing.stripe.com/p/session/abc',
      }),
    );
    const out = await svc.createBillingPortalSession({
      customer: 'cus_y',
      returnUrl: 'https://console.example.com/billing',
    });
    expect(out.url).toBe('https://billing.stripe.com/p/session/abc');
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(init.headers['Idempotency-Key']).toBeUndefined();
    const form = parseFormBody(init.body as string);
    expect(form.get('customer')).toBe('cus_y');
    expect(form.get('return_url')).toBe('https://console.example.com/billing');
  });

  it('throws StripeApiError parsed from the error envelope', async () => {
    const svc = new TestStripeApi();
    svc.fetchImpl.mockResolvedValueOnce(
      jsonResponse(402, {
        error: {
          message: 'Your card was declined.',
          code: 'card_declined',
          type: 'card_error',
        },
      }),
    );
    let thrown: unknown = null;
    try {
      await svc.createSubscription({
        customer: 'cus_y',
        priceId: 'price_y',
        idempotencyKey: 'k',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StripeApiError);
    const e = thrown as StripeApiError;
    expect(e.httpStatus).toBe(402);
    expect(e.stripeCode).toBe('card_declined');
    expect(e.stripeType).toBe('card_error');
    expect(e.message).toMatch(/declined/i);
  });

  it('refuses calls when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const svc = new TestStripeApi();
    await expect(
      svc.createCustomer({ email: 'a@b.co', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(svc.fetchImpl).not.toHaveBeenCalled();
  });
});
