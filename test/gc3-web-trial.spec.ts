// GC-3 (#GC-TRIAL op 1) — trials on the web pay page: the card is saved,
// nothing is charged that day, one trial per client + coach across web and
// app (the in-app PackageTrialUsage claim). These specs drive the real
// GuestCheckoutService conversion and the real TrialUsageService over a small
// in-memory database whose $transaction rolls back on a throw, so "the loser
// has no ClientPurchase" is checked against the rolled-back state.
import { GuestCheckoutService, GUEST_TRIAL_COPY, isGuestTrialIntent } from '../src/storefront/guest-checkout.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { LostWebhookReconcileService } from '../src/storefront/lost-webhook-reconcile.service';
import { readPayDone } from '../src/storefront/pay-done';
import { BillingService } from '../src/billing/billing.service';
import { renderPayDonePage } from '../src/storefront/pay-done.html';
import { payPageTerms, PAY_PAGE_COPY, esc } from '../src/storefront/pay-page.html';
import { makeTable, makeTrialNoticeTable } from './utils/trial-fakes';

type Row = Record<string, any>;
// Test doubles stand in for injected services; `cast` keeps the doubles typed at the call site.
function cast<T>(v: unknown): T {
  return v as T;
}
type Private = Record<string, (...args: unknown[]) => Promise<unknown>>;

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
    trial_days: 7,
    share_token: 'tok_trial_page_012345',
    coach: { id: COACH, name: 'Alex' },
  };
  const withPkg = (r: Row | undefined) => (r ? { ...r, package: pkg } : null);
  const db: any = {
    guestCheckout: {
      findUnique: async ({ where }: any) => withPkg(state.guestCheckout.find((r) => matches(r, where))),
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
  return { db, addCheckout, get state() { return state; }, pkg };
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

describe('GC-3 — web page trials: card saved, nothing charged that day, one trial per coach', () => {
  let sent: Array<{ to: string; subject: string; html: string }>;
  const realFetch = global.fetch;

  beforeEach(() => {
    sent = [];
    global.fetch = cast<typeof fetch>(
      jest.fn(async (_url: unknown, init?: { body?: string }) => {
        sent.push(JSON.parse(init?.body ?? '{}'));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('isGuestTrialIntent tells a trial SetupIntent from a PaymentIntent and the pending sentinel', () => {
    expect(isGuestTrialIntent('seti_abc')).toBe(true);
    expect(isGuestTrialIntent('pi_abc')).toBe(false);
    expect(isGuestTrialIntent('pending_abc')).toBe(false);
    expect(isGuestTrialIntent(undefined)).toBe(false);
  });

  it('winner: the saved card converts the buyer with the trial marker, claims the one trial, and attaches the card after commit', async () => {
    const world = makeDb();
    const gc = world.addCheckout();
    const { service, stripe } = build(world);

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.guestCheckout[0].status).toBe('converted');
    const [purchase] = world.state.clientPurchase;
    expect(purchase).toMatchObject({
      coach_user_id: COACH,
      stripe_subscription_id: 'sub_webtrial01',
      // FR-1193 (LS-1193 B2) — stored like an app trial.
      status: 'trialing',
      entitlement_active: true,
      trial_days: 7,
      card_on_file: true,
    });
    expect(purchase.trial_started_at).toBeInstanceOf(Date);
    expect(purchase.trial_ends_at.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(world.state.packageTrialUsage).toHaveLength(1);
    expect(world.state.packageTrialUsage[0]).toMatchObject({
      purchase_id: purchase.id,
      coach_user_id: COACH,
      status: 'started',
    });
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod.mock.calls[0][0]).toMatchObject({
      subscriptionId: 'sub_webtrial01',
      paymentMethodId: 'pm_card_saved',
    });
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    // Nothing charged: no PaymentIntent or receipt lookup on a trial.
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(sent.some((m) => m.subject === GUEST_TRIAL_COPY.refusedSubject('Alex'))).toBe(false);
  });

  it('replayed webhook: a second setup_intent.succeeded for the same SetupIntent converts nothing twice', async () => {
    const world = makeDb();
    const gc = world.addCheckout();
    const { service, stripe } = build(world);

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.clientPurchase).toHaveLength(1);
    expect(world.state.packageTrialUsage).toHaveLength(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it('race: two web checkouts with one email — one wins the trial; the loser gets no access, its subscription is cancelled at once, and PF-W7 is sent', async () => {
    const world = makeDb();
    const a = world.addCheckout();
    const b = world.addCheckout();
    const { service, stripe } = build(world);

    await Promise.all([
      service.handlePaymentSucceeded(a.stripe_payment_intent_id),
      service.handlePaymentSucceeded(b.stripe_payment_intent_id),
    ]);

    const statuses = world.state.guestCheckout.map((r) => r.status).sort();
    expect(statuses).toEqual(['conversion_failed_terminal', 'converted']);
    const loser = world.state.guestCheckout.find((r) => r.status === 'conversion_failed_terminal')!;
    const winner = world.state.guestCheckout.find((r) => r.status === 'converted')!;
    expect(loser.last_error).toBe('trial_already_used');
    // Only the winner holds a purchase and the trial marker.
    expect(world.state.clientPurchase).toHaveLength(1);
    expect(world.state.clientPurchase[0].stripe_subscription_id).toBe(winner.stripe_subscription_id);
    expect(world.state.packageTrialUsage).toHaveLength(1);
    expect(world.state.packageTrialUsage[0].purchase_id).toBe(world.state.clientPurchase[0].id);
    // The loser's subscription is cancelled; only the winner's card is attached.
    expect(stripe.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith(loser.stripe_subscription_id);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod.mock.calls[0][0].subscriptionId).toBe(winner.stripe_subscription_id);
    const refused = sent.filter((m) => m.subject === GUEST_TRIAL_COPY.refusedSubject('Alex'));
    expect(refused).toHaveLength(1);
    expect(refused[0].to).toBe('jane@example.com');
    expect(refused[0].html).toContain(
      "You&#39;ve already had a free trial with Alex, so this one was not started and nothing was charged. Open the app to subscribe.",
    );
  });

  it('a trial already used in the app (ledger row for client + coach) refuses the web trial the same way', async () => {
    const world = makeDb();
    const { service, stripe } = build(world);
    // The app's trial: same client (same Supabase id) with this coach.
    world.state.user.push({ id: 'user-app', supabase_id: 'sb-jane', email: 'jane@example.com', role: 'student', coach_id: COACH, created_at: new Date(0) });
    world.state.clientPurchase.push({ id: 'purchase-app', client_user_id: 'user-app', coach_user_id: COACH, package_id: 'pkg-app', trial_started_at: null, idempotency_key: 'app-1' });
    world.state.packageTrialUsage.push({ id: 'usage-app', client_user_id: 'user-app', coach_user_id: COACH, package_id: 'pkg-app', purchase_id: 'purchase-app', status: 'started' });
    const gc = world.addCheckout();

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.guestCheckout[0]).toMatchObject({ status: 'conversion_failed_terminal', last_error: 'trial_already_used' });
    expect(world.state.clientPurchase.map((p) => p.id)).toEqual(['purchase-app']);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_webtrial01');
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('LS-1193-B1: a refused second trial never renders trial-started success', async () => {
    const world = makeDb();
    const { service, stripe } = build(world);
    world.state.user.push({ id: 'user-app', supabase_id: 'sb-jane', email: 'jane@example.com', role: 'student', coach_id: COACH, created_at: new Date(0) });
    world.state.packageTrialUsage.push({ id: 'usage-app', client_user_id: 'user-app', coach_user_id: COACH, package_id: PKG, purchase_id: 'purchase-app', status: 'started' });
    const gc = world.addCheckout();

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
    expect(world.state.guestCheckout[0]).toMatchObject({
      status: 'conversion_failed_terminal', last_error: 'trial_already_used',
    });
    expect(world.state.clientPurchase).toHaveLength(0);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith(gc.stripe_subscription_id);

    const result = await readPayDone(
      { db: world.db, stripe, storefrontBase: 'https://app.example.com' },
      world.pkg.share_token,
      { setup_intent: gc.stripe_payment_intent_id, setup_intent_client_secret: `${gc.stripe_payment_intent_id}_secret_z` },
    );
    const html = renderPayDonePage(result.view, 'nonce', 'https://apps.example.com/tgp');
    expect(html).not.toContain('Your free trial has started');
    expect(html).not.toContain('Your first charge of');
    expect(html).not.toContain('The package shows under Your plans.');
  });

  it.each(['sweep', 'trial_will_end', 'subscription_update_then_notice', 'subscription_update_then_sweep'])(
    'LS-1193-B2 S4: a converted web trial gets one push and email with amount and date via %s',
    async (path) => {
      jest.useFakeTimers({
        now: new Date('2026-10-30T17:00:00Z'),
        doNotFake: ['setImmediate', 'nextTick', 'setTimeout', 'clearTimeout'],
      });
      try {
        const world = makeDb();
        const gc = world.addCheckout();
        const { service, stripe } = build(world);
        await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
        expect(world.state.guestCheckout[0].status).toBe('converted');
        expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
        const [purchase] = world.state.clientPurchase;
        expect(purchase.trial_started_at).toBeInstanceOf(Date);
        const end = purchase.trial_ends_at as Date;

        // Read the actual conversion output with the existing query-aware
        // table fake. No native purchase or trial-state correction is seeded.
        const purchases = makeTable([['id']], () => ({}));
        purchases.rows.push(cast(purchase));
        world.db.clientPurchase.findMany = purchases.findMany;
        world.db.clientPurchase.update = purchases.update;
        world.db.clientPurchase.findUnique = async (args: any) => {
          const row = await purchases.findUnique(args);
          return row ? {
            ...row, package: world.pkg, coach: world.pkg.coach,
            client: { name: 'Jane', email: gc.guest_email },
          } : null;
        };
        const notices = makeTrialNoticeTable();
        world.db.packageTrialNotice = notices;
        world.db.connectCustomer = { findUnique: async () => null };
        world.db.notificationPreferences = {
          findUnique: async () => ({ timezone: 'America/Los_Angeles', timezone_updated_at: new Date() }),
        };
        world.db.coachPackage = { findUnique: async () => world.pkg };
        const notifications = {
          createNotification: jest.fn(async () => ({ id: 'notice-row' })),
          getPreferences: jest.fn(async () => ({ muted: false })),
          pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
        };
        const email = { send: jest.fn(async () => ({ status: 'sent' })) };
        const noticeSvc = new TrialNoticeService(world.db, cast(notifications), cast(email));
        const handler = new CheckoutWebhookHandlerService(
          world.db, stripe, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, new TrialUsageService(world.db), noticeSvc,
        );
        const sub = {
          id: gc.stripe_subscription_id, status: 'trialing',
          trial_start: Math.floor(purchase.trial_started_at.getTime() / 1000),
          trial_end: Math.floor(end.getTime() / 1000),
          current_period_end: Math.floor(end.getTime() / 1000),
          cancel_at_period_end: false, default_payment_method: 'pm_card_saved',
          items: { data: [{ quantity: 1, price: { unit_amount: 14900, currency: 'usd' } }] },
        };
        // Positive control: the real native lifecycle handler can refine the
        // web purchase. The two other paths must not require that extra event.
        if (path.startsWith('subscription_update_then_')) {
          await handler.handle({ id: 'event-update', type: 'customer.subscription.updated', data: { object: sub } });
        }
        jest.setSystemTime(new Date(end.getTime() - 3 * DAY));
        if (path === 'sweep' || path === 'subscription_update_then_sweep') {
          await noticeSvc.sweep(new Date());
          await noticeSvc.sweep(new Date());
        } else {
          for (let n = 0; n < 2; n += 1) {
            const result = await handler.handle({
              id: `event-end-${n}`, type: 'customer.subscription.trial_will_end', data: { object: sub },
            });
            if (result.deferredTrialNoticeId) await handler.deliverTrialNotice(result.deferredTrialNoticeId);
          }
        }
        expect({
          push: notifications.pushToUser.mock.calls.length,
          email: email.send.mock.calls.length,
        }).toEqual({ push: 1, email: 1 });
        expect(notifications.pushToUser.mock.calls[0]).toEqual(expect.arrayContaining([
          purchase.client_user_id,
          expect.stringContaining('Your free trial'),
          'Your free trial ends on Nov 6. Your card will be charged $149 then. Cancel anytime before.',
        ]));
        expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
          to: gc.guest_email,
          data: expect.objectContaining({
            amount_display: '$149', trial_end_date: 'Nov 6', will_charge: true,
          }),
        }));
        expect(notices.rows).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('a legacy purchase whose trial started (no ledger row) also refuses — the in-app eligibility read', async () => {
    const world = makeDb();
    const { service, stripe } = build(world);
    world.state.user.push({ id: 'user-old', supabase_id: 'sb-jane', email: 'jane@example.com', role: 'student', coach_id: COACH, created_at: new Date(0) });
    world.state.clientPurchase.push({ id: 'purchase-old', client_user_id: 'user-old', coach_user_id: COACH, package_id: 'pkg-old', trial_started_at: new Date(0), idempotency_key: 'old-1' });
    const gc = world.addCheckout();

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.guestCheckout[0].status).toBe('conversion_failed_terminal');
    expect(world.state.clientPurchase).toHaveLength(1);
    expect(world.state.packageTrialUsage).toHaveLength(0);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_webtrial01');
  });

  it('without the trial ledger wired, a trial row is never converted without its claim (retryable)', async () => {
    const world = makeDb();
    const gc = world.addCheckout();
    const { service } = build(world);
    Reflect.set(service, 'trialUsage', undefined);

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.clientPurchase).toHaveLength(0);
    expect(world.state.guestCheckout[0].status).toBe('conversion_failed_retryable');
  });
});

describe('GC-3 — the billing webhook routes a trial SetupIntent to the guest conversion', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = cast<typeof fetch>(jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const billingFor = (world: ReturnType<typeof makeDb>, guest: GuestCheckoutService) => {
    const checkoutWebhooks = {
      handle: jest.fn(async () => ({ claimed: false })),
      settleGuestPurchase: jest.fn(async () => undefined),
    };
    const billing = Reflect.construct(BillingService, [
      world.db,
      { capture: jest.fn() },
      { log: jest.fn(async () => undefined) },
      undefined,
      checkoutWebhooks,
      undefined,
      guest,
    ]) as BillingService;
    return { billing, checkoutWebhooks };
  };
  const setupSucceeded = (id: string, siId: string) => ({
    id,
    type: 'setup_intent.succeeded',
    data: { object: { id: siId, object: 'setup_intent', status: 'succeeded', payment_method: 'pm_card_saved' } },
  });

  it('setup_intent.succeeded converts the trial once; a replay converts nothing; no settlement is run (nothing charged)', async () => {
    const world = makeDb();
    const gc = world.addCheckout();
    const { service, stripe } = build(world);
    const { billing, checkoutWebhooks } = billingFor(world, service);

    await cast<Private>(billing).handleEvent(setupSucceeded('evt_trial_1', gc.stripe_payment_intent_id));
    await cast<Private>(billing).handleEvent(setupSucceeded('evt_trial_1', gc.stripe_payment_intent_id));
    await cast<Private>(billing).handleEvent(setupSucceeded('evt_trial_2', gc.stripe_payment_intent_id));

    expect(world.state.guestCheckout[0].status).toBe('converted');
    expect(world.state.clientPurchase).toHaveLength(1);
    expect(world.state.packageTrialUsage).toHaveLength(1);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(checkoutWebhooks.settleGuestPurchase).not.toHaveBeenCalled();
  });

  it('a SetupIntent no web trial owns is left to the in-app handler', async () => {
    const world = makeDb();
    const { service } = build(world);
    const spy = jest.spyOn(service, 'handlePaymentSucceeded');
    const { billing, checkoutWebhooks } = billingFor(world, service);

    await cast<Private>(billing).handleEvent(setupSucceeded('evt_app_1', 'seti_inapptrial01'));

    expect(checkoutWebhooks.handle).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('the subscription backstop never converts a trial row from its trialing subscription or $0 invoice', async () => {
    const world = makeDb();
    world.addCheckout();
    const { service } = build(world);
    world.db.guestCheckout.findUnique = jest.fn(async () => ({
      id: 'gc-1',
      stripe_payment_intent_id: 'seti_webtrial01',
      status: 'pending',
    }));
    const { billing } = billingFor(world, service);
    const created = { type: 'customer.subscription.created', data: { object: { id: 'sub_webtrial01', status: 'trialing' } } };
    const paid = { type: 'invoice.paid', data: { object: { subscription: 'sub_webtrial01', amount_paid: 0 } } };

    expect(await cast<Private>(billing).maybeResolveGuestBySubscriptionEvent(created)).toBeNull();
    expect(await cast<Private>(billing).maybeResolveGuestBySubscriptionEvent(paid)).toBeNull();
  });
});

describe('GC-3 — lost-webhook backstop polls the trial SetupIntent', () => {
  const make = (status: string) => {
    const prisma: any = {
      guestCheckout: {
        update: jest.fn(async () => ({ status: 'pending', reconcile_attempts: 1 })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const stripe: any = {
      retrieveSetupIntent: jest.fn(async () => ({ status })),
      retrievePaymentIntent: jest.fn(),
    };
    const guest: any = { handlePaymentSucceeded: jest.fn(async () => undefined) };
    return { svc: new LostWebhookReconcileService(prisma, stripe, guest), prisma, stripe, guest };
  };
  const run = (svc: LostWebhookReconcileService) =>
    cast<Private>(svc).reconcileOne('gc-1', 'seti_webtrial01', 'sub_webtrial01');

  it('succeeded → the same claim as setup_intent.succeeded', async () => {
    const { svc, guest, stripe } = make('succeeded');
    await run(svc);
    expect(guest.handlePaymentSucceeded).toHaveBeenCalledWith('seti_webtrial01');
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('canceled → failed; still open → nothing (never converts on a trialing subscription)', async () => {
    const c = make('canceled');
    await run(c.svc);
    expect(c.prisma.guestCheckout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed' } }),
    );
    const o = make('requires_payment_method');
    await run(o.svc);
    expect(o.guest.handlePaymentSucceeded).not.toHaveBeenCalled();
    expect(o.prisma.guestCheckout.updateMany).not.toHaveBeenCalled();
  });
});

describe('GC-3 — pay page and return page words', () => {
  const quote = (over: Record<string, unknown>) =>
    cast<Parameters<typeof payPageTerms>[0]>({
      name: 'Monthly Coaching',
      recurring: {
        amount_cents: 14900,
        interval: 'month',
        interval_count: 1,
        one_time_cents: 0,
        next_charge_at: '2026-11-06T17:00:00.000Z',
      },
      due_today_cents: 0,
      trial_days: 7,
      ...over,
    });

  it('a trial package shows PF-W5 and PF-W6 with its own amount and date', () => {
    const t = payPageTerms(quote({}));
    expect(t.trial).toBe(true);
    expect(t.cta).toBe('Start free trial');
    expect(t.billing?.today).toBe('Nothing is charged today. Your first charge of $149.00 is on Nov 6.');
    expect(PAY_PAGE_COPY.startTrial).toBe('Start free trial');
  });

  it('a package without a trial keeps its paid-today words', () => {
    const t = payPageTerms(quote({ trial_days: null, due_today_cents: 14900 }));
    expect(t.trial).toBe(false);
    expect(t.cta).not.toBe('Start free trial');
    expect(t.billing?.today).not.toContain('Nothing is charged today');
  });

  it('the return page checks the SetupIntent and shows the trial started with PF-W5', async () => {
    const created = new Date('2026-10-30T17:00:00.000Z');
    const deps: any = {
      storefrontBase: 'https://app.example.com',
      db: {
        guestCheckout: {
          findUnique: jest.fn(async () => ({
            guest_email: 'jane@example.com',
            created_at: created,
            status: 'converted',
            expires_at: new Date(Date.now() + DAY),
            idempotency_key: 'idem-key-trial-1',
            package_snapshot: { price_cents: 14900, trial_days: 7 },
            package: { share_token: 'tok_trial_page_012345', name: 'Monthly Coaching', coach: { name: 'Alex' } },
          })),
        },
        user: { findFirst: jest.fn(async () => null) },
      },
      stripe: {
        retrievePaymentIntent: jest.fn(),
        retrieveCharge: jest.fn(),
        retrieveSetupIntent: jest.fn(async () => ({
          id: 'seti_webtrial01',
          status: 'succeeded',
          client_secret: 'seti_webtrial01_secret_z',
        })),
      },
    };
    const res = await readPayDone(deps, 'tok_trial_page_012345', {
      setup_intent: 'seti_webtrial01',
      setup_intent_client_secret: 'seti_webtrial01_secret_z',
    });
    expect(res.view).toMatchObject({ kind: 'paid', trial: { firstChargeCents: 14900 } });
    expect(deps.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    const html = renderPayDonePage(cast(res.view), 'nonce-gc3', 'https://apps.example.com/tgp');
    expect(html).toContain('Your free trial has started');
    expect(html).toContain('Nothing is charged today. Your first charge of $149.00 is on Nov 6.');

    const wrong = await readPayDone(deps, 'tok_trial_page_012345', {
      setup_intent: 'seti_webtrial01',
      setup_intent_client_secret: 'seti_other00001_secret_z',
    });
    expect(wrong.view.kind).toBe('unknown');
  });
  // FR-1193 (LO-1193 B1, LS-1193 B1) — the saved card alone never says the
  // trial started: the row's conversion result decides the view.
  it.each([
    ['paid', null, 'confirming'],
    ['pending', null, 'confirming'],
    ['conversion_failed_retryable', 'db:x', 'confirming'],
    ['conversion_failed_terminal', 'trial_already_used', 'trialRefused'],
    ['conversion_failed_terminal', 'buyer_has_other_coach', 'unknown'],
    ['refunded', null, 'unknown'],
  ])('FR-1193: a saved card with row %s (%s) shows %s, never the trial started', async (status, lastError, kind) => {
    const deps: any = {
      storefrontBase: 'https://app.example.com',
      db: {
        guestCheckout: {
          findUnique: jest.fn(async () => ({
            guest_email: 'jane@example.com',
            created_at: new Date(Date.now() - 60 * 1000),
            status,
            last_error: lastError,
            expires_at: new Date(Date.now() + DAY),
            idempotency_key: 'idem-key-trial-2',
            package_snapshot: { price_cents: 14900, trial_days: 7 },
            package: { share_token: 'tok_trial_page_012345', name: 'Monthly Coaching', coach: { name: 'Alex' } },
          })),
        },
        user: { findFirst: jest.fn(async () => null) },
      },
      stripe: {
        retrievePaymentIntent: jest.fn(),
        retrieveCharge: jest.fn(),
        retrieveSetupIntent: jest.fn(async () => ({
          id: 'seti_webtrial02', status: 'succeeded', client_secret: 'seti_webtrial02_secret_z',
        })),
      },
    };
    const res = await readPayDone(deps, 'tok_trial_page_012345', {
      setup_intent: 'seti_webtrial02',
      setup_intent_client_secret: 'seti_webtrial02_secret_z',
      n: '1',
    });
    expect(res.view.kind).toBe(kind);
    const html = renderPayDonePage(cast(res.view), 'nonce-gc3', 'https://apps.example.com/tgp');
    expect(html).not.toContain('Your free trial has started');
    expect(html).not.toContain('Your first charge of');
    expect(html).not.toContain('The package shows under Your plans.');
    if (kind === 'confirming') {
      // The existing confirming view, checking this SetupIntent again.
      expect(res.refresh).toContain('setup_intent=seti_webtrial02');
      expect(res.refresh).toContain('n=2');
    } else {
      expect(res.refresh).toBeNull();
    }
    if (kind === 'trialRefused') {
      expect(html).toContain(`<h1 class="state">${GUEST_TRIAL_COPY.refusedSubject('Alex')}</h1>`);
      expect(html).toContain(
        'You&#39;ve already had a free trial with Alex, so this one was not started and nothing was charged. Open the app to subscribe.',
      );
    }
  });

  // FR-1193 (LS-1193 B2) — a short web trial is already inside the notice
  // window when it converts: the shared sweep reaches it at once, with no
  // later subscription webhook.
  it('FR-1193: a 3-day web trial gets its notice from the sweep right after conversion', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-30T17:00:00Z'),
      doNotFake: ['setImmediate', 'nextTick', 'setTimeout', 'clearTimeout'],
    });
    try {
      const world = makeDb();
      world.pkg.trial_days = 3;
      const gc = world.addCheckout({ package_snapshot: { price_cents: 14900, trial_days: 3 } });
      const { service, stripe } = build(world);
      stripe.retrieveSubscription.mockImplementation(async (subId: string) => ({
        id: subId, status: 'trialing', trial_end: Math.floor((Date.now() + 3 * DAY) / 1000),
      }));
      await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
      const [purchase] = world.state.clientPurchase;
      expect(purchase).toMatchObject({ status: 'trialing', entitlement_active: true, card_on_file: true });

      const purchases = makeTable([['id']], () => ({}));
      purchases.rows.push(cast(purchase));
      world.db.clientPurchase.findMany = purchases.findMany;
      world.db.clientPurchase.update = purchases.update;
      world.db.clientPurchase.findUnique = async (args: any) => {
        const row = await purchases.findUnique(args);
        return row ? { ...row, package: world.pkg, coach: world.pkg.coach, client: { name: 'Jane', email: gc.guest_email } } : null;
      };
      const notices = makeTrialNoticeTable();
      world.db.packageTrialNotice = notices;
      world.db.connectCustomer = { findUnique: async () => null };
      world.db.notificationPreferences = {
        findUnique: async () => ({ timezone: 'America/Los_Angeles', timezone_updated_at: new Date() }),
      };
      world.db.coachPackage = { findUnique: async () => world.pkg };
      const notifications = {
        createNotification: jest.fn(async () => ({ id: 'notice-row' })),
        getPreferences: jest.fn(async () => ({ muted: false })),
        pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
      };
      const email = { send: jest.fn(async () => ({ status: 'sent' })) };
      const noticeSvc = new TrialNoticeService(world.db, cast(notifications), cast(email));
      await noticeSvc.sweep(new Date());
      await noticeSvc.sweep(new Date());
      expect({ push: notifications.pushToUser.mock.calls.length, email: email.send.mock.calls.length }).toEqual({ push: 1, email: 1 });
      expect(notifications.pushToUser.mock.calls[0]).toEqual(expect.arrayContaining([
        'Your free trial ends on Nov 2. Your card will be charged $149 then. Cancel anytime before.',
      ]));
      expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount_display: '$149', trial_end_date: 'Nov 2', will_charge: true }),
      }));
      expect(notices.rows).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

// TRIAL-WORDS-BE (owner #189-D1 op 1) — while a web trial starts, the return
// page says a free trial is starting, never a payment: TW1 + its line while
// it checks again, TW2 + its line when that is slow. A paid checkout keeps
// main's words in both states. The trial is told from the server record (the
// guest row whose stored intent is the trial's SetupIntent, checked with
// Stripe), never from the query string. The owner's exact words are written
// out here so the test pins them.
describe('TRIAL-WORDS-BE — the return page while a web trial starts', () => {
  const TW1 = 'Starting your free trial';
  const TW1_LINE = 'This usually takes a few seconds. This page checks again by itself.';
  const TW2 = 'Your free trial is still starting';
  const TW2_LINE = (email: string) =>
    `Nothing is charged today, and you don't need to start it again. When it's ready, we'll email ${email}.`;
  // Main's payment words, word for word (pay-done.html.ts PAY_DONE_COPY at d571dd61).
  const PAID_H = 'Confirming your payment';
  const PAID_SLOW_H = 'Your payment is still being confirmed';
  const PAID_SLOW = (email: string) => `You don't need to pay again. When it goes through, we'll email ${email}.`;
  const TOKEN = 'tok_trial_page_012345';
  const STORE = 'https://apps.example.com/tgp';
  const PAYMENT_WORDS = [PAID_H, PAID_SLOW_H, "You don&#39;t need to pay again", 'When it goes through'];

  let sent: Array<{ to: string; subject: string; html: string }>;
  const realFetch = global.fetch;
  beforeEach(() => {
    sent = [];
    global.fetch = cast<typeof fetch>(
      jest.fn(async (_url: unknown, init?: { body?: string }) => {
        sent.push(JSON.parse(init?.body ?? '{}'));
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  // A web trial whose card is saved (Stripe: SetupIntent succeeded) and whose
  // conversion has not run yet: the real guest row, the real Stripe double.
  function trialWorld(over: Row = {}) {
    const world = makeDb();
    const gc = world.addCheckout(over);
    const { service, stripe } = build(world);
    const deps: any = { db: world.db, stripe, storefrontBase: 'https://app.example.com' };
    const done = async (extra: Record<string, string> = {}) => {
      const res = await readPayDone(deps, TOKEN, {
        setup_intent: gc.stripe_payment_intent_id,
        setup_intent_client_secret: `${gc.stripe_payment_intent_id}_secret_z`,
        ...extra,
      });
      return { ...res, html: renderPayDonePage(cast(res.view), 'nonce-tw', STORE) };
    };
    return { world, gc, service, stripe, done };
  }

  // A paid (PaymentIntent) checkout still processing at Stripe.
  function paidDeps(email = 'jane@example.com') {
    const pi = 'pi_3PaidAAAAAAAAAAAA';
    const secret = `${pi}_secret_good1234`;
    const deps: any = {
      storefrontBase: 'https://app.example.com',
      db: {
        guestCheckout: {
          findUnique: jest.fn(async ({ where }: any) =>
            where.stripe_payment_intent_id === pi
              ? {
                  guest_email: email,
                  created_at: new Date(Date.now() - 60 * 1000),
                  status: 'pending',
                  expires_at: new Date(Date.now() + DAY),
                  idempotency_key: 'idem-key-paid-1',
                  stripe_payment_intent_id: pi,
                  package_snapshot: { price_cents: 14900, trial_days: null },
                  package: { share_token: TOKEN, name: 'Monthly Coaching', coach: { name: 'Alex' } },
                }
              : null,
          ),
        },
        user: { findFirst: jest.fn(async () => null) },
        chargeDispute: { findFirst: jest.fn(async () => null) },
      },
      stripe: {
        retrievePaymentIntent: jest.fn(async () => ({ id: pi, client_secret: secret, status: 'processing', amount: 14900 })),
        retrieveCharge: jest.fn(),
        retrieveSetupIntent: jest.fn(async () => {
          throw new Error('a paid checkout has no SetupIntent');
        }),
      },
    };
    const done = async (extra: Record<string, string> = {}) => {
      const res = await readPayDone(deps, TOKEN, { payment_intent: pi, payment_intent_client_secret: secret, ...extra });
      return { ...res, html: renderPayDonePage(cast(res.view), 'nonce-tw', STORE) };
    };
    return { deps, pi, secret, done };
  }

  it('TRIAL-WORDS-BE first test: a web trial, while it starts, shows "Starting your free trial" and never "Confirming your payment"', async () => {
    const { done } = trialWorld();
    const page = await done({ n: '0' });
    expect(page.view.kind).toBe('confirming');
    expect(page.html).toContain(`<h1 class="state">${TW1}</h1><p>${TW1_LINE}</p>`);
    for (const w of PAYMENT_WORDS) expect(page.html).not.toContain(w);
    // It still checks again by itself (the Refresh header URL).
    expect(page.refresh).toBe(
      `/p/${TOKEN}/done?setup_intent=seti_webtrial01&setup_intent_client_secret=seti_webtrial01_secret_z&n=1`,
    );
  });

  it('the card still saving at Stripe (SetupIntent processing) is a trial starting too', async () => {
    const { stripe, done } = trialWorld();
    stripe.retrieveSetupIntent.mockImplementation(async (siId: string) => ({
      id: siId, status: 'processing', client_secret: `${siId}_secret_z`,
    }));
    const page = await done();
    expect(page.html).toContain(`<h1 class="state">${TW1}</h1>`);
    for (const w of PAYMENT_WORDS) expect(page.html).not.toContain(w);
  });

  it('the slow state of a trial shows TW2 and TW2-line with the address escaped, and Check again', async () => {
    const email = `o'neil+<b>&co@example.com`;
    const { done } = trialWorld({ guest_email: email });
    const page = await done({ n: '5' });
    expect(page.refresh).toBeNull();
    expect(page.html).toContain(`<h1 class="state">${TW2}</h1><p>${esc(TW2_LINE(email))}</p>`);
    expect(page.html).toContain('o&#39;neil+&lt;b&gt;&amp;co@example.com');
    expect(page.html).not.toContain('<b>&co');
    for (const w of PAYMENT_WORDS) expect(page.html).not.toContain(w);
    expect(page.html).toContain(
      `<a class="link" href="/p/${TOKEN}/done?setup_intent=seti_webtrial01&amp;setup_intent_client_secret=seti_webtrial01_secret_z&amp;n=0">Check again</a>`,
    );
  });

  it("the trial page's Check again works in both states: it checks the same SetupIntent again and shows the trial started once converted", async () => {
    const { world, gc, service, done } = trialWorld();
    const slow = await done({ n: '5' });
    const href = /<a class="link" href="([^"]+)"/.exec(slow.html)?.[1]?.replace(/&amp;/g, '&');
    expect(href).toBeDefined();
    const q = Object.fromEntries(new URL(href!, 'https://app.example.com').searchParams);
    // Check again, still not converted: back to TW1, checking again by itself.
    const again = await done(q);
    expect(again.html).toContain(`<h1 class="state">${TW1}</h1>`);
    expect(again.refresh).toContain('n=1');
    // Converted: Check again shows the trial started (main's trial view).
    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
    expect(world.state.guestCheckout[0].status).toBe('converted');
    const started = await done(q);
    expect(started.html).toContain('Your free trial has started');
    expect(started.html).not.toContain(TW2);
  });

  it('R2: the email TW2-line promises goes out when a slow trial finishes starting (the welcome email), to that address', async () => {
    const { world, gc, service, done } = trialWorld();
    const slow = await done({ n: '5' });
    expect(slow.html).toContain(esc(TW2_LINE('jane@example.com')));
    expect(sent).toHaveLength(0);
    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
    expect(world.state.guestCheckout[0].status).toBe('converted');
    // sendWelcomeEmail is fire-and-forget after the conversion commits.
    await new Promise((r) => setImmediate(r));
    const welcome = sent.filter((m) => m.to === 'jane@example.com' && m.subject !== GUEST_TRIAL_COPY.refusedSubject('Alex'));
    expect(welcome).toHaveLength(1);
    expect(welcome[0].subject).toBe('Confirm your email to start with Alex on TGP Fitness');
    expect(welcome[0].html).toContain('Monthly Coaching');
  });

  it("a paid checkout's confirming and slow states keep main's words, word for word", async () => {
    const email = `o'neil+<b>&co@example.com`;
    const { pi, secret, done } = paidDeps(email);
    const first = await done({ n: '0' });
    expect(first.view.kind).toBe('confirming');
    expect(first.html).toContain(
      `<section id="confirming" aria-live="polite"><span class="wait" aria-hidden="true"></span><h1 class="state">${PAID_H}</h1><p>${TW1_LINE}</p></section>`,
    );
    expect(first.refresh).toBe(`/p/${TOKEN}/done?payment_intent=${pi}&payment_intent_client_secret=${secret}&n=1`);
    const slow = await done({ n: '5' });
    expect(slow.html).toContain(
      `<section id="slow"><h1 class="state">${PAID_SLOW_H}</h1><p>${esc(PAID_SLOW(email))}</p><a class="link" href="/p/${TOKEN}/done?payment_intent=${pi}&amp;payment_intent_client_secret=${secret}&amp;n=0">Check again</a></section>`,
    );
    for (const page of [first, slow]) {
      expect(page.html).not.toContain(TW1);
      expect(page.html).not.toContain(TW2);
      expect(page.html).not.toContain('Nothing is charged today');
    }
  });

  it('a trial mark in the query string changes nothing: a paid checkout never shows the trial words', async () => {
    const { pi, secret, done } = paidDeps();
    const extras: Array<Record<string, string>> = [
      { trial: '1' },
      { trial: 'true', mode: 'setup', redirect_status: 'succeeded' },
      { trial: '1', n: '5' },
    ];
    for (const extra of extras) {
      const page = await done(extra);
      expect(page.view.kind).toBe('confirming');
      expect(page.html).not.toContain(TW1);
      expect(page.html).not.toContain(TW2);
      expect(page.html).toContain(extra.n === '5' ? PAID_SLOW_H : PAID_H);
    }
    // A SetupIntent id pasted onto a paid checkout's return finds no trial row: nothing is shown.
    const { deps } = paidDeps();
    const forged = await readPayDone(deps, TOKEN, {
      payment_intent: pi,
      payment_intent_client_secret: secret,
      setup_intent: 'seti_forged0000001',
      setup_intent_client_secret: 'seti_forged0000001_secret_z',
    });
    expect(forged.view.kind).toBe('unknown');
  });

  it("a refused trial still shows main's refused page, never TW1 or TW2", async () => {
    const { done } = trialWorld({ status: 'conversion_failed_terminal', last_error: 'trial_already_used' });
    for (const n of ['0', '5']) {
      const page = await done({ n });
      expect(page.view.kind).toBe('trialRefused');
      expect(page.html).toContain(`<h1 class="state">${GUEST_TRIAL_COPY.refusedSubject('Alex')}</h1>`);
      expect(page.html).not.toContain(TW1);
      expect(page.html).not.toContain(TW2);
    }
  });

  it.each(['conversion cap', 'lost-webhook cap', 'card save canceled'])(
    'LS-1199 B1: a slow trial ending at %s notifies the buyer instead of silently abandoning the email promise',
    async (ending) => {
      const { world, gc, service, stripe, done } = trialWorld({
        created_at: new Date(Date.now() - 60_000),
      });
      const slow = await done({ n: '5' });
      expect(slow.html).toContain(esc(TW2_LINE(gc.guest_email)));
      expect(sent).toHaveLength(0);

      if (ending === 'conversion cap') {
        // A normal dependency outage persists through all five conversion tries.
        world.db.connectAccount.findUnique = jest.fn(async () => {
          throw new Error('conversion dependency unavailable');
        });
        await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);
        for (let attempt = 1; attempt < 5; attempt++) {
          await service.reconcilePaidCheckout(gc.id);
        }
        expect(world.state.guestCheckout[0].status).toBe('conversion_failed_terminal');
      } else {
        stripe.retrieveSetupIntent.mockImplementation(async (intent: string) => ({
          id: intent,
          status: ending === 'card save canceled' ? 'canceled' : 'processing',
          client_secret: `${intent}_secret_z`,
        }));
        // The production backstop scans pending rows and atomically increments
        // its poll count. Supply those DB operations on the same real test row.
        const backstopDb: any = {
          guestCheckout: {
            findMany: async () => world.state.guestCheckout.filter((row) => row.status === 'pending'),
            updateMany: world.db.guestCheckout.updateMany,
            update: async () => {
              const row = world.state.guestCheckout[0];
              row.reconcile_attempts = (row.reconcile_attempts ?? 0) + 1;
              return row;
            },
          },
        };
        const backstop = new LostWebhookReconcileService(backstopDb, stripe, service);
        for (let poll = 0; poll < 6; poll++) await backstop.runOnce();
        expect(world.state.guestCheckout[0].status).toBe(
          ending === 'card save canceled' ? 'failed' : 'conversion_failed_terminal',
        );
      }
      await service.reconcilePaidCheckout(gc.id);
      await new Promise((resolve) => setImmediate(resolve));
      // The buyer was explicitly told to wait for email and may have closed
      // the page. Logging for an operator is not a buyer notification.
      expect(sent.filter((message) => message.to === gc.guest_email)).toHaveLength(1);
    },
  );
});
