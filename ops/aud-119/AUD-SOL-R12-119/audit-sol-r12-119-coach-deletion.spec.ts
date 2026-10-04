// Independent R1 evidence: synthetic provider/database scheduling only.
// No real account, payment or external database is used.
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { sendFenced } from '../src/checkout/subscription-attempt';
import { makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const old = new Date(Date.now() - 10 * 60_000);

function setup() {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  db._users.push({ id: CLIENT, deleted_at: null }, { id: COACH, deleted_at: null });
  const row = {
    id: 'pur_coach_delete', client_user_id: CLIENT, coach_user_id: COACH,
    billing_type: 'recurring', status: 'pending', entitlement_active: false,
    trial_started_at: null, stripe_subscription_id: null, stripe_client_secret: null,
    stripe_customer_id: 'cus_client', stripe_destination_account: 'acct_coach',
    idempotency_key: `sub-${CLIENT}-key`,
    stripe_checkout_session_id: `sub-retry-sub-${CLIENT}-key`,
    created_at: old, updated_at: old,
  };
  db._purchases.push(row);
  const billing = new AccountDeletionBillingService({} as any, stripe);
  return { db, stripe, billing, row };
}

it('control: deleting the client discovers the old uncertain native create', async () => {
  const f = setup();
  await f.stripe.createSubscription({
    customer: 'cus_client', recurringPriceId: 'price_4900',
    metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'original',
  });
  expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, CLIENT)).toEqual(['sub_1']);
});

it('B-678-3: deleting the coach also discovers an old uncertain native create', async () => {
  const f = setup();
  await f.stripe.createSubscription({
    customer: 'cus_client', recurringPriceId: 'price_4900',
    metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'original',
  });
  expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, COACH)).toEqual(['sub_1']);
});

it('B-678-4: a coach finalized before send authority is acquired cannot receive a new subscription', async () => {
  const f = setup();
  f.db._users[1].deleted_at = new Date();
  // This request reserved its purchase before the coach was finalized.
  // The erasure manifest clears its coach identity and terminalizes it.
  Object.assign(f.row, { coach_user_id: '__deleted_user_sentinel__', status: 'canceled' });
  // Existing open-row check protects this case.
  const create = jest.fn(async () => f.stripe.createSubscription({
    customer: 'cus_client', recurringPriceId: 'price_4900',
    metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'original',
  }));
  const out = await sendFenced(f.db, { ...f.row, coach_user_id: COACH } as any, null, create);
  expect(create).not.toHaveBeenCalled();
  expect(out).toBe('closed');
});

it('B-678-4: send authority also holds the coach identity through create and bind', async () => {
  const f = setup();
  const create = jest.fn(async () => f.stripe.createSubscription({
    customer: 'cus_client', recurringPriceId: 'price_4900',
    metadata: { tgp_purchase_id: f.row.id }, idempotencyKey: 'original',
  }));
  await sendFenced(f.db, f.row as any, null, create);
  const locked = f.db.$queryRaw.mock.calls.flatMap((args: any[]) => args.slice(1));
  expect(locked).toContain(CLIENT);
  expect(locked).toContain(COACH);
});
