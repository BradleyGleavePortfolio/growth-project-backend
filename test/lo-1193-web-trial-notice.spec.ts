// LO-1193 (Opus lens, b#1193 round 1) — S4 proof: a web trial gets the same
// trial-ending notice as an app trial (push and email, with the amount and
// the date). The buyer is converted by the real GuestCheckoutService (harness
// copied from gc3-web-trial.spec.ts); the purchase row it commits is then
// driven through the real webhook handler and TrialNoticeService (harness as
// b-trials-notice-and-webhook.spec.ts).
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { formatTrialDate } from '../src/packages/trials/trial-copy';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { makeTrialNoticeTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

type Row = Record<string, any>;
// Test doubles stand in for injected services; `cast` keeps the doubles typed at the call site.
function cast<T>(v: unknown): T {
  return v as T;
}

const COACH = 'coach-alex';
const PKG = 'pkg-trial';
const DAY = 86_400_000;

function makeDb(trialDays = 7) {
  let state = {
    guestCheckout: [] as Row[],
    user: [] as Row[],
    clientPurchase: [] as Row[],
    packageTrialUsage: [] as Row[],
    stripeProcessedEvent: [] as Row[],
  };
  let seq = 0;
  let lock: Promise<unknown> = Promise.resolve();
  const id = (p: string) => `${p}-${++seq}`;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return (v.in as unknown[]).includes(row[k]);
        if ('gt' in v) return row[k] > v.gt;
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
    trial_days: trialDays,
    share_token: 'tok_trial_page_012345',
    coach: { id: COACH, name: 'Alex' },
  };
  const withPkg = (r: Row | undefined) => (r ? { ...r, package: pkg } : null);
  const db: any = {
    guestCheckout: {
      findUnique: async ({ where }: any) =>
        withPkg(state.guestCheckout.find((r) => matches(r, where))),
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
      update: async ({ where, data }: any) =>
        Object.assign(
          state.user.find((r) => matches(r, where))!,
          data,
        ),
      findFirst: async ({ where }: any) => state.user.find((r) => matches(r, where)) ?? null,
    },
    clientPurchase: {
      findFirst: async ({ where }: any) =>
        state.clientPurchase.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: any) => {
        if (state.clientPurchase.some((r) => r.idempotency_key === data.idempotency_key)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: id('purchase'), trial_started_at: null, ...data };
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
    stripeProcessedEvent: {
      findUnique: async ({ where }: any) =>
        state.stripeProcessedEvent.find((r) => matches(r, where)) ?? null,
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
      lock = turn.then(
        () => null,
        () => null,
      );
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
      package_snapshot: { price_cents: 14900, trial_days: trialDays },
      ...over,
    };
    state.guestCheckout.push(row);
    return row;
  };
  return {
    db,
    addCheckout,
    get state() {
      return state;
    },
    pkg,
  };
}

function build(world: ReturnType<typeof makeDb>, trialDays = 7) {
  const stripe: any = {
    retrieveSubscription: jest.fn(async (subId: string) => ({
      id: subId,
      status: 'trialing',
      trial_end: Math.floor((Date.now() + trialDays * DAY) / 1000),
    })),
    retrieveSetupIntent: jest.fn(async (siId: string) => ({
      id: siId,
      status: 'succeeded',
      payment_method: 'pm_card_saved',
      client_secret: `${siId}_secret_z`,
    })),
    setSubscriptionDefaultPaymentMethod: jest.fn(async () => ({})),
    cancelSubscription: jest.fn(async () => ({})),
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
          generateLink: jest.fn(async () => ({
            data: { properties: { action_link: 'https://auth.example.com/x' } },
            error: null,
          })),
        },
      },
    }),
  };
  const config = {
    get: (k: string) =>
      (
        ({
          RESEND_API_KEY: 'test-resend',
          EMAIL_FROM_ADDRESS: 'TGP <hello@example.com>',
        }) as Record<string, string>
      )[k],
  };
  const fanout = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    flushAlerts: jest.fn(),
    discardPendingAlerts: jest.fn(),
  };
  const trialUsage = new TrialUsageService(world.db);
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
    trialUsage,
  );
  return { service, stripe, fanout };
}

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const event = (type: string, object: Record<string, unknown>, id: string) => ({
  id,
  type,
  data: { object },
});

