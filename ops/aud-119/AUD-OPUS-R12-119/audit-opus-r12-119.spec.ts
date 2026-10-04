// AUD-OPUS-R12-119 (Claude Opus 5.5 lens) probes at #679 8bbf4a41 (includes R1 #678 77bce450).
// Audit branch only; never merged. "(should fail at head)" = the defect; "evidence"/"control" pass.
import { HttpException } from '@nestjs/common';
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(trialDays = 0) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  prisma._users.push(
    { id: CLIENT, email: 'client@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'coach@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
    ...{ id: PKG, coach_id: COACH, name: 'Plan', amount_cents: 4900, currency: 'usd' },
    ...{ billing_type: 'recurring', interval: 'month', interval_count: 1 },
    ...{ stripe_price_id: 'price_plan', recurring_amount_cents: null, recurring_interval: null },
    ...{ recurring_interval_count: null, recurring_stripe_price_id: null, is_active: true },
    ...{ published_at: new Date('2026-09-01'), archived_at: null, trial_days: trialDays },
  });
  prisma._accounts.push({
    ...{ coach_user_id: COACH, stripe_account_id: 'acct_coach' },
    ...{ charges_enabled: true, deauthorized_at: null },
  });
  const packages: any = {
    getById: async (id: string) => prisma._packages.find((p: any) => p.id === id),
  };
  const fees: any = { planFor: async () => ({ head_coach_id: null }) };
  const helpers: any = makeCheckoutHelpers(prisma);
  const svc = new SubscriptionCheckoutService(prisma, stripe, packages, { ready: true } as any, fees, helpers);
  return { prisma, stripe, svc };
}
async function resultOf(p: Promise<unknown>): Promise<any> {
  try {
    return { value: await p };
  } catch (err) {
    if (err instanceof HttpException) return { body: err.getResponse(), status: err.getStatus() };
    throw err;
  }
}
const timeout = () =>
  new StripeConnectApiError('synthetic', 503, 'request_timeout', 'api_connection_error');

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_synthetic';
});

describe('C-679-4 attemptSettled: a subscription default with the trial end still set and no SetupIntent', () => {
  // Stripe set the trial up off-session and the subscription carries a default (Sol B-679-10 shape 2);
  // the own SetupIntent was created but the ephemeral key failed, so no sheet secret was ever stored.
  async function prepared() {
    const f = setup(7);
    const create = f.stripe.createSubscription.getMockImplementation();
    f.stripe.createSubscription.mockImplementation(async (a: any) => {
      const sub = await create(a);
      sub.pending_setup_intent = null;
      sub.default_payment_method = 'pm_customer_default';
      return sub;
    });
    f.stripe.createEphemeralKey.mockRejectedValueOnce(timeout());
    const first = await resultOf(
      f.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    const row = f.prisma._purchases[0];
    // The coach changes the price; the same key replays (terms changed -> retireAttempt).
    f.prisma._packages[0].amount_cents = 5900;
    const replay = await resultOf(
      f.svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }),
    );
    const sub = f.stripe._subs.get(row.stripe_subscription_id);
    return { f, first, row, replay, sub };
  }

  it('evidence: no secret was stored and the trial end is still set (no own card)', async () => {
    const { first, row, sub } = await prepared();
    expect(first.body?.code).toBe('STRIPE_CHECKOUT_ERROR');
    expect(row.stripe_client_secret ?? null).toBeNull();
    expect([sub.status, sub.cancel_at_period_end]).toEqual(['trialing', true]);
  });

  it('(should fail at head) the replay never answers SUBSCRIPTION_ALREADY_ACTIVE for a trial that ends with no card', async () => {
    const { replay, sub } = await prepared();
    expect(sub.cancel_at_period_end).toBe(true);
    expect(replay.body?.code).not.toBe('SUBSCRIPTION_ALREADY_ACTIVE');
  });
});

describe('deletion collector edge cases (R1 #678 account-deletion.billing.ts)', () => {
  const old = new Date(Date.now() - 10 * 60_000);
  const row = (o: Record<string, unknown> = {}) => ({
    id: 'pur_1',
    client_user_id: CLIENT,
    coach_user_id: COACH,
    stripe_customer_id: 'cus_1',
    created_at: old,
    updated_at: old,
    ...o,
  });
  // A tiny where-matcher: client_user_id / coach_user_id equality, OR branches.
  const tx = (rows: any[]) => ({
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => {
          const eq = (w: any) =>
            (w.client_user_id === undefined || w.client_user_id === r.client_user_id) &&
            (w.coach_user_id === undefined || w.coach_user_id === r.coach_user_id);
          return where.OR ? where.OR.some(eq) && eq({ ...where, OR: undefined }) : eq(where);
        }),
      ),
    },
  });
  const billing = (stripe: unknown): AccountDeletionBillingService =>
    new (AccountDeletionBillingService as any)({}, stripe);

  it('(should fail at head) a Stripe "No such customer" (404 resource_missing) is proven absence, not a deletion that fails every night', async () => {
    const stripe = {
      listSubscriptionsForCustomer: jest.fn(async () => {
        throw new StripeConnectApiError('No such customer', 404, 'resource_missing', 'invalid_request_error');
      }),
    };
    await expect(
      (billing(stripe) as any).collectUnboundAttemptSubscriptionIds(tx([row()]), CLIENT),
    ).resolves.toEqual([]);
  });

  it('(should fail at head) a coach account deletion also finds an unbound attempt sold under that coach', async () => {
    const stripe = {
      listSubscriptionsForCustomer: jest.fn(async () => ({
        data: [{ id: 'sub_own', status: 'incomplete', metadata: { tgp_purchase_id: 'pur_1' } }],
        has_more: false,
      })),
    };
    expect(
      await (billing(stripe) as any).collectUnboundAttemptSubscriptionIds(tx([row()]), COACH),
    ).toEqual(['sub_own']);
  });

  it('control: the client deletion finds it', async () => {
    const stripe = {
      listSubscriptionsForCustomer: jest.fn(async () => ({
        data: [{ id: 'sub_own', status: 'incomplete', metadata: { tgp_purchase_id: 'pur_1' } }],
        has_more: false,
      })),
    };
    expect(
      await (billing(stripe) as any).collectUnboundAttemptSubscriptionIds(tx([row()]), CLIENT),
    ).toEqual(['sub_own']);
  });
});
