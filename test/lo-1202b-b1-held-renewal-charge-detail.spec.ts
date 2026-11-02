import 'reflect-metadata';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// LO-1202B B1: a renewal held on the coach's own Stripe account (PF-7) on a
// plan that has been paid before. Money's charge detail (GET
// v1/coach/money/charges/:id) must not send state `pending` together with
// settled earlier payments: the phone (mobile main MoneyChargeScreen) reads
// `pending` as "No payment has gone through for this yet, so nothing has
// reached your payouts" and shows the plan's paid total as "Price, not paid
// yet", hiding "This plan so far". Before HOLD-FU-BE the row was `failed`
// and the phone kept the earlier payments ("Latest payment failed").

const COACH = 'hold-coach';
const HELD = { status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON };

function heldRenewalPaidBefore() {
  return {
    id: 'held-renewal', status: 'past_due', coach_user_id: COACH, client_user_id: 'client-1',
    source: null, amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
    created_at: new Date('2026-08-30T09:00:00Z'),
    updated_at: new Date('2026-10-30T09:00:00Z'),
    client: { id: 'client-1', name: 'Test client' },
    package: { id: 'pkg', name: 'Monthly coaching' },
    splits: [{ id: 'slice-1' }],
    refunds: [], disputes: [],
    dunning: HELD,
  };
}

// Two earlier monthly payments that reached the coach.
const SLICES = [1, 2].map((n) => ({
  kind: 'destination', payee_user_id: COACH, amount_cents: 14900, reversed_cents: 0,
  status: 'posted', purchase_id: 'held-renewal', currency: 'usd', id: `slice-${n}`,
}));

function money() {
  const prisma = {
    clientPurchase: { findFirst: jest.fn(async () => heldRenewalPaidBefore()) },
    splitLedgerEntry: { findMany: jest.fn(async () => SLICES) },
    user: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    notification: { findMany: jest.fn(async () => []) },
  };
  const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
  return service;
}

describe('LO-1202B B1: held renewal on a plan paid before, charge detail', () => {
  it('a held renewal with earlier payments is never sent as pending beside its settled payments', async () => {
    const d = await money().getChargeBreakdown(COACH, 'held-renewal');
    expect(d.breakdown.settled).toBe(true);
    expect(d.breakdown.price_cents).toBeGreaterThan(0);
    expect(d.charge.state).not.toBe('paid');
    // The phone shows "No payment has gone through for this yet" and
    // "Price, not paid yet: $298.00" for this pair.
    expect({ state: d.charge.state, settled: d.breakdown.settled }).not.toEqual({
      state: 'pending',
      settled: true,
    });
  });
});
