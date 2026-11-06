// LS-1225R3 B1: a matched historical charge cannot attest an unfinished
// later renewal. invoice.paid hands each renewal charge to the split handler;
// settlement can retain awaiting_fee before posting that charge's ledger.
import { Logger } from '@nestjs/common';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { Table, asPrisma } from './utils/settlement-fakes';

function world(status: string, awaiting: boolean, settledHistory = true) {
  const purchase = {
    id: 'renewing-purchase-example',
    status,
    source: null,
    billing_type: 'recurring',
    amount_cents: 4_900,
    stripe_payment_intent_id: null,
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
  const historical = {
    id: 'historical-settlement-example',
    purchase_id: purchase.id,
    stripe_charge_id: 'historical-charge-example',
    mechanism: 'separate_charge_transfer',
    status: 'settled',
    coach_user_id: 'coach-example',
    head_coach_user_id: null,
    gross_cents: 4_900,
    stripe_fee_cents: 172,
    platform_fee_cents: 98,
    head_coach_split_cents: 0,
    coach_net_cents: 4_630,
    refunded_cents: 0,
    dispute_withdrawn_cents: 0,
    dispute_fee_cents: 0,
    target_platform_fee_cents: 98,
    target_head_coach_cents: 0,
    target_coach_net_cents: 4_630,
    currency: 'usd',
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const settlements = [
    ...(settledHistory ? [historical] : []),
    ...(awaiting ? [{
      id: 'unfinished-settlement-example',
      purchase_id: purchase.id,
      stripe_charge_id: 'unfinished-charge-example',
      mechanism: 'separate_charge_transfer',
      status: 'awaiting_fee',
      gross_cents: 4_900,
      created_at: new Date('2026-02-01T00:00:00Z'),
    }] : []),
  ];
  const ledger = (settledHistory
    ? [['application_fee', 98], ['stripe_fee', 172], ['destination', 4_630]]
    : [['application_fee', 98], ['destination', 4_802]]
  ).map(([kind, amount_cents]) => ({
    purchase_id: purchase.id,
    stripe_charge_id: historical.stripe_charge_id,
    kind, amount_cents, reversed_cents: 0, status: 'posted',
  }));
  const db = asPrisma({
    clientPurchase: new Table([purchase], { prefix: 'purchase' }),
    chargeSettlement: new Table(settlements, { prefix: 'settlement' }),
    splitLedgerEntry: new Table(ledger, { prefix: 'ledger' }),
    connectTransfer: new Table(settledHistory ? [{
      id: 'historical-transfer-example',
      purchase_id: purchase.id,
      settlement_id: historical.id,
      destination_user_id: 'coach-example',
      amount_cents: 4_630,
      netted_recovery_cents: 0,
      reversed_amount_cents: 0,
      status: 'succeeded',
    }] : [], { prefix: 'transfer' }),
    payeeRecovery: new Table([], { prefix: 'recovery' }),
    reconciliationSnapshot: new Table([], { prefix: 'snapshot' }),
  });
  const stripe = {
    retrievePaymentIntent: jest.fn(),
    retrieveCharge: jest.fn(async (id: string) => {
      // The new renewal remains unreadable. The old charge is exactly matched.
      if (id === 'unfinished-charge-example') throw new Error('charge read unavailable');
      return {
        id, amount: 4_900, amount_refunded: 0, application_fee_amount: 98,
        balance_transaction: { id: 'historical-balance-example', amount: 4_900, fee: 172, currency: 'usd' },
      };
    }),
  };
  const service = new ReconciliationService(db, stripe as any);
  const notifications = {
    createNotification: jest.fn(async (input: any) => input),
    pushToUser: jest.fn(async () => ({ delivered: true })),
  };
  const cron = new ReconciliationDailyCron(
    { tryAcquire: jest.fn(async () => ({ acquired: true })) } as any,
    service,
    notifications as any,
    { user: { findFirst: jest.fn(async () => ({ id: 'owner-example' })) } } as any,
  );
  return { service, cron, notifications, stripe, purchase };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const)
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

describe('LS-1225R3 B1: historical money cannot hide an unfinished renewal charge', () => {
  it('control: a settled historical charge with no unfinished renewal is ok', async () => {
    const w = world('active', false);
    await expect(w.service.reconcilePurchase(w.purchase.id)).resolves.toMatchObject({ status: 'ok', drift_cents: 0 });
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'])(
    '%s with settled history and an unreadable awaiting_fee renewal is not ok',
    async (status) => {
      const w = world(status, true);
      const result = await w.service.reconcilePurchase(w.purchase.id);
      expect(result.status).not.toBe('ok');
    },
  );

  it('legacy ledger history cannot hide an unreadable awaiting_fee renewal either', async () => {
    const w = world('past_due', true, false);
    const result = await w.service.reconcilePurchase(w.purchase.id);
    expect(result.status).not.toBe('ok');
  });

  it('the real daily run must not send clean for the unchecked renewal', async () => {
    const w = world('active', true);
    await expect(w.cron.runOnce(new Date(Date.now() - 1_000), 'machine-example', async () => undefined))
      .resolves.toMatchObject({ ran: true, verdict: 'needs_review', tally: { checked: 1, ok: 0 } });
  });

  it('the shared admin sweeper must not omit the unfinished renewal from its unknown count', async () => {
    const w = world('unpaid', true);
    const controller = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (controller as any).reconciliation = w.service;
    await expect(controller.runReconciliationSweeper('50'))
      .resolves.toEqual({ scanned: 1, drifted: 0, unknown: 1 });
  });
});
