// Independent exact-R1-head boundary probes. No Stripe or database access.
import { ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { pickErrorDetails } from '../src/filters/error-details';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { attachTrialCard, readTrialSetup, setupIntentIdOf, trialCardSaved } from '../src/checkout/trial-card';

class RecordingStripe extends StripeConnectApiService {
  calls: Array<{ url: string; method: string; headers: any; form: URLSearchParams }> = [];
  protected fetchImpl: typeof fetch = async (input: any, init: any) => {
    this.calls.push({
      url: String(input), method: init.method, headers: init.headers,
      form: new URLSearchParams(init.body),
    });
    return new Response(JSON.stringify({ id: 'sub_synthetic', status: 'incomplete' }), { status: 200 });
  };
}

const previous = process.env.STRIPE_SECRET_KEY;
beforeAll(() => { process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic'; });
afterAll(() => {
  if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = previous;
});

describe('R1: Stripe foundation + existing guest signature', () => {
  it('existing no-trial caller still has one invoice expansion and no trial fields', async () => {
    const stripe = new RecordingStripe();
    await stripe.createSubscription({
      customer: 'cus_synthetic', recurringPriceId: 'price_rec', oneTimePriceId: 'price_one',
      onBehalfOf: 'acct_coach', metadata: { tgp_package_id: 'synthetic' }, idempotencyKey: 'guest-key',
    });
    const call = stripe.calls[0];
    expect(call.headers['Stripe-Version']).toBe('2024-09-30.acacia');
    expect(call.headers['Idempotency-Key']).toBe('guest-key');
    expect(call.headers['Stripe-Account']).toBeUndefined();
    expect(call.form.get('expand[0]')).toBe('latest_invoice.payment_intent');
    expect(call.form.get('expand[1]')).toBeNull();
    expect(call.form.get('trial_period_days')).toBeNull();
    expect(call.form.get('add_invoice_items[0][price]')).toBe('price_one');
    expect([...call.form.keys()].filter((k) => /transfer_data|application_fee/.test(k))).toEqual([]);
  });

  it('a trial expands setup intent and cancels without a saved card', async () => {
    const stripe = new RecordingStripe();
    await stripe.createSubscription({
      customer: 'cus_synthetic', recurringPriceId: 'price_rec', onBehalfOf: 'acct_coach',
      trialPeriodDays: 7, idempotencyKey: 'trial-key',
    });
    const call = stripe.calls[0];
    expect(call.form.get('payment_behavior')).toBe('default_incomplete');
    expect(call.form.get('payment_settings[save_default_payment_method]')).toBe('on_subscription');
    expect(call.form.get('trial_period_days')).toBe('7');
    expect(call.form.get('trial_settings[end_behavior][missing_payment_method]')).toBe('cancel');
    expect(call.form.get('expand[1]')).toBe('pending_setup_intent');
  });

  it('checkout retrieve expands both intents and URL-encodes identifiers', async () => {
    const stripe = new RecordingStripe();
    await stripe.retrieveSubscriptionForCheckout('sub_synthetic/a');
    const url = new URL(stripe.calls[0].url);
    expect(stripe.calls[0].method).toBe('GET');
    expect(url.pathname).toBe('/v1/subscriptions/sub_synthetic%2Fa');
    expect(url.searchParams.getAll('expand[]')).toEqual(['latest_invoice.payment_intent', 'pending_setup_intent']);
  });

  it('lookup is the bounded customer-specific all-status list, not Search', async () => {
    const stripe = new RecordingStripe();
    await stripe.listSubscriptionsForCustomer('cus_synthetic/a');
    const url = new URL(stripe.calls[0].url);
    expect(url.pathname).toBe('/v1/subscriptions');
    expect(url.searchParams.get('customer')).toBe('cus_synthetic/a');
    expect(url.searchParams.get('status')).toBe('all');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('resume and saved-card calls have independent idempotency keys and minimal bodies', async () => {
    const stripe = new RecordingStripe();
    await stripe.resumeSubscription({ subscriptionId: 'sub_x', idempotencyKey: 'keep-key' });
    await attachTrialCard(stripe, 'sub_x', 'pm_y');
    expect(stripe.calls[0].form.toString()).toBe('cancel_at_period_end=false');
    expect(stripe.calls[0].headers['Idempotency-Key']).toBe('keep-key');
    expect(stripe.calls[1].form.toString()).toBe('default_payment_method=pm_y');
    expect(stripe.calls[1].headers['Idempotency-Key']).toBe('tgp-trial-card-sub_x-pm_y');
  });
});

describe('R1: trial card detached SetupIntent + failure propagation', () => {
  it('reads a detached succeeded SetupIntent by stored secret prefix', async () => {
    const stripe: any = {
      retrieveSetupIntent: jest.fn(async () => ({
        id: 'seti_123', status: 'succeeded', payment_method: 'pm_saved',
      })),
    };
    const out = await readTrialSetup(stripe, 'seti_123_secret_synthetic', { pending_setup_intent: null });
    expect(stripe.retrieveSetupIntent).toHaveBeenCalledWith('seti_123');
    expect(trialCardSaved(out)).toBe(true);
    expect(out?.payment_method).toBe('pm_saved');
  });

  it('an expanded pending intent avoids an unnecessary detached read', async () => {
    const stripe: any = { retrieveSetupIntent: jest.fn() };
    const out = await readTrialSetup(stripe, null, {
      pending_setup_intent: { id: 'seti_123', status: 'processing', payment_method: null },
    });
    expect(out?.status).toBe('processing');
    expect(trialCardSaved(out)).toBe(false);
    expect(stripe.retrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('invalid/no stored secret is not a saved card or arbitrary provider URL', async () => {
    const stripe: any = { retrieveSetupIntent: jest.fn() };
    expect(setupIntentIdOf('pi_123_secret_synthetic')).toBeNull();
    expect(setupIntentIdOf('https://example.test/secret')).toBeNull();
    expect(await readTrialSetup(stripe, 'other_secret')).toBeNull();
    expect(trialCardSaved(null)).toBe(false);
    expect(stripe.retrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('read and attach failures propagate so the owning webhook can retry', async () => {
    const stripe: any = {
      retrieveSetupIntent: jest.fn(async () => { throw new Error('synthetic read outage'); }),
      setSubscriptionDefaultPaymentMethod: jest.fn(async () => { throw new Error('synthetic write outage'); }),
    };
    await expect(readTrialSetup(stripe, 'seti_123_secret_synthetic')).rejects.toThrow('synthetic read outage');
    await expect(attachTrialCard(stripe, 'sub_x', 'pm_y')).rejects.toThrow('synthetic write outage');
  });
});

describe('R1: client-safe error details + actual global filter', () => {
  it('unknown codes, envelope overrides, secrets and malformed cents are rejected', () => {
    expect(pickErrorDetails(409, 'not_a_code', { amount_cents: 4900 })).toEqual({});
    expect(pickErrorDetails(503, 'PACKAGE_PRICE_CHANGED', { amount_cents: 4900 })).toEqual({});
    expect(pickErrorDetails(409, 'constructor', { amount_cents: 4900 })).toEqual({});
    expect(pickErrorDetails(409, 'PACKAGE_PRICE_CHANGED', {
      amount_cents: -1, one_time_cents: '4900', interval: 'day',
      message: 'override', stripe_client_secret: 'secret', request_id: 'override',
    })).toEqual({});
  });

  it('the production filter emits only allowlisted safe facts, preserving its envelope', () => {
    const json = jest.fn();
    const response: any = { status: jest.fn(() => response), json };
    const request = { method: 'POST', url: '/v1/checkout/subscription-intent', originalUrl: '/v1/checkout/subscription-intent',
      route: { path: 'subscription-intent' }, requestId: 'synthetic-reference' };
    const host: any = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) };
    new HttpExceptionFilter().catch(new ConflictException({
      code: 'PACKAGE_PRICE_CHANGED', message: 'Review the new price.', error: 'PACKAGE_PRICE_CHANGED',
      amount_cents: 5900, currency: 'usd', interval: 'month', interval_count: 1,
      first_charge_cents: 5900, request_id: 'bad-override', stripeCode: 'private-code', secret: 'private-secret',
    }), host);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 409, code: 'PACKAGE_PRICE_CHANGED', message: 'Review the new price.',
      request_id: 'synthetic-reference', amount_cents: 5900, currency: 'usd',
    }));
    expect(json.mock.calls[0][0]).not.toHaveProperty('stripeCode');
    expect(json.mock.calls[0][0]).not.toHaveProperty('secret');
  });
});
