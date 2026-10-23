// b#1131 B2 (OPERATOR RULING 6353458098, owner #166-5 "nothing moves before
// payment"): a hosted Checkout purchase is activated only once Stripe reports
// its payment paid. A completion with payment_status 'unpaid' (a delayed
// payment still processing) changes nothing; async_payment_succeeded
// activates it once; async_payment_failed ends it with nothing granted.
// Every package checkout pins cards except the in-app PaymentIntent, whose
// `processing` state grants nothing. The live-database walk (the house move)
// is in test/rls/house-join-rls.spec.ts.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { stub } from './utils/trial-fakes';

class StripeStub extends StripeConnectApiService {
  retrievePaymentIntent = jest.fn(async (id: string) => ({ id, latest_charge: `ch_of_${id}` }));
}

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in v ? (v as { in: unknown[] }).in.includes(row[k]) : row[k] === v,
  );

function harness(status = 'pending') {
  const row: Row = {
    id: 'cp-h',
    client_user_id: 'c1',
    coach_user_id: 'house-1',
    package_id: 'pkg-h',
    amount_cents: 20000,
    currency: 'usd',
    billing_type: 'one_time',
    stripe_checkout_session_id: 'cs_h',
    stripe_payment_intent_id: null,
    status,
    entitlement_active: status === 'paid',
    last_error: null,
    created_at: new Date('2026-10-22T12:00:00Z'),
  };
  const writes: Row[] = [];
  const db: any = {
    $queryRaw: jest.fn(async () => []),
    coachPackage: { findUnique: jest.fn(async () => ({ id: 'pkg-h', coach_id: 'house-1', billing_type: 'one_time' })) },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        (where.id ? where.id === row.id : where.stripe_checkout_session_id === row.stripe_checkout_session_id) ? { ...row } : null,
      ),
      findFirst: jest.fn(async ({ where }: any) => (matches(row, where) ? { ...row } : null)),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => (writes.push(data), Object.assign(row, data), { ...row })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(row, where)) return { count: 0 };
        writes.push(data);
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    purchaseFanout: { upsert: jest.fn(async ({ create }: any) => create) },
  };
  const fanout = new PurchaseFanoutService();
  const entitled = jest.spyOn(fanout, 'onPurchaseEntitled').mockResolvedValue(undefined);
  const stripe = new StripeStub();
  const splits = stub<never>({ onChargeSucceeded: jest.fn() });
  const svc = new CheckoutWebhookHandlerService(db, stripe, splits, undefined, undefined, fanout);
  const deliver = async (event: { id: string; type: string; data: { object: Row } }) =>
    svc.handle(event, db, await svc.prefetchForOuterTx(event));
  return { row, writes, entitled, stripe, deliver };
}

const session = (type: string, payment_status: string, id = `evt_${type}`) => ({
  id,
  type: `checkout.session.${type}`,
  data: { object: { id: 'cs_h', mode: 'payment', payment_status, payment_intent: 'pi_h', customer: 'cus_1' } },
});
const unpaid = session('completed', 'unpaid');
const settled = session('async_payment_succeeded', 'paid');
const failed = session('async_payment_failed', 'unpaid');

