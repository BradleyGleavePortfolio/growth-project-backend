// C5-S1 (agent 157) — GET /v1/checkout/purchases says what each purchase's
// checkout charged first (first_charge_cents), so the app's "Paid" line is
// the server's number, never the package's price or a subscription's renewal.
//
// The Prisma double returns only the selected fields, like Prisma. Rows plant
// Stripe price and subscription ids: the response must carry none of them.

import 'reflect-metadata';
import { CheckoutController } from '../src/checkout/checkout.controller';
import { CheckoutService } from '../src/checkout/checkout.service';
import { CLIENT_PURCHASE_LIST_SELECT } from '../src/checkout/client-purchases.select';

type Row = Record<string, unknown>;

const terms = (over: Row = {}): Row => ({
  v: 1,
  recurring_price_id: 'price_PLANTED_recurring',
  one_time_price_id: 'price_PLANTED_once',
  amount_cents: 14900,
  one_time_cents: 30000,
  currency: 'usd',
  interval: 'month',
  interval_count: 1,
  trial_days: 0,
  ...over,
});

function purchase(id: string, over: Row): Row {
  return {
    id,
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: `pkg-${id}`,
    amount_cents: 14900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: `sub_PLANTED_${id}`,
    checkout_terms: null,
    status: 'active',
    entitlement_active: true,
    access_expires_at: null,
    current_period_end: new Date('2026-11-14T00:00:00Z'),
    cancel_at_period_end: false,
    canceled_at: null,
    last_error: null,
    source: null,
    trial_days: null,
    trial_ends_at: null,
    card_on_file: true,
    created_at: new Date('2026-10-14T00:00:00Z'),
    updated_at: new Date('2026-10-14T00:00:00Z'),
    stripe_client_secret: 'pi_PLANTED_secret_x',
    ...over,
  };
}

const STORED: Row[] = [
  // One-time part $300 + first month $149 on the first invoice.
  purchase('p-combo', { checkout_terms: terms() }),
  // Free 7-day trial: nothing charged today.
  purchase('p-trial', {
    checkout_terms: terms({ one_time_price_id: null, one_time_cents: 0, trial_days: 7 }),
    trial_days: 7,
    trial_ends_at: new Date('2026-10-21T00:00:00Z'),
  }),
  // One-time PaymentIntent sale: its stored price is what was charged.
  purchase('p-once', {
    amount_cents: 19900,
    billing_type: 'one_time',
    stripe_subscription_id: null,
    current_period_end: null,
  }),
  // A subscription with no pinned terms (or terms in an unknown shape): unknown.
  purchase('p-old-sub', {}),
  purchase('p-bad-terms', { checkout_terms: { v: 2, amount_cents: 1 } }),
  // Another client of the same coach.
  purchase('p-other', {
    client_user_id: 'client-2',
    checkout_terms: terms({ amount_cents: 5000, one_time_cents: 0 }),
  }),
];

function buildPrisma() {
  return {
    clientPurchase: {
      findMany: jest.fn(async (args: { where: Row; take?: number; select?: Row }) =>
        STORED.filter((p) => Object.entries(args.where).every(([k, v]) => p[k] === v))
          .slice(0, args.take)
          .map((p) => {
            const out: Row = {};
            for (const [k, on] of Object.entries(args.select ?? p)) if (on) out[k] = p[k];
            return out;
          }),
      ),
    },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: 'pm_1' })) },
    packageTrialConflict: { findMany: jest.fn(async () => []) },
  };
}

async function list(prisma: ReturnType<typeof buildPrisma>, clientId: string) {
  const svc = Reflect.construct(CheckoutService, [prisma, {}, {}, { ready: true }, {}, {}]);
  const ctrl = new CheckoutController(svc);
  const out: { purchases: Row[] } = await Reflect.apply(ctrl.listPurchases, ctrl, [
    { user: { id: clientId, role: 'student' } },
    undefined,
    undefined,
  ]);
  return out.purchases;
}

describe('C5-S1 — purchases[].first_charge_cents', () => {
  it('is the pinned first charge, the one-time price, or null; never the renewal', async () => {
    const rows = await list(buildPrisma(), 'client-1');
    expect(rows.map((r) => [r.id, r.first_charge_cents])).toEqual([
      ['p-combo', 44900],
      ['p-trial', 0],
      ['p-once', 19900],
      ['p-old-sub', null],
      ['p-bad-terms', null],
    ]);
    // The renewal price and the trial view are unchanged.
    expect(rows[0].amount_cents).toBe(14900);
    expect(rows[1]).toMatchObject({ trial: { trial_days: 7, charge_amount_cents: 14900 } });
  });

  it('sends no checkout terms, Stripe price id, subscription id or secret', async () => {
    const rows = await list(buildPrisma(), 'client-1');
    const json = JSON.stringify(rows);
    expect(json).not.toContain('PLANTED');
    for (const r of rows) {
      expect(r).not.toHaveProperty('checkout_terms');
      expect(r).not.toHaveProperty('stripe_subscription_id');
    }
  });

  it("lists only the signed-in client's purchases (positive control: client-2 sees theirs)", async () => {
    const prisma = buildPrisma();
    const mine = await list(prisma, 'client-1');
    expect(mine.map((r) => r.id)).not.toContain('p-other');
    expect(prisma.clientPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { client_user_id: 'client-1' },
        select: CLIENT_PURCHASE_LIST_SELECT,
      }),
    );
    const theirs = await list(prisma, 'client-2');
    expect(theirs.map((r) => [r.id, r.first_charge_cents])).toEqual([['p-other', 5000]]);
  });
});
