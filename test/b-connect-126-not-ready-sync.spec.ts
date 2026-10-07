// B-CONNECT-126 (AUD-MONEY-E2E-126 B1): Stripe approves a coach after the
// onboarding return and account.updated never reaches the platform webhook.
// A not-ready saved row is re-read from Stripe (b#750 syncFromStripe, cooldown)
// by the recurring Buy gate and GET /coach/connect/status; a ready row makes
// no Stripe call; a Stripe failure gives today's answer.
import { Logger } from '@nestjs/common';
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';
import {
  CONNECT_NOT_READY_SYNC_COOLDOWN_MS,
  ConnectService,
} from '../src/connect/connect.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { makeCheckoutHelpers, makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

type Row = Record<string, unknown>;

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const PKG = '33333333-3333-4333-8333-333333333333';
const KEY1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const STRIPE_APPROVED = {
  id: 'acct_coach',
  country: 'US',
  default_currency: 'usd',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null },
};
const STRIPE_STILL_CHECKING = { ...STRIPE_APPROVED, charges_enabled: false, payouts_enabled: false };
const TIMEOUT = new StripeConnectApiError('timed out', 503, 'request_timeout', 'api_connection_error');

function pendingAccount(): Row {
  return {
    coach_user_id: COACH,
    stripe_account_id: 'acct_coach',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
    requirements_due: { currently_due: [], past_due: [], eventually_due: [] },
    disabled_reason: 'requirements.pending_verification',
    deauthorized_at: null,
    updated_at: new Date('2026-10-06T10:00:00Z'),
  };
}

/** A real ConnectService over the same account rows the gate reads. */
function realConnect(accounts: Row[], retrieveAccount: jest.Mock): ConnectService {
  const find = (where: Row) =>
    accounts.find((a) =>
      where.stripe_account_id
        ? a.stripe_account_id === where.stripe_account_id
        : a.coach_user_id === where.coach_user_id,
    ) ?? null;
  const prisma = {
    connectAccount: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => find(where)),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(find(where) ?? {}, data, { updated_at: new Date() }),
      ),
    },
  };
  return Reflect.construct(ConnectService, [prisma, { retrieveAccount }]);
}

function recurringSetup(account: Row, retrieveAccount: jest.Mock) {
  const prisma = makeFakePrisma();
  const stripe = makeFakeStripe();
  prisma._users.push(
    { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
    { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
  );
  prisma._packages.push({
    ...{ id: PKG, coach_id: COACH, name: 'Coaching', description: null, currency: 'usd' },
    ...{ amount_cents: 4900, billing_type: 'recurring', interval: 'month', interval_count: 1 },
    ...{ recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null },
    ...{ recurring_stripe_price_id: null, stripe_price_id: 'price_rec_4900', is_active: true },
    ...{ archived_at: null, published_at: new Date('2026-09-01') },
  });
  prisma._accounts.push(account);
  const packages = {
    getById: jest.fn(async (id: string) => prisma._packages.find((p: Row) => p.id === id) ?? null),
  };
  const fee = { application_fee_cents: 98, head_coach_split_cents: 0, head_coach_id: null };
  const feePolicy = { planFor: jest.fn(async () => fee) };
  const connect = realConnect(prisma._accounts, retrieveAccount);
  const helpers = makeCheckoutHelpers(prisma);
  const args = [prisma, stripe, packages, { ready: true }, feePolicy, helpers, undefined, connect];
  const svc: SubscriptionCheckoutService = Reflect.construct(SubscriptionCheckoutService, args);
  return { svc, stripe, prisma };
}

function coachStatusSetup(account: Row, retrieveAccount: jest.Mock) {
  const accounts = [account];
  const connect = realConnect(accounts, retrieveAccount);
  const prisma = {
    connectAccount: {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        accounts.find((a) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
  };
  const stripe = { isConfigured: () => true };
  const args = [prisma, connect, stripe, { ready: true, reason: null }, {}, {}];
  const svc: CoachConnectService = Reflect.construct(CoachConnectService, args);
  return { svc, accounts };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    const body = (err as { getResponse?: () => { code?: string } }).getResponse?.();
    return body?.code;
  }
  return 'NO_ERROR';
}

const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

beforeAll(() => {
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
});
afterAll(() => warn.mockRestore());

describe('B-CONNECT-126 recurring Buy gate', () => {
  it('saved row not ready + Stripe approved -> the subscription starts and the row reads ready', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc, stripe, prisma } = recurringSetup(pendingAccount(), retrieve);
    const out = await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(out).toEqual(expect.objectContaining({ client_secret: expect.any(String) }));
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(prisma._accounts[0]).toMatchObject({ charges_enabled: true, payouts_enabled: true });
  });

  it('saved row ready -> zero Stripe account reads', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc, stripe } = recurringSetup(
      { ...pendingAccount(), charges_enabled: true, payouts_enabled: true },
      retrieve,
    );
    await svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 });
    expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['Stripe timeout', TIMEOUT],
    ['network error', new TypeError('fetch failed')],
  ])('%s -> today\'s 409 COACH_NOT_PAYOUT_READY, nothing charged', async (_n, err) => {
    const retrieve = jest.fn(async () => Promise.reject(err));
    const { svc, stripe } = recurringSetup(pendingAccount(), retrieve);
    expect(
      await codeOf(svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 })),
    ).toBe('COACH_NOT_PAYOUT_READY');
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });
});

