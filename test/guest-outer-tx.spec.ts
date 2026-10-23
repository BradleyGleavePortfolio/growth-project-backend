import { BillingService } from '../src/billing/billing.service';
import {
  GUEST_CHECKOUT_METADATA_KEY,
  GuestCheckoutService,
} from '../src/storefront/guest-checkout.service';
import { GuestCheckoutReconciliationService } from '../src/storefront/guest-checkout-reconciliation.service';

// GUEST-OUTER-TX (agent 170) — the real BillingService → GuestCheckoutService
// web-purchase path on an in-memory database whose $transaction behaves like
// Prisma's interactive transaction: the budget BillingService passes (none,
// so Prisma's defaults: timeout 5,000 ms, maxWait 2,000 ms) expires the
// transaction, a query on an expired transaction fails with P2028, and a
// thrown callback rolls its writes back. Every Supabase / Stripe / email call
// records whether a transaction was open when it was made.
//
// Before the fix the Supabase account setup, the receipt lookup and the
// Stripe subscription read ran inside BillingService's webhook transaction,
// so a provider slower than 5 s failed the paid delivery (P2028 on the
// handler-completed write) and every provider call below happened with a
// transaction open.

const PROD_TX_TIMEOUT_MS = 5_000; // Prisma default; PrismaService passes no transactionOptions
const PROD_TX_MAX_WAIT_MS = 2_000;
const COACH = 'coach-k';
const PKG_ONE = 'pkg-one';
const PKG_REC = 'pkg-rec';

type Row = Record<string, any>;
type Call = { name: string; openTx: number };

function p2028(timeout: number): Error {
  return Object.assign(
    new Error(
      `Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was ${timeout} ms`,
    ),
    { code: 'P2028' },
  );
}
function p2002(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (k === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    const v = row[k];
    if (cond === null) return v == null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      const c = cond as Row;
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && v === c.not) return false;
      if ('gt' in c && !(v != null && num(v) > num(c.gt))) return false;
      if ('gte' in c && !(v != null && num(v) >= num(c.gte))) return false;
      if ('lt' in c && !(v != null && num(v) < num(c.lt))) return false;
      if ('lte' in c && !(v != null && num(v) <= num(c.lte))) return false;
      return true;
    }
    return v === cond;
  });
}

const UNIQUE: Record<string, string[]> = {
  stripeProcessedEvent: ['stripe_event_id'],
  user: ['supabase_id'],
  clientPurchase: ['idempotency_key'],
  guestCheckout: ['stripe_payment_intent_id'],
};

class FakeDb {
  tables: Record<string, Row[]> = {
    stripeProcessedEvent: [],
    guestCheckout: [],
    user: [],
    clientPurchase: [],
    connectAccount: [],
  };
  packages: Record<string, Row> = {};
  openTx = 0;
  txOptions: Array<Row | undefined> = [];
  seq = 0;
  failNextClaimInTx = false;

