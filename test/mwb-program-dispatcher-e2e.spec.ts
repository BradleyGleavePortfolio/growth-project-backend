/**
 * S-MWB-3 (C-640-15, B-640-12, C-640-14): a deferred package program drop
 * travels the whole dispatcher path with the REAL resolver registry and the
 * REAL WorkoutAssetResolver, and the buyer's package list keeps showing it.
 *
 *   1. DripDispatcherCron.runOnce claims the pending program drop, the
 *      workout resolver calls ProgramDeliveryService.deliver (its own
 *      transaction, never deliverInTx), the drop is stamped delivered with the
 *      first assignment as materialised_ref, and the buyer alert fires once.
 *      A second tick does nothing.
 *   2. CheckoutService.listDropsForBuyer still lists that drop, as 'fired',
 *      with its materialised_ref (it used to vanish: B-640-12).
 *   3. Fair share: one push of hundreds of program drops does not hold every
 *      other coach's due drops for many ticks (C-640-14).
 */
import {
  DripDispatcherCron,
  fairDueBatch,
  __dripDispatcherConsts,
} from '../src/packages/drip-dispatcher.cron';
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { CheckoutService } from '../src/checkout/checkout.service';
import type { ScheduledDrop } from '@prisma/client';

function fake<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-05T13:00:00Z');

function drop(over: Row = {}): Row {
  return {
    id: 'drop-1',
    client_purchase_id: 'purchase-1',
    content_id: 'content-prog',
    push_seq: 0,
    asset_type: 'workout_program',
    asset_id: 'master-1',
    asset_revision_id: null,
    cadence_kind: 'immediate',
    cadence_payload: {},
    display_title: 'Strength foundations',
    display_caption: null,
    fire_at: new Date('2026-10-05T12:59:00Z'),
    fired_at: null,
    status: 'pending',
    attempt_count: 0,
    materialised_ref: null,
    failure_reason: null,
    locked_at: null,
    next_retry_at: null,
    alert_dispatched_at: null,
    created_at: new Date('2026-10-05T12:59:00Z'),
    updated_at: new Date('2026-10-05T12:59:00Z'),
    ...over,
  };
}

