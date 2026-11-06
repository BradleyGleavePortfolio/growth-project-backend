jest.mock('../src/connect/stripe-connect-api.service', () => ({
  StripeConnectApiService: class {},
}));
jest.mock('../src/connect/fees/charge-settlement.service', () => ({
  ChargeSettlementService: class {},
  chargeRefundsFromStripe: jest.fn(),
}));
jest.mock('../src/prisma.service', () => ({ PrismaService: class {} }));

import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

describe('LS-1225 full-day acceptance', () => {
  it('checks all 120 paid purchases across batches even when an admin checked them an hour ago', async () => {
    const runAt = new Date();
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: `acceptance-purchase-${index}`,
      checkedAt: new Date(runAt.getTime() - 60 * 60 * 1000),
    }));
    const prisma = {
      clientPurchase: {
        findMany: jest.fn(async (query: any) => {
          const cutoff = query.where.OR[1].reconciliation.last_checked_at.lt as Date;
          return rows.filter((row) => row.checkedAt < cutoff).slice(0, query.take);
        }),
      },
    };
    const service = new ReconciliationService(prisma as any, {} as any);
    const reconcile = jest.spyOn(service as any, 'reconcileFromRow').mockImplementation(async (purchase: any) => {
      const row = rows.find((entry) => entry.id === purchase.id);
      if (!row) throw new Error('missing fixture');
      row.checkedAt = new Date(runAt.getTime() + 1);
      return { purchase_id: purchase.id, status: 'ok' } as any;
    });
    let checked = 0;
    let batches = 0;
    for (; batches < 5; batches += 1) {
      // Runtime option is intentional: the same regression executes on main,
      // where runSweep has no staleBefore option and silently ignores it.
      const batch = await (service.runSweep as any)(50, { staleBefore: runAt });
      checked += batch.scanned;
      if (batch.scanned < 50) break;
    }
    expect(checked).toBe(120);
    expect(prisma.clientPurchase.findMany).toHaveBeenCalledTimes(3);
    expect(reconcile).toHaveBeenCalledTimes(120);
  });
});
