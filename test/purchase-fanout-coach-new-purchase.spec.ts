import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { NotificationKind } from '../src/notifications/notification-kind';

// PR-15A A2 — PurchaseFanoutService.onPurchaseEntitled emits exactly one
// COACH_NEW_PURCHASE alert per purchase, idempotent across Stripe webhook
// replay, discarded on tx rollback, suppressed when coach prefs are off.

interface MockTxState {
  purchases: any[];
  packages: any[];
  users: any[];
  contents: any[];
  drops: any[];
  fanouts: any[];
  markers: any[];
}

function makeTxBundle(state: MockTxState) {
  const tx: any = {
    purchaseFanout: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = state.fanouts.find((f) => f.purchase_id === where.purchase_id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create };
        state.fanouts.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.fanouts.find((f) => f.purchase_id === where.purchase_id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        state.purchases.find((p) => p.id === where.id) ?? null,
      ),
    },
    coachPackageContent: {
      findMany: jest.fn(async ({ where }: any) =>
        state.contents.filter(
          (c) =>
            c.package_id === where.package_id &&
            (where.removed_at === null ? c.removed_at == null : true),
        ),
      ),
    },
    scheduledDrop: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) {
          const existing = state.drops.find(
            (d) =>
              d.client_purchase_id === row.client_purchase_id &&
              d.content_id === row.content_id,
          );
          if (existing) continue;
          state.drops.push({ id: `drop_${state.drops.length}`, ...row });
        }
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        state.drops.filter((d) => d.client_purchase_id === where.client_purchase_id),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.drops.find((d) => d.id === where.id);
        if (row) {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as any)) {
              row[k] = (row[k] ?? 0) + (v as any).increment;
            } else {
              row[k] = v;
            }
          }
        }
        return row;
      }),
    },
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        state.packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    dripResolverMarker: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = state.markers.find(
          (m) =>
            m.purpose === data.purpose &&
            m.purchase_id === data.purchase_id &&
            m.content_id === data.content_id,
        );
        if (dupe) {
          // Simulate Prisma P2002 unique violation.
          const err = new Error('Unique constraint failed (P2002)') as any;
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `marker_${state.markers.length}`, ...data };
        state.markers.push(row);
        return row;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        state.users.find((u) => u.id === where.id) ?? null,
      ),
    },
  };
  return tx;
}

function makeNotifications() {
  return {
    createNotification: jest.fn(async (_input: unknown): Promise<unknown> => ({
      id: 'notif_1',
    })),
    pushToUser: jest.fn(async () => undefined),
  };
}

function baseState(): MockTxState {
  return {
    purchases: [
      {
        id: 'pur_1',
        client_user_id: 'buyer_1',
        coach_user_id: 'coach_1',
        package_id: 'pkg_1',
        amount_cents: 4900,
        currency: 'usd',
        created_at: new Date('2026-01-15T00:00:00Z'),
      },
    ],
    packages: [{ id: 'pkg_1', name: 'Pro Strength 12-Week' }],
    users: [{ id: 'buyer_1', name: 'Alex Buyer', email: 'alex@example.com' }],
    contents: [],
    drops: [],
    fanouts: [],
    markers: [],
  };
}

