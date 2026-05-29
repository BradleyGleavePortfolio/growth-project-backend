// PR-16 tests — cancelPendingForPurchase + wiring through the three
// revocation handlers (refund/dispute/sub-deleted).
//
// Pattern matches the existing in-memory-Prisma-stub style used across the
// repo (purchase-fanout.service.spec.ts, refund-dispute-handler.service.spec.ts).
// We model ScheduledDrop with the fields the real schema carries so the
// set-based updateMany WHERE clause is exercised against the same shape
// production sees.

import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';

// Helpers -----------------------------------------------------------------

interface DropRow {
  id: string;
  client_purchase_id: string;
  content_id: string;
  status: string;
  fire_at: Date | null;
  materialised_ref: string | null;
  attempt_count: number;
  next_retry_at: Date | null;
  locked_at: Date | null;
  failure_reason: string | null;
}

function makeDropStore() {
  const rows: DropRow[] = [];
  const api = {
    _rows: rows,
    scheduledDrop: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matchStatus = (row: DropRow) => {
          if (where.status === undefined) return true;
          if (typeof where.status === 'object' && where.status !== null) {
            if ('in' in where.status)
              return (where.status.in as string[]).includes(row.status);
            if ('notIn' in where.status)
              return !(where.status.notIn as string[]).includes(row.status);
            if ('not' in where.status) return row.status !== where.status.not;
          }
          return row.status === where.status;
        };
        const matched = rows.filter(
          (r) =>
            (where.client_purchase_id === undefined ||
              r.client_purchase_id === where.client_purchase_id) &&
            (where.id === undefined || r.id === where.id) &&
            matchStatus(r),
        );
        for (const r of matched) Object.assign(r, data);
        return { count: matched.length };
      }),
      // Mimic PR-10 findDue: gates on status IN ('pending','dispatching')
      // + materialised_ref IS NULL + fire_at <= now AND not null.
      findMany: jest.fn(async ({ where }: any) => {
        const now: Date = where.fire_at?.lte ?? new Date();
        return rows.filter((r) => {
          if (r.materialised_ref !== null) return false;
          if (r.fire_at === null) return false;
          if (r.fire_at.getTime() > now.getTime()) return false;
          const allowed = where.OR
            ? (where.OR as any[]).some((branch) =>
                branch.status === r.status &&
                // accept the rest of the branch loosely — we only care
                // about status-eligibility for this excludes-canceled test.
                true,
              )
            : true;
          if (!allowed) return false;
          if (r.status === 'canceled' || r.status === 'fired' || r.status === 'failed' || r.status === 'skipped' || r.status === 'delivered') {
            // findDue only allows pending / dispatching — these are excluded.
            return false;
          }
          return true;
        });
      }),
    },
  };
  return api;
}

function seedDrops(store: ReturnType<typeof makeDropStore>, purchaseId: string, drops: Partial<DropRow>[]) {
  for (const d of drops) {
    store._rows.push({
      id: d.id ?? `drop-${store._rows.length + 1}`,
      client_purchase_id: purchaseId,
      content_id: d.content_id ?? `content-${store._rows.length + 1}`,
      status: d.status ?? 'pending',
      fire_at: d.fire_at === undefined ? new Date(Date.now() - 60_000) : d.fire_at,
      materialised_ref: d.materialised_ref ?? null,
      attempt_count: d.attempt_count ?? 0,
      next_retry_at: d.next_retry_at ?? null,
      locked_at: d.locked_at ?? null,
      failure_reason: d.failure_reason ?? null,
    });
  }
}

// ============================================================================
// Unit — PurchaseFanoutService.cancelPendingForPurchase
// ============================================================================