  client(tx?: { expired: boolean; timeout: number; undo: Array<() => void> }): any {
    const guard = () => {
      if (tx?.expired) throw p2028(tx.timeout);
    };
    const remember = (fn: () => void) => tx?.undo.push(fn);
    const model = (name: string) => {
      const rows = () => this.tables[name];
      const withRelations = (r: Row, include?: Row) => {
        if (!r) return null;
        const out = { ...r };
        if (name === 'guestCheckout' && include?.package) out.package = this.packages[r.package_id];
        return out;
      };
      return {
        findUnique: async (a: Row) => {
          guard();
          return withRelations(rows().find((r) => matches(r, a.where)) as Row, a.include);
        },
        findFirst: async (a: Row) => {
          guard();
          return withRelations(rows().find((r) => matches(r, a?.where)) as Row, a?.include);
        },
        findMany: async (a: Row) => {
          guard();
          return rows()
            .filter((r) => matches(r, a?.where))
            .slice(0, a?.take ?? 1000)
            .map((r) => ({ ...r }));
        },
        create: async (a: Row) => {
          guard();
          for (const key of UNIQUE[name] ?? []) {
            if (a.data[key] != null && rows().some((r) => r[key] === a.data[key])) throw p2002();
          }
          const row = { id: `${name}-${++this.seq}`, ...a.data };
          rows().push(row);
          remember(() => rows().splice(rows().indexOf(row), 1));
          return { ...row };
        },
        updateMany: async (a: Row) => {
          guard();
          if (
            name === 'guestCheckout' &&
            tx &&
            this.failNextClaimInTx &&
            a.data?.status === 'paid'
          ) {
            this.failNextClaimInTx = false;
            throw new Error('connection reset');
          }
          const hit = rows().filter((r) => matches(r, a.where));
          for (const r of hit) {
            const before = { ...r };
            Object.assign(r, a.data);
            remember(() => {
              for (const k of Object.keys(r)) delete r[k];
              Object.assign(r, before);
            });
          }
          return { count: hit.length };
        },
        update: async (a: Row) => {
          guard();
          const r = rows().find((x) => matches(x, a.where));
          if (!r) throw new Error('not found');
          const before = { ...r };
          Object.assign(r, a.data);
          remember(() => Object.assign(r, before));
          return { ...r };
        },
        upsert: async (a: Row) => {
          guard();
          const r = rows().find((x) => matches(x, a.where));
          if (r) {
            Object.assign(r, a.update);
            return { ...r };
          }
          const row = { id: `${name}-${++this.seq}`, ...a.create };
          rows().push(row);
          remember(() => rows().splice(rows().indexOf(row), 1));
          return { ...row };
        },
      };
    };
    const c: any = {};
    for (const name of Object.keys(this.tables)) c[name] = model(name);
    if (!tx) {
      c.$transaction = async (cb: (t: any) => Promise<unknown>, opts?: Row) => {
        this.txOptions.push(opts);
        const timeout = opts?.timeout ?? PROD_TX_TIMEOUT_MS;
        const state = { expired: false, timeout, undo: [] as Array<() => void> };
        const timer = setTimeout(() => {
          state.expired = true;
        }, timeout);
        this.openTx += 1;
        try {
          const out = await cb(this.client(state));
          if (state.expired) throw p2028(timeout);
          return out;
        } catch (err) {
          for (const u of state.undo.reverse()) u();
          throw err;
        } finally {
          clearTimeout(timer);
          this.openTx -= 1;
        }
      };
    }
    return c;
  }
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// Drive fake timers until the promise settles (provider delays and the
// transaction budget are all setTimeout-based).
async function settle<T>(p: Promise<T>, maxMs = 120_000): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  for (let t = 0; t < maxMs && !done; t += 100) {
    await jest.advanceTimersByTimeAsync(100);
  }
  if (!done) throw new Error('promise did not settle');
  if (error) throw error;
  return value as T;
}

interface Harness {
  db: FakeDb;
  billing: BillingService;
  guest: GuestCheckoutService;
  reconciler: GuestCheckoutReconciliationService;
  calls: Call[];
  welcome: Array<{ checkoutId: string; inviteLink: string | null }>;
  fanout: { onPurchaseEntitled: jest.Mock; flushAlerts: jest.Mock; discardPendingAlerts: jest.Mock };
  settled: Array<{ pi: string; purchases: number }>;
  supabaseDelayMs: { value: number };
  stripeDelayMs: { value: number };
  createUserResult: { value: Row };
  listUsersResult: { value: Row[] };
}

