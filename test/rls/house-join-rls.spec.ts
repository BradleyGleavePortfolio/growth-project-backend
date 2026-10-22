/**
 * HOUSE-JOIN-BE: the house coach door on real Postgres (owner #RENEWAL-STYLE
 * "the pathway actually takes them to my coaching packages and assigns them
 * post-purchase", #SWITCH-WHEN "confirmation - then payment - then after
 * both coach loses prior data", #166-1 SWITCH-V1 op 1: the one exception to
 * the closed cross-coach purchase). The real renewal sweep, package list,
 * checkout services and Stripe webhook (BillingService) run on the superuser
 * connection, as the API does; Stripe is a double. Row reads run as the API
 * role `authenticated` (no RLS bypass); every 0 comes right after a 1 for
 * the same caller on a row of the same kind.
 * Coach K coaches A, O and E; coach L coaches nobody here; H is TGP's house
 * coach (HOUSE_COACH_USER_ID) and coaches Q.
 * Runs in rls-live-tests. Gate: TEST_DATABASE_URL (CI=true without it fails).
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { PlanRenewalService } from '../../src/checkout/plan-renewal/plan-renewal.service';
import { readPlanRenewal } from '../../src/checkout/plan-renewal/plan-renewal.state';
import { moveToHouseCoachTx } from '../../src/checkout/plan-renewal/house-join';
import { PLAN_RENEWAL_DAY_MS } from '../../src/checkout/plan-renewal/plan-renewal.cadence';
import { CheckoutService } from '../../src/checkout/checkout.service';
import { SubscriptionCheckoutService } from '../../src/checkout/subscription-checkout.service';
import { CheckoutWebhookHandlerService } from '../../src/checkout/checkout-webhook-handler.service';
import { BillingService } from '../../src/billing/billing.service';
import { PackagesService } from '../../src/packages/packages.service';
import { ClientPackagesController } from '../../src/packages/packages.controller';
import { PurchaseFanoutService } from '../../src/packages/purchase-fanout.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { TrialUsageService } from '../../src/packages/trials/trial-usage.service';
import { SchedulingSessionLifecycleService } from '../../src/scheduling/scheduling-session-lifecycle.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { currentCoachInbox } from '../../src/notifications/current-coach-inbox';
import { CoachMoneyService } from '../../src/coach-money/coach-money.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('house-join-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const HOUR = 60 * 60 * 1000;
const DAY = PLAN_RENEWAL_DAY_MS;
const quiet = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => 'not_configured') });

(DB_URL ? describe : describe.skip)('HOUSE-JOIN-BE: the house coach door', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const keys = [...'KLHAOQE'];
  const u: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'K', O: 'K', E: 'K', Q: 'H' };
  const isCoach = (k: string) => 'KLH'.includes(k);
  const pkg = { PH: randomUUID(), PHR: randomUUID(), PHT: randomUUID(), PH0: randomUUID(), PL: randomUUID() };
  const PI = `pi_house_${u.A}`;
  const env = { flag: process.env.FEATURE_PLAN_RENEWAL, house: process.env.HOUSE_COACH_USER_ID };

  const stripe = {
    createCustomer: async () => ({ id: `cus_house_${u.A}` }),
    createPaymentIntent: async () => ({ id: PI, client_secret: `${PI}_secret` }),
    createEphemeralKey: async () => ({ secret: 'ek_house' }),
    retrievePaymentIntent: async () => ({ id: PI, status: 'succeeded', latest_charge: `ch_house_${u.A}` }),
  };
  const packages = new PackagesService(prisma, new SubCoachScopeService(prisma));
  const checkout = new CheckoutService(
    prisma,
    stub<ConstructorParameters<typeof CheckoutService>[1]>(stripe),
    packages,
    stub<ConstructorParameters<typeof CheckoutService>[3]>({ ready: true }),
    stub<ConstructorParameters<typeof CheckoutService>[4]>({
      planFor: async () => ({ application_fee_cents: 0, head_coach_split_cents: 0, head_coach_id: null }),
    }),
    stub<ConstructorParameters<typeof CheckoutService>[5]>({ evaluate: async () => ({ ok: true }) }),
  );
  const plans = new SubscriptionCheckoutService(prisma, stub<never>(stripe), packages, stub<never>({ ready: true }), stub<never>({}), checkout);
  const catalog = new ClientPackagesController(packages, prisma, new TrialUsageService(prisma));
  const sessions = new SchedulingSessionLifecycleService(prisma, stub<never>(quiet), stub<never>(quiet), stub<never>(quiet));
  const fanout = new PurchaseFanoutService(undefined, undefined, undefined, prisma, sessions);
  // Reflect.construct keeps the partial doubles untyped without a banned cast.
  const webhooks: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [
    prisma, stub<never>(stripe), undefined, undefined, undefined, fanout,
  ]);
  const billing: BillingService = Reflect.construct(BillingService, [
    prisma,
    { capture: jest.fn(), identify: jest.fn() },
    { write: jest.fn(async () => undefined), list: jest.fn(async () => []) },
    undefined,
    webhooks,
  ]);
  const renewal = new PlanRenewalService(prisma, stub<NotificationsService>({ sendPush: async () => null }));

  const view = (who: string) => readPlanRenewal(prisma, u[who]);
  const req = (who: string) => stub<never>({ user: { id: u[who], coach_id: coachOf[who] ? u[coachOf[who]] : null, role: 'student' } });
  /** The error code a call answers, or 'past the door' when it got through. */
  const answer = (call: Promise<unknown>) =>
    call.then(
      () => 'past the door',
      (e: { response?: { error?: string; code?: string } }) => e.response?.error ?? e.response?.code ?? String(e),
    );
  const list = (who: string, coach: string) =>
    catalog.list(req(who), u[coach]).then((r) => {
      const rows: Array<{ id: string }> = r.packages;
      return rows.map((p) => p.id).sort();
    });
  /** Every way to buy, in order: hosted checkout, Payment Sheet, subscription, package list, package detail. */
  const everyBuy = (who: string, oneTime: string, recurring: string, coach: string) =>
    Promise.all([
      answer(checkout.createCheckoutForClient(u[who], { package_id: oneTime })),
      answer(checkout.createPaymentIntentForClient(u[who], { package_id: recurring, idempotency_key: randomUUID() })),
      answer(plans.createSubscriptionIntent(u[who], { package_id: oneTime, idempotency_key: randomUUID() })),
      answer(list(who, coach)),
      answer(catalog.detail(req(who), oneTime)),
    ]);
  const closed = Array(5).fill('PACKAGE_NOT_FOUND');
  const setEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const withEnv = async <T>(name: string, value: string | undefined, run: () => Promise<T>) => {
    const before = process.env[name];
    setEnv(name, value);
    try {
      return await run();
    } finally {
      setEnv(name, before);
    }
  };

  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, u[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, isCoach(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: supa[who], role: 'authenticated' }));
      return query(tx);
    });
  /** `who` reads `of`'s account row (1) or not (0). */
  const reads = async (who: string, of: string) => (await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "User" WHERE "id" = $1`, u[of])))[0].n;
  /** `who` reads `of`'s renewal rows. */
  const readsRenewal = async (who: string, of: string) => (await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "PlanRenewal" WHERE "client_user_id" = $1`, u[of])))[0].n;

  const ranOut = async (who: string, endedMsAgo: number) => {
    const id = randomUUID();
    const old = randomUUID();
    await prisma.coachPackage.create({ data: { id: old, coach_id: u[coachOf[who]], name: 'Coaching', amount_cents: 15000 } });
    await prisma.clientPurchase.create({
      data: {
        id, client_user_id: u[who], coach_user_id: u[coachOf[who]], package_id: old, amount_cents: 15000,
        stripe_checkout_session_id: `cs-house-${id}`, idempotency_key: `idem-house-${id}`, billing_type: 'one_time',
        status: 'paid', entitlement_active: true, access_expires_at: new Date(Date.now() - endedMsAgo),
      },
    });
    return id;
  };

  beforeAll(async () => {
    process.env.FEATURE_PLAN_RENEWAL = 'true';
    process.env.HOUSE_COACH_USER_ID = u.H;
    const names: Record<string, string> = { K: 'Kim Coach', L: 'Lee Coach', H: 'Hal House', A: 'Ann Client' };
    for (const k of keys) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u[k]}, ${supa[k]}, ${`house-${u[k]}@example.test`}, ${names[k] ?? `Person ${k}`},
          ${isCoach(k) ? 'coach' : 'student'}::"Role", ${coachOf[k] ? u[coachOf[k]] : null})`;
    }
    const published = new Date(Date.now() - DAY);
    await prisma.coachPackage.createMany({
      data: [
        { id: pkg.PH, coach_id: u.H, name: 'House coaching', amount_cents: 20000, published_at: published },
        { id: pkg.PHR, coach_id: u.H, name: 'House monthly', amount_cents: 9900, billing_type: 'recurring', interval: 'month', published_at: published },
        // #166-6 HOUSE-TRIALS: a house package with a free trial is not part of the door.
        { id: pkg.PHT, coach_id: u.H, name: 'House trial', amount_cents: 9900, billing_type: 'recurring', interval: 'month', trial_days: 7, published_at: published },
        { id: pkg.PH0, coach_id: u.H, name: 'House starter', amount_cents: 0, published_at: published },
        { id: pkg.PL, coach_id: u.L, name: 'Lee coaching', amount_cents: 20000, published_at: published },
      ],
    });
    await prisma.connectCustomer.create({ data: { client_user_id: u.A, stripe_customer_id: `cus_house_${u.A}` } });
    // A's and Q's plans ran out an hour ago; the real sweep opens their renewal rows.
    await ranOut('A', HOUR);
    await ranOut('Q', HOUR);
    // O's plan ended 31 days ago: its sequence is done and its 30-day window has passed.
    const old = await ranOut('O', 31 * DAY);
    await prisma.planRenewal.create({
      data: { purchase_id: old, client_user_id: u.O, coach_user_id: u.K, ended_at: new Date(Date.now() - 31 * DAY), status: 'done', pushed_step: 7 },
    });
    await renewal.runSweep(new Date());
  });
  afterAll(async () => {
    setEnv('FEATURE_PLAN_RENEWAL', env.flag);
    setEnv('HOUSE_COACH_USER_ID', env.house);
    await prisma.$disconnect();
  });

  it('the renewal offers the house coach to a client whose plan ran out', async () => {
    expect(await view('A')).toMatchObject({ state: 'ended', banner_due: true, house_coach: { id: u.H, first_name: 'Hal' } });
    expect(await view('O')).toMatchObject({ state: 'ended', banner_due: false });
  });

  it('while the door is open every way to buy gets past it, and the list shows the house packages that charge at checkout', async () => {
    // Each answer is the next check after the door (H's payouts are not connected yet), never the 404.
    expect(await everyBuy('A', pkg.PH, pkg.PHR, 'H')).toEqual([
      'COACH_NOT_CONNECTED', 'RECURRING_REQUIRES_SUBSCRIPTION', 'ONE_TIME_REQUIRES_PAYMENT_INTENT', 'past the door', 'past the door',
    ]);
    expect(await list('A', 'H')).toEqual([pkg.PH, pkg.PHR].sort());
    expect(await answer(catalog.detail(req('A'), pkg.PH0))).toBe('PACKAGE_NOT_FOUND');
  });

  it('every other way through is the same 404', async () => {
    expect(await everyBuy('A', pkg.PL, pkg.PL, 'L')).toEqual(closed);
    expect(await withEnv('FEATURE_PLAN_RENEWAL', 'false', () => everyBuy('A', pkg.PH, pkg.PHR, 'H'))).toEqual(closed);
    expect(await withEnv('HOUSE_COACH_USER_ID', undefined, () => everyBuy('A', pkg.PH, pkg.PHR, 'H'))).toEqual(closed);
    expect(await everyBuy('O', pkg.PH, pkg.PHR, 'H')).toEqual(closed);
    // #166-6 HOUSE-TRIALS: the house's free-trial package, while the door is open: the list leaves it
    // out (above) and the detail and all three checkout paths are the same 404; no purchase is written.
    const [hosted, sheet, plan, , detail] = await everyBuy('A', pkg.PHT, pkg.PHT, 'H');
    expect([hosted, sheet, plan, detail]).toEqual(Array(4).fill('PACKAGE_NOT_FOUND'));
    expect(await prisma.clientPurchase.count({ where: { package_id: pkg.PHT } })).toBe(0);
    // The house coach's own client: no house offer, no door, and a payment never moves them.
    expect(await view('Q')).toMatchObject({ state: 'ended', house_coach: null });
    expect(await answer(list('Q', 'H'))).toBe('PACKAGE_NOT_FOUND');
    expect(await prisma.$transaction((tx) => moveToHouseCoachTx(tx, u.Q, u.H))).toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.Q } })).toMatchObject({ coach_id: u.H });
    // SWITCH-TELL-BE: none of the 404 paths, and no move that did not happen, tells any coach.
    expect(await prisma.notification.count({ where: { kind: 'coach_client_moved', user_id: { in: Object.values(u) } } })).toBe(0);
  });

  it('checkout, then payment, then the move: the house coach gets the client, the old coach loses them', async () => {
    await prisma.connectAccount.create({ data: { coach_user_id: u.H, stripe_account_id: `acct_house_${u.H}`, charges_enabled: true } });
    const session = await prisma.coachingSession.create({
      data: { coach_id: u.K, client_id: u.A, status: 'scheduled', title: 'Check-in', start_at: new Date(Date.now() + 2 * DAY), end_at: new Date(Date.now() + 2 * DAY + HOUR) },
    });
    await prisma.messageDraft.create({ data: { coach_id: u.K, client_id: u.A, body: 'See you Tuesday' } });

    const sheet = await checkout.createPaymentIntentForClient(u.A, { package_id: pkg.PH, idempotency_key: randomUUID() });
    expect(sheet.client_secret).toBe(`${PI}_secret`);
    // Checkout alone moves nothing: A is still K's client.
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.A } })).toMatchObject({ coach_id: u.K });
    expect([await reads('K', 'A'), await reads('H', 'Q'), await reads('H', 'A')]).toEqual([1, 1, 0]);
    // ... and tells no coach.
    expect(await prisma.notification.count({ where: { kind: 'coach_client_moved', user_id: { in: Object.values(u) } } })).toBe(0);

    const paid = { id: `evt_house_${u.A}`, type: 'payment_intent.succeeded', data: { object: { id: PI, latest_charge: `ch_house_${u.A}` } } };
    await expect(billing.handleEvent(paid)).resolves.toMatchObject({ processed: true });

    expect(await prisma.clientPurchase.findFirstOrThrow({ where: { stripe_payment_intent_id: PI } }))
      .toMatchObject({ client_user_id: u.A, coach_user_id: u.H, package_id: pkg.PH, status: 'paid', entitlement_active: true });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.A } })).toMatchObject({ coach_id: u.H });
    expect(await prisma.planRenewal.findMany({ where: { client_user_id: u.A }, select: { coach_user_id: true, status: true, stop_reason: true } }))
      .toEqual([{ coach_user_id: u.K, status: 'stopped', stop_reason: 'moved' }]);
    expect(await view('A')).toMatchObject({ state: 'none', house_coach: null });
    // The existing move rules ran: K's upcoming session with A is cancelled and K's unsent draft to A is gone.
    expect(await prisma.coachingSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'canceled', end_reason: 'client_moved' });
    expect(await prisma.messageDraft.count({ where: { client_id: u.A } })).toBe(0);
    // Row access: K still reads its other client E, no longer A; H now reads A.
    expect([await reads('K', 'E'), await reads('K', 'A'), await reads('H', 'A')]).toEqual([1, 0, 1]);
    expect([await readsRenewal('K', 'O'), await readsRenewal('K', 'A')]).toEqual([1, 0]);
    // The door is shut behind them.
    expect(await answer(list('A', 'H'))).toBe('PACKAGE_NOT_FOUND');

    // SWITCH-TELL-BE: K, the coach A left, gets one in-app notification that names only A. No push,
    // no link, and the house coach is never named or linked.
    const tellings = () =>
      prisma.notification.findMany({ where: { kind: 'coach_client_moved', user_id: { in: Object.values(u) } } });
    const told = await tellings();
    expect(told).toEqual([
      expect.objectContaining({
        user_id: u.K, channel: 'inapp', deep_link: null, body: 'Ann Client has moved to another coach.', payload: { client_id: u.A },
      }),
    ]);
    expect(JSON.stringify(told)).not.toMatch(new RegExp(`${u.H}|Hal|House`));
    expect(await prisma.notification.count({ where: { user_id: u.K, channel: 'push' } })).toBe(0);
    // It is in K's inbox (the current-coach rule keeps this link-free row about a client who left).
    const inbox = await prisma.notification.findMany({ where: await currentCoachInbox(prisma, u.K), select: { id: true } });
    expect(inbox.map((n) => n.id)).toContain(told[0].id);
    // The Money line: K's charge to A keeps name, date and amount, no link, and is dated by the move;
    // O (still K's client) has no line.
    const money = new CoachMoneyService(prisma);
    const own = await prisma.clientPurchase.findFirstOrThrow({ where: { client_user_id: u.A, coach_user_id: u.K } });
    const charges = (await money.listCharges(u.K, { status: 'all' })).charges;
    const movedAt = told[0].created_at.toISOString();
    expect(charges.find((c) => c.id === own.id)).toMatchObject({ client: { id: '', name: 'Ann Client' }, moved_away_at: movedAt });
    expect(charges.filter((c) => c.id !== own.id).map((c) => c.moved_away_at)).toEqual(
      charges.filter((c) => c.id !== own.id).map(() => null),
    );
    expect((await money.getChargeBreakdown(u.K, own.id)).charge).toMatchObject({ moved_away_at: movedAt });
    expect(JSON.stringify(charges)).not.toMatch(new RegExp(`${u.H}|Hal`));
    // A repeated webhook and a second move call move nothing and tell nobody again.
    await expect(billing.handleEvent(paid)).resolves.toMatchObject({ processed: false, alreadyProcessed: true });
    expect(await prisma.$transaction((tx) => moveToHouseCoachTx(tx, u.A, u.H))).toBeNull();
    expect(await tellings()).toHaveLength(1);
  });
});