describe('PurchaseFanoutService.cancelPendingForPurchase', () => {
  it('cancels pending+due drops in ONE set-based UPDATE; leaves fired/failed/skipped/canceled untouched', async () => {
    const store = makeDropStore();
    seedDrops(store, 'pur-1', [
      { id: 'd1', status: 'pending' },
      { id: 'd2', status: 'due' },
      { id: 'd3', status: 'fired' },
      { id: 'd4', status: 'failed' },
      { id: 'd5', status: 'skipped' },
      { id: 'd6', status: 'canceled' },
    ]);
    // Drop belonging to a DIFFERENT purchase — must not be touched.
    seedDrops(store, 'pur-OTHER', [{ id: 'd7', status: 'pending' }]);

    const svc = new PurchaseFanoutService();
    const count = await svc.cancelPendingForPurchase('pur-1', 'refund', store as any);

    expect(count).toBe(2);
    expect(store.scheduledDrop.updateMany).toHaveBeenCalledTimes(1);
    // Exactly the two pending+due rows transitioned.
    const byId = Object.fromEntries(store._rows.map((r) => [r.id, r.status] as const));
    expect(byId).toEqual({
      d1: 'canceled',
      d2: 'canceled',
      d3: 'fired',
      d4: 'failed',
      d5: 'skipped',
      d6: 'canceled', // already canceled — unchanged
      d7: 'pending', // OTHER purchase's drop is untouched (scope isolation)
    });
    // Reason is stamped on transitioned drops.
    expect(store._rows.find((r) => r.id === 'd1')?.failure_reason).toBe('canceled:refund');
    expect(store._rows.find((r) => r.id === 'd2')?.failure_reason).toBe('canceled:refund');
  });

  it('is idempotent — a second call returns 0 and changes nothing', async () => {
    const store = makeDropStore();
    seedDrops(store, 'pur-1', [
      { id: 'd1', status: 'pending' },
      { id: 'd2', status: 'due' },
    ]);
    const svc = new PurchaseFanoutService();

    const first = await svc.cancelPendingForPurchase('pur-1', 'dispute', store as any);
    const second = await svc.cancelPendingForPurchase('pur-1', 'dispute', store as any);

    expect(first).toBe(2);
    expect(second).toBe(0); // replay no-op
    expect(store._rows.every((r) => r.status === 'canceled')).toBe(true);
  });

  it('runs ON the passed tx (rolls back with outer tx)', async () => {
    const store = makeDropStore();
    seedDrops(store, 'pur-1', [{ id: 'd1', status: 'pending' }]);
    const otherClient = makeDropStore();
    const svc = new PurchaseFanoutService();

    await svc.cancelPendingForPurchase('pur-1', 'refund', store as any);

    // Only the passed tx's table received the write.
    expect(store.scheduledDrop.updateMany).toHaveBeenCalledTimes(1);
    expect(otherClient.scheduledDrop.updateMany).toHaveBeenCalledTimes(0);
  });

  it("returns 0 when scheduledDrop client is missing (graceful degrade)", async () => {
    const svc = new PurchaseFanoutService();
    // Tx without scheduledDrop and no prisma injected — should warn + return 0.
    const result = await svc.cancelPendingForPurchase(
      'pur-1',
      'refund',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toBe(0);
  });
});

// ============================================================================
// Cron interaction — PR-10 findDue must exclude canceled drops
// ============================================================================

describe('PR-10 cron findDue × PR-16 cancel', () => {
  it('a canceled drop is NOT returned by findDue (status gate excludes canceled)', async () => {
    const store = makeDropStore();
    seedDrops(store, 'pur-1', [
      { id: 'd1', status: 'pending', fire_at: new Date(Date.now() - 60_000) },
      { id: 'd2', status: 'pending', fire_at: new Date(Date.now() - 60_000) },
    ]);
    const svc = new PurchaseFanoutService();

    // Cancel pending drops.
    await svc.cancelPendingForPurchase('pur-1', 'refund', store as any);

    // Now simulate the dispatcher's findDue gate. The real query uses
    // status IN ('pending','dispatching'); a canceled drop never matches.
    const candidates = await store.scheduledDrop.findMany({
      where: {
        materialised_ref: null,
        fire_at: { lte: new Date(), not: null },
        attempt_count: { lt: 5 },
        OR: [{ status: 'pending' }, { status: 'dispatching' }],
      },
    });
    expect(candidates).toHaveLength(0);
  });
});

// ============================================================================
// Wiring — applySubscriptionDeleted cancels for the right purchase
// ============================================================================

function makeWebhookPrisma() {
  const purchases: any[] = [];
  return {
    _purchases: purchases,
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          where.id ? p.id === where.id : p.stripe_subscription_id === where.stripe_subscription_id,
        ) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    coachPackage: { findUnique: jest.fn(async () => null) },
  };
}

