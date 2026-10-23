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
import { FLAGGED_JOIN_ALERT_BODY } from '../../src/onboarding/flagged-join-alert';
import { PLAN_RENEWAL_DAY_MS } from '../../src/checkout/plan-renewal/plan-renewal.cadence';
import { CheckoutService } from '../../src/checkout/checkout.service';
import { SubscriptionCheckoutService } from '../../src/checkout/subscription-checkout.service';
import { CheckoutWebhookHandlerService } from '../../src/checkout/checkout-webhook-handler.service';
import { BillingService } from '../../src/billing/billing.service';
import { PackagesService } from '../../src/packages/packages.service';
import { ClientPackagesController } from '../../src/packages/packages.controller';
import { PurchaseFanoutService } from '../../src/packages/purchase-fanout.service';
import { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { AutoMessageAssetResolver } from '../../src/packages/asset-resolvers/auto-message.resolver';
import { MealPlanAssetResolver } from '../../src/packages/asset-resolvers/meal-plan.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { MessagingService } from '../../src/messaging/messaging.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { TrialUsageService } from '../../src/packages/trials/trial-usage.service';
import { SchedulingSessionLifecycleService } from '../../src/scheduling/scheduling-session-lifecycle.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
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
  // FX-JOIN's scope check reads the committed roster beside the purchase transaction: 5 connections.
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL.replace('connection_limit=1', 'connection_limit=5') } } });
  // b#1131 B2: B, C, D and M (K's clients) check out on the hosted page.
  const keys = [...'KLHAOQEBCDM'];
  const u: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const supa: Record<string, string> = Object.fromEntries(keys.map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'K', O: 'K', E: 'K', Q: 'H', B: 'K', C: 'K', D: 'K', M: 'K' };
  const isCoach = (k: string) => 'KLH'.includes(k);
  const pkg = { PH: randomUUID(), PHR: randomUUID(), PHT: randomUUID(), PH0: randomUUID(), PL: randomUUID() };
  const PI = `pi_house_${u.A}`;
  const env = { flag: process.env.FEATURE_PLAN_RENEWAL, house: process.env.HOUSE_COACH_USER_ID };

  const stripe = {
    createCustomer: async () => ({ id: `cus_house_${randomUUID()}` }),
    createPaymentIntent: async () => ({ id: PI, client_secret: `${PI}_secret` }),
    createEphemeralKey: async () => ({ secret: 'ek_house' }),
    retrievePaymentIntent: async (id: string) => ({ id, status: 'succeeded', latest_charge: `ch_of_${id}` }),
    createProduct: async () => ({ id: `prod_house_${randomUUID()}` }),
    createPrice: async () => ({ id: `price_house_${randomUUID()}` }),
    createCheckoutSession: async (a: { clientReferenceId: string }) => ({ id: `cs_house_${a.clientReferenceId}`, url: 'https://checkout.example.test' }),
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
  });

  // b#1131 B2 (OPERATOR RULING 6353458098, owner #166-5 "nothing moves before payment"): a hosted
  // checkout moves the client only once Stripe reports it paid. B and C pay late (a delayed payment:
  // the completion says 'unpaid'); B's payment fails, C's settles. D pays at completion. B and C were
  // flagged for extra care in their consultation (LO B2, owner 61a); D was not.
  describe('b#1131 B2: the hosted checkout moves the client only once paid', () => {
    const cs: Record<string, string> = {};
    const sent: Record<string, number> = {};
    /** Stripe sends `type` for `who`'s session; a new event id each time unless `same` repeats the last one. */
    const stripeSends = (who: string, type: string, payment_status: string, same = false) => {
      const key = `${who}-${type}`;
      if (!same) sent[key] = (sent[key] ?? 0) + 1;
      return billing.handleEvent({
        id: `evt_${type}_${u[who]}_${sent[key]}`,
        type: `checkout.session.${type}`,
        data: { object: { id: cs[who], mode: 'payment', payment_status, payment_intent: `pi_hosted_${u[who]}`, customer: `cus_hosted_${u[who]}` } },
      });
    };
    /** Who coaches `who`, their house purchase, and the flag alerts the house coach has about them. */
    const where = async (who: string) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: u[who] }, select: { coach_id: true } });
      return {
        coach: user.coach_id === u.H ? 'H' : user.coach_id === u.K ? 'K' : user.coach_id,
        purchase: await prisma.clientPurchase.findFirstOrThrow({
          where: { client_user_id: u[who], package_id: pkg.PH },
          select: { status: true, entitlement_active: true },
        }),
        alerts: await prisma.notification.count({
          where: { user_id: u.H, body: FLAGGED_JOIN_ALERT_BODY, payload: { path: ['client_id'], equals: u[who] } },
        }),
      };
    };
    const intake = (who: string, flagged: boolean) =>
      prisma.clientOnboardingIntake.create({
        data: {
          client_id: u[who], version: 'consult-v1', answers: {}, completed_at: new Date(),
          screening_any_yes: flagged, screening_flagged_at: flagged ? new Date() : null,
        },
      });

    beforeAll(async () => {
      await prisma.connectAccount.upsert({
        where: { coach_user_id: u.H },
        create: { coach_user_id: u.H, stripe_account_id: `acct_house_${u.H}`, charges_enabled: true },
        update: {},
      });
      for (const who of 'BCD') await ranOut(who, HOUR);
      await renewal.runSweep(new Date());
      await intake('B', true);
      await intake('C', true);
      await intake('D', false);
    });

    it('LO N3: while the house account is not a coach the door is closed and a payment moves nobody', async () => {
      await prisma.user.update({ where: { id: u.H }, data: { role: 'owner' } });
      try {
        expect(await everyBuy('D', pkg.PH, pkg.PHR, 'H')).toEqual(closed);
        expect(await prisma.$transaction((tx) => moveToHouseCoachTx(tx, u.D, u.H))).toBeNull();
      } finally {
        await prisma.user.update({ where: { id: u.H }, data: { role: 'coach' } });
      }
      expect(await prisma.user.findUniqueOrThrow({ where: { id: u.D } })).toMatchObject({ coach_id: u.K });
    });

    it('unpaid at completion, then the payment fails: no move, no access, no alert; replays change nothing', async () => {
      cs.B = (await checkout.createCheckoutForClient(u.B, { package_id: pkg.PH })).session_id;
      await expect(stripeSends('B', 'completed', 'unpaid')).resolves.toMatchObject({ processed: true });
      expect(await where('B')).toEqual({ coach: 'K', purchase: { status: 'pending', entitlement_active: false }, alerts: 0 });

      await expect(stripeSends('B', 'async_payment_failed', 'unpaid')).resolves.toMatchObject({ processed: true });
      const failed = { coach: 'K', purchase: { status: 'payment_failed', entitlement_active: false }, alerts: 0 };
      expect(await where('B')).toEqual(failed);
      // The same event again (deduplicated) and a new delivery of each: nothing new.
      await stripeSends('B', 'async_payment_failed', 'unpaid', true);
      await stripeSends('B', 'async_payment_failed', 'unpaid');
      await stripeSends('B', 'completed', 'unpaid');
      expect(await where('B')).toEqual(failed);
      expect([await reads('K', 'B'), await reads('H', 'B')]).toEqual([1, 0]);
    });

    it('unpaid at completion, then the payment settles: one move, one access, one alert; replays and a late failure change nothing', async () => {
      cs.C = (await checkout.createCheckoutForClient(u.C, { package_id: pkg.PH })).session_id;
      await stripeSends('C', 'completed', 'unpaid');
      expect(await where('C')).toEqual({ coach: 'K', purchase: { status: 'pending', entitlement_active: false }, alerts: 0 });
      expect([await reads('K', 'C'), await reads('H', 'C')]).toEqual([1, 0]);

      await expect(stripeSends('C', 'async_payment_succeeded', 'paid')).resolves.toMatchObject({ processed: true });
      const moved = { coach: 'H', purchase: { status: 'paid', entitlement_active: true }, alerts: 1 };
      expect(await where('C')).toEqual(moved);
      expect(await prisma.planRenewal.findMany({ where: { client_user_id: u.C }, select: { status: true, stop_reason: true } }))
        .toEqual([{ status: 'stopped', stop_reason: 'moved' }]);
      expect([await reads('K', 'C'), await reads('H', 'C')]).toEqual([0, 1]);

      await stripeSends('C', 'async_payment_succeeded', 'paid', true);
      await stripeSends('C', 'async_payment_succeeded', 'paid');
      await stripeSends('C', 'completed', 'unpaid');
      // A failure after the payment was reported paid moves nobody back.
      await stripeSends('C', 'async_payment_failed', 'unpaid');
      expect(await where('C')).toEqual(moved);
      expect(await prisma.purchaseFanout.count({ where: { purchase: { client_user_id: u.C, package_id: pkg.PH } } })).toBe(1);
    });

    it('paid at completion: one move, no flag alert for a client who was not flagged; a replay changes nothing', async () => {
      cs.D = (await checkout.createCheckoutForClient(u.D, { package_id: pkg.PH })).session_id;
      await expect(stripeSends('D', 'completed', 'paid')).resolves.toMatchObject({ processed: true });
      const moved = { coach: 'H', purchase: { status: 'paid', entitlement_active: true }, alerts: 0 };
      expect(await where('D')).toEqual(moved);
      await stripeSends('D', 'completed', 'paid', true);
      await stripeSends('D', 'completed', 'paid');
      await stripeSends('D', 'async_payment_failed', 'unpaid');
      expect(await where('D')).toEqual(moved);
      expect(await prisma.notification.count({ where: { user_id: u.H, body: FLAGGED_JOIN_ALERT_BODY } })).toBe(1);
    });

    // B1 (FX-JOIN, b#1140): the house move is written in the purchase transaction before the items
    // are delivered, so the delivery reads the move there. The meal plan arrives in that transaction;
    // the welcome message (its service checks and writes on its own connection) waits for the
    // dispatcher's tick after the commit. Real resolvers, real MessagingService, real dispatcher.
    it('B1: a house package with a welcome message and a meal plan, paid on the hosted page: the client moves and both arrive once', async () => {
      const PHW = randomUUID();
      const MPH = randomUUID();
      const WELCOME = 'Welcome to the house team. Your first week is ready.';
      const none = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => undefined) });
      const realtime = { channel: () => ({ httpSend: async () => ({ success: true }) }), removeChannel: async () => 'ok' };
      const supabase = Object.assign(Object.create(SupabaseService.prototype) as SupabaseService, { getClient: () => realtime });
      const messaging = new MessagingService(prisma, supabase, ...stub<[never, never, never, never, never]>(Array(5).fill(none)));
      const rscope = new ResolverSubCoachScope(new SubCoachScopeService(prisma));
      const registry = new AssignableAssetResolverRegistry([
        new MealPlanAssetResolver(prisma, rscope),
        new AutoMessageAssetResolver(messaging, rscope, prisma),
      ]);
      const delivering: CheckoutWebhookHandlerService = Reflect.construct(CheckoutWebhookHandlerService, [
        prisma, stub<never>(stripe), undefined, undefined, undefined, new PurchaseFanoutService(registry, undefined, undefined, prisma, sessions),
      ]);
      const billingD: BillingService = Reflect.construct(BillingService, [
        prisma, { capture: jest.fn(), identify: jest.fn() }, { write: jest.fn(async () => undefined), list: jest.fn(async () => []) }, undefined, delivering,
      ]);
      const cron = new DripDispatcherCron(prisma, registry, stub<never>(none));
      await prisma.coachPackage.create({ data: { id: PHW, coach_id: u.H, name: 'House welcome', amount_cents: 20000, published_at: new Date(Date.now() - DAY) } });
      await prisma.dailyMealPlan.create({ data: { id: MPH, coach_id: u.H, name: 'House meals' } });
      const item = { package_id: PHW, cadence_kind: 'immediate', cadence_payload: {}, display_title: 'Week 1' };
      await prisma.coachPackageContent.createMany({
        data: [
          { ...item, asset_type: 'meal_plan', asset_id: MPH },
          { ...item, asset_type: 'auto_message', asset_id: randomUUID(), display_caption: WELCOME },
        ],
      });
      await ranOut('M', HOUR);
      await renewal.runSweep(new Date());

      cs.M = (await checkout.createCheckoutForClient(u.M, { package_id: PHW })).session_id;
      const purchase = await prisma.clientPurchase.findUniqueOrThrow({ where: { stripe_checkout_session_id: cs.M } });
      let n = 0;
      const paid = () => billingD.handleEvent({
        id: `evt_house_welcome_${u.M}_${(n += 1)}`,
        type: 'checkout.session.completed',
        data: { object: { id: cs.M, mode: 'payment', payment_status: 'paid', payment_intent: `pi_hosted_${u.M}`, customer: `cus_hosted_${u.M}` } },
      });
      const drops = async () =>
        (await prisma.scheduledDrop.findMany({ where: { client_purchase_id: purchase.id } })).map((d) => `${d.asset_type} ${d.status}`).sort();
      const holds = async () => [
        await prisma.dailyMealPlanAssignment.count({ where: { client_id: u.M, daily_meal_plan_id: MPH } }),
        await prisma.coachMessage.count({ where: { client_id: u.M, coach_id: u.H, body: WELCOME } }),
      ];
      const tick = () => cron.runOnce(new Date(Date.now() + 1000));
      const delivered = ['auto_message delivered', 'meal_plan fired'];

      await expect(paid()).resolves.toMatchObject({ processed: true });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: u.M } })).toMatchObject({ coach_id: u.H });
      expect([await drops(), await holds()]).toEqual([['auto_message pending', 'meal_plan fired'], [1, 0]]);
      await tick();
      expect([await drops(), await holds()]).toEqual([delivered, [1, 1]]);
      // A redelivered completion and a re-entered fan-out (a replay): nothing new arrives.
      await paid();
      await prisma.$transaction(
        (tx) => new PurchaseFanoutService(registry, undefined, undefined, prisma, sessions)
          .onPurchaseEntitled({ id: purchase.id }, { entrypoint: 'in_app_hosted', coachId: u.H, clientId: u.M }, tx),
        { timeout: 20_000 },
      );
      await tick();
      expect([await drops(), await holds()]).toEqual([delivered, [1, 1]]);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: u.M } })).toMatchObject({ coach_id: u.H });
    });
  });
});
