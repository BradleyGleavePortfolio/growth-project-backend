// FIX-1181-MAIN (agent 198) — B-TEST for the b#1181 x main (GC-3) merge.
// A web trial saves a card and charges nothing (GC-3). The in-app rule
// (checkout-webhook-handler.service.ts maybeEmitInvoicePayment): "A trial's
// card save or a $0 invoice never consumes it" — the coach's once-ever
// first-payment notice. With FEATURE_ROMAN_FIRST_PAYMENT on, b#1181's
// conversion step must not claim it at the card save, and must not report an
// amount Stripe never collected. GC-3's own rule: no PaymentIntent lookup on
// a trial. The fixture is GC-3's in-memory database (test/gc3-web-trial.spec.ts).
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';

type Row = Record<string, any>;
function cast<T>(v: unknown): T {
  return v as T;
}

const COACH = 'coach-alex';
const PKG = 'pkg-trial';
const DAY = 86_400_000;

function makeDb() {
  let state = {
    guestCheckout: [] as Row[],
    user: [] as Row[],
    clientPurchase: [] as Row[],
    packageTrialUsage: [] as Row[],
    stripeProcessedEvent: [] as Row[],
  };
  // EmailSendLog lives outside `state`: a send record is written outside any
  // transaction, so a rolled-back transaction must not erase it (Postgres).
  const mail: Row[] = [];
  let seq = 0;
  let lock: Promise<unknown> = Promise.resolve();
  const id = (p: string) => `${p}-${++seq}`;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return (v.in as unknown[]).includes(row[k]);
        if ('gt' in v) return row[k] > v.gt;
        if ('gte' in v || 'lte' in v) return (!('gte' in v) || row[k] >= v.gte) && (!('lte' in v) || row[k] <= v.lte);
        if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
        if ('equals' in v) return String(row[k]).toLowerCase() === String(v.equals).toLowerCase();
        return false;
      }
      return row[k] === v;
    });
  const pkg = {
    id: PKG,
    coach_id: COACH,
    name: 'Monthly Coaching',
    amount_cents: 14900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    trial_days: 7,
    share_token: 'tok_trial_page_012345',
    coach: { id: COACH, name: 'Alex' },
  };
  const withPkg = (r: Row | undefined) => (r ? { ...r, package: pkg } : null);
  const db: any = {
    guestCheckout: {
      findUnique: async ({ where }: any) => withPkg(state.guestCheckout.find((r) => matches(r, where))),
      findFirst: async ({ where }: any) => withPkg(state.guestCheckout.find((r) => matches(r, where))),
      updateMany: async ({ where, data }: any) => {
        const hit = state.guestCheckout.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: any) => {
        const r = state.guestCheckout.find((x) => matches(x, where));
        if (!r) throw new Error('not found');
        return Object.assign(r, data);
      },
    },
    user: {
      upsert: async ({ where, create }: any) => {
        const found = state.user.find((r) => matches(r, where));
        if (found) return found;
        const row = { id: id('user'), created_at: new Date(), ...create };
        state.user.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(state.user.find((r) => matches(r, where))!, data),
      findFirst: async ({ where }: any) => state.user.find((r) => matches(r, where)) ?? null,
    },
    clientPurchase: {
      findFirst: async ({ where }: any) => state.clientPurchase.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: any) => {
        if (state.clientPurchase.some((r) => r.idempotency_key === data.idempotency_key)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: id('purchase'), trial_started_at: null, cancel_at_period_end: false, created_at: new Date(), ...data };
        state.clientPurchase.push(row);
        return row;
      },
    },
    packageTrialUsage: {
      findUnique: async ({ where }: any) => {
        const w = where.client_user_id_coach_user_id ?? where;
        return state.packageTrialUsage.find((r) => matches(r, w)) ?? null;
      },
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          const dup = state.packageTrialUsage.some(
            (r) =>
              r.purchase_id === d.purchase_id ||
              (r.client_user_id === d.client_user_id && r.coach_user_id === d.coach_user_id),
          );
          if (!dup) {
            state.packageTrialUsage.push({ id: id('usage'), ...d });
            count += 1;
          }
        }
        return { count };
      },
      updateMany: async ({ where, data }: any) => {
        const hit = state.packageTrialUsage.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    emailSendLog: {
      findMany: async ({ where }: any) => mail.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      create: async ({ data }: any) => {
        if (mail.some((r) => r.idempotency_key === data.idempotency_key)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: id('mail'), created_at: new Date(), sent_at: null, error: null, ...data };
        mail.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => Object.assign(mail.find((r) => matches(r, where))!, data),
    },
    stripeProcessedEvent: {
      findUnique: async ({ where }: any) => state.stripeProcessedEvent.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: any) => {
        if (state.stripeProcessedEvent.some((r) => r.stripe_event_id === data.stripe_event_id)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        state.stripeProcessedEvent.push({ ...data });
        return data;
      },
      updateMany: async () => ({ count: 1 }),
    },
    connectAccount: { findUnique: async () => ({ stripe_account_id: 'acct_alex' }) },
    // One transaction at a time (Postgres would block the second claim of
    // the same client + coach on the unique index until the first commits).
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const turn = lock.then(async () => {
        const before = structuredClone(state);
        try {
          return await fn(db);
        } catch (err) {
          state = before;
          throw err;
        }
      });
      lock = turn.then(() => null, () => null);
      return turn;
    },
  };
  const addCheckout = (over: Row = {}) => {
    const n = state.guestCheckout.length + 1;
    const row = {
      id: `gc-${n}`,
      status: 'pending',
      stripe_payment_intent_id: `seti_webtrial0${n}`,
      stripe_subscription_id: `sub_webtrial0${n}`,
      stripe_customer_id: `cus_webtrial0${n}`,
      guest_email: 'jane@example.com',
      guest_name: 'Jane',
      package_id: PKG,
      idempotency_key: `idem-key-trial-${n}`,
      landing_page_id: null,
      expires_at: new Date(Date.now() + DAY),
      created_at: new Date(),
      retry_count: 0,
      last_error: null,
      receipt_url: null,
      package_snapshot: { price_cents: 14900, trial_days: 7 },
      ...over,
    };
    state.guestCheckout.push(row);
    return row;
  };
  return { db, addCheckout, matches, get state() { return state; }, mail, pkg };
}

