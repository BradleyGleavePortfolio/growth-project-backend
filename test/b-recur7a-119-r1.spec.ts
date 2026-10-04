// B-RECUR7A-119 fix round 7, R1 (#678). Stateful doubles, no network.
// "(failed before)" cases failed at #678 77bce450 in the CI lane before the fix.
//   Sol B-678-3  deleting the coach finds an old uncertain native create too.
//   Sol B-678-4  send authority holds the coach as well as the client.
import { AccountDeletionBillingService } from '../src/account-deletion/account-deletion.billing';
import { sendFenced } from '../src/checkout/subscription-attempt';
import { makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const old = new Date(Date.now() - 10 * 60_000);

function setup(over: Record<string, unknown> = {}) {
  const db = makeFakePrisma();
  const stripe = makeFakeStripe();
  db._users.push({ id: CLIENT, deleted_at: null }, { id: COACH, deleted_at: null });
  const row: Record<string, any> = {
    id: 'pur_r7',
    client_user_id: CLIENT,
    coach_user_id: COACH,
    billing_type: 'recurring',
    status: 'pending',
    entitlement_active: false,
    trial_started_at: null,
    stripe_subscription_id: null,
    stripe_client_secret: null,
    stripe_customer_id: 'cus_client',
    stripe_destination_account: 'acct_coach',
    idempotency_key: `sub-${CLIENT}-key`,
    stripe_checkout_session_id: `sub-retry-sub-${CLIENT}-key`,
    created_at: old,
    updated_at: old,
    ...over,
  };
  db._purchases.push(row);
  const billing = new AccountDeletionBillingService({} as any, stripe);
  const create = jest.fn(async () =>
    stripe.createSubscription({
      customer: 'cus_client',
      recurringPriceId: 'price_4900',
      metadata: { tgp_purchase_id: row.id },
      idempotencyKey: 'original',
    }),
  );
  return { db, stripe, billing, row, create };
}

const lockedIds = (db: any): string[] =>
  db.$queryRaw.mock.calls.map((args: any[]) => args.slice(1)).flat();

describe('Sol B-678-3 deletion collects unbound attempts of both parties', () => {
  it('control: deleting the client finds the old uncertain create', async () => {
    const f = setup();
    await f.create();
    expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, CLIENT)).toEqual(['sub_1']);
  });

  it('(failed before) deleting the coach finds the same old uncertain create', async () => {
    const f = setup();
    await f.create();
    expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, COACH)).toEqual(['sub_1']);
  });

  it('(failed before) deleting the coach fails closed on a recent attempt and an incomplete list', async () => {
    const recent = setup({ updated_at: new Date() });
    await expect(
      recent.billing.collectUnboundAttemptSubscriptionIds(recent.db, COACH),
    ).rejects.toThrow(/still finishing/);
    const partial = setup();
    partial.stripe.listSubscriptionsForCustomer.mockResolvedValueOnce({
      data: [],
      has_more: true,
    } as any);
    await expect(
      partial.billing.collectUnboundAttemptSubscriptionIds(partial.db, COACH),
    ).rejects.toThrow(/incomplete/);
  });

  it('a key not carrying the row client id is not a native attempt; other users see nothing', async () => {
    const f = setup({ idempotency_key: `sub-${OTHER}-key` });
    await f.create();
    expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, COACH)).toEqual([]);
    expect(await f.billing.collectUnboundAttemptSubscriptionIds(f.db, CLIENT)).toEqual([]);
    const g = setup();
    await g.create();
    expect(await g.billing.collectUnboundAttemptSubscriptionIds(g.db, OTHER)).toEqual([]);
  });
});

describe('Sol B-678-4 send authority fences both parties', () => {
  it('(failed before) the send holds client and coach FOR KEY SHARE, in id order, before the create', async () => {
    const f = setup();
    let atCreate: string[] = [];
    f.create.mockImplementationOnce(async () => {
      atCreate = lockedIds(f.db);
      return f.stripe.createSubscription({
        customer: 'cus_client',
        recurringPriceId: 'price_4900',
        metadata: { tgp_purchase_id: f.row.id },
        idempotencyKey: 'original',
      });
    });
    const out = await sendFenced(f.db, { ...f.row } as any, null, f.create);
    expect(atCreate).toEqual([CLIENT, COACH].sort());
    const sql = f.db.$queryRaw.mock.calls.map((a: any[]) => a[0].join('?'));
    expect(sql.every((q: string) => /FOR KEY SHARE/.test(q))).toBe(true);
    expect(out).toEqual({
      sub: expect.objectContaining({ id: 'sub_1' }),
      bound: expect.anything(),
    });
    expect(f.row.stripe_subscription_id).toBe('sub_1');
  });

  it('(failed before) a coach finalized before the send gets nothing sent', async () => {
    const f = setup();
    f.db._users[1].deleted_at = new Date();
    const out = await sendFenced(f.db, { ...f.row } as any, null, f.create);
    expect(out).toBe('closed');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.row.stripe_checkout_session_id).toBe(`sub-retry-sub-${CLIENT}-key`);
  });

  it('(failed before) a row whose coach changed (erasure sentinel) is never claimed', async () => {
    const f = setup();
    const stale = { ...f.row };
    f.row.coach_user_id = OTHER;
    const out = await sendFenced(f.db, stale as any, null, f.create);
    expect(out).toBe('closed');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('control: a deleted client still answers gone; a closed attempt still answers closed', async () => {
    const gone = setup();
    gone.db._users[0].deleted_at = new Date();
    expect(await sendFenced(gone.db, { ...gone.row } as any, null, gone.create)).toBe('gone');
    const closed = setup({ status: 'canceled' });
    expect(await sendFenced(closed.db, { ...closed.row } as any, null, closed.create)).toBe(
      'closed',
    );
    expect(gone.create).not.toHaveBeenCalled();
    expect(closed.create).not.toHaveBeenCalled();
  });
});
