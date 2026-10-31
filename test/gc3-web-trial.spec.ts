// GC-3 (#GC-TRIAL op 1) — trials on the web pay page: the card is saved,
// nothing is charged that day, one trial per client + coach across web and
// app (the in-app PackageTrialUsage claim). These specs drive the real
// GuestCheckoutService conversion and the real TrialUsageService over a small
// in-memory database whose $transaction rolls back on a throw, so "the loser
// has no ClientPurchase" is checked against the rolled-back state.
import { GuestCheckoutService, GUEST_TRIAL_COPY, isGuestTrialIntent } from '../src/storefront/guest-checkout.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { LostWebhookReconcileService } from '../src/storefront/lost-webhook-reconcile.service';
import { readPayDone } from '../src/storefront/pay-done';
import { BillingService } from '../src/billing/billing.service';
import { renderPayDonePage } from '../src/storefront/pay-done.html';
import { payPageTerms, PAY_PAGE_COPY } from '../src/storefront/pay-page.html';

type Row = Record<string, any>;

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
      lock = turn.catch(() => undefined);
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
    supabase as any,
    config as any,
    { createNotification: jest.fn(async () => ({})) } as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    fanout as any,
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
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}'));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
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
      status: 'active',
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
    (service as any).trialUsage = undefined;

    await service.handlePaymentSucceeded(gc.stripe_payment_intent_id);

    expect(world.state.clientPurchase).toHaveLength(0);
    expect(world.state.guestCheckout[0].status).toBe('conversion_failed_retryable');
  });
});

describe('GC-3 — the billing webhook routes a trial SetupIntent to the guest conversion', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
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

    await (billing as any).handleEvent(setupSucceeded('evt_trial_1', gc.stripe_payment_intent_id));
    await (billing as any).handleEvent(setupSucceeded('evt_trial_1', gc.stripe_payment_intent_id));
    await (billing as any).handleEvent(setupSucceeded('evt_trial_2', gc.stripe_payment_intent_id));

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

    await (billing as any).handleEvent(setupSucceeded('evt_app_1', 'seti_inapptrial01'));

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

    expect(await (billing as any).maybeResolveGuestBySubscriptionEvent(created)).toBeNull();
    expect(await (billing as any).maybeResolveGuestBySubscriptionEvent(paid)).toBeNull();
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
    (svc as any).reconcileOne('gc-1', 'seti_webtrial01', 'sub_webtrial01');

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
    ({
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
    }) as any;

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
            status: 'paid',
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
    const html = renderPayDonePage(res.view as any, 'nonce-gc3', 'https://apps.example.com/tgp');
    expect(html).toContain('Your free trial has started');
    expect(html).toContain('Nothing is charged today. Your first charge of $149.00 is on Nov 6.');

    const wrong = await readPayDone(deps, 'tok_trial_page_012345', {
      setup_intent: 'seti_webtrial01',
      setup_intent_client_secret: 'seti_other00001_secret_z',
    });
    expect(wrong.view.kind).toBe('unknown');
  });
});