describe('b#1131 B2 — a hosted checkout grants nothing until Stripe reports it paid', () => {
  it('unpaid completion: nothing is written, nothing is entitled, no Stripe call', async () => {
    const h = harness();
    expect(await h.deliver(unpaid)).toEqual({ claimed: true, purchase_id: 'cp-h', reason: 'payment_not_settled' });
    expect(h.writes).toEqual([]);
    expect(h.row).toMatchObject({ status: 'pending', entitlement_active: false, stripe_payment_intent_id: null });
    expect(h.entitled).not.toHaveBeenCalled();
    expect(h.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('unpaid, then the PaymentIntent succeeds before async_payment_succeeded: the PaymentIntent activates nothing', async () => {
    const h = harness();
    await h.deliver(unpaid);
    const pi = { id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_h', latest_charge: 'ch_h' } } };
    expect((await h.deliver(pi)).claimed).toBe(false);
    expect(h.row).toMatchObject({ status: 'pending', entitlement_active: false });
    expect(h.entitled).not.toHaveBeenCalled();
  });

  it('unpaid, then async_payment_succeeded: activated once, by the hosted entrypoint; a duplicate adds nothing', async () => {
    const h = harness();
    await h.deliver(unpaid);
    const done = await h.deliver(settled);
    expect(done).toMatchObject({ claimed: true, purchase_id: 'cp-h' });
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true, stripe_payment_intent_id: 'pi_h' });
    expect(h.entitled).toHaveBeenCalledTimes(1);
    expect(h.entitled.mock.calls[0][1]).toMatchObject({ entrypoint: 'in_app_hosted', clientId: 'c1', coachId: 'house-1' });
    expect(done.deferredSplit).toMatchObject({ purchase: { id: 'cp-h' }, charge_id: 'ch_of_pi_h' });
    // A second delivery of the success (a new event id for the same session): no second activation.
    expect(await h.deliver(session('async_payment_succeeded', 'paid', 'evt_again'))).toEqual({
      claimed: true, purchase_id: 'cp-h', reason: 'already_progressed',
    });
    expect(h.entitled).toHaveBeenCalledTimes(1);
  });

  it('unpaid, then async_payment_failed: payment_failed with nothing granted; a duplicate changes nothing', async () => {
    const h = harness();
    await h.deliver(unpaid);
    expect(await h.deliver(failed)).toEqual({ claimed: true, purchase_id: 'cp-h' });
    expect(h.row).toMatchObject({ status: 'payment_failed', entitlement_active: false, last_error: 'async_payment_failed' });
    expect(h.entitled).not.toHaveBeenCalled();
    const writes = h.writes.length;
    expect(await h.deliver(session('async_payment_failed', 'unpaid', 'evt_failed_again'))).toEqual({
      claimed: true, purchase_id: 'cp-h', reason: 'already_progressed',
    });
    expect(h.writes).toHaveLength(writes);
    // The held completion redelivered after the failure still activates nothing.
    expect((await h.deliver(session('completed', 'unpaid', 'evt_cs_late'))).reason).toBe('payment_not_settled');
    expect(h.entitled).not.toHaveBeenCalled();
  });

  it("paid at completion: activated once, as before; 'no_payment_required' (nothing owed) activates too", async () => {
    for (const status of ['paid', 'no_payment_required']) {
      const h = harness();
      expect((await h.deliver(session('completed', status))).claimed).toBe(true);
      expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true });
      expect(h.entitled).toHaveBeenCalledTimes(1);
      expect((await h.deliver(session('completed', status, 'evt_dup'))).reason).toBe('already_progressed');
      expect(h.entitled).toHaveBeenCalledTimes(1);
    }
  });

  it('a failure after the purchase was paid rewrites nothing (nothing moves back)', async () => {
    const h = harness('paid');
    expect(await h.deliver(failed)).toEqual({ claimed: true, purchase_id: 'cp-h', reason: 'already_progressed' });
    expect(h.writes).toEqual([]);
    expect(h.row).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('an async event for an unknown session is not claimed', async () => {
    const h = harness();
    const other = (type: string) => ({ ...session(type, 'paid'), data: { object: { id: 'cs_other', payment_status: 'paid' } } });
    expect(await h.deliver(other('async_payment_failed'))).toEqual({ claimed: false, reason: 'no_matching_purchase' });
    expect(await h.deliver(other('async_payment_succeeded'))).toMatchObject({ claimed: false });
    expect(h.writes).toEqual([]);
  });

  it('payment_intent.processing (the in-app sheet path, not pinned to cards) is not routed: nothing written', async () => {
    const h = harness();
    const processing = { id: 'evt_proc', type: 'payment_intent.processing', data: { object: { id: 'pi_h' } } };
    expect((await h.deliver(processing)).claimed).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.entitled).not.toHaveBeenCalled();
  });
});

describe('b#1131 B2 — the card pin on the Connect checkouts', () => {
  class Recording extends StripeConnectApiService {
    forms: URLSearchParams[] = [];
    protected fetchImpl: typeof fetch = async (_input: unknown, init?: RequestInit) => {
      this.forms.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ id: 'x_1', status: 'open' }), { status: 200 });
    };
  }
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = prev;
  });

  it('the hosted session and the subscription take cards only; the PaymentIntent keeps automatic methods without redirects', async () => {
    const api = new Recording();
    for (const mode of ['payment', 'subscription'] as const) {
      await api.createCheckoutSession({
        mode, customer: 'cus_1', priceId: 'price_1', successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/no',
        onBehalfOf: 'acct_1', idempotencyKey: `k-${mode}`,
      });
    }
    await api.createSubscription({ customer: 'cus_1', recurringPriceId: 'price_r', onBehalfOf: 'acct_1', idempotencyKey: 'k-sub' });
    await api.createPaymentIntent({ amount: 20000, currency: 'usd', onBehalfOf: 'acct_1', metadata: {}, idempotencyKey: 'k-pi' });
    const [pay, sub, subscription, pi] = api.forms;
    expect([pay.getAll('payment_method_types[0]'), sub.getAll('payment_method_types[0]')]).toEqual([['card'], ['card']]);
    expect(subscription.get('payment_settings[payment_method_types][0]')).toBe('card');
    expect([pi.get('payment_method_types[0]'), pi.get('automatic_payment_methods[enabled]'), pi.get('automatic_payment_methods[allow_redirects]')])
      .toEqual([null, 'true', 'never']);
  });
});
