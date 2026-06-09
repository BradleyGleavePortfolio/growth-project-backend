import { NotFoundException } from '@nestjs/common';
import { CheckoutService } from '../src/checkout/checkout.service';

// PR-15A A1 — CheckoutService.listDropsForBuyer.
//
// Verifies the contract PR-13 froze (PR13_BUILD_REPORT.md §c) and the
// brief A1 invariants:
//   - status IN ('pending','due','fired') only; failed/canceled/skipped
//     filtered AT THE SQL WHERE.
//   - COALESCE(fired_at, fire_at, created_at) ASC order.
//   - cross-user purchaseId → 404 (NOT 403; no existence leak —
//     requireOwned pattern).
//   - unknown purchaseId → 404.
//   - empty purchase → { drops: [] }.
//   - materialised_ref is null for upcoming, populated for delivered.
//   - one Prisma query for the drop list (no N+1).

type Row = Record<string, any>;

interface State {
  purchases: Row[];
  drops: Row[];
}

function makePrisma(state: State) {
  const findFirstPurchase = jest.fn(async ({ where }: any) => {
    return (
      state.purchases.find(
        (p) =>
          p.id === where.id &&
          (where.client_user_id == null ||
            p.client_user_id === where.client_user_id),
      ) ?? null
    );
  });
  const findManyDrops = jest.fn(async ({ where, select, take }: any) => {
    const allowedStatuses: string[] | undefined = where.status?.in;
    let rows = state.drops.filter(
      (d) => d.client_purchase_id === where.client_purchase_id,
    );
    if (allowedStatuses) {
      rows = rows.filter((d) => allowedStatuses.includes(d.status));
    }
    if (take) rows = rows.slice(0, take);
    if (!select) return rows;
    // emulate Prisma select projection
    return rows.map((r) => {
      const out: Row = {};
      for (const k of Object.keys(select)) {
        if (select[k]) out[k] = r[k] ?? null;
      }
      return out;
    });
  });
  return {
    clientPurchase: { findFirst: findFirstPurchase },
    scheduledDrop: { findMany: findManyDrops },
    _findFirstPurchase: findFirstPurchase,
    _findManyDrops: findManyDrops,
  };
}

function makeService(state: State) {
  const prisma = makePrisma(state);
  const svc = new CheckoutService(
    prisma as never,
    {} as never,
    {} as never,
    { ready: true } as never,
    {} as never,
    // B5 — contract gate stub: contracts OFF in this suite → gate is a no-op.
    { evaluate: async () => ({ ok: true, reason: 'contracts_disabled' }) } as never,
  );
  return { svc, prisma };
}

