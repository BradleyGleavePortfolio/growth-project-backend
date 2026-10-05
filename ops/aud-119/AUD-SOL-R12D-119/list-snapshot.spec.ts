// Exact-head R2 delta acceptance and optional list-snapshot follow-up.
import { SubscriptionCheckoutService } from '../src/checkout/subscription-checkout.service';
import { makeFakePrisma, makeFakeStripe } from './support/b-recur-fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';

function setup() {
  const db = makeFakePrisma();
  const service = new SubscriptionCheckoutService(
    db, makeFakeStripe(), {} as any, { ready: true } as any, {} as any, {} as any,
  );
  const push = (n: number, over: Record<string, unknown> = {}) => {
    for (let i = 0; i < n; i += 1) {
      db._purchases.push({
        id: `pur_${db._purchases.length}`, client_user_id: CLIENT, coach_user_id: COACH,
        package_id: `package_${db._purchases.length}`, billing_type: 'recurring',
        stripe_subscription_id: `sub_${db._purchases.length}`, status: 'active',
        entitlement_active: true, trial_started_at: null, trial_days: null,
        cancel_at_period_end: false, current_period_end: new Date(2000),
        created_at: new Date(db._purchases.length), amount_cents: 4900,
        currency: 'usd', checkout_terms: null, ...over,
      });
    }
  };
  return { db, service, push };
}

it('acceptance: more than fifty legitimate live plans remain visible and unique', async () => {
  const f = setup();
  f.push(75);
  const plans = await f.service.listPlans(CLIENT);
  expect(plans).toHaveLength(75);
  expect(new Set(plans.map((p) => p.purchase_id)).size).toBe(75);
});

it('control: canceled trial history remains in the trial-bearing set (not the nontrial history cap)', async () => {
  const f = setup();
  f.push(61, {
    status: 'canceled', entitlement_active: false, trial_started_at: new Date(1),
  });
  expect(await f.service.listPlans(CLIENT)).toHaveLength(61);
});

it('C follow-up evidence: cancellation between the two reads duplicates one plan, without changing billing', async () => {
  const f = setup();
  f.push(1);
  const read = f.db.clientPurchase.findMany.getMockImplementation();
  let calls = 0;
  f.db.clientPurchase.findMany.mockImplementation(async (args: any) => {
    calls += 1;
    if (calls === 2) Object.assign(f.db._purchases[0], {
      status: 'canceled', entitlement_active: false,
    });
    return read(args);
  });
  const plans = await f.service.listPlans(CLIENT);
  console.log('SOL_LIST_CANCEL_SNAPSHOT', {
    ids: plans.map((p) => p.purchase_id), states: plans.map((p) => p.status),
  });
  expect(plans.map((p) => p.purchase_id)).toEqual(['pur_0', 'pur_0']);
  expect(plans.map((p) => p.status).sort()).toEqual(['active', 'canceled']);
  expect(f.db._purchases[0].status).toBe('canceled');
});