describe('B-CONNECT-126 GET /coach/connect/status', () => {
  it('saved row pending + Stripe approved -> the coach reads active', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc } = coachStatusSetup(pendingAccount(), retrieve);
    expect(await svc.getStatus(COACH)).toMatchObject({ state: 'active', configured: true });
    // Now ready: the next read makes no Stripe call.
    await svc.getStatus(COACH);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('saved row ready -> zero Stripe account reads', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc } = coachStatusSetup(
      { ...pendingAccount(), charges_enabled: true, payouts_enabled: true, disabled_reason: null },
      retrieve,
    );
    expect((await svc.getStatus(COACH)).state).toBe('active');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('Stripe timeout -> the saved status, no exception', async () => {
    const retrieve = jest.fn(async () => Promise.reject(TIMEOUT));
    const { svc } = coachStatusSetup(pendingAccount(), retrieve);
    expect((await svc.getStatus(COACH)).state).toBe('pending_verification');
  });

  it('"Check status again" still makes exactly one Stripe read', async () => {
    const retrieve = jest.fn(async () => STRIPE_STILL_CHECKING);
    const { svc } = coachStatusSetup(pendingAccount(), retrieve);
    const out = await svc.refreshStatus(COACH);
    expect(out.state).toBe('pending_verification');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});

describe('B-CONNECT-126 cooldown', () => {
  it(`one Stripe read per account per ${CONNECT_NOT_READY_SYNC_COOLDOWN_MS} ms while still not ready`, async () => {
    let now = Date.parse('2026-10-06T10:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const retrieve = jest.fn(async () => STRIPE_STILL_CHECKING);
      const { svc } = recurringSetup(pendingAccount(), retrieve);
      const buy = () =>
        codeOf(svc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: KEY1 }));
      expect(await buy()).toBe('COACH_NOT_PAYOUT_READY');
      expect(await buy()).toBe('COACH_NOT_PAYOUT_READY');
      expect(retrieve).toHaveBeenCalledTimes(1);
      now += CONNECT_NOT_READY_SYNC_COOLDOWN_MS;
      expect(await buy()).toBe('COACH_NOT_PAYOUT_READY');
      expect(retrieve).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('a failed re-read logs a closed code only', async () => {
    warn.mockClear();
    const retrieve = jest.fn(async () => Promise.reject(new TypeError('PRIVATE_CANARY')));
    const { svc } = coachStatusSetup(pendingAccount(), retrieve);
    await svc.getStatus(COACH);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('code=CONNECT_NOT_READY_SYNC_FAILED class=other');
    expect(logged).not.toContain('PRIVATE_CANARY');
  });
});