// The web buyer, converted for real: returns the ClientPurchase and the trial
// ledger row exactly as convertGuestToUser committed them.
async function convertWebTrial(trialDays: number) {
  const realFetch = global.fetch;
  global.fetch = cast<typeof fetch>(
    jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
  );
  try {
    const db = makeDb(trialDays);
    const gc = db.addCheckout();
    const { service, stripe } = build(db, trialDays);
    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
    expect(db.state.guestCheckout[0].status).toBe('converted');
    expect(db.state.clientPurchase).toHaveLength(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    return {
      purchase: structuredClone(db.state.clientPurchase[0]),
      ledger: structuredClone(db.state.packageTrialUsage),
      user: structuredClone(db.state.user[0]),
    };
  } finally {
    global.fetch = realFetch;
  }
}

// The app's notice world (b-trials-notice-and-webhook.spec.ts), holding the
// converted web purchase instead of an in-app one.
function noticeWorld(converted: Awaited<ReturnType<typeof convertWebTrial>>) {
  const notices = makeTrialNoticeTable();
  const usage = makeTrialUsageTable();
  for (const r of converted.ledger) usage.rows.push({ ...r });
  // Column defaults the database fills on insert (the fake create does not).
  const purchases: Row[] = [
    { cancel_at_period_end: false, created_at: new Date(), ...converted.purchase },
  ];
  const clientEmail: string = converted.user?.email ?? 'jane@example.com';
  const prisma: any = {
    packageTrialNotice: notices,
    packageTrialUsage: usage,
    // A guest buyer has no ConnectCustomer row: a completed read, no customer default card.
    connectCustomer: { findUnique: jest.fn(async () => null) },
    notificationPreferences: {
      findUnique: jest.fn(async () => ({
        timezone: 'America/Los_Angeles',
        timezone_updated_at: new Date(),
      })),
    },
    coachPackage: {
      findUnique: jest.fn(async () => ({
        id: PKG,
        duration_periods: null,
        trial_days: converted.purchase.trial_days,
      })),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
        const row = purchases.find(
          (p) =>
            (where.id && p.id === where.id) ||
            (where.stripe_subscription_id &&
              p.stripe_subscription_id === where.stripe_subscription_id),
        );
        if (!row) return null;
        return {
          ...row,
          package: { name: 'Monthly Coaching', interval: 'month', interval_count: 1 },
          coach: { name: 'Alex' },
          client: { email: clientEmail, name: 'Jane' },
        };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = purchases.find((p) => p.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({
      id: 'n-1',
      ...input,
    })),
    getPreferences: jest.fn(async () => ({ muted: false })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = {
    send: jest.fn(async (input: { idempotencyKey: string }) => ({
      status: 'sent',
      providerMessageId: 'm',
      idempotencyKey: input.idempotencyKey,
    })),
  };
  const noticeSvc = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const usageSvc = new TrialUsageService(
    stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
  );
  const handler = new CheckoutWebhookHandlerService(
    stub<ConstructorParameters<typeof CheckoutWebhookHandlerService>[0]>(prisma),
    stub<StripeConnectApiService>({
      cancelSubscription: jest.fn(async () => ({ id: 'sub_x', status: 'canceled' })),
      retrieveSubscription: jest.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    usageSvc,
    noticeSvc,
  );
  const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(prisma);
  return { purchases, notices, notifications, email, handler, tx, clientEmail };
}

// The web trial's subscription after the winner's card attach (trial-card.ts:
// default card set, create-time end lifted).
function webTrialSub(purchase: Row, over: Record<string, unknown> = {}) {
  const end: Date = purchase.trial_ends_at;
  const days: number = purchase.trial_days;
  return {
    id: purchase.stripe_subscription_id,
    status: 'trialing',
    customer: purchase.stripe_customer_id,
    trial_start: epoch(new Date(end.getTime() - days * DAY)),
    trial_end: epoch(end),
    current_period_end: epoch(end),
    cancel_at_period_end: false,
    default_payment_method: 'pm_card_saved',
    items: { data: [{ quantity: 1, price: { unit_amount: 14900, currency: 'usd' } }] },
    metadata: { tgp_package_id: PKG, tgp_coach_user_id: COACH },
    ...over,
  };
}

describe('LO-1193 S4 — a web trial gets the app trial-ending notice (push and email, amount and date)', () => {
  it('LO-1193 S4: a converted web trial gets the trial-ending push and email with the amount and the date', async () => {
    const converted = await convertWebTrial(7);
    const w = noticeWorld(converted);
    const purchase = w.purchases[0];
    const end = new Date(epoch(purchase.trial_ends_at) * 1000);
    purchase.trial_ends_at = end;

    // The winner's card attach after commit makes Stripe send customer.subscription.updated.
    await w.handler.handle(
      event('customer.subscription.updated', webTrialSub(purchase), 'evt_attach'),
      w.tx,
    );
    expect(purchase).toMatchObject({ status: 'trialing', entitlement_active: true });

    // Stripe's trial_will_end, 3 days before the first charge.
    const res = await w.handler.handle(
      event('customer.subscription.trial_will_end', webTrialSub(purchase), 'evt_will_end'),
      w.tx,
    );
    expect(res.claimed).toBe(true);
    expect(res.deferredTrialNoticeId).toEqual(expect.any(String));
    await w.handler.deliverTrialNotice(res.deferredTrialNoticeId as string);

    const date = formatTrialDate(end, 'America/Los_Angeles');
    const body = `Your free trial ends on ${date}. Your card will be charged $149 then. Cancel anytime before.`;
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.notifications.pushToUser.mock.calls[0].slice(0, 3)).toEqual([
      converted.purchase.client_user_id,
      'Your free trial',
      body,
    ]);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({
      to: w.clientEmail,
      template: 'trial-ending',
      data: expect.objectContaining({
        trial_end_date: date,
        amount_display: '$149',
        will_charge: true,
      }),
    });
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'delivered',
      email_status: 'sent',
      amount_cents: 14900,
    });
  });

  it('LO-1193 S4: a three-day web trial (trial_will_end came before the card) gets its notice when the card attach lands', async () => {
    const converted = await convertWebTrial(3);
    const w = noticeWorld(converted);
    const purchase = w.purchases[0];
    purchase.trial_ends_at = new Date(epoch(purchase.trial_ends_at) * 1000);

    const res = await w.handler.handle(
      event('customer.subscription.updated', webTrialSub(purchase), 'evt_attach_3d'),
      w.tx,
    );
    expect(res.deferredTrialNoticeId).toEqual(expect.any(String));
    await w.handler.deliverTrialNotice(res.deferredTrialNoticeId as string);
    const date = formatTrialDate(purchase.trial_ends_at, 'America/Los_Angeles');
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({
      template: 'trial-ending',
      data: expect.objectContaining({
        trial_end_date: date,
        amount_display: '$149',
        will_charge: true,
      }),
    });
  });
});
