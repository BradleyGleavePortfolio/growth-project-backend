import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

// In-memory tx stub honouring the on-conflict-do-nothing semantics of
// `upsert({ where: {purchase_id}, create: {...}, update: {} })`.
function makeTx() {
  const rows: any[] = [];
  return {
    _rows: rows,
    purchaseFanout: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = rows.find((r) => r.purchase_id === where.purchase_id);
        if (existing) {
          // update is {} → no-op, return existing row unchanged.
          return { ...existing };
        }
        const row = {
          id: `fanout-${rows.length + 1}`,
          state: 'pending',
          retry_count: 0,
          created_at: new Date(),
          ...create,
        };
        rows.push(row);
        return { ...row };
      }),
    },
  };
}

describe('PurchaseFanoutService.onPurchaseEntitled', () => {
  it('creates exactly one PurchaseFanout row with state=pending + correct entrypoint', async () => {
    const svc = new PurchaseFanoutService();
    const tx = makeTx();

    await svc.onPurchaseEntitled(
      { id: 'pur-1' },
      { entrypoint: 'in_app_hosted', coachId: 'coach-1', clientId: 'client-1' },
      tx as any,
    );

    expect(tx._rows).toHaveLength(1);
    expect(tx._rows[0]).toMatchObject({
      purchase_id: 'pur-1',
      entrypoint: 'in_app_hosted',
      state: 'pending',
    });
    expect(tx.purchaseFanout.upsert).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a replay leaves exactly one row and does not throw', async () => {
    const svc = new PurchaseFanoutService();
    const tx = makeTx();

    await svc.onPurchaseEntitled(
      { id: 'pur-1' },
      { entrypoint: 'in_app_ps' },
      tx as any,
    );
    // Stripe redelivers the same event — second invocation must no-op.
    await expect(
      svc.onPurchaseEntitled({ id: 'pur-1' }, { entrypoint: 'in_app_ps' }, tx as any),
    ).resolves.toBeUndefined();

    expect(tx._rows).toHaveLength(1);
    expect(tx._rows[0].entrypoint).toBe('in_app_ps');
    expect(tx.purchaseFanout.upsert).toHaveBeenCalledTimes(2);
  });

  it('writes via the passed tx client (rolls back with outer tx)', async () => {
    const svc = new PurchaseFanoutService();
    const tx = makeTx();
    const otherClient = makeTx();

    await svc.onPurchaseEntitled(
      { id: 'pur-2' },
      { entrypoint: 'storefront_guest' },
      tx as any,
    );

    // Only the passed tx received the write — proving that if the outer
    // $transaction aborted, this row would be rolled back along with it
    // (Prisma's tx client is scoped to the transaction's connection).
    expect(tx._rows).toHaveLength(1);
    expect(otherClient._rows).toHaveLength(0);
    expect(tx.purchaseFanout.upsert).toHaveBeenCalledTimes(1);
    expect(otherClient.purchaseFanout.upsert).not.toHaveBeenCalled();
  });

  it('distinct purchase ids create distinct rows', async () => {
    const svc = new PurchaseFanoutService();
    const tx = makeTx();
    await svc.onPurchaseEntitled({ id: 'pur-a' }, { entrypoint: 'in_app_hosted' }, tx as any);
    await svc.onPurchaseEntitled({ id: 'pur-b' }, { entrypoint: 'in_app_hosted' }, tx as any);
    expect(tx._rows).toHaveLength(2);
    expect(tx._rows.map((r) => r.purchase_id).sort()).toEqual(['pur-a', 'pur-b']);
  });
});
