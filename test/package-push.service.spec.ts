import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';
import {
  PackagePushService,
  SHIPPED_STATUSES,
} from '../src/packages/package-push.service';

// PR-17 B2 tests — package PUSH / BACKFILL service. Hand-rolled prisma
// stubs in the PR-8 package-contents.service.spec.ts style. Covers
// (PR17_EXPANSION_PLAN.md §2.8):
//   - audience scoping (all / active / cohort)
//   - chunking (>500 buyers → multiple createMany calls in ONE tx)
//   - push_seq computation (push_existing → 0; resend → max+1)
//   - resend-vs-unique (skip set per G4)
//   - past-date 400
//   - idempotent replay no-op (skipDuplicates, deterministic push_seq)
//   - notify-suppression stamps alert_dispatched_at at seed time
//   - NO Stripe (resolver/prisma stubs never construct a billing client)
//   - cohort cross-tenant rejection (IDOR re-filter by package_id)
//   - push_seq>0 inline-materialise resolver-key bypass (resolver called
//     WITHOUT the (clientPurchaseId, contentId) pair)

// ─────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────
function makePrismaStub() {
  const packages: any[] = [];
  const contents: any[] = [];
  const purchases: any[] = [];
  const drops: any[] = [];
  const createManyCalls: Array<{ count: number; chunkSize: number }> = [];
  // Set when ANY code path reaches for a Stripe/billing client on the stub —
  // the NO-Stripe test asserts this stays false.
  const stripeTouch = { touched: false };

  let dropSeq = 0;

  function matchScalar(rowVal: any, cond: any): boolean {
    if (cond === null) return rowVal === null || rowVal === undefined;
    if (typeof cond === 'object' && cond !== null) {
      if ('in' in cond) return (cond.in as any[]).includes(rowVal);
      if ('not' in cond) return rowVal !== cond.not;
      if ('lte' in cond) return rowVal != null && rowVal <= cond.lte;
      if ('gte' in cond) return rowVal != null && rowVal >= cond.gte;
      return false;
    }
    return rowVal === cond;
  }
  function filterMatch(row: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => matchScalar(row[k], v));
  }
  function project(row: any, select: any) {
    if (!select) return { ...row };
    const o: any = {};
    for (const k of Object.keys(select)) if (select[k]) o[k] = row[k];
    return o;
  }

  const dropClient = {
    findMany: jest.fn(async ({ where, select }: any) =>
      drops.filter((d) => filterMatch(d, where)).map((d) => project(d, select)),
    ),
    findFirst: jest.fn(async ({ where, select, orderBy }: any) => {
      let matches = drops.filter((d) => filterMatch(d, where));
      if (orderBy?.push_seq === 'desc') {
        matches = [...matches].sort((a, b) => b.push_seq - a.push_seq);
      }
      const row = matches[0] ?? null;
      return row ? project(row, select) : null;
    }),
    createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
      const rows: any[] = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const d of rows) {
        const dup = drops.find(
          (x) =>
            x.client_purchase_id === d.client_purchase_id &&
            x.content_id === d.content_id &&
            x.push_seq === (d.push_seq ?? 0),
        );
        if (dup) {
          if (!skipDuplicates) throw new Error('unique violation');
          continue;
        }
        dropSeq += 1;
        drops.push({
          id: `drop-${dropSeq}`,
          asset_revision_id: null,
          display_title: null,
          display_caption: null,
          fired_at: null,
          materialised_ref: null,
          attempt_count: 0,
          failure_reason: null,
          locked_at: null,
          next_retry_at: null,
          alert_dispatched_at: null,
          push_seq: 0,
          created_at: new Date(),
          updated_at: new Date(),
          ...d,
        });
        count += 1;
      }
      createManyCalls.push({ count, chunkSize: rows.length });
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = drops.find((d) => d.id === where.id);
      if (!row) throw new Error('drop not found');
      const next = { ...data };
      if (next.attempt_count && typeof next.attempt_count === 'object') {
        next.attempt_count = row.attempt_count + next.attempt_count.increment;
      }
      Object.assign(row, next, { updated_at: new Date() });
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const matches = drops.filter((d) => filterMatch(d, where));
      for (const r of matches) Object.assign(r, data);
      return { count: matches.length };
    }),
  };

  const stub: any = {
    _packages: packages,
    _contents: contents,
    _purchases: purchases,
    _drops: drops,
    _createManyCalls: createManyCalls,
    _stripeTouch: stripeTouch,
    coachPackage: {
      findFirst: jest.fn(
        async ({ where }: any) => packages.find((p) => filterMatch(p, where)) ?? null,
      ),
    },
    coachPackageContent: {
      findFirst: jest.fn(
        async ({ where }: any) => {
          const row = contents.find((c) => filterMatch(c, where));
          return row ? { ...row } : null;
        },
      ),
    },
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) =>
        purchases.filter((p) => filterMatch(p, where)).map((p) => ({ ...p })),
      ),
    },
    scheduledDrop: dropClient,
    // A getter that flags any attempt to use a Stripe/billing client. The
    // push path must NEVER reach for one.
    get billing() {
      stripeTouch.touched = true;
      return {};
    },
    get stripe() {
      stripeTouch.touched = true;
      return {};
    },
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') {
        // Hand the same stub back as the tx-client — the service only uses
        // scheduledDrop on the tx handle.
        return arg(stub);
      }
      throw new Error('unexpected $transaction arg');
    }),
  };
  return stub;
}