describe('CheckoutService.listDropsForBuyer (PR-15A A1)', () => {
  const BUYER = 'usr_buyer';
  const OTHER_BUYER = 'usr_other';
  const PURCHASE = 'pur_1';
  const FOREIGN_PURCHASE = 'pur_foreign';

  function baseState(): State {
    return {
      purchases: [
        { id: PURCHASE, client_user_id: BUYER },
        { id: FOREIGN_PURCHASE, client_user_id: OTHER_BUYER },
      ],
      drops: [],
    };
  }

  it('owner sees their pending+due+fired drops in COALESCE order', async () => {
    const state = baseState();
    const now = new Date('2026-01-15T12:00:00Z');
    state.drops = [
      {
        id: 'd1',
        client_purchase_id: PURCHASE,
        status: 'fired',
        fired_at: new Date('2026-01-10T00:00:00Z'),
        fire_at: new Date('2026-01-10T00:00:00Z'),
        created_at: new Date('2026-01-01T00:00:00Z'),
        asset_type: 'workout_program',
        asset_id: 'asset-1',
        asset_revision_id: 'rev-1',
        cadence_kind: 'immediate',
        display_title: 'Week 1',
        display_caption: null,
        materialised_ref: 'assignment-1',
      },
      {
        id: 'd2',
        client_purchase_id: PURCHASE,
        status: 'pending',
        fired_at: null,
        fire_at: new Date('2026-01-20T00:00:00Z'),
        created_at: new Date('2026-01-02T00:00:00Z'),
        asset_type: 'meal_plan',
        asset_id: 'asset-2',
        asset_revision_id: null,
        cadence_kind: 'relative_to_purchase',
        display_title: 'Day 5 meal',
        display_caption: 'For your day-5 unlock',
        materialised_ref: null,
      },
      {
        id: 'd3',
        client_purchase_id: PURCHASE,
        status: 'due',
        fired_at: null,
        fire_at: null,
        created_at: new Date('2026-01-05T00:00:00Z'),
        asset_type: 'pdf',
        asset_id: 'asset-3',
        asset_revision_id: null,
        cadence_kind: 'on_completion',
        display_title: 'Workbook',
        display_caption: null,
        materialised_ref: null,
      },
    ];

    const { svc, prisma } = makeService(state);
    const result = await svc.listDropsForBuyer(BUYER, PURCHASE);
    expect(result.drops.map((d) => d.id)).toEqual(['d3', 'd1', 'd2']);
    // d3 has no fire/fired so created_at (2026-01-05) wins;
    // d1 has fired_at 2026-01-10; d2 has fire_at 2026-01-20.

    // No N+1 — one query for drops, one for the IDOR ownership check.
    expect(prisma._findFirstPurchase).toHaveBeenCalledTimes(1);
    expect(prisma._findManyDrops).toHaveBeenCalledTimes(1);
    // Verify status filter pushed to SQL.
    const whereArg = (prisma._findManyDrops.mock.calls[0][0] as any).where;
    expect(whereArg.status.in).toEqual(['pending', 'due', 'fired']);
    expect(whereArg.client_purchase_id).toBe(PURCHASE);
    void now;
  });

  it('excludes failed/canceled/skipped drops at the SQL WHERE', async () => {
    const state = baseState();
    state.drops = [
      mkDrop('d_failed', PURCHASE, 'failed'),
      mkDrop('d_canceled', PURCHASE, 'canceled'),
      mkDrop('d_skipped', PURCHASE, 'skipped'),
      mkDrop('d_pending', PURCHASE, 'pending'),
    ];
    const { svc } = makeService(state);
    const result = await svc.listDropsForBuyer(BUYER, PURCHASE);
    expect(result.drops.map((d) => d.id)).toEqual(['d_pending']);
  });

  it('cross-user purchaseId returns 404 (NOT 403; no existence leak)', async () => {
    const state = baseState();
    state.drops = [mkDrop('d_foreign', FOREIGN_PURCHASE, 'fired')];
    const { svc } = makeService(state);
    await expect(svc.listDropsForBuyer(BUYER, FOREIGN_PURCHASE)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('unknown purchaseId returns 404', async () => {
    const { svc } = makeService(baseState());
    await expect(svc.listDropsForBuyer(BUYER, 'pur_does_not_exist')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('empty purchase returns { drops: [] }', async () => {
    const { svc } = makeService(baseState());
    const result = await svc.listDropsForBuyer(BUYER, PURCHASE);
    expect(result).toEqual({ drops: [] });
  });

  it('materialised_ref is null for upcoming, populated for delivered', async () => {
    const state = baseState();
    state.drops = [
      {
        ...mkDrop('d_pending', PURCHASE, 'pending'),
        materialised_ref: null,
      },
      {
        ...mkDrop('d_fired', PURCHASE, 'fired'),
        materialised_ref: 'workout-assignment-99',
      },
    ];
    const { svc } = makeService(state);
    const result = await svc.listDropsForBuyer(BUYER, PURCHASE);
    const pending = result.drops.find((d) => d.id === 'd_pending');
    const fired = result.drops.find((d) => d.id === 'd_fired');
    expect(pending?.materialised_ref).toBeNull();
    expect(fired?.materialised_ref).toBe('workout-assignment-99');
  });

  it('response shape matches the frozen typed contract (PR13_BUILD_REPORT §c)', async () => {
    const state = baseState();
    state.drops = [mkDrop('d1', PURCHASE, 'fired')];
    const { svc } = makeService(state);
    const result = await svc.listDropsForBuyer(BUYER, PURCHASE);
    const d = result.drops[0];
    // Exact field-name match required by the mobile typed client.
    expect(Object.keys(d).sort()).toEqual(
      [
        'asset_id',
        'asset_revision_id',
        'asset_type',
        'cadence_kind',
        'display_caption',
        'display_title',
        'fire_at',
        'fired_at',
        'id',
        'materialised_ref',
        'status',
      ].sort(),
    );
  });
});

function mkDrop(id: string, purchaseId: string, status: string): Row {
  return {
    id,
    client_purchase_id: purchaseId,
    status,
    fired_at: null,
    fire_at: null,
    created_at: new Date('2026-01-05T00:00:00Z'),
    asset_type: 'workout_program',
    asset_id: 'asset-x',
    asset_revision_id: null,
    cadence_kind: 'immediate',
    display_title: null,
    display_caption: null,
    materialised_ref: null,
  };
}
