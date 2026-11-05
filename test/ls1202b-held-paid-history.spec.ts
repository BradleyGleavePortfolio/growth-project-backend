import { CoachMoneyService } from '../src/coach-money/coach-money.service';

describe('LS-1202B B1: held renewal must not select the installed phone never-paid branch', () => {
  it.each([false, true])('two paid instalments remain visible when held=%s', async (held) => {
    const purchase = {
      id: 'synthetic-plan',
      coach_user_id: 'synthetic-coach',
      client_user_id: 'synthetic-client',
      status: 'past_due',
      amount_cents: 14900,
      currency: 'usd',
      billing_type: 'recurring',
      source: null,
      created_at: new Date('2026-08-01T09:00:00Z'),
      client: { id: 'synthetic-client', name: 'Test client' },
      package: { id: 'synthetic-package', name: 'Monthly coaching' },
      dunning: {
        status: 'active',
        last_failure_reason: held ? 'coach_account_not_ready' : 'card_declined',
      },
      splits: [{ id: 'synthetic-earlier-posted-destination' }],
      refunds: [],
      disputes: [],
    };
    const slices = Array.from({ length: 2 }, () => [
      { kind: 'destination', payee_user_id: 'synthetic-coach', amount_cents: 14000 },
      { kind: 'application_fee', payee_user_id: null, amount_cents: 298 },
      { kind: 'stripe_fee', payee_user_id: null, amount_cents: 602 },
    ]).flat().map((slice) => ({
      ...slice,
      purchase_id: purchase.id,
      reversed_cents: 0,
      status: 'posted',
      currency: 'usd',
    }));
    const prisma = {
      clientPurchase: { findFirst: jest.fn(async () => purchase) },
      user: { findMany: jest.fn(async () => []) },
      splitLedgerEntry: { findMany: jest.fn(async () => slices) },
    };
    const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
    const detail = await service.getChargeBreakdown('synthetic-coach', purchase.id);
    expect(detail.breakdown).toMatchObject({
      settled: true, price_cents: 29800, net_cents: 28000,
    });
    expect(detail.charge).toMatchObject(
      held ? { state: 'pending', waiting_on: 'coach_account' } : { state: 'failed', waiting_on: null },
    );
    // HELD-RENEWAL-BE: the phone contract on mobile main 12f158c1 (m#920),
    // src/screens/coach/money/MoneyChargeScreen.tsx:132-139 with
    // coachMoneyApi.ts chargeHeld: held = waiting_on && (pending | failed);
    // paidBefore = plan && settled; the never-paid copy (and its hidden
    // plan-paid totals) only when (pending || held) && !paidBefore.
    const c = detail.charge;
    const chargeHeld = c.waiting_on === 'coach_account' && (c.state === 'pending' || c.state === 'failed');
    const paidBefore = c.billing_type === 'recurring' && detail.breakdown.settled;
    const neverPaid = (c.state === 'pending' || chargeHeld) && !paidBefore;
    expect({
      showsNeverPaidCopy: neverPaid,
      hidesPlanPaidTotals: neverPaid,
      shownUnpaidPriceCents: neverPaid ? detail.breakdown.price_cents : null,
    }).toEqual({
      showsNeverPaidCopy: false,
      hidesPlanPaidTotals: false,
      shownUnpaidPriceCents: null,
    });
  });
});