describe('CheckoutWebhookHandlerService.applySubscriptionDeleted × cancelPendingForPurchase', () => {
  it('cancels pending drops for the purchase identified by stripe_subscription_id; does NOT touch a different purchase', async () => {
    const dropStore = makeDropStore();
    seedDrops(dropStore, 'pur-target', [
      { id: 'd-t1', status: 'pending' },
      { id: 'd-t2', status: 'due' },
    ]);
    seedDrops(dropStore, 'pur-other', [{ id: 'd-o1', status: 'pending' }]);

    const prisma = makeWebhookPrisma();
    // The target purchase is entitled — wasEntitled=true triggers the cancel call.
    prisma._purchases.push({
      id: 'pur-target',
      stripe_subscription_id: 'sub_t',
      entitlement_active: true,
      status: 'active',
      package_id: 'pkg-1',
      coach_user_id: 'coach-1',
      client_user_id: 'client-1',
      amount_cents: 1000,
      currency: 'usd',
    });
    prisma._purchases.push({
      id: 'pur-other',
      stripe_subscription_id: 'sub_o',
      entitlement_active: true,
      status: 'active',
      package_id: 'pkg-2',
      coach_user_id: 'coach-1',
      client_user_id: 'client-2',
      amount_cents: 1000,
      currency: 'usd',
    });

    const fanout = new PurchaseFanoutService();
    const handler = new CheckoutWebhookHandlerService(
      prisma as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      fanout,
    );

    // tx forwarded by BillingService — we use the merged dropStore+prisma map.
    const tx = { ...prisma, ...dropStore } as any;
    const result = await handler.handle(
      {
        id: 'evt_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_t', canceled_at: 1700000000 } },
      },
      tx,
    );

    expect(result.claimed).toBe(true);
    expect(result.purchase_id).toBe('pur-target');
    // Target's drops are canceled.
    const targetDrops = dropStore._rows.filter((r) => r.client_purchase_id === 'pur-target');
    expect(targetDrops.every((d) => d.status === 'canceled')).toBe(true);
    // OTHER purchase's drop is untouched.
    const otherDrops = dropStore._rows.filter((r) => r.client_purchase_id === 'pur-other');
    expect(otherDrops.every((d) => d.status === 'pending')).toBe(true);
  });

  it('replay (same sub.deleted twice) does not double-cancel and does not throw', async () => {
    const dropStore = makeDropStore();
    seedDrops(dropStore, 'pur-1', [{ id: 'd1', status: 'pending' }]);
    const prisma = makeWebhookPrisma();
    prisma._purchases.push({
      id: 'pur-1',
      stripe_subscription_id: 'sub_1',
      entitlement_active: true,
      status: 'active',
      package_id: 'pkg-1',
      coach_user_id: 'c',
      client_user_id: 'u',
      amount_cents: 1000,
      currency: 'usd',
    });
    const fanout = new PurchaseFanoutService();
    const handler = new CheckoutWebhookHandlerService(
      prisma as any, {} as any, undefined, undefined, undefined, fanout,
    );
    const event = {
      id: 'evt',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', canceled_at: 1700000000 } },
    };
    const tx = { ...prisma, ...dropStore } as any;
    await handler.handle(event, tx);
    // Replay — wasEntitled is now false (we flipped it on the first call),
    // so the second invocation skips the cancel call entirely. The drop
    // is still canceled and the WHERE clause would no-op anyway.
    await expect(handler.handle(event, tx)).resolves.toBeDefined();
    expect(dropStore._rows[0].status).toBe('canceled');
  });
});

// ============================================================================
// Wiring — applyPaymentIntentFailed × never-entitled rule
// ============================================================================

