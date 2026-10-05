// B-RECUR-3 fix round 2 (agent 115) — units of the new pieces behind
// B-654-5 / B-654-7: the pinned attempt-terms snapshot and the Stripe list
// read the checkout uses to find the subscription of an uncertain create.
// (New code; the behaviour proofs that failed before live in
// test/b-recur-3-fix-round-2.spec.ts.)
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  checkoutTermsFor,
  parseCheckoutTerms,
  planPriceFromTerms,
  termsStillOffered,
} from '../src/checkout/subscription-terms';

describe('subscription terms snapshot', () => {
  const terms = checkoutTermsFor(
    {
      amount_cents: 4900,
      currency: 'usd',
      interval: 'month',
      interval_count: 1,
      first_charge_cents: 4900,
      one_time_cents: 0,
      trial_days: 0,
    },
    0,
    { recurring: 'price_rec_4900', oneTime: null },
  );
  it('round-trips and rejects foreign shapes', () => {
    expect(parseCheckoutTerms(JSON.parse(JSON.stringify(terms)))).toEqual(terms);
    expect(parseCheckoutTerms(null)).toBeNull();
    expect(parseCheckoutTerms({ ...terms, v: 2 })).toBeNull();
    expect(parseCheckoutTerms({ ...terms, amount_cents: -1 })).toBeNull();
    expect(parseCheckoutTerms({ ...terms, interval: 'day' })).toBeNull();
    expect(JSON.stringify(terms)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
  it('a trial attempt charges nothing today; terms compare money and cadence', () => {
    const trial = { ...terms, trial_days: 7 };
    expect(planPriceFromTerms(trial).first_charge_cents).toBe(0);
    const offered = planPriceFromTerms(terms);
    expect(termsStillOffered(terms, offered, 7)).toBe(true);
    expect(termsStillOffered(trial, offered, 7)).toBe(true);
    expect(termsStillOffered(trial, offered, 14)).toBe(false);
    expect(termsStillOffered(terms, { ...offered, amount_cents: 5900 }, 0)).toBe(false);
    expect(termsStillOffered(terms, { ...offered, interval_count: 3 }, 0)).toBe(false);
  });
});

describe('StripeConnectApiService.listSubscriptionsForCustomer', () => {
  it('listSubscriptionsForCustomer wire format: GET, any status, by customer', async () => {
    class Recording extends StripeConnectApiService {
      calls: Array<{ url: string; method: string }> = [];
      protected fetchImpl: typeof fetch = async (input: any, init: any) => {
        this.calls.push({ url: String(input), method: init.method });
        return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
      };
    }
    const prev = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    try {
      const api = new Recording();
      const out = await api.listSubscriptionsForCustomer('cus_A');
      expect(out.data).toEqual([]);
      expect(api.calls[0].method).toBe('GET');
      expect(api.calls[0].url).toContain('/subscriptions?');
      expect(api.calls[0].url).toContain('customer=cus_A');
      expect(api.calls[0].url).toContain('status=all');
    } finally {
      process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});
