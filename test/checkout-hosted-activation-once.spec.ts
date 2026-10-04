// B-661-5 (Opus, round 4) + C-661-7: a hosted Checkout purchase is activated
// exactly once, by its checkout.session.completed. payment_intent.succeeded
// activates only the PaymentSheet purchase created for that PaymentIntent.
// Harness from the lens probe (AUD-OPUS-661CI-116): the real handler and the
// real PurchaseFanoutService on an in-memory Prisma double whose
// coach_new_purchase marker is unique, like the real table (a violation
// inside the webhook transaction aborts it in PostgreSQL).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
  retrievePaymentIntent = jest.fn(async (id: string) => ({ id, latest_charge: `ch_of_${id}` }));
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && 'in' in v)
      return (v as { in: unknown[] }).in.includes(row[k]);
    if (v && typeof v === 'object' && 'notIn' in v) {
      return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
    }
    return row[k] === v;
  });
}

function makeHarness() {
  const purchases: any[] = [];
  const fanoutRows: any[] = [];
  const markers: string[] = [];
  const uniqueViolations: string[] = [];
  const db: any = {
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
    coachPackage: {
      findUnique: jest.fn(async () => ({
        id: 'pkg-h',
        coach_id: 'coach-1',
        billing_type: 'one_time',
        duration_periods: 4,
      })),
    },
    clientPurchase: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          purchases.find((p) =>
            where.stripe_checkout_session_id
              ? p.stripe_checkout_session_id === where.stripe_checkout_session_id
              : p.id === where.id,
          ) ?? null,
      ),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        if (orderBy?.created_at === 'desc') rows.sort((a, b) => b.created_at - a.created_at);
        return rows[0] ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => matchesWhere(p, where));
        if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    purchaseFanout: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          fanoutRows.find((r) => r.purchase_id === where.purchase_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create }: any) => {
        const found = fanoutRows.find((r) => r.purchase_id === where.purchase_id);
        if (found) return found;
        fanoutRows.push({ ...create });
        return create;
      }),
    },
    coachPackageContent: { findMany: jest.fn(async () => []) },
    scheduledDrop: {
      createMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
    },
    user: { findUnique: jest.fn(async () => ({ id: 'c1' })) },
    dripResolverMarker: {
      create: jest.fn(async ({ data }: any) => {
        const key = `${data.purpose}|${data.purchase_id}|${data.content_id}`;
        if (markers.includes(key)) {
          uniqueViolations.push(key);
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        markers.push(key);
        return data;
      }),
    },
  };
  const stripe = new StripeStub();
  const splits: any = { onChargeSucceeded: jest.fn() };
  const fanout = new PurchaseFanoutService();
  const onPurchaseEntitled = jest.spyOn(fanout, 'onPurchaseEntitled');
  const svc = new CheckoutWebhookHandlerService(db, stripe, splits, undefined, undefined, fanout);
  return { svc, db, purchases, fanoutRows, uniqueViolations, onPurchaseEntitled };
}

type Harness = ReturnType<typeof makeHarness>;
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };

// BillingService.handleEvent order: prefetch out of the tx, then handle in it.
async function deliver(h: Harness, event: Event) {
  return h.svc.handle(event, h.db, await h.svc.prefetchForOuterTx(event));
}

const metadata = { tgp_package_id: 'pkg-h', tgp_client_user_id: 'c1' };
const decline = (pi: string): Event => ({
  id: `evt_decline_${pi}`,
  type: 'payment_intent.payment_failed',
  data: { object: { id: pi, metadata, last_payment_error: { message: 'card_declined' } } },
});
const piSucceeded = (pi: string, eventId = `evt_ok_${pi}`): Event => ({
  id: eventId,
  type: 'payment_intent.succeeded',
  data: { object: { id: pi, latest_charge: `ch_${pi}`, metadata } },
});
const sessionCompleted = (cs: string, pi: string, eventId = `evt_cs_${cs}`): Event => ({
  id: eventId,
  type: 'checkout.session.completed',
  data: { object: { id: cs, payment_intent: pi, customer: 'cus_1', mode: 'payment' } },
});

function hostedRow(id: string, cs: string, createdAt: string) {
  return {
    id,
    client_user_id: 'c1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-h',
    amount_cents: 10000,
    currency: 'usd',
    billing_type: 'one_time',
    stripe_checkout_session_id: cs,
    stripe_payment_intent_id: null,
    stripe_customer_id: 'cus_1',
    status: 'pending',
    entitlement_active: false,
    access_expires_at: null,
    last_error: null,
    created_at: new Date(createdAt),
  };
}

const FOUR_WEEKS_MS = 4 * 7 * 24 * 3600 * 1000;

