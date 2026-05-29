import { DripTriggerService } from '../src/packages/drip-trigger.service';
import { MilestoneService } from '../src/packages/milestone.service';

// PR-11 — DripTriggerService + MilestoneService tests.
//
// Verification matrix from the brief:
//   1. Buyer completes triggering asset -> matching on_completion
//      pending-trigger drop gets fire_at=now (flipped).
//   2. Explicit depends_on_content_id fires on THAT content's
//      completion.
//   3. Omitted depends_on fires per documented default: the
//      immediately-prior content in display_order.
//   4. Milestone emit -> matching on_milestone drop fires;
//      non-matching milestone_key is a no-op.
//   5. Double completion / double emit -> drop only flipped once
//      (idempotent: fire_at IS NULL re-asserted in WHERE).
//   6. Completion with no waiting drop -> no-op, no error.
//   7. Buyer A's completion does NOT flip buyer B's drops.
//   8. Drops that are already delivered (materialised_ref set) or
//      already fire_at-set are not re-flipped.

type Row = Record<string, any>;

interface MockState {
  drops: Row[];
  purchases: Row[];
  contents: Row[]; // CoachPackageContent rows; field `package_id` optional in tests
}

function clone<T>(v: T): T {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function matchesScalar(cur: any, cond: any): boolean {
  if (cond === null) return cur == null;
  if (cond instanceof Date) return cur instanceof Date && cur.getTime() === cond.getTime();
  if (typeof cond === 'object') {
    if ('gte' in cond) {
      if (cur == null) return false;
      const a = cur instanceof Date ? cur.getTime() : cur;
      const b = cond.gte instanceof Date ? cond.gte.getTime() : cond.gte;
      if (a < b) return false;
    }
    if ('lt' in cond) {
      if (cur == null) return false;
      const a = cur instanceof Date ? cur.getTime() : cur;
      const b = cond.lt instanceof Date ? cond.lt.getTime() : cond.lt;
      if (a >= b) return false;
    }
    if ('gt' in cond) {
      if (cur == null) return false;
      const a = cur instanceof Date ? cur.getTime() : cur;
      const b = cond.gt instanceof Date ? cond.gt.getTime() : cond.gt;
      if (a <= b) return false;
    }
    if ('in' in cond) {
      if (!(cond.in as any[]).includes(cur)) return false;
    }
    return true;
  }
  return cur === cond;
}

function matches(row: Row, where: Record<string, any>, state: MockState): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as any[]).every((sub) => matches(row, sub, state))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(v as any[]).some((sub) => matches(row, sub, state))) return false;
      continue;
    }
    if (k === 'client_purchase') {
      // join lookup
      const p = state.purchases.find((pp) => pp.id === row.client_purchase_id);
      if (!p) return false;
      if (!matches(p, v as Record<string, any>, state)) return false;
      continue;
    }
    if (!matchesScalar(row[k], v)) return false;
  }
  return true;
}

function project<T extends Row>(row: T, select?: Record<string, boolean>): T {
  if (!select) return clone(row);
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) {
    if (on) out[k] = clone(row[k]);
  }
  return out as T;
}

