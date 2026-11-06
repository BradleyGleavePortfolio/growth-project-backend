// Independent LS-1225R2 proof: a previously paid subscription may become
// unpaid after renewal retries. That is not a never-money-moved state:
// checkout-webhook-handler.service.ts:1746,1849-1852 writes Stripe's state;
// dunning-v2/dunning-grace.ts:5-11 identifies the ordinary renewal path.
import { Logger } from '@nestjs/common';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

function world(status: string, shortBy: number) {
  const purchase = {
    id: 'renewal-example',
    status,
    source: null,
    billing_type: 'recurring',
    amount_cents: 10_000,
    stripe_payment_intent_id: 'intent-example',
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) =>
        where.status.in.includes(purchase.status) ? [purchase] : []),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async () => [
        { kind: 'destination', amount_cents: 9_800 - shortBy, reversed_cents: 0, status: 'posted' },
        { kind: 'application_fee', amount_cents: 200, reversed_cents: 0, status: 'posted' },
      ]),
    },
    connectTransfer: { findMany: jest.fn(async () => []) },
    chargeSettlement: { findMany: jest.fn(async () => []) },
    reconciliationSnapshot: { upsert: jest.fn(async ({ create }: any) => create) },
  };
  const stripe = {
    retrievePaymentIntent: jest.fn(async () => ({ latest_charge: 'charge-example' })),
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

describe('LS-1225R2 B1: previously paid unpaid renewals remain money-bearing', () => {
  it.each([
    ['past_due', 500, 'needs_review'],
    ['unpaid', 0, 'clean'],
    ['unpaid', 500, 'needs_review'],
  ] as const)('%s with ledger short by %i is checked and reports %s', async (status, shortBy, verdict) => {
    const { cron } = world(status, shortBy);
    await expect(cron.runOnce(new Date(Date.now() - 1_000), 'machine-example', async () => undefined))
      .resolves.toMatchObject({
        ran: true,
        verdict,
        tally: { checked: 1, drift: shortBy > 0 ? 1 : 0 },
      });
  });

  it('the shared admin sweeper also counts a drifted unpaid renewal', async () => {
    const { reconciliation } = world('unpaid', 500);
    const controller = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (controller as any).reconciliation = reconciliation;
    await expect(controller.runReconciliationSweeper('50'))
      .resolves.toEqual({ scanned: 1, drifted: 1, unknown: 0 });
  });
});
