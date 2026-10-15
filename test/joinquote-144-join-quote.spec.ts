// JOINQUOTE (agent 144) — a new client pays for the first time on the join
// screen: their invite code or coach link carries one package (B-PACKAGE-135)
// and, until that purchase attaches them, they have no coach, so the client
// package reads give them nothing. The join outcome's package therefore
// carries the same `quote` (#998's packageQuote / chargeQuote) for THIS
// client: their trial offer, the open attempt the join checkout would resume,
// fresh on every call. These specs run the real attach path, the real join
// checkouts (subscription-intent and payment-intent with `join_code`) and a
// mock Stripe.
import { HttpException } from '@nestjs/common';
import type { CoachPackage, ConnectCustomer } from '@prisma/client';
import { CheckoutService, type ChargeQuote } from '../src/checkout/checkout.service';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { TrialCheckoutCapability } from '../src/packages/trials/trial-checkout-capability';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import {
  makeCheckoutHelpers,
  makeFakePrisma,
  makeFakeStripe,
  matchWhere,
} from './support/b-recur-fakes';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const OTHER_COACH = '55555555-5555-4555-8555-555555555555';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINK = 'GP-SAMLNK'; // the coach's link (CoachProfile code, no package of its own)
const ROW = 'GP-ROW001'; // a per-row invite code
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date('2026-10-14T17:30:00.000Z');
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function pkg(id: string, over: Record<string, unknown> = {}): CoachPackage {
  return stub<CoachPackage>({
    id,
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
    duration_periods: null,
    trial_days: 0,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    requires_contract: false,
    contract_template_id: null,
    ...over,
  });
}
const MONTHLY = pkg('p-monthly');
const TRIAL = pkg('p-trial', { trial_days: 14 });
const ONE_TIME = pkg('p-once', { billing_type: 'one_time', interval: null, amount_cents: 9900 });
const COMBO = pkg('p-combo', {
  billing_type: 'one_time',
  interval: null,
  amount_cents: 9900,
  recurring_amount_cents: 4900,
  recurring_interval: 'month',
  recurring_interval_count: 1,
});
const FREE = pkg('p-free', { billing_type: 'one_time', interval: null, amount_cents: 0 });
const THEIRS = pkg('p-theirs', { coach_id: OTHER_COACH, amount_cents: 1500 });

const client = (id: string, coachId: string | null) => ({
  id,
  email: `${id}-email`,
  name: 'Client',
  role: 'student',
  coach_id: coachId,
});