function harness(): Harness {
  const db = new FakeDb();
  const prisma = db.client();
  const calls: Call[] = [];
  const welcome: Harness['welcome'] = [];
  const settled: Harness['settled'] = [];
  const supabaseDelayMs = { value: 0 };
  const stripeDelayMs = { value: 0 };
  let sbSeq = 0;
  const createUserResult: { value: Row } = { value: {} };
  const listUsersResult: { value: Row[] } = { value: [] };
  const record = (name: string) => calls.push({ name, openTx: db.openTx });

  const supabase = {
    getClient: () => ({
      auth: {
        admin: {
          createUser: (args: Row) => {
            record('supabase.createUser');
            const res = createUserResult.value.error
              ? createUserResult.value
              : { data: { user: { id: `sb-${++sbSeq}`, email: args.email } }, error: null };
            return delay(supabaseDelayMs.value, res);
          },
          generateLink: () => {
            record('supabase.generateLink');
            return delay(0, {
              data: { properties: { action_link: 'https://auth.example.com/invite' } },
              error: null,
            });
          },
          listUsers: () => {
            record('supabase.listUsers');
            return delay(supabaseDelayMs.value, { data: { users: listUsersResult.value }, error: null });
          },
        },
      },
    }),
  };
  const stripe = {
    retrievePaymentIntent: (id: string) => {
      record('stripe.retrievePaymentIntent');
      return delay(stripeDelayMs.value, { id, latest_charge: `ch_${id}` });
    },
    retrieveCharge: (id: string) => {
      record('stripe.retrieveCharge');
      return delay(stripeDelayMs.value, { id, receipt_url: `https://pay.stripe.com/receipts/${id}` });
    },
    retrieveSubscription: (id: string) => {
      record('stripe.retrieveSubscription');
      return delay(stripeDelayMs.value, { id, status: 'active' });
    },
  };
  const fanout = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    flushAlerts: jest.fn(),
    discardPendingAlerts: jest.fn(),
  };
  // Reflect.construct keeps the partial doubles untyped without a cast; the
  // services themselves are the real classes.
  const guest: GuestCheckoutService = Reflect.construct(GuestCheckoutService, [
    prisma,
    stripe,
    supabase,
    { get: () => undefined },
    { createNotification: jest.fn(async () => undefined) },
    {},
    {},
    undefined,
    undefined,
    fanout,
    undefined,
  ]);
  // The welcome email (Resend) is counted, not sent.
  Reflect.set(guest, 'sendWelcomeEmail', async (checkout: Row, inviteLink: string | null) => {
    record('email.welcome');
    welcome.push({ checkoutId: checkout.id, inviteLink });
  });
  const checkoutWebhooks = {
    handle: jest.fn(async () => ({ claimed: false })),
    settleGuestPurchase: jest.fn(async (pi: string) => {
      record('stripe.settleGuestPurchase');
      settled.push({
        pi,
        purchases: db.tables.clientPurchase.filter((p) => p.stripe_payment_intent_id === pi).length,
      });
    }),
  };
  const billing: BillingService = Reflect.construct(BillingService, [
    prisma,
    { capture: jest.fn(), identify: jest.fn() },
    { write: jest.fn(async () => undefined), list: jest.fn(async () => []) },
    undefined,
    checkoutWebhooks,
    undefined,
    guest,
  ]);
  const reconciler = new GuestCheckoutReconciliationService(prisma, guest);

  db.packages[PKG_ONE] = {
    id: PKG_ONE,
    coach_id: COACH,
    amount_cents: 29700,
    currency: 'usd',
    billing_type: 'one_time',
    coach: { id: COACH, name: 'Coach K' },
  };
  db.packages[PKG_REC] = { ...db.packages[PKG_ONE], id: PKG_REC, billing_type: 'recurring' };
  db.tables.connectAccount.push({ id: 'ca-1', coach_user_id: COACH, stripe_account_id: 'acct_k' });

  return {
    db,
    billing,
    guest,
    reconciler,
    calls,
    welcome,
    fanout,
    settled,
    supabaseDelayMs,
    stripeDelayMs,
    createUserResult,
    listUsersResult,
  };
}

function seedCheckout(h: Harness, pi: string, extra: Row = {}): Row {
  const row: Row = {
    id: `gc-${pi}`,
    idempotency_key: `idem-${pi}`,
    guest_email: `${pi}@example.com`,
    guest_name: 'Guest Buyer',
    package_id: PKG_ONE,
    stripe_payment_intent_id: pi,
    stripe_subscription_id: null,
    stripe_customer_id: 'cus_g',
    landing_page_id: null,
    status: 'pending',
    expires_at: new Date(Date.now() + 60 * 60_000),
    created_at: new Date(Date.now() - 5 * 60_000),
    retry_count: 0,
    last_retry_at: null,
    last_error: null,
    receipt_url: null,
    created_user_id: null,
    ...extra,
  };
  h.db.tables.guestCheckout.push(row);
  return row;
}

function piEvent(eventId: string, pi: string, withMetadata = true): any {
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: pi,
        metadata: withMetadata ? { [GUEST_CHECKOUT_METADATA_KEY]: `idem-${pi}` } : {},
        latest_charge: `ch_${pi}`,
      },
    },
  };
}

function providerCallsInsideTx(h: Harness): Call[] {
  return h.calls.filter((c) => c.openTx > 0);
}

