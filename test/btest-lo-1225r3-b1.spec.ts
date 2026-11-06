// Independent LO-1225R3 proof: a web trial keeps its SetupIntent id in
// ClientPurchase.stripe_payment_intent_id (guest-checkout.service.ts:136-140,
// :2012 copies checkout.stripe_payment_intent_id; isGuestTrialIntent at :141).
// A SetupIntent is not a charge. With nothing charged (no settlement of any
// status, no ledger entry, no transfer) the purchase never moved money, but
// the never-charged branch (reconciliation.service.ts:261-283) only accepts
// a null payment-intent pointer, so the sweep reads the SetupIntent as a
// payment intent, Stripe has no such payment intent, resolveChargeId returns
// null and the purchase is "could not be confirmed yet" on every daily run.
// 708ee69d added 'trialing' and 'paused' to RECONCILED_PURCHASE_STATUSES, so
// every running web trial now turns the owner's daily alert to "needs review".
import { Logger } from '@nestjs/common';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

const SETUP_INTENT = 'seti_example';

function world(status: string, opts: { settlement?: string; ledger?: boolean } = {}) {
  const purchase = {
    id: 'web-trial-example',
    status,
    source: null,
    billing_type: 'recurring',
    amount_cents: 10_000,
    stripe_payment_intent_id: SETUP_INTENT,
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
  const settlement = opts.settlement
    ? {
        id: 'settlement-example',
        purchase_id: purchase.id,
        mechanism: 'separate_charge_transfer',
        stripe_charge_id: 'charge-example',
        stripe_invoice_id: 'invoice-example',
        status: opts.settlement,
        gross_cents: 10_000,
      }
    : null;
  const ledger = opts.ledger
    ? [
        { kind: 'destination', amount_cents: 9_800, reversed_cents: 0, status: 'posted', stripe_charge_id: 'charge-example' },
        { kind: 'application_fee', amount_cents: 200, reversed_cents: 0, status: 'posted', stripe_charge_id: 'charge-example' },
      ]
    : [];
  const matches = (where: any) => {
    if (!settlement || where.purchase_id !== purchase.id) return false;
    if (where.mechanism && where.mechanism !== settlement.mechanism) return false;
    if (!where.status) return true;
    return typeof where.status === 'string'
      ? where.status === settlement.status
      : !!where.status.in?.includes(settlement.status);
  };
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) =>
        where.status.in.includes(purchase.status) ? [purchase] : []),
      findUnique: jest.fn(async () => purchase),
    },
    splitLedgerEntry: { findMany: jest.fn(async () => ledger) },
    connectTransfer: { findMany: jest.fn(async () => []) },
    chargeSettlement: {
      findMany: jest.fn(async ({ where }: any) => (matches(where) ? [settlement] : [])),
      findFirst: jest.fn(async ({ where }: any) => (matches(where) ? settlement : null)),
      count: jest.fn(async ({ where }: any) => (matches(where) ? 1 : 0)),
    },
    reconciliationSnapshot: { upsert: jest.fn(async ({ create }: any) => create) },
  };
  const stripe = {
    // Stripe answers a SetupIntent id on /v1/payment_intents with
    // resource_missing ("No such payment_intent").
    retrievePaymentIntent: jest.fn(async (id: string) => {
      if (id.startsWith('seti_')) throw new Error('resource_missing: No such payment_intent');
      return { latest_charge: 'charge-example' };
    }),
    retrieveCharge: jest.fn(async () => ({ amount: 10_000, amount_refunded: 0, application_fee_amount: 200 })),
  };
  const reconciliation = new ReconciliationService(prisma as any, stripe as any);
  const notifications = {
    createNotification: jest.fn(async (input: any) => input),
    pushToUser: jest.fn(async () => ({ delivered: true })),
  };
  const lease = { tryAcquire: jest.fn(async () => ({ acquired: true, until: new Date() })) };
  const users = { user: { findFirst: jest.fn(async () => ({ id: 'owner-example' })) } };
  const cron = new ReconciliationDailyCron(lease as any, reconciliation, notifications as any, users as any);
  return { reconciliation, cron, notifications };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const)
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

describe('LO-1225R3 B1: a web trial that never charged is not "could not be confirmed yet"', () => {
  it.each(['trialing', 'paused', 'canceled'])(
    'a %s web trial with no charge of any kind leaves the daily check clean',
    async (status) => {
      const { cron, notifications } = world(status);
      await expect(cron.runOnce(new Date(Date.now() - 1_000), 'machine-example', async () => undefined))
        .resolves.toMatchObject({ ran: true, verdict: 'clean', tally: { checked: 1, ok: 1, unknown: 0 } });
      for (const [input] of notifications.createNotification.mock.calls as any[])
        expect(String(input.body)).not.toContain('could not be confirmed yet');
    },
  );

  it('the SetupIntent alone reads as never charged', async () => {
    const { reconciliation } = world('trialing');
    await expect(reconciliation.reconcilePurchase('web-trial-example'))
      .resolves.toMatchObject({ status: 'ok', notes: expect.stringContaining('never_charged') });
  });

  // Controls: evidence of a charge still keeps a web trial out of never_charged.
  it.each([
    ['canceled', { settlement: 'awaiting_fee' }],
    ['past_due', { settlement: 'error' }],
    ['canceled', { ledger: true }],
  ] as const)('a %s web trial with charge evidence %j is not never_charged', async (status, opts) => {
    const { reconciliation } = world(status, opts);
    const result = await reconciliation.reconcilePurchase('web-trial-example');
    expect(result.notes ?? '').not.toContain('never_charged');
  });
});
