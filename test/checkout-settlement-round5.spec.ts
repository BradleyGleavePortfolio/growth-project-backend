// #661 round 5 (agent 117, B-661-R5-117): Sol B-661-3 and B-661-8, Opus
// C-661-8 and C-661-9. The real handler and the real PurchaseFanoutService on
// an in-memory Prisma double that behaves like the tables it stands for:
//   - every write of a ClientPurchase row bumps `_xmin`, PostgreSQL's row
//     version (xmin), whatever the clock says;
//   - reads return snapshots; `update` with a where beyond the id is a
//     compare-and-set that throws P2025 when no row matches;
//   - $queryRaw answers the row-version read and the row locks by their SQL.
// Interleavings are injected between a read and the write that follows it.
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

const SEEDED = new Date('2026-10-04T05:00:00.000Z');

class StripeStub extends StripeConnectApiService {
  piStatus = 'succeeded';
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
  retrievePaymentIntent = jest.fn(async (id: string) => ({
    id,
    status: this.piStatus,
    latest_charge: `ch_of_${id}`,
  }));
}

type Row = Record<string, any>;

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((branch) => matchesWhere(row, branch));
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    if (v && typeof v === 'object' && 'in' in v)
      return (v as { in: unknown[] }).in.includes(row[k]);
    if (v && typeof v === 'object' && 'notIn' in v)
      return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
    return row[k] === v;
  });
}

function makeHarness() {
  const purchases: Row[] = [];
  const drops: Row[] = [];
  const fanoutRows: Row[] = [];
  const isActivated = (p: Row) => fanoutRows.some((r) => r.purchase_id === p.id);
  const markers: string[] = [];
  const uniqueViolations: string[] = [];
  const rawSql: string[] = [];
  const snapshot = (row: Row | undefined) => (row ? { ...row } : null);
  const write = (row: Row, data: Row) =>
    Object.assign(row, data, { updated_at: new Date(), _xmin: row._xmin + 1 });
  const db: any = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      rawSql.push(sql);
      if (!sql.includes('"ClientPurchase"')) return [];
      if (sql.includes('stripe_payment_intent_id')) {
        return purchases
          .filter((p) => p.stripe_payment_intent_id === vals[0])
          .map((p) => ({ id: p.id }));
      }
      const row = purchases.find((p) => p.id === vals[0]);
      return row ? [{ status: row.status, row_version: String(row._xmin) }] : [];
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
    coachPackage: {
      findUnique: jest.fn(async () => ({
        id: 'pkg-r5',
        coach_id: 'coach-1',
        billing_type: 'one_time',
        duration_periods: 4,
      })),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        snapshot(
          purchases.find((p) =>
            where.stripe_checkout_session_id
              ? p.stripe_checkout_session_id === where.stripe_checkout_session_id
              : p.id === where.id,
          ),
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        snapshot(purchases.find((p) => matchesWhere(p, where))),
      ),
      findMany: jest.fn(async ({ where: { fanout: hasFanout, ...where } }: any) =>
        purchases.filter((p) => matchesWhere(p, where) && (!hasFanout || isActivated(p))),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => matchesWhere(p, where));
        if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        write(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        for (const row of rows) write(row, data);
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
        fanoutRows.push({ id: `fo-${create.purchase_id}`, ...create });
        return create;
      }),
    },
    coachPackageContent: { findMany: jest.fn(async () => []) },
    scheduledDrop: {
      createMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = drops.filter((d) => matchesWhere(d, where));
        for (const d of rows) Object.assign(d, data);
        return { count: rows.length };
      }),
    },
    user: { findUnique: jest.fn(async () => ({ id: 'c1' })) },
    dripResolverMarker: {
      // ON CONFLICT DO NOTHING (createMany + skipDuplicates), like the real
      // claim: a duplicate is recorded here and inserts nothing.
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          const key = `${row.purpose}|${row.purchase_id}|${row.content_id}`;
          if (markers.includes(key)) {
            uniqueViolations.push(key);
            continue;
          }
          markers.push(key);
          count += 1;
        }
        return { count };
      }),
    },
  };
  const stripe = new StripeStub();
  const splits = { onChargeSucceeded: jest.fn() };
  const firstPayment = { tryEmitFirstPayment: jest.fn(async () => undefined) };
  const fanout = new PurchaseFanoutService();
  const onPurchaseEntitled = jest.spyOn(fanout, 'onPurchaseEntitled');
  // Partial doubles of the split and first-payment services.
  const splitsWiring: any = splits;
  const firstPaymentWiring: any = firstPayment;
  const svc = new CheckoutWebhookHandlerService(
    db,
    stripe,
    splitsWiring,
    undefined,
    undefined,
    fanout,
    undefined,
    undefined,
    firstPaymentWiring,
  );
  return {
    svc,
    db,
    stripe,
    splits,
    firstPayment,
    purchases,
    drops,
    fanoutRows,
    uniqueViolations,
    rawSql,
    onPurchaseEntitled,
  };
}