/** One coach, a coachless client, the coach's link and one row code; `rows` oldest first. */
function world(rows: CoachPackage[], code: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma.packageTrialUsage = makeTrialUsageTable();
  prisma._users.push(
    client(CLIENT, null),
    { id: COACH, email: 'coach-email', name: 'Sam Rivera', role: 'coach', coach_id: null },
    { id: OTHER_COACH, email: 'other-email', name: 'Alex', role: 'coach', coach_id: null },
  );
  prisma._packages.push(...[...rows, THEIRS].map((r) => ({ ...r })));
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const profile = {
    user_id: COACH,
    invite_code: LINK,
    invite_code_package_id: null,
    invite_code_grant_mode: 'none',
  };
  const codes: Array<Record<string, any>> = [
    {
      id: 'row-1',
      code: ROW,
      coach_id: COACH,
      revoked: false,
      expires_at: null,
      max_uses: null,
      used_count: 0,
      intended_email: null,
      package_id: null,
      grant_mode: 'none',
      ...code,
    },
  ];
  const role = (id: string) => prisma._users.find((u: { id: string }) => u.id === id)?.role;
  prisma.user.updateMany = jest.fn(async ({ where, data }: any) => {
    const hits = prisma._users.filter((u: any) => matchWhere(u, where));
    for (const u of hits) Object.assign(u, data);
    return { count: hits.length };
  });
  prisma.coachProfile = {
    findUnique: jest.fn(async ({ where }: any) =>
      where.invite_code === LINK ? { ...profile, user: { id: COACH, role: role(COACH) } } : null,
    ),
  };
  prisma.inviteCode = {
    findUnique: jest.fn(async ({ where }: any) => {
      const c = codes.find((x) => (where.code ? x.code === where.code : x.id === where.id));
      return c ? { ...c, coach: { id: c.coach_id, name: 'Sam', role: role(c.coach_id) } } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hits = codes.filter((c) => c.id === where.id);
      for (const c of hits) {
        if (data.used_count) c.used_count += data.used_count.increment;
        else Object.assign(c, data);
      }
      return { count: hits.length };
    }),
  };
  prisma.coachSubscription = { findUnique: jest.fn(async () => ({ status: 'active' })) };
  // findJoinPackage step 2: the coach's oldest usable package (seed order).
  const usable = (p: CoachPackage, coachId: string) =>
    p.coach_id === coachId && p.is_active && !p.archived_at && !!p.published_at;
  prisma.coachPackage.findFirst = jest.fn(
    async ({ where }: any) =>
      prisma._packages.find((p: CoachPackage) => usable(p, where.coach_id)) ?? null,
  );
  prisma.inviteRedemption = {
    create: jest.fn(async ({ data }: any) => ({ id: 'red-1', ...data })),
  };

  // The join checkouts, wired as in the app (the subscription one registers
  // the trial capability the client's trial offer reads).
  const stripe = makeFakeStripe();
  const helpers = makeCheckoutHelpers(prisma);
  const prices = new Map<string, { unit: number; currency: string }>();
  helpers.ensurePriceForPackage.mockImplementation(async (p: CoachPackage) => {
    prices.set(`price_one_${p.id}`, { unit: p.amount_cents, currency: p.currency });
    return `price_one_${p.id}`;
  });
  helpers.ensureRecurringPriceForPackage.mockImplementation(async (p: CoachPackage) => {
    const unit = p.recurring_amount_cents ?? 0;
    prices.set(`price_rec_${p.id}`, { unit, currency: p.currency });
    return `price_rec_${p.id}`;
  });
  const packages = {
    getById: jest.fn(
      async (id: string) => prisma._packages.find((p: CoachPackage) => p.id === id) ?? null,
    ),
  };
  const feePolicy = {
    planFor: jest.fn(async () => ({
      application_fee_cents: 98,
      head_coach_split_cents: 0,
      head_coach_id: null,
    })),
  };
  type SubDeps = ConstructorParameters<typeof SubscriptionCheckoutService>;
  const capability = new TrialCheckoutCapability();
  const subscriptions = new SubscriptionCheckoutService(
    prisma,
    stripe,
    stub<SubDeps[2]>(packages),
    stub<SubDeps[3]>({ ready: true }),
    stub<SubDeps[4]>(feePolicy),
    stub<SubDeps[5]>(helpers),
    capability,
  );
  const piStripe: any = {
    createPaymentIntent: jest.fn(async () => ({ id: 'pi_1', client_secret: 'pi_1_secret' })),
    createEphemeralKey: jest.fn(async () => ({ secret: 'ek_1' })),
  };
  type PiDeps = ConstructorParameters<typeof CheckoutService>;
  const oneTime = new CheckoutService(
    prisma,
    stub<PiDeps[1]>(piStripe),
    stub<PiDeps[2]>(packages),
    stub<PiDeps[3]>({ ready: true }),
    stub<PiDeps[4]>(feePolicy),
    stub<PiDeps[5]>({ evaluate: jest.fn(async () => ({ ok: true })) }),
  );
  jest
    .spyOn(oneTime, 'ensureCustomer')
    .mockResolvedValue(stub<ConnectCustomer>({ stripe_customer_id: 'cus_1' }));

  const trials = new TrialUsageService(prisma, capability);
  const grants = {
    joinGrantActive: jest.fn(async () => true),
    grantForJoinTx: jest.fn(async () => ({ status: 'created', purchase_id: 'cp-grant' })),
    flushAfterCommit: jest.fn(),
  };
  type InvDeps = ConstructorParameters<typeof InviteCodesService>;
  const invites = new InviteCodesService(
    prisma,
    stub<InvDeps[1]>({ capture: jest.fn() }),
    stub<InvDeps[2]>({}),
    stub<InvDeps[3]>({ write: jest.fn() }),
    stub<InvDeps[4]>(grants),
    trials,
  );
  /** POST /auth/attach-invite-code (every accept point runs this attach). */
  const join = (code: string, user = CLIENT) => invites.attachUserToCoachByCode(user, code);
  /** The join screen's "Continue to payment" for a renewing package (subscription-intent). */
  const subscribe = (packageId: string, key: string, joinCode?: string, user = CLIENT) =>
    subscriptions.createSubscriptionIntent(user, {
      package_id: packageId,
      idempotency_key: key,
      join_code: joinCode,
    });
  const stripeDate = (subId: string) =>
    new Date(stripe._subs.get(subId).current_period_end * 1000).toISOString();
  const offers = jest.spyOn(trials, 'offersForClient');
  return { prisma, stripe, piStripe, prices, oneTime, join, subscribe, stripeDate, offers, codes };
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const MONTH_ON = '2026-11-14T17:30:00.000Z';
const quoteOf = (due: number, currency: string, next: string | null, trialEnd: string | null) => ({
  due_today_cents: due,
  currency,
  first_charge_at: next,
  trial_end: trialEnd,
});

describe('JOINQUOTE — a paid join carries the quote, and the join checkout charges it', () => {
  it.each([
    ['monthly', MONTHLY, quoteOf(4900, 'usd', MONTH_ON, null)],
    ['one-time + recurring', COMBO, quoteOf(14800, 'usd', MONTH_ON, null)],
    ['14-day trial', TRIAL, quoteOf(0, 'usd', iso(14 * DAY), iso(14 * DAY))],
    ['monthly in eur', pkg('p-eur', { currency: 'eur' }), quoteOf(4900, 'eur', MONTH_ON, null)],
  ])('%s: the join quote, then Stripe first invoice = due today', async (_n, row, expected) => {
    const w = world([row]);
    const res = await w.join(LINK);
    expect(res).toMatchObject({
      coach_id: null,
      join: { status: 'checkout_required', package: { id: row.id } },
    });
    const quote = res.join?.package.quote as ChargeQuote;
    expect(quote).toEqual(expected);

    const out = await w.subscribe(row.id, KEY, res.join?.code ?? '');
    const sent = w.stripe.createSubscription.mock.calls[0][0];
    const items = [sent.recurringPriceId, sent.oneTimePriceId]
      .filter((id): id is string => typeof id === 'string')
      .map((id) => w.prices.get(id));
    const trialDays = sent.trialPeriodDays ?? 0;
    // Stripe's first invoice: every item now, or $0 while a trial runs.
    const firstInvoice =
      trialDays > 0 ? 0 : items.reduce((sum, p) => sum + (p?.unit ?? NaN), 0);
    expect(firstInvoice).toBe(quote.due_today_cents);
    for (const p of items) expect(p?.currency).toBe(quote.currency);
    expect(out.plan.first_charge_cents).toBe(quote.due_today_cents);
    expect(out.plan.trial_ends_at).toBe(quote.trial_end);
    if (trialDays > 0) expect(w.stripeDate(out.subscription_id)).toBe(quote.first_charge_at);
  });

  it('one-time: the PaymentIntent amount and currency are the join quote', async () => {
    const w = world([ONE_TIME]);
    const res = await w.join(ROW);
    const quote = res.join?.package.quote;
    expect(quote).toEqual(quoteOf(9900, 'usd', null, null));
    await w.oneTime.createPaymentIntentForClient(CLIENT, {
      package_id: ONE_TIME.id,
      idempotency_key: KEY,
      join_code: ROW,
    });
    const sent = w.piStripe.createPaymentIntent.mock.calls[0][0];
    expect(sent.amount).toBe(quote?.due_today_cents);
    expect(sent.currency).toBe(quote?.currency);
  });

  it('a client whose trial with this coach was used is quoted the full price', async () => {
    const w = world([TRIAL]);
    w.prisma.packageTrialUsage.rows.push({
      id: 'u-1',
      client_user_id: CLIENT,
      coach_user_id: COACH,
      package_id: 'p-old',
      purchase_id: 'pur-old',
      trial_days: 14,
      status: 'started',
      reserved_at: new Date(),
    });
    const quote = (await w.join(LINK)).join?.package.quote;
    expect(quote).toEqual(quoteOf(4900, 'usd', MONTH_ON, null));
  });
});

describe('JOINQUOTE — only the package the code really grants is quoted', () => {
  it("a bound code quotes its package; the link the coach's oldest usable one", async () => {
    const w = world([MONTHLY, TRIAL], { package_id: TRIAL.id });
    const bound = await w.join(ROW);
    expect(bound.join?.package).toMatchObject({
      id: TRIAL.id,
      quote: { due_today_cents: 0, trial_end: iso(14 * DAY) },
    });
    const link = await w.join(LINK);
    expect(link.join?.package).toMatchObject({
      id: MONTHLY.id,
      quote: { due_today_cents: 4900, trial_end: null },
    });
  });

  it("a code bound to another coach's package never quotes it: the coach's own one", async () => {
    const w = world([MONTHLY], { package_id: THEIRS.id });
    const res = await w.join(ROW);
    expect(res.join?.package).toMatchObject({ id: MONTHLY.id, quote: { due_today_cents: 4900 } });
    expect(w.offers).toHaveBeenCalledWith(CLIENT, [
      expect.objectContaining({ id: MONTHLY.id, coach_id: COACH }),
    ]);
  });

  it('free and prepaid joins are granted: quote null, no trial or attempt read', async () => {
    const free = world([FREE]);
    const a = await free.join(LINK);
    expect(a).toMatchObject({
      coach_id: COACH,
      join: { status: 'granted', grant_mode: 'free', package: { id: FREE.id, quote: null } },
    });
    const prepaid = world([MONTHLY], { package_id: MONTHLY.id, grant_mode: 'prepaid' });
    const b = await prepaid.join(ROW);
    expect(b).toMatchObject({
      coach_id: COACH,
      join: { status: 'granted', grant_mode: 'prepaid', package: { quote: null } },
    });
    for (const w of [free, prepaid]) {
      expect(w.offers).not.toHaveBeenCalled();
      expect(w.prisma.clientPurchase.findMany).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['expired', { expires_at: new Date(NOW.getTime() - DAY) }, 'code_expired'],
    ['revoked', { revoked: true }, 'code_revoked'],
  ])('an %s code is refused as today, with no quote', async (_n, over, code) => {
    const w = world([MONTHLY], over);
    const err = await w.join(ROW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({ code });
    expect(w.offers).not.toHaveBeenCalled();
    expect(w.prisma.clientPurchase.findMany).not.toHaveBeenCalled();
  });

  it("another coach's client entering this code is refused as today, with no quote", async () => {
    const w = world([MONTHLY]);
    w.prisma._users.push(client('client-b', OTHER_COACH));
    const err = await w.join(LINK, 'client-b').catch((e: unknown) => e);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'already_attached_to_different_coach',
    });
    expect(w.offers).not.toHaveBeenCalled();
    expect(w.prisma.clientPurchase.findMany).not.toHaveBeenCalled();
  });
});

// "Finish joining" reopens a saved join. The quote is valid only when read,
// so the app re-reads the join (the same attach call with the saved code).
describe('JOINQUOTE — each read is fresh and follows the attempt the checkout resumes', () => {
  it('read again 3 days later: a quote from then; no attach, seat or ledger row', async () => {
    const w = world([TRIAL]);
    expect((await w.join(ROW)).join?.package.quote?.trial_end).toBe(iso(14 * DAY));
    jest.setSystemTime(NOW.getTime() + 3 * DAY);
    const again = await w.join(ROW);
    expect(again).toMatchObject({ coach_id: null, already_attached: false });
    const later = iso(3 * DAY + 14 * DAY);
    expect(again.join?.package.quote).toEqual(quoteOf(0, 'usd', later, later));
    expect(w.codes[0].used_count).toBe(0);
    expect(w.prisma.inviteRedemption.create).not.toHaveBeenCalled();
  });

  it('trial sheet dismissed, join re-read 12 h later: the retained trial end', async () => {
    const w = world([TRIAL]);
    const first = await w.subscribe(TRIAL.id, KEY, LINK);
    jest.setSystemTime(NOW.getTime() + 12 * HOUR);
    const quote = (await w.join(LINK)).join?.package.quote;
    expect(quote).toEqual(quoteOf(0, 'usd', iso(14 * DAY), iso(14 * DAY)));
    const again = await w.subscribe(TRIAL.id, KEY2, LINK);
    expect(again.reused).toBe(true);
    expect(again.subscription_id).toBe(first.subscription_id);
    expect(again.plan.trial_ends_at).toBe(quote?.trial_end);
    expect(w.stripeDate(again.subscription_id)).toBe(quote?.first_charge_at);
  });

  it('re-read after the reuse window: a fresh trial, the date checkout sends', async () => {
    const w = world([TRIAL]);
    const first = await w.subscribe(TRIAL.id, KEY, LINK);
    jest.setSystemTime(NOW.getTime() + 24 * HOUR);
    const quote = (await w.join(LINK)).join?.package.quote;
    const fresh = iso(24 * HOUR + 14 * DAY);
    expect(quote).toEqual(quoteOf(0, 'usd', fresh, fresh));
    const again = await w.subscribe(TRIAL.id, KEY2, LINK);
    expect(again.subscription_id).not.toBe(first.subscription_id);
    expect(again.plan.trial_ends_at).toBe(quote?.trial_end);
    expect(w.stripeDate(again.subscription_id)).toBe(quote?.first_charge_at);
  });

  it("another client's open attempt on the same package never shapes my join quote", async () => {
    const w = world([TRIAL]);
    w.prisma._users.push(client('client-c', COACH));
    // Their own coach's plan, opened and dismissed.
    const theirs = await w.subscribe(TRIAL.id, KEY, undefined, 'client-c');
    expect(theirs.plan.trial_ends_at).toBe(iso(14 * DAY));
    jest.setSystemTime(NOW.getTime() + HOUR);
    const quote = (await w.join(LINK)).join?.package.quote;
    expect(quote?.trial_end).toBe(iso(HOUR + 14 * DAY));
    const mine = await w.subscribe(TRIAL.id, KEY2, LINK);
    expect(mine.subscription_id).not.toBe(theirs.subscription_id);
    expect(mine.plan.trial_ends_at).toBe(quote?.trial_end);
  });
});
