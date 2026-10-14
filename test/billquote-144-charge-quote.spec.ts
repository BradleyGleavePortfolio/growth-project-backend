// BILLQUOTE (agent 144) — the server says what is due today and when the
// first later charge is, before the client taps pay. The quote on the client
// package reads (GET /v1/clients/me/coach/packages[/:id]) comes from
// chargeQuote(), the same rule the checkout sends to Stripe:
//   * one-time: the PaymentIntent amount is chargeQuote(pkg, 0).due_today_cents;
//   * renewing: planPriceFor(pkg, trialDays) (pinned by the subscription
//     checkout) with trial_period_days = trialDays.
// These specs prove each package shape, the currency, the client's trial, the
// quote against the mocked Stripe request of both checkout paths, and that a
// client never gets a quote for a package their current coach does not offer.
import { NotFoundException } from '@nestjs/common';
import type { CoachPackage, ConnectCustomer } from '@prisma/client';
import {
  CheckoutService,
  chargeQuote,
  packageQuote,
  type ChargeQuote,
} from '../src/checkout/checkout.service';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { ClientPackagesController } from '../src/packages/packages.controller';
import {
  SUBSCRIPTION_CHECKOUT_OWNER,
  TrialCheckoutCapability,
} from '../src/packages/trials/trial-checkout-capability';
import { TrialUsageService, offerFor } from '../src/packages/trials/trial-usage.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const OTHER_COACH = '55555555-5555-4555-8555-555555555555';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DAY = 86_400_000;
const NOW = new Date('2026-10-14T17:30:00.000Z');

function pkgRow(over: Record<string, unknown> = {}): CoachPackage {
  return stub<CoachPackage>({
    id: PKG,
    coach_id: COACH,
    name: 'Coaching',
    description: null,
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    recurring_stripe_price_id: null,
    stripe_price_id: null,
    trial_days: 0,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    ...over,
  });
}

const MONTHLY = {};
const ONE_TIME = { billing_type: 'one_time', interval: null, amount_cents: 9900 };
const COMBO = {
  billing_type: 'one_time',
  interval: null,
  amount_cents: 9900,
  recurring_amount_cents: 4900,
  recurring_interval: 'month',
  recurring_interval_count: 1,
};
const TRIAL = { trial_days: 14 };

afterEach(() => jest.restoreAllMocks());

describe('BILLQUOTE — chargeQuote: what each package charges', () => {
  it('monthly: the first month today, the next charge one month on', () => {
    expect(chargeQuote(pkgRow(MONTHLY), 0, NOW)).toEqual({
      due_today_cents: 4900,
      currency: 'usd',
      first_charge_at: '2026-11-14T17:30:00.000Z',
      trial_end: null,
    });
  });

  it('one-time: the price today and no later charge', () => {
    expect(chargeQuote(pkgRow(ONE_TIME), 0, NOW)).toEqual({
      due_today_cents: 9900,
      currency: 'usd',
      first_charge_at: null,
      trial_end: null,
    });
  });

  it('one-time + recurring: the one-time part plus the first period today', () => {
    expect(chargeQuote(pkgRow(COMBO), 0, NOW)).toEqual({
      due_today_cents: 14800,
      currency: 'usd',
      first_charge_at: '2026-11-14T17:30:00.000Z',
      trial_end: null,
    });
  });

  it('trial: nothing today, the first charge at the trial end', () => {
    const q = chargeQuote(pkgRow(TRIAL), 14, NOW);
    expect(q.due_today_cents).toBe(0);
    expect(q.trial_end).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());
    expect(q.first_charge_at).toBe(q.trial_end);
  });

  it.each([
    ['monthly', MONTHLY],
    ['one-time', ONE_TIME],
    ['one-time + recurring', COMBO],
    ['trial', TRIAL],
  ])('%s: the package currency is carried', (_n, over) => {
    expect(chargeQuote(pkgRow({ ...over, currency: 'eur' }), 0, NOW).currency).toBe('eur');
  });

  it('free packages (claimed, never charged): 0 today and nothing later', () => {
    for (const over of [{ amount_cents: 0 }, { ...ONE_TIME, amount_cents: 0 }]) {
      expect(chargeQuote(pkgRow(over), 0, NOW)).toEqual({
        due_today_cents: 0,
        currency: 'usd',
        first_charge_at: null,
        trial_end: null,
      });
    }
  });

  it('the next charge follows the cadence (weeks, months clamped to the month end, years)', () => {
    const at = (over: Record<string, unknown>, now: string) =>
      chargeQuote(pkgRow(over), 0, new Date(now)).first_charge_at;
    expect(at({ interval: 'week', interval_count: 2 }, '2026-10-14T00:00:00Z')).toBe(
      '2026-10-28T00:00:00.000Z',
    );
    expect(at({ interval_count: 3 }, '2026-10-14T00:00:00Z')).toBe('2027-01-14T00:00:00.000Z');
    expect(at({}, '2027-01-31T09:00:00Z')).toBe('2027-02-28T09:00:00.000Z');
    expect(at({ interval: 'year' }, '2028-02-29T09:00:00Z')).toBe('2029-02-28T09:00:00.000Z');
  });

  it('a renewing package with no valid cadence: refused like the checkout, no quote', () => {
    const broken = pkgRow({ interval: null });
    expect(() => chargeQuote(broken, 0, NOW)).toThrow();
    expect(packageQuote(broken, undefined, NOW)).toBeNull();
  });

  it('the trial counts only when this client gets it (one trial per client per coach)', () => {
    const pkg = pkgRow(TRIAL);
    expect(packageQuote(pkg, offerFor(pkg, false), NOW)?.due_today_cents).toBe(0);
    expect(packageQuote(pkg, offerFor(pkg, true), NOW)).toEqual({
      due_today_cents: 4900,
      currency: 'usd',
      first_charge_at: '2026-11-14T17:30:00.000Z',
      trial_end: null,
    });
  });
});

