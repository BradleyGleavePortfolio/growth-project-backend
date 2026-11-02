import { CheckoutService } from '../src/checkout/checkout.service';
import { RESTRICTED, T0, buildWorld, stub } from './support/pf7-hold-world';

/**
 * LO-1195 B1 (lens B-TEST). Owner #PF-STRIPE option 1 / R1: a renewal that
 * waits on the coach's Stripe account keeps the client's access and gives the
 * client no card reminders. The phone's Your plans / Membership read the plan
 * status from GET /v1/checkout/purchases (CheckoutService.listForClient) and,
 * for 'past_due', show "The last payment did not go through. To keep this
 * plan, choose Update card. To end it now, choose End my plan."
 * (mobile YourPlansPanel pastDueUpdateCard; MembershipScreen "Payment did not
 * go through"). A held renewal must not reach the client as past_due.
 */
describe('LO-1195 B1: a renewal waiting on the coach account is not a failed payment to the client', () => {
  const prev = { v2: process.env['FEATURE_DUNNING_V2'], hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'] };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    for (const [k, v] of [
      ['FEATURE_DUNNING_V2', prev.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', prev.hold],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('held renewal: the client purchases list does not report the plan as past_due', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    await w.fail();
    // Precondition: the renewal is held (no ten-day cycle), as the PR intends.
    expect(w.state()).toMatchObject({ status: 'active', step_index: -1, last_failure_reason: 'coach_account_not_ready' });
    expect(w.clientPushes()).toBe(0);

    const checkout = new CheckoutService(w.prisma, stub({}), stub({}), stub({}), stub({}), stub({}));
    const { items } = await checkout.listForClient('client-1');
    const plan = items.find((p) => p.id === 'purchase-1');
    expect(plan).toBeDefined();
    // At 1f8878ec this is 'past_due', so the phone tells the client the
    // payment did not go through and to update their card.
    expect(plan!.status).not.toBe('past_due');
  });
});