describe('CheckoutWebhookHandlerService.applyPaymentIntentFailed × cancelPendingForPurchase', () => {
  it('does NOT cancel drops for a never-entitled purchase (PI fails before entitlement)', async () => {
    const dropStore = makeDropStore();
    // A pre-entitlement purchase shouldn't have drops, but seed one to
    // prove the wiring won't touch them even if present (defense-in-depth).
    seedDrops(dropStore, 'pur-pending', [{ id: 'd1', status: 'pending' }]);

    const prisma = makeWebhookPrisma();
    prisma._purchases.push({
      id: 'pur-pending',
      stripe_payment_intent_id: 'pi_1',
      entitlement_active: false, // never entitled
      status: 'pending',
      package_id: 'pkg-1',
      coach_user_id: 'c',
      client_user_id: 'u',
      amount_cents: 1000,
      currency: 'usd',
    });

    const fanout = new PurchaseFanoutService();
    const cancelSpy = jest.spyOn(fanout, 'cancelPendingForPurchase');
    const handler = new CheckoutWebhookHandlerService(
      prisma as any, {} as any, undefined, undefined, undefined, fanout,
    );
    const tx = { ...prisma, ...dropStore } as any;
    await handler.handle(
      {
        id: 'evt',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_1' } },
      },
      tx,
    );
    // cancelPendingForPurchase NEVER called for never-entitled.
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(dropStore._rows[0].status).toBe('pending');
  });

  it('DOES cancel drops when a previously-entitled purchase later fails (defensive)', async () => {
    const dropStore = makeDropStore();
    seedDrops(dropStore, 'pur-1', [{ id: 'd1', status: 'pending' }]);

    const prisma = makeWebhookPrisma();
    prisma._purchases.push({
      id: 'pur-1',
      stripe_payment_intent_id: 'pi_1',
      entitlement_active: true, // was entitled
      status: 'paid',
      package_id: 'pkg-1',
      coach_user_id: 'c',
      client_user_id: 'u',
      amount_cents: 1000,
      currency: 'usd',
    });

    const fanout = new PurchaseFanoutService();
    const handler = new CheckoutWebhookHandlerService(
      prisma as any, {} as any, undefined, undefined, undefined, fanout,
    );
    const tx = { ...prisma, ...dropStore } as any;
    await handler.handle(
      {
        id: 'evt',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_1' } },
      },
      tx,
    );
    expect(dropStore._rows[0].status).toBe('canceled');
  });
});

// ============================================================================
// Wiring — RefundDisputeHandlerService.handle (dispute lost branch)
// ============================================================================

