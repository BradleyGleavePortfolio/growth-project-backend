// B-TEST LO-1225 B1 (lens, agent 199): a client who starts a free trial and
// cancels before the first charge leaves a ClientPurchase with status
// 'canceled', trial_started_at set, no payment intent, no ledger row and no
// settlement (checkout-webhook-handler.service.ts:2207; $0 invoices are skipped
// at charge-settlement.service.ts:927). runSweep keeps 'canceled' in its set
// (reconciliation.service.ts:204), resolveChargeId returns null
// (reconciliation.service.ts:451-461) and the snapshot is 'unknown' every day,
// so the daily verdict reads "needs review" forever although no money moved.
// Expected at head: FAILS (title is "Money check: needs review").
import { Logger } from '@nestjs/common';
import { CronLeaseService } from '../src/checkout/cron-lease.service';
import { ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { Table, asPrisma } from './utils/settlement-fakes';

function world() {
  const purchases = [
    { id: 'paid-1', status: 'paid', source: null, amount_cents: 10_000, stripe_payment_intent_id: 'pi_paid-1', trial_started_at: null, updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)) },
    { id: 'paid-2', status: 'paid', source: null, amount_cents: 10_000, stripe_payment_intent_id: 'pi_paid-2', trial_started_at: null, updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)) },
    // Free trial started, canceled before the first charge: no money ever moved.
    { id: 'trial-canceled', status: 'canceled', source: null, amount_cents: 10_000, billing_type: 'recurring', stripe_subscription_id: 'sub_t', stripe_payment_intent_id: null, trial_started_at: new Date(Date.UTC(2026, 0, 1)), updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)) },
  ];
  const snapshots = new Map<string, any>();
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async (args: any) => {
        const w = args.where;
        const stale: Date = w.OR[1].reconciliation.last_checked_at.lt;
        return purchases
          .filter((p) => w.status.in.includes(p.status) && p.source === w.source)
          .filter((p) => !snapshots.has(p.id) || snapshots.get(p.id).last_checked_at < stale)
          .slice(0, args.take);
      }),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where }: any) =>
        where.purchase_id === 'trial-canceled'
          ? []
          : [
              { purchase_id: where.purchase_id, kind: 'destination', amount_cents: 9_800, reversed_cents: 0, status: 'posted' },
              { purchase_id: where.purchase_id, kind: 'application_fee', amount_cents: 200, reversed_cents: 0, status: 'posted' },
            ],
      ),
      findFirst: jest.fn(async () => null),
    },
    connectTransfer: { findMany: jest.fn(async () => []) },
    chargeSettlement: { findMany: jest.fn(async () => []) },
    payeeRecovery: { findMany: jest.fn(async () => []) },
    reconciliationSnapshot: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const prev = snapshots.get(where.purchase_id);
        const row = prev ? { ...prev, ...update } : { ...create };
        snapshots.set(where.purchase_id, row);
        return row;
      }),
    },
  };
  const stripe = {
    retrievePaymentIntent: jest.fn(async (id: string) => ({ id, latest_charge: `ch_${id}` })),
    retrieveCharge: jest.fn(async (id: string) => ({ id, amount: 10_000, amount_refunded: 0, application_fee_amount: 200 })),
    // FIX-1225R4: Stripe's paid invoices for sub_t: only the $0 trial invoice (it never charged).
    listInvoices: jest.fn(async () => ({ data: [{ id: 'in_trial', status: 'paid', amount_paid: 0, charge: null }], has_more: false })),
  };
  return new ReconciliationService(prisma as any, stripe as any);
}

beforeAll(() => {
  for (const m of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('B-TEST LO-1225 B1', () => {
  it('a free trial canceled before any charge does not turn every daily alert into "needs review"', async () => {
    delete process.env.RECONCILIATION_DAILY_ENABLED;
    const notes = {
      createNotification: jest.fn(async (input: any) => ({ id: 'n-1', ...input })),
      pushToUser: jest.fn(async () => ({ sent: 1 }) as any),
    };
    const users = { user: { findFirst: jest.fn(async () => ({ id: 'owner-1' })) } };
    const lease = new CronLeaseService(asPrisma({ cronLease: new Table([], { prefix: 'lease', unique: ['name'] }) }));
    const cron = new ReconciliationDailyCron(lease, world(), notes as any, users as any);
    await cron.runOnce(new Date(Date.now() - 1_000), 'm1', async () => undefined);
    expect(notes.createNotification).toHaveBeenCalledTimes(1);
    expect(notes.createNotification.mock.calls[0][0].payload.title).toBe('Money check: clean');
    expect(notes.createNotification.mock.calls[0][0].payload.unknown).toBe(0);
  });
});