describe('GUEST-OUTER-TX — web purchase setup runs after the payment save commits', () => {
  let h: Harness;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    h = harness();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a slow account setup (7 s: past the 5 s budget, inside the 10 s Supabase limit) converts on the first delivery, once', async () => {
    const row = seedCheckout(h, 'pi_slow_sb');
    h.supabaseDelayMs.value = 7_000;

    const res = await settle(h.billing.handleEvent(piEvent('evt_slow_sb', 'pi_slow_sb')));

    expect(res).toEqual({ processed: true });
    // BillingService passes no budget, so Prisma's production defaults apply.
    expect(h.db.txOptions[0]).toBeUndefined();
    expect(PROD_TX_TIMEOUT_MS).toBe(5_000);
    expect(PROD_TX_MAX_WAIT_MS).toBe(2_000);
    expect(row.status).toBe('converted');
    expect(row.created_user_id).toEqual(expect.any(String));
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.db.tables.clientPurchase[0]).toMatchObject({
      stripe_payment_intent_id: 'pi_slow_sb',
      amount_cents: 29700,
      coach_user_id: COACH,
      idempotency_key: 'guest-purchase-idem-pi_slow_sb',
      stripe_destination_account: 'acct_k',
    });
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.welcome).toHaveLength(1);
    const dedup = h.db.tables.stripeProcessedEvent.find((e) => e.stripe_event_id === 'evt_slow_sb');
    expect(dedup?.handler_completed_at).toBeInstanceOf(Date);
    expect(h.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(['supabase.createUser', 'email.welcome']),
    );
    // No Supabase / Stripe / email call while any transaction is open.
    expect(providerCallsInsideTx(h)).toEqual([]);
    // Settlement ran after the conversion committed the purchase.
    expect(h.settled).toEqual([{ pi: 'pi_slow_sb', purchases: 1 }]);
  });

  it('slow Stripe (receipt lookup and subscription read 6 s each) on a recurring first-invoice payment converts once', async () => {
    const row = seedCheckout(h, 'pi_rec_first', {
      package_id: PKG_REC,
      stripe_subscription_id: 'sub_rec',
    });
    h.stripeDelayMs.value = 6_000;

    // Stripe sends a subscription's first-invoice PaymentIntent without our
    // metadata, so no receipt pre-lookup runs before the transaction.
    const res = await settle(
      h.billing.handleEvent(piEvent('evt_rec_first', 'pi_rec_first', false)),
    );

    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('converted');
    expect(row.receipt_url).toBe('https://pay.stripe.com/receipts/ch_pi_rec_first');
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.db.tables.clientPurchase[0]).toMatchObject({
      status: 'active',
      entitlement_active: true,
      stripe_subscription_id: 'sub_rec',
    });
    expect(h.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(['stripe.retrieveCharge', 'stripe.retrieveSubscription']),
    );
    expect(providerCallsInsideTx(h)).toEqual([]);
    expect(h.welcome).toHaveLength(1);
  });

  it('Supabase past its 10 s limit: the paid claim commits, the row is retryable, and the retry converts exactly once', async () => {
    const row = seedCheckout(h, 'pi_sb_timeout');
    h.supabaseDelayMs.value = 11_000;

    const res = await settle(h.billing.handleEvent(piEvent('evt_sb_timeout', 'pi_sb_timeout')));

    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('conversion_failed_retryable');
    expect(row.retry_count).toBe(1);
    expect(row.last_error).toMatch(/^supabase:/);
    expect(h.db.tables.clientPurchase).toHaveLength(0);
    expect(h.welcome).toHaveLength(0);
    expect(providerCallsInsideTx(h)).toEqual([]);

    // Supabase recovers; the reconciler retries after its 60 s backoff.
    h.supabaseDelayMs.value = 0;
    await jest.advanceTimersByTimeAsync(61_000);
    await settle(h.reconciler.run());
    await settle(h.reconciler.run());

    expect(row.status).toBe('converted');
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.welcome).toHaveLength(1);
    // Stripe redelivers the original event: already processed, nothing new.
    const again = await settle(h.billing.handleEvent(piEvent('evt_sb_timeout', 'pi_sb_timeout')));
    expect(again).toEqual({ processed: false, alreadyProcessed: true });
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.welcome).toHaveLength(1);
  });

  it('a crash after the commit and before conversion leaves a paid row the reconciler converts once', async () => {
    const row = seedCheckout(h, 'pi_crash');
    // The process dies right after the webhook transaction commits.
    jest
      .spyOn(h.guest, 'finishPaidCheckout')
      .mockImplementationOnce(async () => {
        throw new Error('process exited');
      });

    const res = await settle(h.billing.handleEvent(piEvent('evt_crash', 'pi_crash')));

    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('paid');
    expect(row.created_user_id).toBeNull();
    expect(h.db.tables.stripeProcessedEvent).toHaveLength(1);
    expect(h.db.tables.clientPurchase).toHaveLength(0);
    expect(h.calls.filter((c) => c.name.startsWith('supabase'))).toEqual([]);

    // The orphaned-paid scan (created_at past the 2 min grace) converts it.
    await settle(h.reconciler.run());
    await settle(h.reconciler.run());
    expect(row.status).toBe('converted');
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.db.tables.user).toHaveLength(1);
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.welcome).toHaveLength(1);
    expect(h.calls.filter((c) => c.name === 'supabase.createUser')).toHaveLength(1);

    // A redelivery and a lost-webhook style direct call change nothing.
    await settle(h.billing.handleEvent(piEvent('evt_crash', 'pi_crash')));
    await settle(h.guest.handlePaymentSucceeded('pi_crash'));
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.welcome).toHaveLength(1);
    expect(providerCallsInsideTx(h)).toEqual([]);
  });

  it('duplicate webhook deliveries (sequential and concurrent) claim and convert once', async () => {
    const row = seedCheckout(h, 'pi_dup');
    h.supabaseDelayMs.value = 6_000;

    const [a, b] = await settle(
      Promise.all([
        h.billing.handleEvent(piEvent('evt_dup', 'pi_dup')),
        h.billing.handleEvent(piEvent('evt_dup', 'pi_dup')),
      ]),
    );
    const c = await settle(h.billing.handleEvent(piEvent('evt_dup', 'pi_dup')));

    const outcomes = [a, b, c];
    expect(outcomes.filter((o) => o.processed === true)).toHaveLength(1);
    expect(outcomes.filter((o) => 'alreadyProcessed' in o && o.alreadyProcessed === true)).toHaveLength(2);
    expect(row.status).toBe('converted');
    expect(h.db.tables.stripeProcessedEvent).toHaveLength(1);
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.calls.filter((x) => x.name === 'supabase.createUser')).toHaveLength(1);
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(h.welcome).toHaveLength(1);
    // Account setup ran after the winning delivery's commit.
    expect(
      h.calls.filter((x) => x.name.startsWith('supabase') && x.openTx > 0),
    ).toEqual([]);
  });

  it('a same-coach returning buyer keeps the existing account and gets one new purchase', async () => {
    h.db.tables.user.push({
      id: 'user-g',
      supabase_id: 'sb-existing',
      email: 'returning@example.com',
      name: 'Returning Buyer',
      role: 'student',
      coach_id: COACH,
    });
    const row = seedCheckout(h, 'pi_returning', { guest_email: 'returning@example.com' });
    h.supabaseDelayMs.value = 3_000; // createUser + listUsers: 6 s total, past the tx budget
    h.createUserResult.value = {
      data: { user: null },
      error: { message: 'A user with this email address has already been registered' },
    };
    h.listUsersResult.value = [{ id: 'sb-existing', email: 'returning@example.com' }];

    const res = await settle(h.billing.handleEvent(piEvent('evt_returning', 'pi_returning')));

    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('converted');
    expect(row.created_user_id).toBe('user-g');
    expect(h.db.tables.user).toHaveLength(1);
    expect(h.db.tables.user[0].coach_id).toBe(COACH);
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.db.tables.clientPurchase[0].client_user_id).toBe('user-g');
    expect(h.welcome).toEqual([{ checkoutId: row.id, inviteLink: null }]);
    expect(providerCallsInsideTx(h)).toEqual([]);
  });

  it('a database failure on the claim rolls the delivery back (dedup row too) so the redelivery converts once', async () => {
    const row = seedCheckout(h, 'pi_claim_fail');
    h.db.failNextClaimInTx = true;

    await expect(
      settle(h.billing.handleEvent(piEvent('evt_claim_fail', 'pi_claim_fail'))),
    ).rejects.toThrow('connection reset');
    expect(row.status).toBe('pending');
    expect(h.db.tables.stripeProcessedEvent).toHaveLength(0);
    expect(h.calls.filter((c) => !c.name.startsWith('stripe.retrieveCharge'))).toEqual([]);

    const res = await settle(h.billing.handleEvent(piEvent('evt_claim_fail', 'pi_claim_fail')));
    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('converted');
    expect(h.db.tables.clientPurchase).toHaveLength(1);
    expect(h.welcome).toHaveLength(1);
  });

  it('an expired checkout is not claimed and nothing is created', async () => {
    const row = seedCheckout(h, 'pi_expired', { expires_at: new Date(Date.now() - 1_000) });

    const res = await settle(h.billing.handleEvent(piEvent('evt_expired', 'pi_expired')));

    expect(res).toEqual({ processed: true });
    expect(row.status).toBe('pending');
    expect(h.calls.filter((c) => c.name.startsWith('supabase'))).toEqual([]);
    expect(h.db.tables.clientPurchase).toHaveLength(0);
  });
});