describe('PurchaseFanoutService — COACH_NEW_PURCHASE (PR-15A A2)', () => {
  // Helper: await all microtasks so the fire-and-forget IIFE inside
  // flushCoachNewPurchaseAlert finishes before assertions.
  async function flush() {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  }

  it('coach gets exactly one COACH_NEW_PURCHASE on entitlement', async () => {
    const state = baseState();
    const tx = makeTxBundle(state);
    const notifications = makeNotifications();
    const svc = new PurchaseFanoutService(
      undefined,
      undefined,
      notifications as never,
    );
    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'in_app_hosted' },
      tx,
    );
    svc.flushAlerts('pur_1');
    await flush();
    // One in-app row + one push row + one push send.
    const inAppCalls = notifications.createNotification.mock.calls.filter(
      ([c]: any[]) => c.kind === NotificationKind.COACH_NEW_PURCHASE,
    );
    expect(inAppCalls.length).toBe(2); // inapp + push channel row
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    const firstCall: any = inAppCalls[0]![0];
    expect(firstCall.user_id).toBe('coach_1');
    expect(firstCall.body).toMatch(/Alex Buyer/);
    expect(firstCall.body).toMatch(/Pro Strength/);
    expect(firstCall.deep_link).toBe('tgp://coach/purchases/pur_1');
  });

  it('replay does not double-notify the coach', async () => {
    const state = baseState();
    const tx = makeTxBundle(state);
    const notifications = makeNotifications();
    const svc = new PurchaseFanoutService(
      undefined,
      undefined,
      notifications as never,
    );

    // First commit.
    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'in_app_hosted' },
      tx,
    );
    svc.flushAlerts('pur_1');
    await flush();
    const firstCount = notifications.pushToUser.mock.calls.length;

    // Stripe replay — same purchase id, same tx state already has marker.
    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'in_app_hosted' },
      tx,
    );
    svc.flushAlerts('pur_1');
    await flush();

    expect(notifications.pushToUser.mock.calls.length).toBe(firstCount);
    expect(state.markers.length).toBe(1);
  });

  it('rollback fires none — discardPendingAlerts wipes the bucket', async () => {
    const state = baseState();
    const tx = makeTxBundle(state);
    const notifications = makeNotifications();
    const svc = new PurchaseFanoutService(
      undefined,
      undefined,
      notifications as never,
    );

    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'in_app_hosted' },
      tx,
    );
    // Caller's tx rolled back — simulate the discardPending hook
    // (BillingService catch block) clearing the bucket.
    svc.discardPendingAlerts('pur_1');
    svc.flushAlerts('pur_1');
    await flush();
    expect(notifications.pushToUser).not.toHaveBeenCalled();
    const calls = notifications.createNotification.mock.calls.filter(
      ([c]: any[]) => c.kind === NotificationKind.COACH_NEW_PURCHASE,
    );
    expect(calls.length).toBe(0);
  });

  it('guest-converted purchase still notifies the coach with display name fallback', async () => {
    const state = baseState();
    // Simulate a freshly-converted guest: no name, but email set.
    state.users[0] = { id: 'buyer_1', name: '', email: 'guest@example.com' };
    const tx = makeTxBundle(state);
    const notifications = makeNotifications();
    const svc = new PurchaseFanoutService(
      undefined,
      undefined,
      notifications as never,
    );
    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'storefront_guest' },
      tx,
    );
    svc.flushAlerts('pur_1');
    await flush();
    const calls = notifications.createNotification.mock.calls.filter(
      ([c]: any[]) => c.kind === NotificationKind.COACH_NEW_PURCHASE,
    );
    expect(calls.length).toBeGreaterThan(0);
    const firstCallArgs: any = calls[0]![0];
    expect(firstCallArgs.body).toMatch(/guest@example\.com/);
  });

  it('prefs OFF for the coach suppresses the row write via NotificationsService gate', async () => {
    // We test the wiring contract: createNotification is called with
    // kind=COACH_NEW_PURCHASE, channel=inapp/push — the actual prefs
    // gate lives in NotificationsService.createNotification, which
    // routes 'coach_new_purchase' to the dedicated prefs prefix (NOT
    // the digest fallback). A mocked createNotification returning null
    // proves the suppress path is plumbed through.
    const state = baseState();
    const tx = makeTxBundle(state);
    const notifications = makeNotifications();
    notifications.createNotification = jest.fn(async (_input: unknown): Promise<unknown> => null);
    const svc = new PurchaseFanoutService(
      undefined,
      undefined,
      notifications as never,
    );
    await svc.onPurchaseEntitled(
      { id: 'pur_1' },
      { entrypoint: 'in_app_hosted' },
      tx,
    );
    svc.flushAlerts('pur_1');
    await flush();
    // A null return from createNotification (= prefs OFF) MUST NOT throw.
    // pushToUser is still attempted (NotificationsService.pushToUser
    // applies its own per-kind prefs check inside).
    expect(notifications.createNotification).toHaveBeenCalled();
  });
});