/** Minimal Prisma filter evaluator for the shapes the dispatcher and checkout use. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as Record<string, unknown>[]).every((sub) => matches(row, sub))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(v as Record<string, unknown>[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    const cur = row[k];
    if (v === null) {
      if (cur != null) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Record<string, unknown>;
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('lte' in cond && (cur == null || num(cur) > num(cond.lte))) return false;
      if ('lt' in cond && (cur == null || num(cur) >= num(cond.lt))) return false;
      if ('not' in cond && cond.not === null && cur == null) return false;
      if ('in' in cond && !(cond.in as unknown[]).includes(cur)) return false;
      if ('notIn' in cond && (cond.notIn as unknown[]).includes(cur)) return false;
      continue;
    }
    if (v !== cur) return false;
  }
  return true;
}

function apply(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) {
      row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
}

function makePrisma(drops: Row[]) {
  const purchases = [
    { id: 'purchase-1', client_user_id: 'client-1', coach_user_id: 'coach-1', package_id: 'pkg-1' },
  ];
  return {
    scheduledDrop: {
      findMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          orderBy?: { fire_at?: string };
          take?: number;
          select?: Record<string, boolean>;
        }) => {
          let rows = drops.filter((d) => matches(d, args.where));
          if (args.orderBy?.fire_at === 'asc') {
            rows = [...rows].sort(
              (a, b) => (a.fire_at as Date).getTime() - (b.fire_at as Date).getTime(),
            );
          }
          if (args.take) rows = rows.slice(0, args.take);
          return rows.map((r) => ({ ...r }));
        },
      ),
      updateMany: jest.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of drops) {
            if (matches(r, args.where)) {
              apply(r, args.data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        const r = drops.find((d) => d.id === args.where.id);
        return r ? { ...r } : null;
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        return purchases.find((p) => p.id === args.where.id) ?? null;
      }),
      findFirst: jest.fn(async (args: { where: { id: string; client_user_id: string } }) => {
        return (
          purchases.find(
            (p) => p.id === args.where.id && p.client_user_id === args.where.client_user_id,
          ) ?? null
        );
      }),
    },
  };
}

function harness(drops: Row[]) {
  const prisma = makePrisma(drops);
  const programDelivery = {
    isProgramMaster: jest.fn(async () => true),
    findDeliverableMaster: jest.fn(async () => ({ id: 'master-1', name: 'Strength foundations' })),
    deliverInTx: jest.fn(),
    deliver: jest.fn(async () => ({
      program_id: 'copy-1',
      assignment_ids: ['asg-1', 'asg-2'],
      first_assignment_id: 'asg-1',
      first_plan_id: 'plan-1',
      first_scheduled_for: '2026-10-05T13:00:00.000Z',
      last_scheduled_for: '2026-11-02T13:00:00.000Z',
      replayed: false,
    })),
  };
  const scope = new ResolverSubCoachScope(
    fake({
      canAccessClient: jest.fn(async () => true),
      getHeadCoachIdForSubCoach: jest.fn(async () => null),
    }),
  );
  const resolver = new WorkoutAssetResolver(
    fake({ assignPlan: jest.fn() }),
    scope,
    fake(programDelivery),
  );
  const registry = new AssignableAssetResolverRegistry([resolver]);
  const notifications = {
    createNotification: jest.fn(async () => ({ id: 'n-1' })),
    pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
  };
  const cron = new DripDispatcherCron(fake(prisma), registry, fake(notifications));
  const checkout = new CheckoutService(
    fake(prisma),
    fake({}),
    fake({}),
    fake({ ready: true }),
    fake({}),
    fake({ evaluate: async () => ({ ok: true, reason: 'contracts_disabled' }) }),
  );
  return { prisma, programDelivery, notifications, cron, checkout };
}

describe('S-MWB-3 C-640-15: deferred program drop through the real dispatcher path', () => {
  it('delivers once in its own transaction, stamps the drop, alerts the buyer once, and stays on the buyer list (B-640-12)', async () => {
    const drops = [drop()];
    const { programDelivery, notifications, cron, checkout } = harness(drops);

    const stats = await cron.runOnce(NOW);
    expect(stats).toMatchObject({ claimed: 1, delivered: 1, retried: 0, failed_permanently: 0 });
    expect(programDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(programDelivery.deliverInTx).not.toHaveBeenCalled();
    expect(programDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        masterProgramId: 'master-1',
        clientId: 'client-1',
        deliveryKey: 'pkg:p=purchase-1:c=content-prog',
        source: 'package',
      }),
    );
    expect(drops[0]).toMatchObject({
      status: 'delivered',
      materialised_ref: 'asg-1',
      fired_at: NOW,
      locked_at: null,
    });
    expect(drops[0].alert_dispatched_at).toBeInstanceOf(Date);
    // One alert: one push, plus its in-app row and its push-channel row.
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);

    // A second tick finds nothing to do: no second copy, no second alert.
    const again = await cron.runOnce(new Date(NOW.getTime() + 60_000));
    expect(again.claimed).toBe(0);
    expect(programDelivery.deliver).toHaveBeenCalledTimes(1);
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);

    // The buyer's package list still shows the program, opened at day 1.
    const { drops: listed } = await checkout.listDropsForBuyer('client-1', 'purchase-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'drop-1',
      asset_type: 'workout_program',
      status: 'fired',
      materialised_ref: 'asg-1',
    });
  });
});

describe('S-MWB-3 C-640-14: one big push shares the tick with other content', () => {
  const { TICK_BATCH_SIZE, PER_CONTENT_TICK_SHARE } = __dripDispatcherConsts;

  it("a 600-drop program push leaves room for another coach's due drop in the same tick", async () => {
    const drops: Row[] = [];
    for (let i = 0; i < 600; i += 1) {
      drops.push(
        drop({
          id: `big-${i}`,
          content_id: 'content-big',
          fire_at: new Date(NOW.getTime() - 10 * 60_000 + i),
        }),
      );
    }
    // Another coach's drop, due AFTER the whole push was queued.
    drops.push(
      drop({
        id: 'other-1',
        content_id: 'content-other',
        client_purchase_id: 'purchase-1',
        asset_type: 'meal_plan',
        fire_at: new Date(NOW.getTime() - 60_000),
      }),
    );
    const { cron, prisma } = harness(drops);
    const findDue = Reflect.get(cron, 'findDue') as (now: Date) => Promise<ScheduledDrop[]>;
    const batch = await findDue.call(cron, NOW);
    expect(batch.length).toBeLessThanOrEqual(TICK_BATCH_SIZE);
    expect(batch.map((d) => d.id)).toContain('other-1');
    // With other content waiting, the big push still gets the spare capacity.
    expect(batch.filter((d) => d.content_id === 'content-big').length).toBe(TICK_BATCH_SIZE - 1);
    expect(prisma.scheduledDrop.findMany).toHaveBeenCalledTimes(2);
    // FIFO order is kept inside the batch.
    const times = batch.map((d) => (d.fire_at as Date).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    void PER_CONTENT_TICK_SHARE;
  });

  it('fairDueBatch caps each heavy content at its share while others wait', () => {
    const mk = (id: string, content: string, t: number) =>
      fake<ScheduledDrop>({ id, content_id: content, fire_at: new Date(t) });
    const oldest: ScheduledDrop[] = [];
    for (let i = 0; i < TICK_BATCH_SIZE; i += 1) oldest.push(mk(`a-${i}`, 'A', i));
    const others: ScheduledDrop[] = [];
    for (let i = 0; i < TICK_BATCH_SIZE; i += 1) others.push(mk(`b-${i}`, 'B', 10_000 + i));
    const batch = fairDueBatch(oldest, others, new Set(['A']));
    expect(batch).toHaveLength(TICK_BATCH_SIZE);
    expect(batch.filter((d) => d.content_id === 'A')).toHaveLength(PER_CONTENT_TICK_SHARE);
    expect(batch.filter((d) => d.content_id === 'B')).toHaveLength(
      TICK_BATCH_SIZE - PER_CONTENT_TICK_SHARE,
    );
  });

  it('a tick with fewer due drops than the batch size reads once and takes them all', async () => {
    const drops = [drop({ id: 'x-1' }), drop({ id: 'x-2', client_purchase_id: 'purchase-1' })];
    const { cron, prisma } = harness(drops);
    const findDue = Reflect.get(cron, 'findDue') as (now: Date) => Promise<ScheduledDrop[]>;
    const batch = await findDue.call(cron, NOW);
    expect(batch.map((d) => d.id).sort()).toEqual(['x-1', 'x-2']);
    expect(prisma.scheduledDrop.findMany).toHaveBeenCalledTimes(1);
  });
});
