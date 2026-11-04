import 'reflect-metadata';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// LO-1202B B1: a renewal held on the coach's own Stripe account (PF-7) on a
// plan that has been paid before. Money's charge detail (GET
// v1/coach/money/charges/:id) must never make the phone hide the plan's
// earlier payments. HELD-RENEWAL-BE: the phone now reads `waiting_on`
// (m#920, mobile main 12f158c1 MoneyChargeScreen.tsx:132-139): a held charge
// (`waiting_on: 'coach_account'`) beside `settled` payments keeps "This plan
// so far" and never shows "No payment has gone through for this yet". So the
// server sends it as held: `pending`, `waiting_on` set, `settled` kept.

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
  it('a held renewal with earlier payments is sent as held, with its settled payments kept', async () => {
    const d = await money().getChargeBreakdown(COACH, 'held-renewal');
    expect(d.breakdown.settled).toBe(true);
    expect(d.breakdown.price_cents).toBeGreaterThan(0);
    expect(d.charge.state).not.toBe('paid');
    expect(d.charge).toMatchObject({ state: 'pending', waiting_on: 'coach_account' });
    // m#920's phone: a pending charge beside settled payments is shown as
    // held only when waiting_on says so; never the never-paid card.
    expect({ state: d.charge.state, settled: d.breakdown.settled, waiting_on: d.charge.waiting_on })
      .not.toEqual({ state: 'pending', settled: true, waiting_on: null });
  });
  });
});
