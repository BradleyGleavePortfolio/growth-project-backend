// AUD-OPUS-661E-120 replay of the AUD-OPUS-661CI-116 hosted probe (never merge). Branch from #702 @ b96611de.
// The 116 file asserted the DEFECTS (green = defect present) and its double predates round 7 (no
// clientPurchase.findMany, which activatedFailedPurchases uses). This copy keeps the same scenarios and
// harness, adds findMany (+ notIn / fanout isNot) and purchaseFanout.findUnique (round 4+ wasActivated), and asserts the FIXED behaviour: green = defect gone. It drives the real CheckoutWebhookHandlerService and the real
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

let fanoutIndex: any[] = [];
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'fanout' && v && typeof v === 'object' && 'isNot' in v) {
      return fanoutIndex.some((f) => f.purchase_id === row.id);
    }
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(row[k]);
    if (v && typeof v === 'object' && 'notIn' in v) return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== (v as { not: unknown }).not;
    return row[k] === v;
  });
}

function makeDb() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const fanoutRows: any[] = [];
  fanoutIndex = fanoutRows;
  const markers: any[] = [];
  const uniqueViolations: string[] = [];
  const db: any = {
    _packages: packages,
    _purchases: purchases,
    _fanoutRows: fanoutRows,
    _markers: markers,
    _uniqueViolations: uniqueViolations,
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
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
      findMany: jest.fn(async ({ where, take }: any) =>
        purchases.filter((p) => matchesWhere(p, where)).slice(0, take ?? undefined).map((p) => ({ ...p })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    purchaseFanout: {
      findUnique: jest.fn(async ({ where }: any) => fanoutRows.find((r) => r.purchase_id === where.purchase_id) ?? null),
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

describe('AUD-OPUS-661E-120 replay of the 116 hosted probe: the round-2 widening defects stay closed', () => {
  it('FIXED (single session): hosted decline -> in-page retry succeeds -> payment_intent.succeeded leaves the hosted row to its session; checkout.session.completed activates it exactly once', async () => {
    const { svc, db, onPurchaseEntitled } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: 4, name: 'Hosted 4' });
    db._purchases.push(hostedRow('cp-h', 'cs_test_h', '2026-10-03T12:00:00Z'));
    const d = await deliver(svc, db, decline('pi_h'));
    expect(d).toMatchObject({ claimed: true, purchase_id: 'cp-h' });
    const s = await deliver(svc, db, piSucceeded('pi_h', 'ch_h'));
    expect(s.claimed).toBe(false);
    expect(s.deferredSplit).toBeUndefined();
    expect(db._purchases[0].entitlement_active).toBe(false);
    const c = await deliver(svc, db, sessionCompleted('cs_test_h', 'pi_h'));
    expect(c.claimed).toBe(true);
    expect(db._purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(db._uniqueViolations).toEqual([]);
    // A redelivered success never activates or splits a second time.
    const again = await deliver(svc, db, { ...piSucceeded('pi_h', 'ch_h'), id: 'evt_ok_pi_h_again' });
    expect(again.deferredSplit).toBeUndefined();
    expect(onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('FIXED (two open sessions): the success of session A never activates the row of session B that a decline adopted', async () => {
    const { svc, db, onPurchaseEntitled } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: null, name: 'Hosted' });
    db._purchases.push(hostedRow('cp-A', 'cs_A', '2026-10-02T23:50:00Z'));
    db._purchases.push(hostedRow('cp-B', 'cs_B', '2026-10-03T00:10:00Z'));
    await deliver(svc, db, decline('pi_A'));
    const rowA = db._purchases.find((p: any) => p.id === 'cp-A');
    const rowB = db._purchases.find((p: any) => p.id === 'cp-B');
    const c = await deliver(svc, db, sessionCompleted('cs_A', 'pi_A'));
    expect(c.claimed).toBe(true);
    expect(rowA).toMatchObject({ status: 'paid', entitlement_active: true });
    const s = await deliver(svc, db, piSucceeded('pi_A', 'ch_A'));
    expect(s.claimed).toBe(false);
    expect(s.deferredSplit).toBeUndefined();
    expect(rowB.entitlement_active).toBe(false);
    expect(onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('(control) a PaymentSheet row (stripe_checkout_session_id === PaymentIntent id) is activated by its success and its credentials erased', async () => {
    const { svc, db } = makeHandler();
    db._packages.push({ id: 'pkg-h', coach_id: 'coach-1', billing_type: 'one_time', name: 'Sheet' });
    db._purchases.push({
      ...hostedRow('cp-ps', 'pi_ps', '2026-10-03T12:00:00Z'),
      stripe_payment_intent_id: 'pi_ps',
      stripe_client_secret: 'pi_ps_secret_x',
      stripe_ephemeral_key: 'ek_test_x',
    });
    await deliver(svc, db, decline('pi_ps'));
    expect(db._purchases[0]).toMatchObject({ status: 'payment_failed', stripe_client_secret: 'pi_ps_secret_x' });
    const s = await deliver(svc, db, piSucceeded('pi_ps', 'ch_ps'));
    expect(s.claimed).toBe(true);
    expect(db._purchases[0]).toMatchObject({ status: 'paid', entitlement_active: true, stripe_client_secret: null, stripe_ephemeral_key: null });
  });
});
