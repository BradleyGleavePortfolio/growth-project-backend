// Ordinary uncharged web-trial provenance:
// guest-checkout.service.ts:139-144,1828,1973,2001-2012 stores a
// SetupIntent (not a PaymentIntent) on the trialing ClientPurchase.
import { Logger } from '@nestjs/common';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { asPrisma, Table } from './utils/settlement-fakes';

function world(intent: string | null, charged = false) {
  const purchases = new Table([{
    id: 'guest-trial-example', source: null, status: 'trialing',
    billing_type: 'recurring', amount_cents: 4900, currency: 'usd',
    stripe_payment_intent_id: intent,
    stripe_subscription_id: 'subscription-example',
  }], { prefix: 'purchase' });
  const settlements = new Table(charged ? [{
    id: 'settlement-example', purchase_id: 'guest-trial-example',
    mechanism: 'separate_charge_transfer', status: 'awaiting_fee',
    stripe_charge_id: 'charged-renewal-example', gross_cents: 4900,
  }] : [], { prefix: 'settlement' });
  const snapshots = new Table([], { prefix: 'snapshot', unique: ['purchase_id'] });
  const none = () => new Table([], { prefix: 'none' });
  const prisma = asPrisma({
    clientPurchase: purchases,
    chargeSettlement: settlements,
    splitLedgerEntry: none(),
    connectTransfer: none(),
    payeeRecovery: none(),
    chargeDispute: none(),
    reconciliationSnapshot: snapshots,
  });
  // Stripe cannot return a PaymentIntent for a SetupIntent identifier.
  const stripe = {
    retrievePaymentIntent: jest.fn(async () => {
      throw new Error('resource_missing: this is a SetupIntent, not a PaymentIntent');
    }),
    retrieveCharge: jest.fn(),
  };
  const service = new ReconciliationService(prisma, stripe as never);
  const notifications = {
    createNotification: jest.fn(async (input: unknown) => input),
    pushToUser: jest.fn(async () => ({ delivered: true })),
  };
  const cron = new ReconciliationDailyCron(
    { tryAcquire: jest.fn(async () => ({ acquired: true })) } as never,
    service,
    notifications as never,
    { user: { findFirst: jest.fn(async () => ({ id: 'owner-example' })) } } as never,
  );
  return { service, cron, stripe };
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const)
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

describe('LS-1225R3 C1: an ordinary no-charge web trial is not a broken PI read', () => {
  it('control: no-pointer trial is correctly never_charged', async () => {
    const { service } = world(null);
    await expect(service.reconcilePurchase('guest-trial-example'))
      .resolves.toMatchObject({ status: 'ok', notes: 'never_charged' });
  });

  it('recognizes the real SetupIntent-only trial as uncharged', async () => {
    const { service } = world('seti_example_guest_trial');
    await expect(service.reconcilePurchase('guest-trial-example'))
      .resolves.toMatchObject({ status: 'ok', notes: 'never_charged' });
  });

  it('does not turn an ordinary zero-charge trial into a daily exception', async () => {
    const { cron } = world('seti_example_guest_trial');
    await expect(cron.runOnce(new Date(Date.now() - 1000), 'machine-example', async () => undefined))
      .resolves.toMatchObject({
        verdict: 'clean',
        tally: { checked: 1, ok: 1, unknown: 0 },
      });
  });

  it('keeps the shared admin sweeper consistent with the no-charge trial', async () => {
    const { service } = world('seti_example_guest_trial');
    const admin = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    Object.assign(admin, { reconciliation: service });
    await expect(admin.runReconciliationSweeper('50'))
      .resolves.toEqual({ scanned: 1, drifted: 0, unknown: 0 });
  });

  it('control: a SetupIntent marker must not hide an actual charged renewal', async () => {
    const { service } = world('seti_example_guest_trial', true);
    const result = await service.reconcilePurchase('guest-trial-example');
    expect(result.status).not.toBe('ok');
  });
});