describe('BILLQUOTE — the quote equals what the checkout sends to Stripe (mock Stripe)', () => {
  // The Prices the real ensure*PriceForPackage create: unit_amount and currency.
  function priceBook(helpers: ReturnType<typeof makeCheckoutHelpers>) {
    const prices = new Map<string, { unit: number; currency: string }>();
    helpers.ensurePriceForPackage.mockImplementation(async (pkg: CoachPackage) => {
      const id = `price_one_${prices.size}`;
      prices.set(id, { unit: pkg.amount_cents, currency: pkg.currency });
      return id;
    });
    helpers.ensureRecurringPriceForPackage.mockImplementation(async (pkg: CoachPackage) => {
      const id = `price_rec_${prices.size}`;
      prices.set(id, { unit: pkg.recurring_amount_cents ?? 0, currency: pkg.currency });
      return id;
    });
    return prices;
  }

  function subscriptionCheckout(pkg: CoachPackage) {
    const prisma = makeFakePrisma();
    const stripe = makeFakeStripe();
    const helpers = makeCheckoutHelpers(prisma);
    const prices = priceBook(helpers);
    prisma._users.push(
      { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
      { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
    );
    prisma._packages.push(pkg);
    prisma._accounts.push({
      coach_user_id: COACH,
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    const packages: any = { getById: jest.fn(async () => pkg) };
    const feePolicy: any = {
      planFor: jest.fn(async () => ({
        application_fee_cents: 98,
        head_coach_split_cents: 0,
        head_coach_id: null,
      })),
    };
    const state: any = { ready: true };
    const checkout: any = helpers;
    const svc = new SubscriptionCheckoutService(
      prisma,
      stripe,
      packages,
      state,
      feePolicy,
      checkout,
    );
    return { svc, stripe, prices };
  }

  it.each([
    ['monthly', MONTHLY],
    ['one-time + recurring', COMBO],
    ['trial', TRIAL],
    ['monthly in eur', { currency: 'eur' }],
  ])('%s: Stripe first invoice = due_today_cents, trial = trial_end', async (_n, over) => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const pkg = pkgRow(over);
    const quote = packageQuote(pkg, offerFor(pkg, false), NOW) as ChargeQuote;
    const { svc, stripe, prices } = subscriptionCheckout(pkg);
    const input = { package_id: PKG, idempotency_key: KEY };
    const out = await svc.createSubscriptionIntent(CLIENT, input);

    const sent = stripe.createSubscription.mock.calls[0][0];
    const items = [sent.recurringPriceId, sent.oneTimePriceId]
      .filter((id): id is string => typeof id === 'string')
      .map((id) => prices.get(id));
    const trialDays = sent.trialPeriodDays ?? 0;
    // Stripe's first invoice: every item now, or $0 while a trial runs.
    const firstInvoice = trialDays > 0 ? 0 : items.reduce((sum, p) => sum + (p?.unit ?? NaN), 0);
    expect(quote.due_today_cents).toBe(firstInvoice);
    expect(out.plan.first_charge_cents).toBe(quote.due_today_cents);
    for (const p of items) expect(p?.currency).toBe(quote.currency);
    expect(out.plan.currency).toBe(quote.currency);
    if (trialDays > 0) {
      expect(NOW.getTime() + trialDays * DAY).toBe(Date.parse(quote.trial_end ?? ''));
      expect(out.plan.trial_ends_at).toBe(quote.trial_end);
      expect(quote.first_charge_at).toBe(quote.trial_end);
    } else {
      expect(quote.trial_end).toBeNull();
      expect(out.plan.trial_ends_at).toBeNull();
    }
  });

  it.each([['usd'], ['eur']])(
    'one-time (%s): the PaymentIntent amount and currency are the quote',
    async (currency) => {
      const pkg = pkgRow({ ...ONE_TIME, currency });
      const quote = packageQuote(pkg, offerFor(pkg, false), NOW) as ChargeQuote;
      const prisma = makeFakePrisma();
      prisma._users.push(
        { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
        { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
      );
      prisma._accounts.push({
        coach_user_id: COACH,
        stripe_account_id: 'acct_coach',
        charges_enabled: true,
        deauthorized_at: null,
      });
      const stripe: any = {
        createPaymentIntent: jest.fn(async () => ({ id: 'pi_1', client_secret: 'pi_1_secret' })),
        createEphemeralKey: jest.fn(async () => ({ secret: 'ek_1' })),
      };
      const feePolicy: any = {
        planFor: jest.fn(async () => ({
          application_fee_cents: 198,
          head_coach_split_cents: 0,
          head_coach_id: null,
        })),
      };
      const gate: any = { evaluate: jest.fn(async () => ({ ok: true })) };
      const packages: any = { getById: jest.fn(async () => pkg) };
      const state: any = { ready: true };
      const svc = new CheckoutService(prisma, stripe, packages, state, feePolicy, gate);
      jest
        .spyOn(svc, 'ensureCustomer')
        .mockResolvedValue(stub<ConnectCustomer>({ stripe_customer_id: 'cus_1' }));

      await svc.createPaymentIntentForClient(CLIENT, { package_id: PKG, idempotency_key: KEY });

      const sent = stripe.createPaymentIntent.mock.calls[0][0];
      expect(sent.amount).toBe(quote.due_today_cents);
      expect(sent.amount).toBe(9900);
      expect(sent.currency).toBe(quote.currency);
      expect(quote.first_charge_at).toBeNull();
    },
  );
});

describe('BILLQUOTE — client package reads carry the quote, own coach only', () => {
  function build(rows: CoachPackage[], startedTrialWith: string[] = []) {
    const table = makeTrialUsageTable();
    for (const coach of startedTrialWith) {
      table.rows.push({
        id: `u-${coach}`,
        client_user_id: CLIENT,
        coach_user_id: coach,
        package_id: 'pkg-old',
        purchase_id: `pur-${coach}`,
        trial_days: 14,
        status: 'started',
        reserved_at: new Date(),
      });
    }
    const capability = new TrialCheckoutCapability();
    capability.register(SUBSCRIPTION_CHECKOUT_OWNER);
    const trials = new TrialUsageService(
      stub<ConstructorParameters<typeof TrialUsageService>[0]>({ packageTrialUsage: table }),
      capability,
    );
    const packages = {
      listPublicForCoach: jest.fn(async (coachId: string) =>
        rows.filter((r) => r.coach_id === coachId),
      ),
      getById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    };
    const prisma = makeFakePrisma();
    const controller = new ClientPackagesController(
      stub<ConstructorParameters<typeof ClientPackagesController>[0]>(packages),
      stub<ConstructorParameters<typeof ClientPackagesController>[1]>(prisma),
      trials,
    );
    return { controller, packages, prisma };
  }
  const req = (coachId: string | null) =>
    stub<Parameters<ClientPackagesController['list']>[0]>({
      user: { id: CLIENT, coach_id: coachId },
    });

  it('the list quotes every package of the current coach for this client', async () => {
    const monthly = pkgRow({ id: 'p-monthly' });
    const trial = pkgRow({ id: 'p-trial', ...TRIAL });
    const combo = pkgRow({ id: 'p-combo', ...COMBO });
    const { controller, packages } = build([monthly, trial, combo]);
    const res = await controller.list(req(COACH));
    expect(packages.listPublicForCoach).toHaveBeenCalledWith(COACH);
    const byId = new Map<string, ChargeQuote | null>();
    for (const p of res.packages) byId.set(p.id, p.quote);
    expect(byId.get('p-monthly')?.due_today_cents).toBe(4900);
    expect(byId.get('p-combo')?.due_today_cents).toBe(14800);
    const t = byId.get('p-trial');
    expect(t?.due_today_cents).toBe(0);
    expect(t?.first_charge_at).toBe(t?.trial_end);
    expect(Date.parse(t?.trial_end ?? '')).toBeGreaterThan(Date.now() + 13 * DAY);
  });

  it('a client whose trial with this coach was used is quoted the full price today', async () => {
    const { controller } = build([pkgRow(TRIAL)], [COACH]);
    const detail = await controller.detail(req(COACH), PKG);
    expect(detail.trial_offer?.available).toBe(false);
    expect(detail.quote?.due_today_cents).toBe(4900);
    expect(detail.quote?.trial_end).toBeNull();
  });

  it("another coach's package is refused: 404, no quote, no trial read", async () => {
    const theirs = pkgRow({ coach_id: OTHER_COACH });
    const { controller, prisma } = build([theirs]);
    const offers = jest.spyOn(TrialUsageService.prototype, 'offersForClient');
    await expect(controller.detail(req(COACH), PKG)).rejects.toBeInstanceOf(NotFoundException);
    expect(offers).not.toHaveBeenCalled();
    const list = await controller.list(req(COACH));
    expect(list.packages).toEqual([]);
    expect(prisma.clientPurchase.findMany).not.toHaveBeenCalled();
  });

  it('a client with no coach gets no packages and no quotes', async () => {
    const { controller, packages } = build([pkgRow()]);
    expect(await controller.list(req(null))).toEqual({ packages: [] });
    expect(packages.listPublicForCoach).not.toHaveBeenCalled();
    await expect(controller.detail(req(null), PKG)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// FIX998 (Sol B1) — a client who opens a plan's sheet, dismisses it and comes
// back inside the reuse window gets the SAME attempt back from the checkout,
// with the dates Stripe already set. The quote reads that attempt through the
// checkout's own rule and reports its dates; outside the window it is fresh.
describe('FIX998 — the quote shows the dates of the attempt the checkout resumes', () => {
  const OTHER_CLIENT = '66666666-6666-4666-8666-666666666666';
  const PKG_MONTHLY = '77777777-7777-4777-8777-777777777777';
  const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const HOUR = 3_600_000;
  const at = (ms: number) => jest.setSystemTime(NOW.getTime() + ms);
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const req = stub<Parameters<ClientPackagesController['list']>[0]>({
    user: { id: CLIENT, coach_id: COACH },
  });

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  function world() {
    const prisma = makeFakePrisma();
    prisma.packageTrialUsage = makeTrialUsageTable();
    const stripe = makeFakeStripe();
    prisma._users.push(
      { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
      { id: OTHER_CLIENT, email: 'o@example.test', name: 'Other', coach_id: COACH },
      { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
    );
    const rows = [
      pkgRow({ ...TRIAL, stripe_price_id: 'price_trial' }),
      pkgRow({ id: PKG_MONTHLY, stripe_price_id: 'price_monthly' }),
    ];
    prisma._packages.push(...rows);
    prisma._accounts.push({
      coach_user_id: COACH,
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    const packages = {
      getById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
      listPublicForCoach: jest.fn(async () => rows),
    };
    const feePolicy = {
      planFor: jest.fn(async () => ({
        application_fee_cents: 98,
        head_coach_split_cents: 0,
        head_coach_id: null,
      })),
    };
    type Deps = ConstructorParameters<typeof SubscriptionCheckoutService>;
    const capability = new TrialCheckoutCapability();
    const checkout = new SubscriptionCheckoutService(
      prisma,
      stripe,
      stub<Deps[2]>(packages),
      stub<Deps[3]>({ ready: true }),
      stub<Deps[4]>(feePolicy),
      stub<Deps[5]>(makeCheckoutHelpers(prisma)),
      capability,
    );
    const controller = new ClientPackagesController(
      stub<ConstructorParameters<typeof ClientPackagesController>[0]>(packages),
      prisma,
      new TrialUsageService(prisma, capability),
    );
    /** Open the pay / trial sheet (subscription-intent); the client then dismisses it. */
    const buy = (client: string, key: string, pkgId = PKG) =>
      checkout.createSubscriptionIntent(client, { package_id: pkgId, idempotency_key: key });
    /** Refresh the package list, as the app does when the client comes back. */
    const quotes = async () => {
      const byId = new Map<string, ChargeQuote | null>();
      for (const p of (await controller.list(req)).packages) byId.set(p.id, p.quote);
      return byId;
    };
    /** The date Stripe holds for a subscription (trial end, or next renewal). */
    const stripeDate = (subId: string) =>
      new Date(stripe._subs.get(subId).current_period_end * 1000).toISOString();
    return { stripe, controller, buy, quotes, stripeDate };
  }

  it('trial: dismissed, back 12 h later: the quote is the retained trial end, and checkout resumes it', async () => {
    const w = world();
    const first = await w.buy(CLIENT, KEY);
    expect(first.plan.trial_ends_at).toBe(iso(14 * DAY));
    at(12 * HOUR);
    const { quote } = await w.controller.detail(req, PKG);
    const again = await w.buy(CLIENT, KEY2);
    expect(again.reused).toBe(true);
    expect(again.subscription_id).toBe(first.subscription_id);
    expect(w.stripe.createSubscription).toHaveBeenCalledTimes(1);
    // Not a fresh now + 14 days (that would be 12 h later than Stripe's).
    expect(quote).toEqual({
      due_today_cents: 0,
      currency: 'usd',
      first_charge_at: iso(14 * DAY),
      trial_end: iso(14 * DAY),
    });
    expect(again.plan.trial_ends_at).toBe(quote?.trial_end);
    expect(w.stripeDate(again.subscription_id)).toBe(quote?.first_charge_at);
    expect(again.plan.first_charge_cents).toBe(quote?.due_today_cents);
  });

  it('trial: back after the reuse window: a fresh trial from now, the date checkout then sends', async () => {
    const w = world();
    const first = await w.buy(CLIENT, KEY);
    at(24 * HOUR);
    const { quote } = await w.controller.detail(req, PKG);
    const again = await w.buy(CLIENT, KEY2);
    expect(again.subscription_id).not.toBe(first.subscription_id);
    expect(w.stripe.cancelSubscription).toHaveBeenCalledWith(first.subscription_id);
    expect(w.stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBe(14);
    const fresh = iso(24 * HOUR + 14 * DAY);
    expect(quote).toEqual({
      due_today_cents: 0,
      currency: 'usd',
      first_charge_at: fresh,
      trial_end: fresh,
    });
    expect(again.plan.trial_ends_at).toBe(quote?.trial_end);
    expect(w.stripeDate(again.subscription_id)).toBe(quote?.first_charge_at);
  });

  it('monthly: dismissed, back 12 h later: the next charge is the resumed subscription date', async () => {
    const w = world();
    const first = await w.buy(CLIENT, KEY, PKG_MONTHLY);
    at(12 * HOUR);
    const quote = (await w.quotes()).get(PKG_MONTHLY);
    const again = await w.buy(CLIENT, KEY2, PKG_MONTHLY);
    expect(again.reused).toBe(true);
    expect(again.subscription_id).toBe(first.subscription_id);
    expect(quote).toEqual({
      due_today_cents: 4900,
      currency: 'usd',
      first_charge_at: w.stripeDate(first.subscription_id),
      trial_end: null,
    });
    expect(again.plan.first_charge_cents).toBe(quote?.due_today_cents);
  });

  it("another client's attempt never shapes my quote, nor my attempt for another plan", async () => {
    const w = world();
    const theirs = await w.buy(OTHER_CLIENT, KEY);
    const mine = await w.buy(CLIENT, KEY, PKG_MONTHLY);
    at(12 * HOUR);
    const quotes = await w.quotes();
    // PKG: only the other client has an attempt, so mine is a fresh trial from now.
    const fresh = iso(12 * HOUR + 14 * DAY);
    expect(quotes.get(PKG)?.trial_end).toBe(fresh);
    expect(quotes.get(PKG)?.first_charge_at).toBe(fresh);
    expect(quotes.get(PKG_MONTHLY)?.first_charge_at).toBe(w.stripeDate(mine.subscription_id));
    const bought = await w.buy(CLIENT, KEY2);
    expect(bought.subscription_id).not.toBe(theirs.subscription_id);
    expect(bought.plan.trial_ends_at).toBe(fresh);
    expect(w.stripeDate(bought.subscription_id)).toBe(fresh);
  });
});
