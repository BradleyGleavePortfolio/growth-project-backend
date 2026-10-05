// B-TR8-120 (agent 120) — ONE SHARED TRIAL RULE (owner ruling 10:31 PDT 10-05):
// at most one free trial per client per coach, whichever checkout sold it.
// Main's native subscription checkout (#678: trial_started_at, open-attempt
// hold) and the package trial ledger (T1/T3: PackageTrialUsage) compose in one
// place: every trial start in the webhook claims the ledger first, and only
// the purchase that holds it carries trial_started_at. The checkout's
// eligibility (trial_started_at) and the trial offer (ledger) then always say
// the same thing.
//
// Before this round (#673 merged naively onto main's webhook): a second
// purchase of the same coach whose card was saved got its own free trial
// (access + trial_started_at), the ledger never saw native trials, and the
// trial offer said "not offered yet" because no checkout registered.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { TrialCheckoutCapability } from '../src/packages/trials/trial-checkout-capability';
import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';
import { makeTrialConflictTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG_A = '33333333-3333-4333-8333-333333333333';
const PKG_B = '44444444-4444-4444-8444-444444444444';
const PKG_C = '55555555-5555-4555-8555-555555555555';
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function pkg(id: string, trialDays: number) {
  return {
    id,
    coach_id: COACH,
    name: `Coaching ${id.slice(0, 4)}`,
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
    stripe_price_id: `price_${id.slice(0, 4)}`,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    duration_periods: null,
    trial_days: trialDays,
  };
}

function world() {
  const prisma = makeFakePrisma();
  prisma.packageTrialUsage = makeTrialUsageTable();
  prisma.packageTrialConflict = makeTrialConflictTable();
  const stripe = makeFakeStripe();
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push(pkg(PKG_A, 7), pkg(PKG_B, 14), pkg(PKG_C, 3));
  prisma._accounts.push({
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: true,
    deauthorized_at: null,
  });
  const packages = {
    getById: jest.fn(async (id: string) =>
      prisma._packages.find((p: { id: string }) => p.id === id),
    ),
  };
  const feePolicy = {
    planFor: jest.fn(async () => ({
      application_fee_cents: 98,
      head_coach_split_cents: 0,
      head_coach_id: null,
    })),
  };
  type CheckoutDeps = ConstructorParameters<typeof SubscriptionCheckoutService>;
  const capability = new TrialCheckoutCapability();
  const checkout = new SubscriptionCheckoutService(
    prisma,
    stripe,
    stub<CheckoutDeps[2]>(packages),
    stub<CheckoutDeps[3]>({ ready: true }),
    stub<CheckoutDeps[4]>(feePolicy),
    stub<CheckoutDeps[5]>(makeCheckoutHelpers(prisma)),
    capability,
  );
  const usage = new TrialUsageService(prisma, capability);
  const conflicts = new TrialConflictService(prisma, stripe);
  const fanout = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const dunning = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const splits = {
    onChargeSucceeded: jest.fn(async () => ({
      charge_id: null,
      ledger_entries: 0,
      transfer_enqueued: false,
    })),
  };
  type HandlerDeps = ConstructorParameters<typeof CheckoutWebhookHandlerService>;
  const handler = new CheckoutWebhookHandlerService(
    prisma,
    stripe,
    stub<HandlerDeps[2]>(splits),
    stub<HandlerDeps[3]>(dunning),
    undefined,
    stub<HandlerDeps[5]>(fanout),
    undefined,
    undefined,
    undefined,
    usage,
    undefined,
    conflicts,
  );
  const row = (pkgId: string) =>
    prisma._purchases.find((p: { package_id: string }) => p.package_id === pkgId);
  /** A native trial attempt for `pkgId` through POST /v1/checkout/subscription-intent. */
  const buy = (pkgId: string, key: string) =>
    checkout.createSubscriptionIntent(CLIENT, { package_id: pkgId, idempotency_key: key });
  /** Stripe's subscription event for the attempt of `pkgId`. */
  const subEvent = (pkgId: string, status: string, over: Record<string, unknown> = {}) => ({
    id: `evt_${pkgId.slice(0, 4)}_${status}_${Math.random()}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: row(pkgId).stripe_subscription_id,
        status,
        trial_start: now() - DAY,
        trial_end: now() + 6 * DAY,
        current_period_end: now() + 6 * DAY,
        cancel_at_period_end: false,
        default_payment_method: 'pm_card',
        ...over,
      },
    },
  });
  /** The two trial records agree: one started trial, carried by the same purchase. */
  const agree = () => {
    const ledger = prisma.packageTrialUsage.rows.filter(
      (u: { status: string }) => u.status === 'started',
    );
    const marked = prisma._purchases.filter(
      (p: { trial_started_at: Date | null }) => !!p.trial_started_at,
    );
    expect(ledger.map((u: { purchase_id: string }) => u.purchase_id)).toEqual(
      marked.map((p: { id: string }) => p.id),
    );
    return ledger.length;
  };
  return { prisma, stripe, checkout, usage, handler, capability, row, buy, subEvent, agree };
}

type World = ReturnType<typeof world>;

/** A second attempt that slipped past the checkout (e.g. a stale attempt whose retire failed). */
function secondAttempt(w: World, pkgId: string, subId: string) {
  const first = w.row(PKG_A);
  w.prisma._purchases.push({
    ...first,
    id: `cp_${pkgId.slice(0, 4)}`,
    package_id: pkgId,
    stripe_subscription_id: subId,
    stripe_checkout_session_id: subId,
    idempotency_key: `sub-${subId}`,
    trial_days: 14,
    trial_started_at: null,
    entitlement_active: false,
    status: 'trialing',
    created_at: new Date(),
  });
}

describe('B-TR8-120 — one shared trial rule across the native checkout and the trial ledger', () => {
  it('the subscription checkout registers: a trial is offered before any trial is used', async () => {
    const w = world();
    expect(w.capability.registeredBy()).toBe('subscription-checkout');
    const offers = await w.usage.offersForClient(CLIENT, w.prisma._packages);
    expect(offers.get(PKG_A)).toEqual({ trial_days: 7, available: true, reason: 'offered' });
  });

  it('native trial started: the ledger holds it, the offer says already_used and the next checkout has no trial', async () => {
    const w = world();
    const first = await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(first.plan.trial_days).toBe(7);
    await w.handler.handle(w.subEvent(PKG_A, 'trialing'), w.prisma);
    expect(w.row(PKG_A)).toEqual(
      expect.objectContaining({ entitlement_active: true, status: 'trialing' }),
    );
    expect(w.agree()).toBe(1);
    const offers = await w.usage.offersForClient(CLIENT, w.prisma._packages);
    expect(offers.get(PKG_B)?.reason).toBe('already_used');
    expect(offers.get(PKG_C)?.reason).toBe('already_used');
    const next = await w.buy(PKG_B, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(w.stripe.createSubscription.mock.calls[1][0].trialPeriodDays).toBeUndefined();
    expect(next.plan.trial_days).toBe(0);
  });

  it.each([
    ['A first, then B', PKG_A, PKG_B],
    ['B first, then A', PKG_B, PKG_A],
  ])(
    'two trialing attempts (%s): the first card saved wins, the second gets no access and owes a cancel',
    async (_n, winner, loser) => {
      const w = world();
      await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      secondAttempt(w, PKG_B, 'sub_b');
      await w.handler.handle(w.subEvent(winner, 'trialing'), w.prisma);
      const res = await w.handler.handle(w.subEvent(loser, 'trialing'), w.prisma);
      expect(w.row(winner)).toEqual(expect.objectContaining({ entitlement_active: true }));
      expect(w.row(loser)).toEqual(
        expect.objectContaining({ entitlement_active: false, trial_started_at: null }),
      );
      // C-671-4 — a trial that never started keeps no trial end.
      expect(w.row(loser).trial_ends_at ?? null).toBeNull();
      expect(res.trialConflictSubscriptionId).toBe(w.row(loser).stripe_subscription_id);
      expect(w.prisma.packageTrialConflict.rows).toEqual([
        expect.objectContaining({ purchase_id: w.row(loser).id, status: 'owed' }),
      ]);
      expect(w.agree()).toBe(1);
      // Redelivery and a later card event never flip it.
      await w.handler.handle(w.subEvent(loser, 'trialing'), w.prisma);
      expect(w.row(loser).entitlement_active).toBe(false);
      expect(w.agree()).toBe(1);
    },
  );

  it('the losing attempt first seen active (B-680-4: it billed): a paid plan, no second trial recorded', async () => {
    const w = world();
    await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    secondAttempt(w, PKG_B, 'sub_b');
    await w.handler.handle(w.subEvent(PKG_A, 'trialing'), w.prisma);
    await w.handler.handle(
      w.subEvent(PKG_B, 'active', { trial_end: now() - 60, current_period_end: now() + 30 * DAY }),
      w.prisma,
    );
    expect(w.row(PKG_B)).toEqual(
      expect.objectContaining({
        entitlement_active: true,
        status: 'active',
        trial_started_at: null,
      }),
    );
    expect(w.prisma.packageTrialConflict.rows[0].status).toBe('superseded');
    expect(w.agree()).toBe(1);
  });

  it('the losing attempt first seen past_due (no money taken): no access, the cancel is owed', async () => {
    const w = world();
    await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    secondAttempt(w, PKG_B, 'sub_b');
    await w.handler.handle(w.subEvent(PKG_A, 'trialing'), w.prisma);
    const res = await w.handler.handle(
      w.subEvent(PKG_B, 'past_due', { trial_end: now() - 60 }),
      w.prisma,
    );
    expect(w.row(PKG_B)).toEqual(
      expect.objectContaining({ entitlement_active: false, trial_started_at: null }),
    );
    expect(res.trialConflictSubscriptionId).toBe('sub_b');
    expect(w.agree()).toBe(1);
  });

  it('the losing attempt ends after its trial ran: never counted as a trial, the owed cancel is settled', async () => {
    const w = world();
    await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    secondAttempt(w, PKG_B, 'sub_b');
    await w.handler.handle(w.subEvent(PKG_A, 'trialing'), w.prisma);
    await w.handler.handle(w.subEvent(PKG_B, 'trialing'), w.prisma);
    const ended = w.subEvent(PKG_B, 'canceled', { canceled_at: now() });
    await w.handler.handle({ ...ended, type: 'customer.subscription.deleted' }, w.prisma);
    expect(w.row(PKG_B)).toEqual(
      expect.objectContaining({ entitlement_active: false, trial_started_at: null }),
    );
    expect(w.prisma.packageTrialConflict.rows[0].status).toBe('cancelled');
    expect(w.agree()).toBe(1);
  });

  it('a native trial first seen at its end (deleted) still claims the one trial', async () => {
    const w = world();
    await w.buy(PKG_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const ended = w.subEvent(PKG_A, 'canceled', { canceled_at: now() });
    await w.handler.handle({ ...ended, type: 'customer.subscription.deleted' }, w.prisma);
    expect(w.row(PKG_A).trial_started_at).toBeInstanceOf(Date);
    expect(w.agree()).toBe(1);
    const offers = await w.usage.offersForClient(CLIENT, w.prisma._packages);
    expect(offers.get(PKG_B)?.reason).toBe('already_used');
  });
});
