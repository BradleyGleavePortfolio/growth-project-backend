import {
  DripDispatcherCron,
  __dripDispatcherConsts,
} from '../src/packages/drip-dispatcher.cron';

// PR-10 — DripDispatcherCron tests.
//
// Covers the verification matrix from the brief:
//   1. Due pending drop is claimed + materialised + delivered + alerted.
//   2. Future drop (fire_at > now) is NOT picked up this tick.
//   3. on_completion / on_milestone (fire_at = NULL) is NOT picked up.
//   4. Already-delivered drop (materialised_ref set) is NOT re-materialised.
//   5. Concurrency: two parallel dispatch passes over the same due drop
//      result in exactly ONE materialisation (atomic claim works).
//   6. Failure → attempts++ / backoff / status=pending; after MAX_ATTEMPTS
//      → status=failed + COACH_ALERT + structured log. Retried drop does
//      not double-fire.
//   7. Push failure does NOT mark the drop undelivered.
//   8. Batch limit respected.

type Row = Record<string, any>;

interface MockPrismaState {
  drops: Row[];
  purchases: Row[];
}

function makeMockPrisma(state: MockPrismaState) {
  const matches = (row: Row, where: Record<string, any>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'AND') {
        const arr = v as Array<Record<string, any>>;
        if (!arr.every((sub) => matches(row, sub))) return false;
        continue;
      }
      if (k === 'OR') {
        const arr = v as Array<Record<string, any>>;
        if (!arr.some((sub) => matches(row, sub))) return false;
        continue;
      }
      const cur = row[k];
      if (v === null) {
        if (cur != null) return false;
        continue;
      }
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const cond = v as Record<string, any>;
        if ('lte' in cond) {
          if (cur == null) return false;
          const a = cur instanceof Date ? cur.getTime() : cur;
          const b =
            cond.lte instanceof Date ? cond.lte.getTime() : cond.lte;
          if (a > b) return false;
        }
        if ('lt' in cond) {
          if (cur == null) return false;
          const a = cur instanceof Date ? cur.getTime() : cur;
          const b =
            cond.lt instanceof Date ? cond.lt.getTime() : cond.lt;
          if (a >= b) return false;
        }
        if ('gte' in cond) {
          if (cur == null) return false;
          const a = cur instanceof Date ? cur.getTime() : cur;
          const b =
            cond.gte instanceof Date ? cond.gte.getTime() : cond.gte;
          if (a < b) return false;
        }
        if ('not' in cond) {
          if (cur == null && cond.not == null) return false;
        }
        if ('in' in cond) {
          if (!(cond.in as any[]).includes(cur)) return false;
        }
        continue;
      }
      if (v !== cur) return false;
    }
    return true;
  };

  const applyData = (row: Row, data: Record<string, any>) => {
    for (const [k, v] of Object.entries(data)) {
      if (
        v &&
        typeof v === 'object' &&
        !(v instanceof Date) &&
        'increment' in (v as Record<string, any>)
      ) {
        row[k] = (row[k] ?? 0) + (v as { increment: number }).increment;
      } else {
        row[k] = v;
      }
    }
  };

  return {
    scheduledDrop: {
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let rows = state.drops.filter((d) => matches(d, where));
        if (orderBy?.fire_at === 'asc') {
          rows = [...rows].sort((a, b) => {
            const ta = a.fire_at ? a.fire_at.getTime() : Infinity;
            const tb = b.fire_at ? b.fire_at.getTime() : Infinity;
            return ta - tb;
          });
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = state.drops.find((d) => d.id === where.id);
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.drops) {
          if (matches(row, where)) {
            applyData(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.drops.find((d) => d.id === where.id);
        if (!row) throw new Error(`no drop ${where.id}`);
        applyData(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const row = state.purchases.find((p) => p.id === where.id);
        if (!row) return null;
        if (!select) return { ...row };
        const out: Row = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = row[k];
        }
        return out;
      }),
    },
  };
}

