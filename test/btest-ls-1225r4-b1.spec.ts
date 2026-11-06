// LS-1225R4: local charge evidence is not a complete Stripe charge census.
// invoice.paid uses the invoice's charge without changing the purchase's
// original payment-intent pointer (checkout-webhook-handler.service.ts:2747+).
// A lost renewal webhook is an existing supported state: the independent
// settlement backstop discovers it later (charge-settlement.service.ts:1115+).
// This daily read-only check must not attest the missing money in that interval,
// or while invoice discovery is unavailable, merely because older money matches.
import { Logger } from '@nestjs/common';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { asPrisma, Table } from './utils/settlement-fakes';

function world(history: boolean, missingRenewal: boolean, unreadable = false) {
  const purchase = {
    id: 'renewing-purchase-example',
    source: null,
    status: history ? 'active' : 'trialing',
    billing_type: 'recurring',
    amount_cents: 4_900,
    currency: 'usd',
    stripe_subscription_id: 'subscription-example',
    stripe_payment_intent_id: history ? 'original-intent-example' : null,
  };
  const old = {
    id: 'settlement-example',
    purchase_id: purchase.id,
    stripe_charge_id: 'original-charge-example',
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
  const ledger = history
    ? [['application_fee', 98], ['stripe_fee', 172], ['destination', 4_630]]
      .map(([kind, amount_cents]) => ({
        purchase_id: purchase.id, stripe_charge_id: old.stripe_charge_id,
        kind, amount_cents, reversed_cents: 0, status: 'posted',
      }))
    : [];
  const none = () => new Table([], { prefix: 'empty' });
  const db = asPrisma({
    clientPurchase: new Table([purchase], { prefix: 'purchase' }),
    chargeSettlement: new Table(history ? [old] : [], { prefix: 'settlement' }),
    splitLedgerEntry: new Table(ledger, { prefix: 'ledger' }),
    connectTransfer: new Table(history ? [{
      id: 'transfer-example', purchase_id: purchase.id, settlement_id: old.id,
      source_stripe_charge_id: old.stripe_charge_id,
      destination_user_id: old.coach_user_id, amount_cents: 4_630,
      reversed_amount_cents: 0, netted_recovery_cents: 0, status: 'succeeded',
    }] : [], { prefix: 'transfer' }),
    payeeRecovery: none(),
    chargeDispute: none(),
    reconciliationSnapshot: none(),
  });
  const paid = [
    ...(missingRenewal ? [{
      id: 'renewal-invoice-example', subscription: purchase.stripe_subscription_id,
      charge: 'unrecorded-renewal-charge-example', amount_paid: 4_900, status: 'paid',
    }] : []),
    ...(history ? [{
      id: 'original-invoice-example', subscription: purchase.stripe_subscription_id,
      charge: old.stripe_charge_id, amount_paid: 4_900, status: 'paid',
    }] : []),
  ];
  const invoices = jest.fn(async () => {
    if (unreadable) throw new Error('invoice history unavailable');
    return { data: paid, has_more: false };
  });
  const stripe = {
    listInvoices: invoices,
    listPaidInvoices: invoices,
    retrievePaymentIntent: jest.fn(async () => ({
      id: purchase.stripe_payment_intent_id, latest_charge: old.stripe_charge_id,
    })),
    retrieveCharge: jest.fn(async (id: string) => ({
      id, amount: 4_900, amount_refunded: 0, application_fee_amount: 98,
      balance_transaction: { amount: 4_900, fee: 172, currency: 'usd' },
    })),
  };
  const service = new ReconciliationService(db, stripe as never);
  const notifications = {
    createNotification: jest.fn(async (input: unknown) => input),
    pushToUser: jest.fn(async () => ({ delivered: true })),
  };
  const cron = new ReconciliationDailyCron(
    { tryAcquire: jest.fn(async () => ({ acquired: true })) } as never,
    service, notifications as never,
    { user: { findFirst: jest.fn(async () => ({ id: 'owner-example' })) } } as never,
  );
  return { cron, notifications, stripe };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const)
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

describe('LS-1225R4 B1: Stripe-only renewal money is not attested by local history', () => {
  it('control: matched recorded history without another paid invoice can be clean', async () => {
    const { cron } = world(true, false);
    await expect(cron.runOnce(new Date(Date.now() - 1_000), 'machine-example', async () => undefined))
      .resolves.toMatchObject({ ran: true, verdict: 'clean' });
  });

  it.each([
    ['older matched settlement', true, true, false],
    ['trial has now charged', false, true, false],
    ['unreadable invoice history after a trial', false, true, true],
  ] as const)('%s cannot produce Every one matches without reading that money', async (_label, history, missing, unreadable) => {
    const { cron, notifications } = world(history, missing, unreadable);
    const result = await cron.runOnce(new Date(Date.now() - 1_000), 'machine-example', async () => undefined);
    expect(result).toMatchObject({ ran: true, verdict: 'needs_review' });
    const bodies = notifications.createNotification.mock.calls.map(([input]) => (input as { body: string }).body);
    expect(bodies.join(' ')).not.toContain('Every one matches.');
  });
});
