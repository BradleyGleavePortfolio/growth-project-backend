import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { AutoMessageAssetResolver } from '../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';

// PR-9 R1 — explicit rollback+retry simulation, the failure mode the
// audit's P1-1 and P1-2 identified. The earlier specs reused the same
// in-memory tx stub between calls so ScheduledDrop UUIDs were stable;
// THIS spec models what production actually does:
//
//   1. Run fan-out on a FRESH tx → drops get UUIDs U1.
//   2. The outer tx ROLLS BACK (any post-resolver in-tx failure, OR the
//      explicit resolver-throw the brief documents). The ScheduledDrop
//      rows are gone. The fanout row is gone. Side-effects committed on
//      `this.prisma` outside the tx (workout-ledger, auto-message
//      marker, the actual ClientWorkoutAssignment / CoachMessage rows)
//      PERSIST.
//   3. Stripe retries the same event. Fan-out runs on a NEW tx → drops
//      get fresh UUIDs U2 (different from U1).
//   4. Assert: across both attempts, the resolver fires its downstream
//      side-effect EXACTLY ONCE for the same (purchase_id, content_id).
//
// Before the R1 fix this test would FAIL for workout and auto_message
// because their idempotency keys embedded the now-stale U1, and the
// retry's U2-keyed dispatch produced a SECOND ClientWorkoutAssignment /
// CoachMessage. After R1 the keys are (purchaseId, contentId), stable
// across the rollback, and both resolvers collapse the retry onto the
// cached row.

const PURCHASE_ID = 'pur-rollback';
const CLIENT_ID = 'client-rollback';
const COACH_ID = 'coach-rollback';
const PACKAGE_ID = 'pkg-rollback';