function makeSubCoachStub(headMap: Record<string, string | null> = {}) {
  return {
    getHeadCoachIdForSubCoach: jest.fn(
      async (userId: string) => headMap[userId] ?? null,
    ),
  };
}

// Resolver registry stub — records every materialise() call so we can assert
// the resolver-key bypass and that NO Stripe client is ever touched.
function makeResolverStub() {
  const calls: any[] = [];
  let n = 0;
  return {
    _calls: calls,
    materialise: jest.fn(async (assetType: string, input: any) => {
      calls.push({ assetType, input });
      n += 1;
      return { materialisedRef: `ref-${n}` };
    }),
  };
}

function makeNotificationsStub() {
  return {
    createNotification: jest.fn(async () => ({ id: 'notif' })),
    pushToUser: jest.fn(async () => undefined),
  };
}

// Seed helpers.
function seedPackage(prisma: any, p: { id: string; coach_id: string }) {
  prisma._packages.push({ id: p.id, coach_id: p.coach_id });
}
function seedContent(
  prisma: any,
  c: {
    id: string;
    package_id: string;
    asset_type?: string;
    asset_id?: string;
    cadence_kind?: string;
    cadence_payload?: any;
    display_title?: string | null;
  },
) {
  prisma._contents.push({
    id: c.id,
    package_id: c.package_id,
    asset_type: c.asset_type ?? 'auto_message',
    asset_id: c.asset_id ?? 'asset-1',
    asset_revision_id: null,
    cadence_kind: c.cadence_kind ?? 'immediate',
    cadence_payload: c.cadence_payload ?? {},
    display_title: c.display_title ?? 'Week 1',
    display_caption: null,
    display_order: 0,
    removed_at: null,
  });
}
function seedPurchase(
  prisma: any,
  p: {
    id: string;
    package_id: string;
    client_user_id?: string;
    coach_user_id?: string;
    entitlement_active?: boolean;
  },
) {
  prisma._purchases.push({
    id: p.id,
    package_id: p.package_id,
    client_user_id: p.client_user_id ?? `client-${p.id}`,
    coach_user_id: p.coach_user_id ?? 'coach-1',
    entitlement_active: p.entitlement_active ?? true,
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00Z'),
  });
}
function seedDrop(
  prisma: any,
  d: {
    client_purchase_id: string;
    content_id: string;
    status: string;
    push_seq?: number;
  },
) {
  prisma._drops.push({
    id: `seed-${prisma._drops.length + 1}`,
    client_purchase_id: d.client_purchase_id,
    content_id: d.content_id,
    asset_type: 'auto_message',
    asset_id: 'asset-1',
    asset_revision_id: null,
    cadence_kind: 'immediate',
    cadence_payload: {},
    display_title: 'Week 1',
    display_caption: null,
    fire_at: new Date('2026-01-01T00:00:00Z'),
    fired_at: new Date('2026-01-01T00:00:00Z'),
    status: d.status,
    materialised_ref: 'old-ref',
    attempt_count: 1,
    failure_reason: null,
    locked_at: null,
    next_retry_at: null,
    alert_dispatched_at: new Date('2026-01-01T00:00:00Z'),
    push_seq: d.push_seq ?? 0,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

// A fire_at "today or later" the service accepts. Use far-future for
// forward-dated cases, now for due-now inline materialise.
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000);

// ─────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────
describe('PackagePushService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let subCoach: ReturnType<typeof makeSubCoachStub>;
  let packages: PackagesService;
  let resolvers: ReturnType<typeof makeResolverStub>;
  let notifications: ReturnType<typeof makeNotificationsStub>;
  let svc: PackagePushService;

  beforeEach(() => {
    prisma = makePrismaStub();
    subCoach = makeSubCoachStub();
    packages = new PackagesService(prisma as any, subCoach as any);
    resolvers = makeResolverStub();
    notifications = makeNotificationsStub();
    svc = new PackagePushService(
      prisma as any,
      packages,
      resolvers as any,
      notifications as any,
    );
    seedPackage(prisma, { id: 'pkg-1', coach_id: 'coach-1' });
    seedContent(prisma, { id: 'content-1', package_id: 'pkg-1' });
  });

  // ── SHIPPED_STATUSES constant (G4) ───────────────────────────────────
  it('centralizes the shipped-status set as fired + delivered (G4)', () => {
    expect([...SHIPPED_STATUSES].sort()).toEqual(['delivered', 'fired']);
  });

  // ── IDOR / content existence ─────────────────────────────────────────
  it("rejects a push to another coach's package (IDOR)", async () => {
    seedPackage(prisma, { id: 'pkg-2', coach_id: 'coach-2' });
    seedContent(prisma, { id: 'content-2', package_id: 'pkg-2' });
    await expect(
      svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-2',
        'content-2',
        { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the content row does not exist on the package', async () => {
    await expect(
      svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'missing',
        { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── past-date 400 (#2/#6) ────────────────────────────────────────────
  it('rejects fire_at before the start of today with a 400', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    const past = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await expect(
      svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: past, mode: 'push_existing', notify: true },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── audience scoping (#1 / §2.6) ─────────────────────────────────────
  describe('audience scoping', () => {
    beforeEach(() => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1', entitlement_active: true });
      seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1', entitlement_active: false });
      seedPurchase(prisma, { id: 'p3', package_id: 'pkg-1', entitlement_active: true });
    });

    it('all → every purchase for the package', async () => {
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      );
      expect(res.scheduled).toBe(3);
    });

    it('active → only entitlement_active purchases', async () => {
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'active', fireAt: FUTURE, mode: 'push_existing', notify: true },
      );
      expect(res.scheduled).toBe(2);
    });

    it('cohort → only the listed purchase ids', async () => {
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        {
          audience: 'cohort',
          cohortPurchaseIds: ['p1'],
          fireAt: FUTURE,
          mode: 'push_existing',
          notify: true,
        },
      );
      expect(res.scheduled).toBe(1);
    });
  });

  // ── cohort cross-tenant rejection (IDOR re-filter by package_id) ─────
  it('cohort ignores purchase ids that belong to another package', async () => {
    seedPackage(prisma, { id: 'pkg-2', coach_id: 'coach-2' });
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    // p-foreign belongs to pkg-2 — a coach-1 push must NOT reach it.
    seedPurchase(prisma, { id: 'p-foreign', package_id: 'pkg-2' });
    const res = await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      {
        audience: 'cohort',
        cohortPurchaseIds: ['p1', 'p-foreign'],
        fireAt: FUTURE,
        mode: 'push_existing',
        notify: true,
      },
    );
    // Only p1 (in pkg-1) is seeded; p-foreign is filtered out by package_id.
    expect(res.scheduled).toBe(1);
    const seeded = prisma._drops.map((d: any) => d.client_purchase_id);
    expect(seeded).toEqual(['p1']);
  });

  // ── push_seq computation + resend-vs-unique (G4 / #5) ────────────────
  describe('push_seq computation & resend-vs-unique', () => {
    it('push_existing skips buyers with ANY existing drop, seeds seq 0 for the rest', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' }); // already has a drop
      seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1' }); // fresh
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered' });
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      );
      expect(res.scheduled).toBe(1);
      expect(res.skipped).toBe(1);
      const newRow = prisma._drops.find(
        (d: any) => d.client_purchase_id === 'p2' && d.content_id === 'content-1',
      );
      expect(newRow.push_seq).toBe(0);
    });

    it('resend targets only buyers whose latest drop is shipped, at push_seq=max+1', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' }); // delivered → resend
      seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1' }); // pending → skip
      seedPurchase(prisma, { id: 'p3', package_id: 'pkg-1' }); // no drop → skip
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered', push_seq: 0 });
      seedDrop(prisma, { client_purchase_id: 'p2', content_id: 'content-1', status: 'pending', push_seq: 0 });
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: FUTURE, mode: 'resend', notify: true },
      );
      expect(res.scheduled).toBe(1);
      expect(res.skipped).toBe(2);
      const resendRow = prisma._drops.find(
        (d: any) => d.client_purchase_id === 'p1' && d.push_seq === 1,
      );
      expect(resendRow).toBeTruthy();
      expect(resendRow.status).toBe('pending');
    });

    it('resend off an already-resent drop computes max+1 (seq 2)', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'fired', push_seq: 0 });
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered', push_seq: 1 });
      const res = await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: FUTURE, mode: 'resend', notify: true },
      );
      expect(res.scheduled).toBe(1);
      const row = prisma._drops.find(
        (d: any) => d.client_purchase_id === 'p1' && d.push_seq === 2,
      );
      expect(row).toBeTruthy();
    });
  });

  // ── chunking (decision #7) ───────────────────────────────────────────
  it('seeds >500 buyers in chunked createMany calls inside ONE transaction', async () => {
    for (let i = 0; i < 1201; i++) {
      seedPurchase(prisma, { id: `pp${i}`, package_id: 'pkg-1' });
    }
    const res = await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
    );
    expect(res.scheduled).toBe(1201);
    // Exactly ONE $transaction opened.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    // 1201 rows → 3 chunks of <=500.
    const chunkSizes = (prisma as any)._createManyCalls.map((c: any) => c.chunkSize);
    expect(chunkSizes).toEqual([500, 500, 201]);
  });

  // ── idempotent replay no-op (#8) ─────────────────────────────────────
  it('a replayed identical push is a true no-op via deterministic push_seq + skipDuplicates', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1' });
    const first = await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      'idem-key-1',
    );
    expect(first.scheduled).toBe(2);
    const dropCountAfterFirst = prisma._drops.length;

    const replay = await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      'idem-key-1',
    );
    // No NEW rows inserted; the replay re-derives seq 0 and skipDuplicates
    // makes it a no-op. scheduled reflects existing rows at the target seq.
    expect(prisma._drops.length).toBe(dropCountAfterFirst);
    // push_existing now sees an existing drop for each buyer → all skipped.
    expect(replay.scheduled).toBe(0);
    expect(replay.skipped).toBe(2);
  });

  // ── notify suppression stamps alert_dispatched_at (#9) ───────────────
  it('notify=false stamps alert_dispatched_at at seed time and sends NO inline alert', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    // due-now so inline materialise runs; notify false must still suppress.
    const res = await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: new Date(), mode: 'push_existing', notify: false },
    );
    expect(res.scheduled).toBe(1);
    const row = prisma._drops.find((d: any) => d.client_purchase_id === 'p1');
    expect(row.alert_dispatched_at).not.toBeNull();
    // No buyer push/in-app was sent.
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('notify=true leaves alert_dispatched_at NULL at seed for a forward-dated push (cron alerts later)', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
    );
    const row = prisma._drops.find((d: any) => d.client_purchase_id === 'p1');
    // Forward-dated, not materialised inline → alert_dispatched_at stays NULL
    // so the cron fires DRIP_RELEASED when it delivers.
    expect(row.alert_dispatched_at).toBeNull();
  });

  // ── NO Stripe (decision #7 / watchpoint §6.3) ────────────────────────
  it('never touches a Stripe / billing client on the push path', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
    await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: new Date(), mode: 'push_existing', notify: true },
    );
    expect((prisma as any)._stripeTouch.touched).toBe(false);
  });

  // ── resolver-key bypass (#5, the single most fragile rule) ───────────
  describe('resolver-key bypass on inline due-now materialise', () => {
    it('push_seq===0 backfill → resolver called WITH the (clientPurchaseId, contentId) pair', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1', client_user_id: 'cl1', coach_user_id: 'coach-1' });
      await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: new Date(), mode: 'push_existing', notify: true },
      );
      expect(resolvers.materialise).toHaveBeenCalledTimes(1);
      const input = resolvers._calls[0].input;
      expect(input.clientPurchaseId).toBe('p1');
      expect(input.contentId).toBe('content-1');
      expect(input.scheduledDropId).toBeTruthy();
    });

    it('push_seq>0 resend → resolver called WITHOUT the pair (scheduledDropId only) for a FRESH delivery', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1', client_user_id: 'cl1', coach_user_id: 'coach-1' });
      // Existing shipped drop so resend lands at push_seq=1.
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered', push_seq: 0 });
      await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: new Date(), mode: 'resend', notify: true },
      );
      expect(resolvers.materialise).toHaveBeenCalledTimes(1);
      const input = resolvers._calls[0].input;
      // The pair MUST be omitted so the resolver does not collapse to the
      // cached marker/ledger result — this is the fresh-delivery guarantee.
      expect(input.clientPurchaseId).toBeNull();
      expect(input.contentId).toBeNull();
      expect(input.scheduledDropId).toBeTruthy();
    });

    it('forward-dated push does NOT materialise inline (cron handles it)', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
      await svc.pushContentToExistingBuyers(
        'coach-1',
        'pkg-1',
        'content-1',
        { audience: 'all', fireAt: FUTURE, mode: 'push_existing', notify: true },
      );
      expect(resolvers.materialise).not.toHaveBeenCalled();
      const row = prisma._drops.find((d: any) => d.client_purchase_id === 'p1');
      expect(row.status).toBe('pending');
      expect(row.materialised_ref).toBeNull();
    });
  });

  // ── immutable fired drop (watchpoint §6.5) ───────────────────────────
  it('resend leaves the original shipped row byte-identical (new row at max+1)', async () => {
    seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1', client_user_id: 'cl1' });
    seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered', push_seq: 0 });
    const original = { ...prisma._drops[0] };
    await svc.pushContentToExistingBuyers(
      'coach-1',
      'pkg-1',
      'content-1',
      { audience: 'all', fireAt: new Date(), mode: 'resend', notify: true },
    );
    const stillOriginal = prisma._drops.find((d: any) => d.push_seq === 0);
    expect(stillOriginal.materialised_ref).toBe(original.materialised_ref);
    expect(stillOriginal.status).toBe('delivered');
    expect(stillOriginal.id).toBe(original.id);
  });

  // ── preview endpoint (pure read, §2.1) ───────────────────────────────
  describe('previewPush', () => {
    it('push_existing → count of buyers with no drop; already_delivered counts shipped', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
      seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1' });
      seedPurchase(prisma, { id: 'p3', package_id: 'pkg-1' });
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'delivered' });
      const res = await svc.previewPush('coach-1', 'pkg-1', 'content-1', {
        audience: 'all',
        mode: 'push_existing',
      });
      // p2, p3 have no drop → count 2; p1 shipped → already_delivered 1.
      expect(res.count).toBe(2);
      expect(res.already_delivered).toBe(1);
    });

    it('resend → count of buyers whose latest drop is shipped', async () => {
      seedPurchase(prisma, { id: 'p1', package_id: 'pkg-1' });
      seedPurchase(prisma, { id: 'p2', package_id: 'pkg-1' });
      seedDrop(prisma, { client_purchase_id: 'p1', content_id: 'content-1', status: 'fired' });
      seedDrop(prisma, { client_purchase_id: 'p2', content_id: 'content-1', status: 'pending' });
      const res = await svc.previewPush('coach-1', 'pkg-1', 'content-1', {
        audience: 'all',
        mode: 'resend',
      });
      expect(res.count).toBe(1);
      expect(res.already_delivered).toBe(1);
    });

    it("preview rejects another coach's package (IDOR)", async () => {
      seedPackage(prisma, { id: 'pkg-2', coach_id: 'coach-2' });
      seedContent(prisma, { id: 'content-2', package_id: 'pkg-2' });
      await expect(
        svc.previewPush('coach-1', 'pkg-2', 'content-2', {
          audience: 'all',
          mode: 'push_existing',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