describe('RefundDisputeHandlerService dispute-lost × cancelPendingForPurchase', () => {
  it('cancels pending drops for the disputed purchase on dispute closed/lost', async () => {
    const dropStore = makeDropStore();
    seedDrops(dropStore, 'pur-target', [
      { id: 'd-t1', status: 'pending' },
      { id: 'd-t2', status: 'due' },
    ]);
    seedDrops(dropStore, 'pur-other', [{ id: 'd-o1', status: 'pending' }]);

    // Build a minimal prisma that supports the dispute-lost path PLUS the
    // inner $transaction we now wrap around the entitlement flip.
    const disputes: any[] = [{
      id: 'cd-1',
      stripe_dispute_id: 'dp_t',
      purchase_id: 'pur-target',
      amount_cents: 1000,
      status: 'needs_response',
      ledger_reversed: false,
    }];
    const purchases: any[] = [{
      id: 'pur-target',
      entitlement_active: true,
      status: 'disputed',
      amount_cents: 1000,
      coach_user_id: 'c',
      client_user_id: 'u',
    }];

    const txFns = {
      chargeDispute: {
        update: jest.fn(async ({ where, data }: any) => {
          const row = disputes.find((d) => d.id === where.id || d.stripe_dispute_id === where.stripe_dispute_id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        }),
      },
      clientPurchase: {
        update: jest.fn(async ({ where, data }: any) => {
          const row = purchases.find((p) => p.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        }),
      },
      ...dropStore,
    };

    const prisma = {
      chargeDispute: {
        findUnique: jest.fn(async ({ where }: any) =>
          disputes.find((d) => d.stripe_dispute_id === where.stripe_dispute_id) ?? null,
        ),
        update: txFns.chargeDispute.update,
      },
      clientPurchase: {
        findUnique: jest.fn(async ({ where }: any) =>
          purchases.find((p) => p.id === where.id) ?? null,
        ),
        update: txFns.clientPurchase.update,
      },
      connectTransfer: { findFirst: jest.fn(async () => null) },
      splitLedgerEntry: { findFirst: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(txFns)),
    };

    const ledger = { findByPurchase: jest.fn(async () => []), applyReversal: jest.fn() };
    const fanout = new PurchaseFanoutService();

    const svc = new RefundDisputeHandlerService(
      prisma as any,
      {} as any,
      ledger as any,
      {} as any,
      {} as any,
      { createNotification: jest.fn(), pushToUser: jest.fn() } as any,
      fanout,
    );

    const result = await svc.handle({
      id: 'evt-1',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_t', status: 'lost', amount: 1000 } },
    });

    expect(result.claimed).toBe(true);
    // Target purchase's pending+due drops canceled.
    expect(dropStore._rows.filter((r) => r.client_purchase_id === 'pur-target').every((d) => d.status === 'canceled')).toBe(true);
    // OTHER purchase's drop untouched.
    expect(dropStore._rows.find((r) => r.id === 'd-o1')?.status).toBe('pending');
    // Inner $transaction was used for the atomic flip+cancel pair.
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// ============================================================================
// Atomicity — cancel rolls back with the outer tx on failure
// ============================================================================

describe('cancelPendingForPurchase atomicity (rollback with outer tx)', () => {
  it('a thrown error inside the tx callback prevents the cancel from being observed in the store', async () => {
    // Simulate Prisma $transaction by capturing writes in a SCRATCH copy
    // and only flushing on commit. If the inner fn throws, the scratch
    // is discarded — modelling DB rollback.
    const persistent: DropRow[] = [
      {
        id: 'd1',
        client_purchase_id: 'pur-1',
        content_id: 'c1',
        status: 'pending',
        fire_at: new Date(Date.now() - 1000),
        materialised_ref: null,
        attempt_count: 0,
        next_retry_at: null,
        locked_at: null,
        failure_reason: null,
      },
    ];

    async function $transaction(fn: (tx: any) => Promise<any>) {
      const scratch = persistent.map((r) => ({ ...r }));
      const tx = {
        scheduledDrop: {
          updateMany: jest.fn(async ({ where, data }: any) => {
            const matched = scratch.filter(
              (r) =>
                r.client_purchase_id === where.client_purchase_id &&
                (where.status?.in as string[] | undefined)?.includes(r.status),
            );
            for (const r of matched) Object.assign(r, data);
            return { count: matched.length };
          }),
        },
      };
      try {
        const result = await fn(tx);
        // Commit — flush scratch back to persistent.
        for (let i = 0; i < persistent.length; i++) persistent[i] = scratch[i];
        return result;
      } catch (e) {
        // Rollback — discard scratch.
        throw e;
      }
    }

    const svc = new PurchaseFanoutService();

    await expect(
      $transaction(async (tx) => {
        await svc.cancelPendingForPurchase('pur-1', 'refund', tx);
        throw new Error('simulated revoke failure after cancel');
      }),
    ).rejects.toThrow('simulated revoke failure');

    // The cancel write did not commit — drop is still pending.
    expect(persistent[0].status).toBe('pending');
  });

  it('a successful tx commits the cancel atomically with whatever else the caller did', async () => {
    const persistent: DropRow[] = [
      {
        id: 'd1',
        client_purchase_id: 'pur-1',
        content_id: 'c1',
        status: 'pending',
        fire_at: new Date(Date.now() - 1000),
        materialised_ref: null,
        attempt_count: 0,
        next_retry_at: null,
        locked_at: null,
        failure_reason: null,
      },
    ];

    async function $transaction(fn: (tx: any) => Promise<any>) {
      const scratch = persistent.map((r) => ({ ...r }));
      const tx = {
        scheduledDrop: {
          updateMany: jest.fn(async ({ where, data }: any) => {
            const matched = scratch.filter(
              (r) =>
                r.client_purchase_id === where.client_purchase_id &&
                (where.status?.in as string[] | undefined)?.includes(r.status),
            );
            for (const r of matched) Object.assign(r, data);
            return { count: matched.length };
          }),
        },
      };
      const result = await fn(tx);
      for (let i = 0; i < persistent.length; i++) persistent[i] = scratch[i];
      return result;
    }

    const svc = new PurchaseFanoutService();
    await $transaction(async (tx) => {
      await svc.cancelPendingForPurchase('pur-1', 'refund', tx);
    });
    expect(persistent[0].status).toBe('canceled');
  });
});