type Harness = ReturnType<typeof makeHarness>;
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };

// BillingService.handleEvent order: prefetch out of the tx, then handle in it.
async function deliver(h: Harness, event: Event) {
  return h.svc.handle(event, h.db, await h.svc.prefetchForOuterTx(event));
}

const PI = 'pi_r5';
const decline = (eventId: string): Event => ({
  id: eventId,
  type: 'payment_intent.payment_failed',
  data: { object: { id: PI, last_payment_error: { message: 'card_declined' } } },
});
const success = (eventId = 'evt_r5_ok'): Event => ({
  id: eventId,
  type: 'payment_intent.succeeded',
  data: { object: { id: PI, latest_charge: `ch_${eventId}` } },
});
const completed = (eventId = 'evt_r5_cs'): Event => ({
  id: eventId,
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_r5', payment_intent: PI, customer: 'cus_1', mode: 'payment' } },
});

function hostedRow(overrides: Row = {}): Row {
  return {
    id: 'cp-r5',
    client_user_id: 'c1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-r5',
    amount_cents: 10000,
    currency: 'usd',
    billing_type: 'one_time',
    stripe_checkout_session_id: 'cs_r5',
    stripe_payment_intent_id: null,
    stripe_subscription_id: null,
    stripe_customer_id: 'cus_1',
    status: 'pending',
    entitlement_active: false,
    access_expires_at: null,
    last_error: null,
    stripe_client_secret: null,
    stripe_ephemeral_key: null,
    created_at: SEEDED,
    updated_at: SEEDED,
    _xmin: 1,
    ...overrides,
  };
}
// A PaymentSheet purchase: its stripe_checkout_session_id is its PaymentIntent id.
function sheetRow(overrides: Row = {}): Row {
  return hostedRow({
    stripe_checkout_session_id: PI,
    stripe_payment_intent_id: PI,
    stripe_client_secret: 'pi_r5_secret_canary',
    stripe_ephemeral_key: 'ek_test_canary',
    ...overrides,
  });
}

// A hosted checkout that completed while its asynchronous payment was still
// processing: provisionally paid, activated once (fanout row, drops).
async function completedHosted(h: Harness) {
  h.purchases.push(hostedRow());
  const result = await deliver(h, completed());
  expect(result.claimed).toBe(true);
  h.drops.push(
    { id: 'd-pending', client_purchase_id: 'cp-r5', status: 'pending', failure_reason: null },
    { id: 'd-due', client_purchase_id: 'cp-r5', status: 'due', failure_reason: null },
    { id: 'd-fired', client_purchase_id: 'cp-r5', status: 'fired', failure_reason: null },
  );
  return h.purchases[0];
}

function expectPaidAndEntitled(row: Row) {
  expect(row).toMatchObject({ status: 'paid', entitlement_active: true, last_error: null });
}

// Fake only the clock: `new Date()` returns the given instant.
function freezeClockAt(now: number) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'nextTick',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete process.env.FEATURE_ROMAN_FIRST_PAYMENT;
});