let dropUuidCounter = 0;
function freshDropUuid(): string {
  dropUuidCounter += 1;
  return `drop-uuid-${dropUuidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// In-memory tx stub. Each invocation of `makeTx` returns a fresh stub —
// rows in this stub are local to the tx; on "rollback" we just throw
// the stub away. Drop UUIDs are minted by `freshDropUuid()` so two
// successive txs see different UUIDs for the SAME content row, exactly
// like production after a rollback.
function makeTx(contents: any[], purchase: any) {
  const fanouts: any[] = [];
  const drops: any[] = [];
  const tx: any = {
    _fanouts: fanouts,
    _drops: drops,
    purchaseFanout: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = fanouts.find((f) => f.purchase_id === where.purchase_id);
        if (existing) return { ...existing };
        const row = { id: `fo-${fanouts.length + 1}`, state: 'pending', ...create };
        fanouts.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = fanouts.find((f) => f.purchase_id === where.purchase_id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === purchase.id ? purchase : null,
      ),
    },
    coachPackageContent: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let rows = contents.filter(
          (c) => c.package_id === where.package_id && c.removed_at == null,
        );
        if (orderBy?.display_order === 'asc') {
          rows = [...rows].sort((a, b) => a.display_order - b.display_order);
        }
        return rows.map((r) => ({ ...r }));
      }),
    },
    scheduledDrop: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        let created = 0;
        for (const row of data) {
          const exists = drops.find(
            (d) =>
              d.client_purchase_id === row.client_purchase_id &&
              d.content_id === row.content_id,
          );
          if (exists) {
            if (skipDuplicates) continue;
            throw new Error('p2002');
          }
          drops.push({
            // FRESH uuid per row — this is the key difference vs the
            // simpler stub used in purchase-fanout-real-body.spec.ts.
            id: freshDropUuid(),
            attempt_count: 0,
            materialised_ref: null,
            fired_at: null,
            failure_reason: null,
            ...row,
          });
          created += 1;
        }
        return { count: created };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        drops
          .filter((d) =>
            Object.entries(where).every(([k, v]) => d[k] === v),
          )
          .map((d) => ({ ...d })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = drops.find((d) => d.id === where.id);
        for (const [k, v] of Object.entries(data ?? {})) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) {
            row[k] = (row[k] ?? 0) + (v as any).increment;
          } else {
            row[k] = v;
          }
        }
        return { ...row };
      }),
    },
  };
  return tx;
}

function basePurchase() {
  return {
    id: PURCHASE_ID,
    client_user_id: CLIENT_ID,
    coach_user_id: COACH_ID,
    package_id: PACKAGE_ID,
    created_at: new Date('2026-05-01T00:00:00Z'),
  };
}

function makeContents() {
  return [
    {
      id: 'c-workout',
      package_id: PACKAGE_ID,
      asset_type: 'workout_program',
      asset_id: 'wp-1',
      asset_revision_id: null,
      display_order: 0,
      cadence_kind: 'immediate',
      cadence_payload: {},
      display_title: 'Workout',
      display_caption: null,
      removed_at: null,
    },
    {
      id: 'c-message',
      package_id: PACKAGE_ID,
      asset_type: 'auto_message',
      asset_id: 'tmpl-1',
      asset_revision_id: null,
      display_order: 1,
      cadence_kind: 'immediate',
      cadence_payload: {},
      display_title: 'Welcome',
      display_caption: 'Welcome to the program',
      removed_at: null,
    },
  ];
}

// ---- WorkoutAssetResolver wired against a STUB that mimics
//      WorkoutBuilderService + its withIdempotency ledger backed by a
//      single shared store. The store lives ABOVE the tx — same as
//      production where the WorkoutBuilderIdempotencyKey rows live on
//      this.prisma, not the rolled-back tx.

function buildWorkoutLedger() {
  const cache = new Map<string, { id: string }>(); // key -> assignment row
  const wb = {
    assignPlan: jest.fn(
      async (_coachId: string, planId: string, dto: { client_id: string }, key: string) => {
        const existing = cache.get(key);
        if (existing) return existing;
        const assignment = { id: `assignment-${cache.size + 1}-${planId}-${dto.client_id}` };
        cache.set(key, assignment);
        return assignment;
      },
    ),
    _cache: cache,
  };
  return wb;
}

// ---- AutoMessageAssetResolver wired against a STUB that mimics
//      MessagingService.sendAsCoach + a stub PrismaService whose
//      `dripResolverMarker` table is a shared Map (mimicking the
//      persistent DripResolverMarker table — does NOT get rolled back
//      with the outer tx since the resolver uses this.prisma).

function buildMessagingAndMarkerStore() {
  const sendLog: Array<{ coachId: string; clientId: string; body: string }> = [];
  let msgCounter = 0;
  const msg = {
    sendAsCoach: jest.fn(async (coachId: string, clientId: string, payload: any) => {
      sendLog.push({ coachId, clientId, body: payload.body });
      msgCounter += 1;
      return { id: `msg-${msgCounter}` };
    }),
  };
  // marker store keyed by `${purpose}::${purchase_id}::${content_id}`
  const markers = new Map<string, { materialised_ref: string | null }>();
  const prisma = {
    dripResolverMarker: {
      create: jest.fn(async ({ data }: any) => {
        const k = `${data.purpose}::${data.purchase_id}::${data.content_id}`;
        if (markers.has(k)) {
          const err: any = new Error('p2002');
          err.code = 'P2002';
          // Mimic Prisma's PrismaClientKnownRequestError shape minimally.
          err.constructor = { name: 'PrismaClientKnownRequestError' };
          throw err;
        }
        markers.set(k, { materialised_ref: null });
        return { id: `marker-${markers.size}`, ...data, materialised_ref: null };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const w = where.purpose_purchase_id_content_id;
        const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
        const row = markers.get(k);
        if (!row) return null;
        return { purpose: w.purpose, purchase_id: w.purchase_id, content_id: w.content_id, ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const w = where.purpose_purchase_id_content_id;
        const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
        const row = markers.get(k);
        if (!row) throw new Error('marker not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  return { msg, prisma, sendLog, markers };
}

// The AutoMessageAssetResolver's P2002 check uses `instanceof
// Prisma.PrismaClientKnownRequestError`. The stub throws a plain Error
// with `code='P2002'`; to make instanceof match we patch the resolver
// internals or use a different check. Simpler: we patch Prisma's
// known-request-error class detection at runtime via this monkey-patch.
import { Prisma } from '@prisma/client';

function makeP2002Error(): Error {
  const ctor = Prisma.PrismaClientKnownRequestError as any;
  const err = new ctor('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  return err;
}

function makeScopeAllowing(): ResolverSubCoachScope {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => true),
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
  } as any);
}

class TwoResolverRegistry extends AssignableAssetResolverRegistry {
  constructor(
    private readonly workout: WorkoutAssetResolver,
    private readonly auto: AutoMessageAssetResolver,
  ) { super([]); }
  override async materialise(assetType: string, input: any) {
    if (assetType === 'workout_program' || assetType === 'workout_plan') {
      return this.workout.materialise(input);
    }
    if (assetType === 'auto_message') {
      return this.auto.materialise(input);
    }
    throw new Error(`unhandled type ${assetType}`);
  }
  override resolve(): any { return null; }
}