function makeDrop(over: Partial<Row> = {}): Row {
  return {
    id: 'drop-1',
    client_purchase_id: 'purchase-1',
    content_id: 'content-1',
    asset_type: 'meal_plan',
    asset_id: 'asset-1',
    asset_revision_id: null,
    cadence_kind: 'relative_to_purchase',
    cadence_payload: {},
    display_title: 'Week 1 Plan',
    display_caption: null,
    fire_at: new Date(2026, 0, 1, 12, 0, 0),
    fired_at: null,
    status: 'pending',
    attempt_count: 0,
    materialised_ref: null,
    failure_reason: null,
    locked_at: null,
    next_retry_at: null,
    alert_dispatched_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function makePurchase(over: Partial<Row> = {}): Row {
  return {
    id: 'purchase-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'package-1',
    ...over,
  };
}

function makeRegistry(materialise: jest.Mock) {
  return {
    materialise,
    resolve: jest.fn(),
    list: jest.fn(() => []),
  } as any;
}

function makeNotifications() {
  return {
    createNotification: jest.fn(async () => ({ id: 'n-1' })),
    pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
  } as any;
}

const NOW = new Date(2026, 0, 1, 13, 0, 0);

describe('DripDispatcherCron', () => {
  it('dispatches a due pending drop: materialises, stamps delivered, sends push+in-app alert', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'mp-assignment-99' });
    const registry = makeRegistry(materialise);
    const notifications = makeNotifications();
    const cron = new DripDispatcherCron(prisma as any, registry, notifications);

    const stats = await cron.runOnce(NOW);

    expect(stats).toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      failed_permanently: 0,
    });
    expect(materialise).toHaveBeenCalledTimes(1);
    const [assetType, input] = materialise.mock.calls[0];
    expect(assetType).toBe('meal_plan');
    expect(input.clientPurchaseId).toBe('purchase-1');
    expect(input.contentId).toBe('content-1');
    expect(input.scheduledDropId).toBe('drop-1');
    expect(input.clientId).toBe('client-1');
    expect(input.coachId).toBe('coach-1');
    expect(state.drops[0].materialised_ref).toBe('mp-assignment-99');
    expect(state.drops[0].status).toBe('delivered');
    expect(state.drops[0].fired_at).toEqual(NOW);
    expect(state.drops[0].attempt_count).toBe(1);
    expect(state.drops[0].alert_dispatched_at).toBeInstanceOf(Date);
    // 2 in-app + push notification calls happen via the same helper —
    // we expect both an in-app and a push channel write, plus pushToUser.
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    const channels = notifications.createNotification.mock.calls.map(
      (c: any[]) => c[0].channel,
    );
    expect(channels.sort()).toEqual(['inapp', 'push']);
  });

  it('does NOT dispatch a future drop (fire_at > now)', async () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    const state: MockPrismaState = {
      drops: [makeDrop({ fire_at: future })],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
    expect(state.drops[0].status).toBe('pending');
  });

  it('does NOT dispatch on_completion / on_milestone drops (fire_at NULL)', async () => {
    const state: MockPrismaState = {
      drops: [
        makeDrop({
          id: 'drop-trig-1',
          cadence_kind: 'on_completion',
          fire_at: null,
        }),
        makeDrop({
          id: 'drop-trig-2',
          content_id: 'content-2',
          cadence_kind: 'on_milestone',
          fire_at: null,
        }),
      ],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
  });

  it('does NOT re-materialise an already-delivered drop (materialised_ref set)', async () => {
    const state: MockPrismaState = {
      drops: [
        makeDrop({
          materialised_ref: 'already-shipped',
          status: 'delivered',
          fired_at: new Date(NOW.getTime() - 1000),
        }),
      ],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
    expect(state.drops[0].materialised_ref).toBe('already-shipped');
  });

  it('concurrency: two simultaneous dispatch passes produce exactly ONE materialisation', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'mp-once' });
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const [a, b] = await Promise.all([
      cron.runOnce(NOW),
      cron.runOnce(NOW),
    ]);

    // Exactly one of the two passes claimed; the other got 0.
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.delivered + b.delivered).toBe(1);
    expect(materialise).toHaveBeenCalledTimes(1);
    expect(state.drops[0].materialised_ref).toBe('mp-once');
  });

  it('failure: resolver throws → attempts++, next_retry_at set with backoff, status pending', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockRejectedValue(new Error('transient downstream blip'));
    const notifications = makeNotifications();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      notifications,
    );

    const stats = await cron.runOnce(NOW);

    expect(stats).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 1,
      failed_permanently: 0,
    });
    expect(state.drops[0].status).toBe('pending');
    expect(state.drops[0].attempt_count).toBe(1);
    expect(state.drops[0].materialised_ref).toBeNull();
    expect(state.drops[0].failure_reason).toContain('transient');
    expect(state.drops[0].next_retry_at).toBeInstanceOf(Date);
    expect(
      (state.drops[0].next_retry_at as Date).getTime() - NOW.getTime(),
    ).toBe(__dripDispatcherConsts.BACKOFF_MS[0]);
    // No COACH_ALERT yet (not permanent).
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('failure: after MAX_ATTEMPTS-1 prior failures, hitting MAX → status=failed + COACH_ALERT + log', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop({ attempt_count: __dripDispatcherConsts.MAX_ATTEMPTS - 1 })],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockRejectedValue(new Error('still broken'));
    const notifications = makeNotifications();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      notifications,
    );

    const stats = await cron.runOnce(NOW);

    expect(stats).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      failed_permanently: 1,
    });
    expect(state.drops[0].status).toBe('failed');
    expect(state.drops[0].attempt_count).toBe(
      __dripDispatcherConsts.MAX_ATTEMPTS,
    );
    // COACH_ALERT sent.
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    const call = notifications.createNotification.mock.calls[0][0];
    expect(call.kind).toBe('coach_alert');
    expect(call.user_id).toBe('coach-1');
    expect(call.payload.event).toBe('drip_drop_failed');
    expect(call.payload.client_purchase_id).toBe('purchase-1');
    expect(call.payload.content_id).toBe('content-1');
    expect(call.payload.attempts).toBe(__dripDispatcherConsts.MAX_ATTEMPTS);
  });

  it('drop with attempt_count >= MAX_ATTEMPTS is NOT picked up (no infinite retry)', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop({ attempt_count: __dripDispatcherConsts.MAX_ATTEMPTS })],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
  });

  it('retry idempotency: a retried drop reuses the SAME stable (clientPurchaseId, contentId) keys', async () => {
    // Same drop fails first attempt, then succeeds on the retry. The
    // brief invariant: the resolver MUST see the same stable
    // (clientPurchaseId, contentId) on both attempts so the resolver's
    // own per-type idempotency ledger (workout: WorkoutBuilderIdempotencyKey
    // with drip:workout:p={purchaseId}:c={contentId}; auto_message:
    // DripResolverMarker(purpose, purchase_id, content_id)) collapses the
    // retry onto the cached row and never double-fires.
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ materialisedRef: 'mp-final' });
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    await cron.runOnce(NOW);
    // Simulate the backoff timer expiring on the next tick.
    state.drops[0].next_retry_at = new Date(NOW.getTime() - 1);
    await cron.runOnce(new Date(NOW.getTime() + 2 * 60 * 1000));

    expect(materialise).toHaveBeenCalledTimes(2);
    const firstKey = materialise.mock.calls[0][1];
    const secondKey = materialise.mock.calls[1][1];
    expect(firstKey.clientPurchaseId).toBe(secondKey.clientPurchaseId);
    expect(firstKey.contentId).toBe(secondKey.contentId);
    expect(state.drops[0].materialised_ref).toBe('mp-final');
    expect(state.drops[0].status).toBe('delivered');
  });

  it('push failure does NOT mark the drop undelivered', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'mp-ok' });
    const notifications = {
      createNotification: jest
        .fn()
        .mockRejectedValue(new Error('expo blew up')),
      pushToUser: jest.fn().mockRejectedValue(new Error('expo blew up')),
    } as any;
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      notifications,
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.delivered).toBe(1);
    expect(state.drops[0].status).toBe('delivered');
    expect(state.drops[0].materialised_ref).toBe('mp-ok');
    // alert_dispatched_at still stamped (we tried).
    expect(state.drops[0].alert_dispatched_at).toBeInstanceOf(Date);
  });

  it('batch limit: never claims more than TICK_BATCH_SIZE in one tick', async () => {
    const N = __dripDispatcherConsts.TICK_BATCH_SIZE + 25;
    const drops = Array.from({ length: N }, (_, i) =>
      makeDrop({
        id: `drop-${i}`,
        content_id: `content-${i}`,
      }),
    );
    const state: MockPrismaState = {
      drops,
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'x' });
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(__dripDispatcherConsts.TICK_BATCH_SIZE);
    expect(materialise).toHaveBeenCalledTimes(
      __dripDispatcherConsts.TICK_BATCH_SIZE,
    );
  });

  it('cron tick wrapper: env-gated (NODE_ENV=test → no-op)', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );
    // jest.setup.ts already pins NODE_ENV='test', so the cron tick must
    // short-circuit without calling the registry.
    await cron.tick();
    expect(materialise).not.toHaveBeenCalled();
  });

  it('backoff schedule increases monotonically and clamps at the last entry', () => {
    const schedule = __dripDispatcherConsts.BACKOFF_MS;
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]).toBeGreaterThan(schedule[i - 1]);
    }
    expect(schedule[0]).toBe(60_000); // 1 min
    expect(schedule[schedule.length - 1]).toBe(6 * 60 * 60 * 1000); // 6 hours
    expect(__dripDispatcherConsts.MAX_ATTEMPTS).toBe(5);
  });

  it('canceled / failed / delivered drops are NOT picked up', async () => {
    const state: MockPrismaState = {
      drops: [
        makeDrop({ id: 'd-canceled', status: 'canceled' }),
        makeDrop({ id: 'd-failed', content_id: 'c-2', status: 'failed' }),
        makeDrop({
          id: 'd-delivered',
          content_id: 'c-3',
          status: 'delivered',
          materialised_ref: 'r',
        }),
      ],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
  });

  it('drop blocked by future next_retry_at is NOT picked up (backoff respected)', async () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const state: MockPrismaState = {
      drops: [makeDrop({ next_retry_at: future, attempt_count: 1 })],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(materialise).not.toHaveBeenCalled();
  });

  it('stale lock recovery: a drop locked > STALE_CLAIM_MS ago IS reclaimable', async () => {
    const staleLockedAt = new Date(
      NOW.getTime() - __dripDispatcherConsts.STALE_CLAIM_MS - 1000,
    );
    const state: MockPrismaState = {
      drops: [makeDrop({ locked_at: staleLockedAt, status: 'pending' })],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'mp-stale-recover' });
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats.delivered).toBe(1);
    expect(state.drops[0].status).toBe('delivered');
  });

  it('missing registry → no-op + structured log (defensive)', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    // No registry passed.
    const cron = new DripDispatcherCron(prisma as any);

    const stats = await cron.runOnce(NOW);

    expect(stats.claimed).toBe(0);
    expect(stats.delivered).toBe(0);
    expect(state.drops[0].status).toBe('pending');
  });

  it('order: due drops processed by fire_at ASC (oldest first)', async () => {
    const old = new Date(NOW.getTime() - 60 * 60 * 1000);
    const newer = new Date(NOW.getTime() - 30 * 60 * 1000);
    const state: MockPrismaState = {
      drops: [
        makeDrop({ id: 'd-new', content_id: 'c-new', fire_at: newer }),
        makeDrop({ id: 'd-old', content_id: 'c-old', fire_at: old }),
      ],
      purchases: [makePurchase()],
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest
      .fn()
      .mockResolvedValue({ materialisedRef: 'x' });
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    await cron.runOnce(NOW);

    expect(materialise.mock.calls[0][1].scheduledDropId).toBe('d-old');
    expect(materialise.mock.calls[1][1].scheduledDropId).toBe('d-new');
  });

  it('parent ClientPurchase missing → drop canceled defensively, never re-tried', async () => {
    const state: MockPrismaState = {
      drops: [makeDrop()],
      purchases: [], // purchase row missing
    };
    const prisma = makeMockPrisma(state);
    const materialise = jest.fn();
    const cron = new DripDispatcherCron(
      prisma as any,
      makeRegistry(materialise),
      makeNotifications(),
    );

    const stats = await cron.runOnce(NOW);

    expect(stats).toEqual({
      claimed: 1,
      delivered: 0,
      retried: 0,
      failed_permanently: 0,
    });
    expect(state.drops[0].status).toBe('canceled');
    expect(materialise).not.toHaveBeenCalled();
  });
});