function makeMockPrisma(state: MockState) {
  // Auto-attach a default package_id to contents that don't specify one
  // (tests can leave package_id off and rely on the single-package default).
  for (const c of state.contents) {
    if (!('package_id' in c)) c.package_id = c.package_id ?? 'pkg-default';
  }
  for (const p of state.purchases) {
    if (!('package_id' in p)) p.package_id = 'pkg-default';
  }
  return {
    scheduledDrop: {
      findMany: jest.fn(async ({ where, select }: any = {}) => {
        return state.drops
          .filter((r) => (where ? matches(r, where, state) : true))
          .map((r) => project(r, select));
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return clone(state.drops.find((r) => r.id === where.id)) ?? null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of state.drops) {
          if (matches(r, where, state)) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    coachPackageContent: {
      findMany: jest.fn(async ({ where, select }: any = {}) => {
        return state.contents
          .filter((r) => (where ? matches(r, where, state) : true))
          .map((r) => project(r, select));
      }),
      findFirst: jest.fn(async ({ where, select }: any = {}) => {
        const hit = state.contents.find((r) =>
          where ? matches(r, where, state) : true,
        );
        return hit ? project(hit, select) : null;
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const p = state.purchases.find((pp) => pp.id === where.id);
        return p ? project(p, select) : null;
      }),
    },
  } as any;
}

function makeDrop(overrides: Partial<Row> = {}): Row {
  return {
    id: 'drop-' + Math.random().toString(36).slice(2, 8),
    client_purchase_id: 'p-A',
    content_id: 'c-2',
    asset_type: 'workout_plan',
    asset_id: 'plan-X',
    cadence_kind: 'on_completion',
    cadence_payload: { depends_on_content_id: 'c-1' },
    fire_at: null,
    status: 'pending',
    materialised_ref: null,
    created_at: new Date('2026-05-29T00:00:00Z'),
    ...overrides,
  };
}

describe('DripTriggerService.onContentCompleted', () => {
  // ── 1. Happy path: explicit depends_on_content_id matches completion ──
  it('flips a matching on_completion drop when buyer completes the depended-on content', async () => {
    const state: MockState = {
      drops: [
        // Drop snapshot for the COMPLETED content (c-1, plan-A)
        makeDrop({ id: 'd-prev', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {}, materialised_ref: 'wb-1', status: 'delivered' }),
        // Pending-trigger drop waiting on completion of c-1
        makeDrop({ id: 'd-next', content_id: 'c-2', asset_id: 'plan-B', cadence_payload: { depends_on_content_id: 'c-1' } }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(1);
    expect(result.flippedDropIds).toEqual(['d-next']);
    const nextDrop = state.drops.find((d) => d.id === 'd-next')!;
    expect(nextDrop.fire_at).toBeInstanceOf(Date);
    expect(nextDrop.status).toBe('pending'); // unchanged
  });

  // ── 2. Explicit depends_on_content_id only matches that content_id ──
  it('does NOT flip a drop whose depends_on_content_id points elsewhere', async () => {
    const state: MockState = {
      drops: [
        makeDrop({ id: 'd-prev', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-target', content_id: 'c-2', cadence_payload: { depends_on_content_id: 'c-OTHER' } }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(0);
    expect(state.drops.find((d) => d.id === 'd-target')!.fire_at).toBeNull();
  });

  // ── 3. Documented default: omitted depends_on -> immediately-prior content ──
  it('with no depends_on, fires when the immediately-prior content (by display_order) is completed', async () => {
    const state: MockState = {
      drops: [
        // Completed (c-1, display_order=0)
        makeDrop({ id: 'd-prev', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        // Trigger drop has NO depends_on; should fire because c-1 is the prior one
        makeDrop({ id: 'd-target', content_id: 'c-2', cadence_payload: {} }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(1);
    expect(result.flippedDropIds).toEqual(['d-target']);
  });

  // ── 3b. Default rule: completing content #1 should NOT fire #3's drop ──
  it('with no depends_on, completion of N-2 content does NOT fire N content (only immediately-prior fires)', async () => {
    const state: MockState = {
      drops: [
        makeDrop({ id: 'd-c1', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-c2', content_id: 'c-2', asset_id: 'plan-B', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-c3', content_id: 'c-3', cadence_payload: {} }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
        { id: 'c-3', display_order: 2 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(0);
    expect(state.drops.find((d) => d.id === 'd-c3')!.fire_at).toBeNull();
  });

  // ── 5. Idempotent double completion ──
  it('double completion -> drop flipped exactly once (fire_at NULL re-asserted)', async () => {
    const state: MockState = {
      drops: [
        makeDrop({ id: 'd-prev', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-target', content_id: 'c-2', cadence_payload: { depends_on_content_id: 'c-1' } }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const r1 = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    const fireAtAfterFirst = state.drops.find((d) => d.id === 'd-target')!.fire_at;
    const r2 = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(r1.flipped).toBe(1);
    // Second emit: drop is no longer fire_at IS NULL, so the WHERE
    // filter excludes it. flipped should be 0.
    expect(r2.flipped).toBe(0);
    // fire_at unchanged from the first flip.
    expect(state.drops.find((d) => d.id === 'd-target')!.fire_at).toEqual(fireAtAfterFirst);
  });

  // ── 6. No-op when no waiting drop ──
  it('completion with no waiting drop -> no-op, no error', async () => {
    const state: MockState = {
      drops: [],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(0);
  });

  // ── 7. Buyer scope: A's completion must not fire B's drops ──
  it("buyer A's completion does NOT fire buyer B's drops", async () => {
    const state: MockState = {
      drops: [
        // Both purchases snapshot the SAME (asset_type, asset_id) — c-1 / plan-A
        makeDrop({ id: 'd-A-prev', client_purchase_id: 'p-A', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-A-next', client_purchase_id: 'p-A', content_id: 'c-2', cadence_payload: { depends_on_content_id: 'c-1' } }),
        makeDrop({ id: 'd-B-prev', client_purchase_id: 'p-B', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        makeDrop({ id: 'd-B-next', client_purchase_id: 'p-B', content_id: 'c-2', cadence_payload: { depends_on_content_id: 'c-1' } }),
      ],
      purchases: [
        { id: 'p-A', client_user_id: 'buyer-A' },
        { id: 'p-B', client_user_id: 'buyer-B' },
      ],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(1);
    expect(result.flippedDropIds).toEqual(['d-A-next']);
    expect(state.drops.find((d) => d.id === 'd-B-next')!.fire_at).toBeNull();
  });

  // ── 8. Delivered drop is not re-flipped ──
  it('drop with materialised_ref set is not re-flipped', async () => {
    const state: MockState = {
      drops: [
        makeDrop({ id: 'd-prev', content_id: 'c-1', asset_id: 'plan-A', cadence_kind: 'immediate', cadence_payload: {} }),
        // Already-delivered trigger drop (materialised_ref set)
        makeDrop({ id: 'd-done', content_id: 'c-2', cadence_payload: { depends_on_content_id: 'c-1' }, status: 'delivered', materialised_ref: 'wb-9', fire_at: new Date('2026-05-25T00:00:00Z') }),
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [
        { id: 'c-1', display_order: 0 },
        { id: 'c-2', display_order: 1 },
      ],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(0);
    // Untouched
    expect(state.drops.find((d) => d.id === 'd-done')!.materialised_ref).toBe('wb-9');
  });
});

describe('DripTriggerService.onMilestone', () => {
  // ── 4. Matching milestone -> fires ──
  it('milestone emit fires matching on_milestone drop', async () => {
    const state: MockState = {
      drops: [
        {
          id: 'd-1',
          client_purchase_id: 'p-A',
          content_id: 'c-1',
          asset_type: 'auto_message',
          asset_id: 'am-1',
          cadence_kind: 'on_milestone',
          cadence_payload: { milestone_key: 'build_week_complete' },
          fire_at: null,
          status: 'pending',
          materialised_ref: null,
          created_at: new Date(),
        },
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onMilestone({
      buyerUserId: 'buyer-A',
      milestoneKey: 'build_week_complete',
    });
    expect(result.flipped).toBe(1);
    expect(state.drops[0].fire_at).toBeInstanceOf(Date);
  });

  // ── 4b. Non-matching milestone_key is a no-op ──
  it('non-matching milestone_key is a no-op', async () => {
    const state: MockState = {
      drops: [
        {
          id: 'd-1',
          client_purchase_id: 'p-A',
          content_id: 'c-1',
          asset_type: 'auto_message',
          asset_id: 'am-1',
          cadence_kind: 'on_milestone',
          cadence_payload: { milestone_key: 'build_week_complete' },
          fire_at: null,
          status: 'pending',
          materialised_ref: null,
          created_at: new Date(),
        },
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onMilestone({
      buyerUserId: 'buyer-A',
      milestoneKey: 'something_else',
    });
    expect(result.flipped).toBe(0);
    expect(state.drops[0].fire_at).toBeNull();
  });

  // ── 5. Double emit -> exactly once ──
  it('double milestone emit -> drop flipped exactly once', async () => {
    const state: MockState = {
      drops: [
        {
          id: 'd-1',
          client_purchase_id: 'p-A',
          content_id: 'c-1',
          asset_type: 'auto_message',
          asset_id: 'am-1',
          cadence_kind: 'on_milestone',
          cadence_payload: { milestone_key: 'k1' },
          fire_at: null,
          status: 'pending',
          materialised_ref: null,
          created_at: new Date(),
        },
      ],
      purchases: [{ id: 'p-A', client_user_id: 'buyer-A' }],
      contents: [],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const r1 = await svc.onMilestone({ buyerUserId: 'buyer-A', milestoneKey: 'k1' });
    const r2 = await svc.onMilestone({ buyerUserId: 'buyer-A', milestoneKey: 'k1' });
    expect(r1.flipped).toBe(1);
    expect(r2.flipped).toBe(0);
  });

  // ── 7. Buyer scope on milestones ──
  it("milestone emit for buyer A does NOT fire buyer B's drops", async () => {
    const state: MockState = {
      drops: [
        {
          id: 'd-A',
          client_purchase_id: 'p-A',
          content_id: 'c-1',
          asset_type: 'auto_message',
          asset_id: 'am-1',
          cadence_kind: 'on_milestone',
          cadence_payload: { milestone_key: 'k1' },
          fire_at: null,
          status: 'pending',
          materialised_ref: null,
          created_at: new Date(),
        },
        {
          id: 'd-B',
          client_purchase_id: 'p-B',
          content_id: 'c-1',
          asset_type: 'auto_message',
          asset_id: 'am-1',
          cadence_kind: 'on_milestone',
          cadence_payload: { milestone_key: 'k1' },
          fire_at: null,
          status: 'pending',
          materialised_ref: null,
          created_at: new Date(),
        },
      ],
      purchases: [
        { id: 'p-A', client_user_id: 'buyer-A' },
        { id: 'p-B', client_user_id: 'buyer-B' },
      ],
      contents: [],
    };
    const svc = new DripTriggerService(makeMockPrisma(state));
    const result = await svc.onMilestone({ buyerUserId: 'buyer-A', milestoneKey: 'k1' });
    expect(result.flipped).toBe(1);
    expect(result.flippedDropIds).toEqual(['d-A']);
    expect(state.drops.find((d) => d.id === 'd-B')!.fire_at).toBeNull();
  });
});

describe('MilestoneService', () => {
  it('delegates to DripTriggerService.onMilestone', async () => {
    const trigger = { onMilestone: jest.fn(async () => ({ flipped: 1, flippedDropIds: ['d-1'] })) } as any;
    const svc = new MilestoneService(trigger);
    await svc.emit('buyer-A', 'build_week_complete');
    expect(trigger.onMilestone).toHaveBeenCalledWith({
      buyerUserId: 'buyer-A',
      milestoneKey: 'build_week_complete',
    });
  });

  it('swallows a trigger throw (fire-and-forget invariant)', async () => {
    const trigger = { onMilestone: jest.fn(async () => { throw new Error('boom'); }) } as any;
    const svc = new MilestoneService(trigger);
    await expect(svc.emit('buyer-A', 'k1')).resolves.toBeUndefined();
  });

  it('no-op on missing buyerUserId or milestoneKey', async () => {
    const trigger = { onMilestone: jest.fn() } as any;
    const svc = new MilestoneService(trigger);
    await svc.emit('', 'k1');
    await svc.emit('buyer-A', '');
    expect(trigger.onMilestone).not.toHaveBeenCalled();
  });
});

describe('DripTriggerService — error safety', () => {
  it('onContentCompleted never throws even if underlying prisma errors', async () => {
    const prisma = {
      scheduledDrop: {
        findMany: jest.fn(async () => { throw new Error('db down'); }),
      },
    } as any;
    const svc = new DripTriggerService(prisma);
    const result = await svc.onContentCompleted({
      buyerUserId: 'buyer-A',
      assetType: 'workout_plan',
      assetId: 'plan-A',
    });
    expect(result.flipped).toBe(0);
    expect(result.flippedDropIds).toEqual([]);
  });

  it('onMilestone never throws even if underlying prisma errors', async () => {
    const prisma = {
      scheduledDrop: {
        findMany: jest.fn(async () => { throw new Error('db down'); }),
      },
    } as any;
    const svc = new DripTriggerService(prisma);
    const result = await svc.onMilestone({
      buyerUserId: 'buyer-A',
      milestoneKey: 'k1',
    });
    expect(result.flipped).toBe(0);
  });
});