describe('PR-9 R1 audit-fix — rollback+retry idempotency for workout & auto_message', () => {
  it('workout: outer-tx rollback then Stripe retry with FRESH drop UUIDs produces EXACTLY ONE ClientWorkoutAssignment', async () => {
    const contents = makeContents();

    const wb = buildWorkoutLedger();
    const { msg, prisma, sendLog } = buildMessagingAndMarkerStore();
    // Patch P2002 path so instanceof checks pass — needed for auto_message.
    (prisma.dripResolverMarker.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const k = `${data.purpose}::${data.purchase_id}::${data.content_id}`;
      const markers = (prisma as any).__markers ?? ((prisma as any).__markers = new Map());
      if (markers.has(k)) throw makeP2002Error();
      markers.set(k, { materialised_ref: null });
      return { id: `marker-${markers.size}`, ...data, materialised_ref: null };
    });
    (prisma.dripResolverMarker.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      const w = where.purpose_purchase_id_content_id;
      const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
      const markers = (prisma as any).__markers ?? new Map();
      const row = markers.get(k);
      if (!row) return null;
      return { purpose: w.purpose, purchase_id: w.purchase_id, content_id: w.content_id, ...row };
    });
    (prisma.dripResolverMarker.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const w = where.purpose_purchase_id_content_id;
      const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
      const markers = (prisma as any).__markers ?? new Map();
      const row = markers.get(k);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    });

    const workoutResolver = new WorkoutAssetResolver(wb as any, makeScopeAllowing());
    const autoResolver = new AutoMessageAssetResolver(msg as any, makeScopeAllowing(), prisma as any);
    const registry = new TwoResolverRegistry(workoutResolver, autoResolver);
    const fanout = new PurchaseFanoutService(registry);

    // --- ATTEMPT 1: runs to completion (resolvers fire) but the outer tx
    //     then "rolls back" — we simply discard tx1 and its drops.
    const tx1 = makeTx(contents, basePurchase());
    await fanout.onPurchaseEntitled(
      { id: PURCHASE_ID },
      { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
      tx1,
    );

    // Sanity: both resolvers fired once on attempt 1.
    expect(wb.assignPlan).toHaveBeenCalledTimes(1);
    expect(msg.sendAsCoach).toHaveBeenCalledTimes(1);
    expect(wb._cache.size).toBe(1);
    expect(sendLog).toHaveLength(1);

    // Capture the drop UUIDs from attempt 1 so we can prove they
    // differ from attempt 2's UUIDs.
    const attempt1DropIds = tx1._drops.map((d: any) => d.id).sort();

    // Simulate the rolled-back+discarded alert bucket.
    fanout.discardPendingAlerts(PURCHASE_ID);

    // --- ATTEMPT 2: fresh tx (mimics Stripe retry of the same event).
    //     Drops get NEW UUIDs. If idempotency was scheduledDropId-keyed,
    //     both resolvers would re-fire and create duplicates.
    const tx2 = makeTx(contents, basePurchase());
    await fanout.onPurchaseEntitled(
      { id: PURCHASE_ID },
      { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
      tx2,
    );

    const attempt2DropIds = tx2._drops.map((d: any) => d.id).sort();
    // Prove the UUIDs really did regenerate.
    expect(attempt2DropIds).not.toEqual(attempt1DropIds);

    // --- THE ASSERTION the audit's P1-1/P1-2 were about: across both
    //     attempts the underlying side-effect was called EXACTLY ONCE.
    //     (Pre-fix this would be 2.)
    expect(wb.assignPlan).toHaveBeenCalledTimes(2); // resolver invoked twice…
    expect(wb._cache.size).toBe(1); // …but the ledger collapsed onto one assignment.
    // The cached assignment from attempt 1 is the one returned to attempt 2.
    const cachedKey = `drip:workout:p=${PURCHASE_ID}:c=c-workout`;
    expect(wb._cache.has(cachedKey)).toBe(true);

    expect(msg.sendAsCoach).toHaveBeenCalledTimes(1); // sendAsCoach was NOT called a second time
    expect(sendLog).toHaveLength(1); // exactly one outbound message
  });

  it('auto_message: marker.reclaim path — first attempt dies AFTER marker insert but BEFORE send completes; retry sends exactly once and stamps the marker', async () => {
    // Models: marker insert succeeds, then sendAsCoach throws (e.g.
    // network blip). Retry observes the existing marker with
    // materialised_ref=null and reclaims, sending once.
    const contents = makeContents().filter((c) => c.asset_type === 'auto_message');

    const sendCalls: any[] = [];
    let sendShouldThrow = true;
    const msg = {
      sendAsCoach: jest.fn(async (coachId: string, clientId: string, payload: any) => {
        sendCalls.push({ coachId, clientId, body: payload.body });
        if (sendShouldThrow) throw new Error('messaging blew up');
        return { id: `msg-final-${sendCalls.length}` };
      }),
    };

    const markers = new Map<string, { materialised_ref: string | null }>();
    const prisma = {
      dripResolverMarker: {
        create: jest.fn(async ({ data }: any) => {
          const k = `${data.purpose}::${data.purchase_id}::${data.content_id}`;
          if (markers.has(k)) throw makeP2002Error();
          markers.set(k, { materialised_ref: null });
          return { id: `m-${markers.size}`, ...data, materialised_ref: null };
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          const w = where.purpose_purchase_id_content_id;
          const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
          const row = markers.get(k);
          if (!row) return null;
          return { purpose: w.purpose, purchase_id: w.purchase_id, content_id: w.content_id, ...row };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const w = where.purpose_purchase_id_content_id;
          const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
          const row = markers.get(k);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        }),
      },
    };
    const autoResolver = new AutoMessageAssetResolver(msg as any, makeScopeAllowing(), prisma as any);
    const registry = new TwoResolverRegistry(
      // workout never used in this test — placeholder
      new WorkoutAssetResolver(
        { assignPlan: jest.fn() } as any,
        makeScopeAllowing(),
      ),
      autoResolver,
    );
    const fanout = new PurchaseFanoutService(registry);

    const tx1 = makeTx(contents, basePurchase());
    await expect(
      fanout.onPurchaseEntitled(
        { id: PURCHASE_ID },
        { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
        tx1,
      ),
    ).rejects.toThrow(/messaging blew up/);

    expect(markers.size).toBe(1);
    const onlyMarker = [...markers.values()][0];
    expect(onlyMarker.materialised_ref).toBeNull(); // send never completed
    expect(sendCalls).toHaveLength(1);

    // Retry: send no longer throws.
    sendShouldThrow = false;
    const tx2 = makeTx(contents, basePurchase());
    await fanout.onPurchaseEntitled(
      { id: PURCHASE_ID },
      { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
      tx2,
    );

    // Marker still ONE (reclaimed), final ref stamped.
    expect(markers.size).toBe(1);
    expect([...markers.values()][0].materialised_ref).toMatch(/^msg-final-/);
    // sendAsCoach was called twice (once failed, once succeeded), but
    // exactly ONE CoachMessage ended up in the system (the second
    // call's response).
    expect(sendCalls).toHaveLength(2);
  });

  it('auto_message: cached path — both attempts succeed; second observes the marker and DOES NOT call sendAsCoach again', async () => {
    const contents = makeContents().filter((c) => c.asset_type === 'auto_message');

    const sendCalls: any[] = [];
    const msg = {
      sendAsCoach: jest.fn(async (_c: string, _cl: string, payload: any) => {
        sendCalls.push(payload.body);
        return { id: `msg-${sendCalls.length}` };
      }),
    };
    const markers = new Map<string, { materialised_ref: string | null }>();
    const prisma = {
      dripResolverMarker: {
        create: jest.fn(async ({ data }: any) => {
          const k = `${data.purpose}::${data.purchase_id}::${data.content_id}`;
          if (markers.has(k)) throw makeP2002Error();
          markers.set(k, { materialised_ref: null });
          return { id: `m-${markers.size}`, ...data, materialised_ref: null };
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          const w = where.purpose_purchase_id_content_id;
          const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
          const row = markers.get(k);
          if (!row) return null;
          return { purpose: w.purpose, purchase_id: w.purchase_id, content_id: w.content_id, ...row };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const w = where.purpose_purchase_id_content_id;
          const k = `${w.purpose}::${w.purchase_id}::${w.content_id}`;
          const row = markers.get(k);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        }),
      },
    };
    const autoResolver = new AutoMessageAssetResolver(msg as any, makeScopeAllowing(), prisma as any);
    const registry = new TwoResolverRegistry(
      new WorkoutAssetResolver({ assignPlan: jest.fn() } as any, makeScopeAllowing()),
      autoResolver,
    );
    const fanout = new PurchaseFanoutService(registry);

    const tx1 = makeTx(contents, basePurchase());
    await fanout.onPurchaseEntitled(
      { id: PURCHASE_ID },
      { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
      tx1,
    );
    expect(sendCalls).toHaveLength(1);

    // Outer tx "rolled back" — we just throw away tx1. Drops get new UUIDs on retry.
    const tx2 = makeTx(contents, basePurchase());
    await fanout.onPurchaseEntitled(
      { id: PURCHASE_ID },
      { entrypoint: 'in_app_hosted', coachId: COACH_ID, clientId: CLIENT_ID },
      tx2,
    );

    // CRITICAL: sendAsCoach was NOT called a second time. The retry
    // observed the marker.materialised_ref and short-circuited.
    expect(sendCalls).toHaveLength(1);
    expect(msg.sendAsCoach).toHaveBeenCalledTimes(1);

    // The drop on the retry tx has materialised_ref set to the cached
    // message id (from the marker), proving the fan-out service stamped
    // the new drop with the original side-effect's id.
    const retryDrop = tx2._drops[0];
    expect(retryDrop.materialised_ref).toBe('msg-1');
    expect(retryDrop.status).toBe('fired');
  });
});