describe('B-661-3 round 5: a successful settlement is never revoked by an older failure', () => {
  it('the success writes in the same millisecond as the version an old failure was read against: the old failure is retried, never applied', async () => {
    freezeClockAt(SEEDED.getTime());
    const h = makeHarness();
    const row = await completedHosted(h);
    h.stripe.piStatus = 'requires_payment_method';
    const oldDecline = decline('evt_r5_old');
    const stale = await h.svc.prefetchForOuterTx(oldDecline);
    expect(stale.paymentIntentStatusById).toEqual({ [PI]: 'requires_payment_method' });

    // A later attempt of the same PaymentIntent succeeds and its event is
    // applied in the same application-clock millisecond.
    h.stripe.piStatus = 'succeeded';
    const confirmed = await deliver(h, success());
    expect(confirmed.claimed).toBe(false);
    expect(row.updated_at.getTime()).toBe(SEEDED.getTime());

    await expect(h.svc.handle(oldDecline, h.db, stale)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(row);
    expect(h.drops.map((d) => d.status)).toEqual(['pending', 'due', 'fired']);

    // Stripe redelivers it; the fresh read says the PaymentIntent succeeded.
    expect((await deliver(h, oldDecline)).reason).toBe('stale_failure');
    expectPaidAndEntitled(row);
  });

  it('(control) a success written a millisecond later is detected as well', async () => {
    const h = makeHarness();
    const row = await completedHosted(h);
    h.stripe.piStatus = 'requires_payment_method';
    const oldDecline = decline('evt_r5_old_ms');
    const stale = await h.svc.prefetchForOuterTx(oldDecline);
    freezeClockAt(SEEDED.getTime() + 1);
    h.stripe.piStatus = 'succeeded';
    await deliver(h, success());
    await expect(h.svc.handle(oldDecline, h.db, stale)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(row);
  });

  it('a decline of a settled purchase checks the row version under a row lock before it ends access', async () => {
    const h = makeHarness();
    const row = await completedHosted(h);
    h.stripe.piStatus = 'requires_payment_method';
    h.rawSql.length = 0;
    await deliver(h, decline('evt_r5_real'));
    expect(row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(h.rawSql).toContainEqual(expect.stringMatching(/xmin.*"ClientPurchase".*FOR NO KEY UPDATE/s));
  });

  it('an activated hosted purchase whose payment really failed is recovered when the same PaymentIntent then succeeds: access and drops come back, nothing runs twice', async () => {
    process.env.FEATURE_ROMAN_FIRST_PAYMENT = 'true';
    const h = makeHarness();
    const row = await completedHosted(h);
    h.drops.push({
      id: 'd-refund',
      client_purchase_id: 'cp-r5',
      status: 'canceled',
      failure_reason: 'canceled:refund',
    });
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.firstPayment.tryEmitFirstPayment).toHaveBeenCalledTimes(1);

    // The asynchronous payment fails: access ends, pending drops canceled.
    h.stripe.piStatus = 'requires_payment_method';
    expect((await deliver(h, decline('evt_r5_async_fail'))).claimed).toBe(true);
    expect(row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(h.drops.map((d) => [d.id, d.status])).toEqual([
      ['d-pending', 'canceled'],
      ['d-due', 'canceled'],
      ['d-fired', 'fired'],
      ['d-refund', 'canceled'],
    ]);

    // The same PaymentIntent then succeeds.
    h.stripe.piStatus = 'succeeded';
    const recovered = await deliver(h, success('evt_r5_recovered'));
    expect(recovered).toEqual({ claimed: true, purchase_id: 'cp-r5', reason: 'payment_recovered' });
    expectPaidAndEntitled(row);
    expect(h.drops.map((d) => [d.id, d.status, d.failure_reason])).toEqual([
      ['d-pending', 'pending', null],
      ['d-due', 'pending', null],
      ['d-fired', 'fired', null],
      ['d-refund', 'canceled', 'canceled:refund'],
    ]);
    // Activation ran once: no second fanout, first-payment notice or split.
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.firstPayment.tryEmitFirstPayment).toHaveBeenCalledTimes(1);
    expect(recovered.deferredSplit).toBeUndefined();
    expect(h.fanoutRows).toHaveLength(1);
    expect(h.uniqueViolations).toEqual([]);

    // A redelivery of the success changes nothing.
    expect((await deliver(h, success('evt_r5_recovered'))).claimed).toBe(false);
    expectPaidAndEntitled(row);
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('a late completion event never re-activates a purchase that was activated and then really failed', async () => {
    const h = makeHarness();
    const row = await completedHosted(h);
    h.stripe.piStatus = 'requires_payment_method';
    await deliver(h, decline('evt_r5_fail_then_cs'));
    expect(row).toMatchObject({ status: 'payment_failed', entitlement_active: false });

    const again = await deliver(h, completed('evt_r5_cs_late'));
    expect(again).toEqual({ claimed: true, purchase_id: 'cp-r5', reason: 'already_progressed' });
    expect(row).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('(control) a hosted purchase a decline marked failed before its checkout completed still waits for that completion', async () => {
    const h = makeHarness();
    h.purchases.push(hostedRow({ status: 'payment_failed', stripe_payment_intent_id: PI }));
    const result = await deliver(h, success());
    expect(result).toEqual({ claimed: false, reason: 'checkout_session_activates' });
    expect(h.purchases[0]).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    const activated = await deliver(h, completed());
    expect(activated.claimed).toBe(true);
    expectPaidAndEntitled(h.purchases[0]);
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('(control) a PaymentSheet decline then a successful retry of the same PaymentIntent activates once', async () => {
    const h = makeHarness();
    h.purchases.push(sheetRow());
    await deliver(h, decline('evt_r5_sheet_decline'));
    expect(h.purchases[0].status).toBe('payment_failed');
    const result = await deliver(h, success());
    expect(result).toMatchObject({ claimed: true, purchase_id: 'cp-r5' });
    expect(result.deferredSplit).toMatchObject({ purchase: { id: 'cp-r5' } });
    expect(h.purchases[0]).toMatchObject({
      status: 'paid',
      entitlement_active: true,
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
    });
    expect(h.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });
});

describe('B-661-8 round 5: a successful retry never overwrites a state committed after its read', () => {
  // The success reads the purchase; `between` commits before its write.
  async function successWithInterleaving(h: Harness, between: (row: Row) => void) {
    const event = success();
    const prefetched = await h.svc.prefetchForOuterTx(event);
    const read = h.db.clientPurchase.findFirst.getMockImplementation();
    h.db.clientPurchase.findFirst.mockImplementationOnce(async (args: unknown) => {
      const seen = await read(args);
      between(h.purchases[0]);
      return seen;
    });
    return { event, prefetched, run: () => h.svc.handle(event, h.db, prefetched) };
  }

  it.each([
    ['refunded', false],
    ['canceled', false],
    ['expired', false],
    ['disputed', true],
    ['chargeback_lost', false],
  ])(
    'a purchase that became %s after the retry read it stays so (entitled: %s)',
    async (terminal, entitled) => {
      const h = makeHarness();
      h.purchases.push(sheetRow({ status: 'payment_failed' }));
      const { run } = await successWithInterleaving(h, (row) => {
        Object.assign(row, {
          status: terminal,
          entitlement_active: entitled,
          _xmin: row._xmin + 1,
        });
      });
      await expect(run()).rejects.toThrow(ServiceUnavailableException);
      expect(h.purchases[0]).toMatchObject({ status: terminal, entitlement_active: entitled });
      expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
      expect(h.fanoutRows).toHaveLength(0);

      // Stripe redelivers the success: the terminal state stands.
      const again = await deliver(h, success());
      expect(again.claimed).toBe(false);
      expect(h.purchases[0]).toMatchObject({ status: terminal, entitlement_active: entitled });
    },
  );

  it('a refund committed after a pending PaymentSheet purchase was read is not overwritten either', async () => {
    const h = makeHarness();
    h.purchases.push(sheetRow());
    const { run } = await successWithInterleaving(h, (row) => {
      Object.assign(row, { status: 'refunded', _xmin: row._xmin + 1 });
    });
    await expect(run()).rejects.toThrow(ServiceUnavailableException);
    expect(h.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('two deliveries of a success race: only the one that wins the write activates (one fanout, one split)', async () => {
    const h = makeHarness();
    h.purchases.push(sheetRow({ status: 'payment_failed' }));
    const winner = { result: undefined as unknown };
    const { run } = await successWithInterleaving(h, (row) => {
      // The other delivery activates first.
      Object.assign(row, { status: 'paid', entitlement_active: true, _xmin: row._xmin + 1 });
      h.fanoutRows.push({ id: 'fo-cp-r5', purchase_id: row.id, entrypoint: 'in_app_ps' });
      winner.result = 'activated';
    });
    await expect(run()).rejects.toThrow(ServiceUnavailableException);
    expect(winner.result).toBe('activated');
    expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(h.fanoutRows).toHaveLength(1);
    expect(h.splits.onChargeSucceeded).not.toHaveBeenCalled();
  });

  it('inside the webhook transaction the purchases of the PaymentIntent are locked before they are read', async () => {
    const h = makeHarness();
    h.purchases.push(sheetRow());
    const event = success();
    const prefetched = await h.svc.prefetchForOuterTx(event);
    h.db.$queryRaw.mockClear();
    h.db.clientPurchase.findFirst.mockClear();
    await h.svc.handle(event, h.db, prefetched);
    const lockIndex = h.db.$queryRaw.mock.calls.findIndex(([strings]: [TemplateStringsArray]) =>
      /"ClientPurchase" WHERE stripe_payment_intent_id = .*FOR NO KEY UPDATE/s.test(strings.join('?')),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(h.db.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      h.db.clientPurchase.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('(control) a refund already committed before the read is left alone', async () => {
    const h = makeHarness();
    h.purchases.push(sheetRow({ status: 'refunded' }));
    const result = await deliver(h, success());
    expect(result.claimed).toBe(false);
    expect(h.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(h.db.clientPurchase.update).not.toHaveBeenCalled();
  });
});

describe('C-661-8: only a 404 or 400 from Stripe drops a decline of a settled purchase', () => {
  it.each([401, 403])(
    'a %s (revoked or rotated key) is retried: Stripe redelivers, access unchanged',
    async (httpStatus) => {
      const h = makeHarness();
      const row = await completedHosted(h);
      h.stripe.retrievePaymentIntent.mockRejectedValue(
        new StripeConnectApiError('key', httpStatus, 'api_key_invalid', 'authentication_error'),
      );
      await expect(deliver(h, decline(`evt_r5_${httpStatus}`))).rejects.toThrow(
        ServiceUnavailableException,
      );
      expectPaidAndEntitled(row);
    },
  );

  it.each([404, 400])(
    'a %s is permanent: not applied, logged at error level with ids and the code',
    async (httpStatus) => {
      const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const h = makeHarness();
      const row = await completedHosted(h);
      h.stripe.retrievePaymentIntent.mockRejectedValue(
        new StripeConnectApiError('gone', httpStatus, 'resource_missing', 'invalid_request_error'),
      );
      const result = await deliver(h, decline(`evt_r5_${httpStatus}`));
      expect(result).toEqual({
        claimed: true,
        purchase_id: 'cp-r5',
        reason: 'payment_intent_unreadable',
      });
      expectPaidAndEntitled(row);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(
          `PaymentIntent ${PI} cannot be read (stripe_${httpStatus}_resource_missing)`,
        ),
      );
    },
  );
});

describe('C-661-9: the completion write fence', () => {
  it('a refund committed between the completion reading the purchase and activating it wins; the redelivery is a no-op', async () => {
    const h = makeHarness();
    h.purchases.push(hostedRow({ stripe_payment_intent_id: PI }));
    const event = completed();
    const prefetched = await h.svc.prefetchForOuterTx(event);
    const read = h.db.clientPurchase.findUnique.getMockImplementation();
    h.db.clientPurchase.findUnique.mockImplementationOnce(async (args: unknown) => {
      const seen = await read(args);
      Object.assign(h.purchases[0], { status: 'refunded', _xmin: h.purchases[0]._xmin + 1 });
      return seen;
    });
    await expect(h.svc.handle(event, h.db, prefetched)).rejects.toMatchObject({ code: 'P2025' });
    expect(h.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(h.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(h.fanoutRows).toHaveLength(0);

    const again = await deliver(h, completed());
    expect(again).toEqual({ claimed: true, purchase_id: 'cp-r5', reason: 'already_progressed' });
    expect(h.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
  });
});