describe('B-661-5 a hosted Checkout purchase activates exactly once, by checkout.session.completed', () => {
  it('decline, then a successful retry on the hosted page: the PaymentIntent success leaves the purchase to its checkout session, which activates it once with its access window', async () => {
    const h = makeHarness();
    h.purchases.push(hostedRow('cp-h', 'cs_h', '2026-10-03T12:00:00Z'));

    await deliver(h, decline('pi_h'));
    expect(h.purchases[0]).toMatchObject({
      status: 'payment_failed',
      stripe_payment_intent_id: 'pi_h',
    });

    const success = await deliver(h, piSucceeded('pi_h'));
    expect(success).toEqual({ claimed: false, reason: 'checkout_session_activates' });
    expect(h.purchases[0]).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(h.fanoutRows).toHaveLength(0);

    const completed = await deliver(h, sessionCompleted('cs_h', 'pi_h'));
    expect(completed.claimed).toBe(true);
    expect(h.purchases[0]).toMatchObject({
      status: 'paid',
      entitlement_active: true,
      last_error: null,
    });
    expect(h.purchases[0].access_expires_at.getTime()).toBe(
      new Date('2026-10-03T12:00:00Z').getTime() + FOUR_WEEKS_MS,
    );
    expect(h.fanoutRows).toEqual([
      expect.objectContaining({ purchase_id: 'cp-h', entrypoint: 'in_app_hosted' }),
    ]);
    expect(completed.deferredSplit).toMatchObject({
      purchase: { id: 'cp-h' },
      charge_id: 'ch_of_pi_h',
    });

    // Stripe redelivers both events (and a second completion event for the
    // same session, C-661-7): nothing activates again and nothing hits the
    // marker's unique index, so no delivery fails.
    expect((await deliver(h, piSucceeded('pi_h', 'evt_ok_again'))).claimed).toBe(false);
    const again = await deliver(h, sessionCompleted('cs_h', 'pi_h', 'evt_cs_again'));
    expect(again).toEqual({ claimed: true, purchase_id: 'cp-h', reason: 'already_progressed' });
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.uniqueViolations).toEqual([]);
    expect(h.purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('two open sessions: the success of session A never entitles the session B purchase a decline marked failed', async () => {
    const h = makeHarness();
    h.purchases.push(hostedRow('cp-A', 'cs_A', '2026-10-02T23:50:00Z'));
    h.purchases.push(hostedRow('cp-B', 'cs_B', '2026-10-03T00:10:00Z'));
    const [rowA, rowB] = h.purchases;

    await deliver(h, decline('pi_A'));
    expect(rowB).toMatchObject({ status: 'payment_failed', stripe_payment_intent_id: 'pi_A' });

    const completed = await deliver(h, sessionCompleted('cs_A', 'pi_A'));
    expect(completed.deferredSplit?.purchase.id).toBe('cp-A');
    const success = await deliver(h, piSucceeded('pi_A'));

    expect(success.claimed).toBe(false);
    expect(success.deferredSplit).toBeUndefined();
    expect(rowA).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(rowB).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.onPurchaseEntitled.mock.calls[0][0]).toMatchObject({ id: 'cp-A' });
  });

  it('(control) a PaymentSheet purchase (stripe_checkout_session_id is the PaymentIntent id) is activated by the success of its retried PaymentIntent', async () => {
    const h = makeHarness();
    h.purchases.push({
      ...hostedRow('cp-ps', 'pi_ps', '2026-10-03T12:00:00Z'),
      stripe_payment_intent_id: 'pi_ps',
      stripe_client_secret: 'pi_ps_secret_x',
      stripe_ephemeral_key: 'ek_test_x',
    });
    await deliver(h, decline('pi_ps'));
    const success = await deliver(h, piSucceeded('pi_ps'));
    expect(success).toMatchObject({ claimed: true, purchase_id: 'cp-ps' });
    expect(success.deferredSplit).toMatchObject({
      purchase: { id: 'cp-ps' },
      charge_id: 'ch_pi_ps',
    });
    expect(h.purchases[0]).toMatchObject({
      status: 'paid',
      entitlement_active: true,
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
    });
    expect(h.fanoutRows).toEqual([expect.objectContaining({ entrypoint: 'in_app_ps' })]);
  });
});

// C-661-7: a late checkout.session.completed never re-activates a purchase
// that was activated already or that a later event ended.
describe('C-661-7 checkout.session.completed activates only a purchase that was never activated', () => {
  it.each(['paid', 'refunded', 'disputed', 'chargeback_lost', 'canceled', 'expired'])(
    'a purchase in status %s stays as it is',
    async (status) => {
      const h = makeHarness();
      const entitled = status === 'paid' || status === 'disputed';
      h.purchases.push({
        ...hostedRow('cp-late', 'cs_late', '2026-10-03T12:00:00Z'),
        stripe_payment_intent_id: 'pi_late',
        status,
        entitlement_active: entitled,
      });
      const result = await deliver(h, sessionCompleted('cs_late', 'pi_late'));
      expect(result).toEqual({
        claimed: true,
        purchase_id: 'cp-late',
        reason: 'already_progressed',
      });
      expect(h.purchases[0]).toMatchObject({
        status,
        entitlement_active: entitled,
        access_expires_at: null,
      });
      expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
    },
  );
});
