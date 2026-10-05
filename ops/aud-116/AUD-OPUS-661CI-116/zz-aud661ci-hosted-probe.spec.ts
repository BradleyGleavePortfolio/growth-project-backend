// AUD-OPUS-661CI-116 lens probe (never merge). Branch from #661 @ a193d7e1.
// Each test is a DEMONSTRATION: green = the described defect is present at
// this head. It drives the real CheckoutWebhookHandlerService and the real
// PurchaseFanoutService against the same in-memory Prisma double the PR's own
// spec uses (test/checkout-webhook-handler.spec.ts).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
  retrievePaymentIntent = jest.fn();
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(row[k]);
    return row[k] === v;
  });
}

function makeDb() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const fanoutRows: any[] = [];
  const markers: any[] = [];
  const uniqueViolations: string[] = [];
  const db: any = {
    _packages: packages,
    _purchases: purchases,
    _fanoutRows: fanoutRows,
    _markers: markers,
    _uniqueViolations: uniqueViolations,
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: any) => cb(db)),
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) => packages.find((p) => p.id === where.id) ?? null),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => {
          if (where.stripe_checkout_session_id) return p.stripe_checkout_session_id === where.stripe_checkout_session_id;
          if (where.stripe_subscription_id) return p.stripe_subscription_id === where.stripe_subscription_id;
          if (where.id) return p.id === where.id;
          return false;
        }) ?? null,
      ),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        if (orderBy?.created_at === 'desc') rows.sort((a, b) => b.created_at - a.created_at);
        return rows[0] ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
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
      upsert: jest.fn(async ({ where, create }: any) => {
        const found = fanoutRows.find((r) => r.purchase_id === where.purchase_id);
        if (found) return found;
        fanoutRows.push({ ...create });
        return create;
      }),
    },
    coachPackageContent: { findMany: jest.fn(async () => []) },
    scheduledDrop: { createMany: jest.fn(async () => ({ count: 0 })), findMany: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async () => ({ id: 'c1', name: 'Client', email: 'c@x.test' })) },
    // Unique (purpose, purchase_id, content_id), like the real table. A
    // violation inside an interactive transaction aborts that transaction in
    // PostgreSQL (every later statement fails with 25P02), so it is recorded.
    dripResolverMarker: {
      create: jest.fn(async ({ data }: any) => {
        const key = `${data.purpose}|${data.purchase_id}|${data.content_id}`;
        if (markers.includes(key)) {
          uniqueViolations.push(key);
          const err: any = new Error('Unique constraint failed on the fields: (`purpose`,`purchase_id`,`content_id`)');
          err.code = 'P2002';
          throw err;
        }
        markers.push(key);
        return data;
      }),
    },
  };
  return db;
}

function makeHandler() {
  const db = makeDb();
  const stripe = new StripeStub();
  const splits = { onChargeSucceeded: jest.fn() };
  const fanout = new PurchaseFanoutService();
  const onPurchaseEntitled = jest.spyOn(fanout, 'onPurchaseEntitled');
  const svc = new CheckoutWebhookHandlerService(
    db as any,
    stripe as any,
    splits as any,
    undefined,
    undefined,
    fanout,
  );
  return { svc, db, stripe, onPurchaseEntitled };
}

// BillingService.handleEvent order: prefetch out of the tx, then handle in it.
async function deliver(svc: CheckoutWebhookHandlerService, db: any, event: any) {
  const prefetched = await svc.prefetchForOuterTx(event);
  return svc.handle(event, db, prefetched);
}

const decline = (pi: string) => ({
  id: `evt_decline_${pi}`,
  type: 'payment_intent.payment_failed',
  data: {
    object: {
      id: pi,
      metadata: { tgp_package_id: 'pkg-h', tgp_client_user_id: 'c1' },
      last_payment_error: { message: 'card_declined' },
    },
  },
});
const piSucceeded = (pi: string, ch: string) => ({
  id: `evt_ok_${pi}`,
  type: 'payment_intent.succeeded',
  data: { object: { id: pi, latest_charge: ch, metadata: { tgp_package_id: 'pkg-h', tgp_client_user_id: 'c1' } } },
});
const sessionCompleted = (cs: string, pi: string) => ({
  id: `evt_cs_${cs}`,
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
    stripe_checkout_session_id: cs, // hosted Checkout: a real cs_ id
    stripe_payment_intent_id: null, // Checkout creates the PI on confirm
    stripe_customer_id: 'cus_1',
    status: 'pending',
    entitlement_active: false,
    access_expires_at: null,
    last_error: null,
    created_at: new Date(createdAt),
  };
}