function build(world: ReturnType<typeof makeDb>) {
  const stripe: any = {
    retrieveSubscription: jest.fn(async (subId: string) => ({
      id: subId,
      status: 'trialing',
      trial_end: Math.floor((Date.now() + 7 * DAY) / 1000),
    })),
    retrieveSetupIntent: jest.fn(async (siId: string) => ({
      id: siId,
      status: 'succeeded',
      payment_method: 'pm_card_saved',
      client_secret: `${siId}_secret_z`,
    })),
    setSubscriptionDefaultPaymentMethod: jest.fn(async () => ({})),
    cancelSubscription: jest.fn(async () => ({})),
    cancelSetupIntent: jest.fn(async (siId: string) => ({ id: siId, status: 'canceled' })),
    retrievePaymentIntent: jest.fn(async () => {
      throw new Error('a trial has no PaymentIntent');
    }),
    retrieveCharge: jest.fn(),
  };
  const supabase = {
    getClient: () => ({
      auth: {
        admin: {
          createUser: jest.fn(async () => ({ data: { user: { id: 'sb-jane' } }, error: null })),
          listUsers: jest.fn(),
          generateLink: jest.fn(async () => ({ data: { properties: { action_link: 'https://auth.example.com/x' } }, error: null })),
        },
      },
    }),
  };
  const config = {
    get: (k: string) =>
      ({ RESEND_API_KEY: 'test-resend', EMAIL_FROM_ADDRESS: 'TGP <hello@example.com>' } as Record<string, string>)[k],
  };
  const fanout = { onPurchaseEntitled: jest.fn(async () => undefined), flushAlerts: jest.fn(), discardPendingAlerts: jest.fn() };
  const firstPayment = { tryEmitFirstPayment: jest.fn(async () => undefined) };
  const service = new GuestCheckoutService(
    world.db,
    stripe,
    cast(supabase),
    cast(config),
    cast({ createNotification: jest.fn(async () => ({})) }),
    cast({}),
    cast({}),
    undefined,
    undefined,
    cast(fanout),
    undefined,
    new TrialUsageService(world.db),
    cast(firstPayment),
  );
  return { service, stripe, firstPayment };
}

describe('FIX-1181-MAIN B-TEST: a web trial card save is not the coach\'s first payment', () => {
  const FLAG = 'FEATURE_ROMAN_FIRST_PAYMENT';
  const before = process.env[FLAG];
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env[FLAG] = 'true';
    global.fetch = cast<typeof fetch>(jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as Response)));
  });
  afterAll(() => {
    global.fetch = realFetch;
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  });

  it('flag on: a web trial converts (nothing charged) without claiming the first-payment notice or reading a PaymentIntent', async () => {
    const world = makeDb();
    const gc = world.addCheckout();
    const { service, stripe, firstPayment } = build(world);

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.guestCheckout[0].status).toBe('converted');
    expect(world.state.clientPurchase[0]).toMatchObject({ status: 'trialing', trial_days: 7 });
    // GC-3: nothing charged, so no PaymentIntent lookup on a trial.
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    // In-app rule: a trial's card save never consumes the once-ever notice.
    expect(firstPayment.tryEmitFirstPayment).not.toHaveBeenCalled();
  });
});