describe('AUD 661 probe — payment_intent.succeeded now claims hosted Checkout rows (round 2 widening)', () => {
  it('DEFECT (single session): hosted decline -> in-page retry succeeds -> payment_intent.succeeded activates the hosted row through the PaymentSheet path; checkout.session.completed then activates it a second time', async () => {
    const { svc, db, onPurchaseEntitled } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: 4, name: 'Hosted 4' });
    db._purchases.push(hostedRow('cp-h', 'cs_test_h', '2026-10-03T12:00:00Z'));

    // 1. First card declined on the hosted page: the metadata fallback adopts the row (pre-existing).
    const d = await deliver(svc, db, decline('pi_h'));
    expect(d).toMatchObject({ claimed: true, purchase_id: 'cp-h' });
    expect(db._purchases[0]).toMatchObject({ status: 'payment_failed', stripe_payment_intent_id: 'pi_h' });

    // 2. Retry on the same hosted page succeeds; Stripe delivers payment_intent.succeeded first.
    const s = await deliver(svc, db, piSucceeded('pi_h', 'ch_h'));
    // Before round 2 this was { claimed: false } (status 'pending' only). Now the PaymentSheet path claims it:
    expect(s.claimed).toBe(true);
    expect(db._purchases[0].status).toBe('paid');
    expect(db._purchases[0].entitlement_active).toBe(true);
    // ... without the hosted activation's access window (duration_periods = 4 weeks) ...
    expect(db._purchases[0].access_expires_at).toBeNull();
    // ... and the fanout row is stamped as an in-app PaymentSheet purchase.
    expect(db._fanoutRows[0].entrypoint).toBe('in_app_ps');
    expect(s.deferredSplit?.purchase.id).toBe('cp-h');

    // 3. checkout.session.completed for the same session activates the same purchase AGAIN (no status fence).
    const c = await deliver(svc, db, sessionCompleted('cs_test_h', 'pi_h'));
    expect(c.claimed).toBe(true);
    expect(onPurchaseEntitled).toHaveBeenCalledTimes(2);
    expect(c.deferredSplit?.purchase.id).toBe('cp-h'); // a second split posting for one charge
    // The second activation hits the coach_new_purchase marker's unique index INSIDE the webhook tx.
    // In PostgreSQL that aborts the transaction: BillingService's next statement fails, the event
    // rolls back and every redelivery fails the same way.
    expect(db._uniqueViolations).toEqual(['coach_new_purchase|cp-h|-']);
  });

  it('DEFECT (two open sessions): the success of session A activates the row of session B that a decline adopted, so one payment entitles two rows and defers two splits on one charge', async () => {
    const { svc, db } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: null, name: 'Hosted' });
    // Yesterday's session A (still open) and today's session B: one row per client/package/day.
    db._purchases.push(hostedRow('cp-A', 'cs_A', '2026-10-02T23:50:00Z'));
    db._purchases.push(hostedRow('cp-B', 'cs_B', '2026-10-03T00:10:00Z'));

    // A's first card is declined; the fallback adopts the NEWEST pending row without a PI = B (pre-existing heuristic).
    await deliver(svc, db, decline('pi_A'));
    const rowA = db._purchases.find((p: any) => p.id === 'cp-A');
    const rowB = db._purchases.find((p: any) => p.id === 'cp-B');
    expect(rowB).toMatchObject({ status: 'payment_failed', stripe_payment_intent_id: 'pi_A' });

    // A's retry succeeds. checkout.session.completed(cs_A) activates A ...
    const c = await deliver(svc, db, sessionCompleted('cs_A', 'pi_A'));
    expect(c.deferredSplit?.purchase.id).toBe('cp-A');
    expect(rowA).toMatchObject({ status: 'paid', entitlement_active: true, stripe_payment_intent_id: 'pi_A' });
    // ... and payment_intent.succeeded(pi_A) now ALSO claims B (payment_failed, same PI id).
    const s = await deliver(svc, db, piSucceeded('pi_A', 'ch_A'));
    expect(s.claimed).toBe(true);
    expect(s.deferredSplit?.purchase.id).toBe('cp-B');
    expect(s.deferredSplit?.charge_id).toBe('ch_A');
    expect(rowB).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('(control) a PaymentSheet row (stripe_checkout_session_id === PaymentIntent id) is the row the round-2 widening was meant for', async () => {
    const { svc, db } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', name: 'Sheet' });
    db._purchases.push({
      ...hostedRow('cp-ps', 'pi_ps', '2026-10-03T12:00:00Z'),
      stripe_payment_intent_id: 'pi_ps',
      stripe_client_secret: 'pi_ps_secret_x',
      stripe_ephemeral_key: 'ek_test_x',
    });
    await deliver(svc, db, decline('pi_ps'));
    const s = await deliver(svc, db, piSucceeded('pi_ps', 'ch_ps'));
    expect(s.claimed).toBe(true);
    expect(db._purchases[0]).toMatchObject({ status: 'paid', stripe_client_secret: null, stripe_ephemeral_key: null });
  });
});
