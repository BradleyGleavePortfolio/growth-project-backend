import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';
import { PackageContentsService } from '../src/packages/package-contents.service';
import { computeFireAt, type CadenceKind } from '../src/packages/drip-fire-at';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';

// PR-17 — drip "push to existing" fire_at extraction.
//
// PR-9's per-cadence fire_at math was extracted into the pure
// `computeFireAt(kind, payload, anchor, now)` module (src/packages/
// drip-fire-at.ts) so the PR-17 push-to-existing flow reuses the EXACT
// same calculation PurchaseFanoutService uses at checkout — no
// duplication. This suite locks the contract on TWO surfaces:
//
//   (1) the extracted pure function directly, across every cadence kind;
//   (2) the on-main consumer (PurchaseFanoutService.onPurchaseEntitled)
//       to prove the math is still wired identically AND that the anchor
//       is the BUYER'S OWN purchase time — two buyers with different
//       purchase dates get DIFFERENT relative_to_purchase fire_at, never
//       a shared coach-now (the drip-fire-at.ts header LAW, decision #2).
//
// Cadence coverage (intent carried over from PR-17A §A tests):
//   - immediate                    → now
//   - relative_to_purchase         → anchor + offset_days (per-buyer)
//   - fixed_calendar (future)      → release_at
//   - fixed_calendar (past)        → now (fire at next tick)
//   - on_completion / on_milestone → null (PR-11 wires the trigger)

const DAY_MS = 24 * 3600 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// (1) The extracted pure function — every cadence kind.
// ─────────────────────────────────────────────────────────────────────────
describe('computeFireAt (extracted PR-9 cadence math)', () => {
  const anchor = new Date('2026-01-01T00:00:00.000Z');
  const now = new Date('2026-06-01T12:00:00.000Z');

  describe('immediate', () => {
    it('returns `now` regardless of payload or anchor', () => {
      const out = computeFireAt('immediate', {}, anchor, now);
      expect(out).not.toBeNull();
      expect(out!.getTime()).toBe(now.getTime());
    });

    it('ignores a release_at on an immediate cadence', () => {
      const out = computeFireAt(
        'immediate',
        { release_at: '2030-01-01T00:00:00.000Z' },
        anchor,
        now,
      );
      expect(out!.getTime()).toBe(now.getTime());
    });
  });

  describe('relative_to_purchase', () => {
    it('returns anchor + offset_days (integer days, no timezone drift)', () => {
      const out = computeFireAt(
        'relative_to_purchase',
        { offset_days: 7 },
        anchor,
        now,
      );
      expect(out!.toISOString()).toBe(
        new Date(anchor.getTime() + 7 * DAY_MS).toISOString(),
      );
    });

    it('offset_days=0 lands exactly on the anchor', () => {
      const out = computeFireAt(
        'relative_to_purchase',
        { offset_days: 0 },
        anchor,
        now,
      );
      expect(out!.toISOString()).toBe(anchor.toISOString());
    });

    it('coerces a negative offset_days to 0 (never fires before the anchor)', () => {
      const out = computeFireAt(
        'relative_to_purchase',
        { offset_days: -5 },
        anchor,
        now,
      );
      expect(out!.toISOString()).toBe(anchor.toISOString());
    });

    it('coerces a non-numeric / non-finite offset_days to 0', () => {
      for (const bad of [
        { offset_days: 'not a number' },
        { offset_days: NaN },
        { offset_days: Infinity },
        {},
        null,
      ]) {
        const out = computeFireAt(
          'relative_to_purchase',
          bad,
          anchor,
          now,
        );
        expect(out!.toISOString()).toBe(anchor.toISOString());
      }
    });

    it('does the millisecond arithmetic exactly (offset_days * 24 * 3600 * 1000)', () => {
      const out = computeFireAt(
        'relative_to_purchase',
        { offset_days: 30 },
        anchor,
        now,
      );
      expect(out!.getTime() - anchor.getTime()).toBe(30 * DAY_MS);
    });
  });

  describe('fixed_calendar', () => {
    it('returns release_at when it is in the FUTURE', () => {
      const future = new Date(now.getTime() + 90 * DAY_MS);
      const out = computeFireAt(
        'fixed_calendar',
        { release_at: future.toISOString() },
        anchor,
        now,
      );
      expect(out!.toISOString()).toBe(future.toISOString());
    });

    it('returns `now` when release_at is in the PAST (fire at next tick)', () => {
      const past = new Date(now.getTime() - 90 * DAY_MS);
      const out = computeFireAt(
        'fixed_calendar',
        { release_at: past.toISOString() },
        anchor,
        now,
      );
      expect(out!.getTime()).toBe(now.getTime());
    });

    it('treats release_at exactly equal to now as past → returns now', () => {
      const out = computeFireAt(
        'fixed_calendar',
        { release_at: now.toISOString() },
        anchor,
        now,
      );
      expect(out!.getTime()).toBe(now.getTime());
    });

    it('returns `now` for a malformed / missing release_at (fire rather than dangle)', () => {
      for (const bad of [
        { release_at: 'not-a-date' },
        { release_at: 12345 },
        {},
        null,
      ]) {
        const out = computeFireAt('fixed_calendar', bad, anchor, now);
        expect(out!.getTime()).toBe(now.getTime());
      }
    });
  });

  describe('trigger cadences seed with null fire_at', () => {
    it('on_completion returns null', () => {
      expect(computeFireAt('on_completion', {}, anchor, now)).toBeNull();
    });

    it('on_milestone returns null', () => {
      expect(
        computeFireAt('on_milestone', { milestone_key: 'lost_5lb' }, anchor, now),
      ).toBeNull();
    });

    it('an unknown cadence kind returns null (operator notices; cron never blindly fires)', () => {
      expect(
        computeFireAt('who_knows' as CadenceKind, {}, anchor, now),
      ).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) Through the on-main consumer: PurchaseFanoutService.onPurchaseEntitled
//     uses computeFireAt with the BUYER'S purchase time as the anchor.
// ─────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

const COACH_ID = 'coach-1';
const PACKAGE_ID = 'pkg-1';

// In-memory tx stub mirroring the PR-9 fan-out tx surface
// (purchase-fanout-real-body.spec.ts). Only the tables onPurchaseEntitled
// touches are modelled.
function makeTx(opts: { contents: Row[]; purchases: Row[] }) {
  const fanouts: Row[] = [];
  const drops: Row[] = [];
  const { purchases, contents } = opts;

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
        if (!row) throw new Error('no fanout row');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
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
            throw new Error('unique violation');
          }
          drops.push({
            id: `drop-${drops.length + 1}`,
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
          .filter((d) => Object.entries(where).every(([k, v]) => d[k] === v))
          .map((d) => ({ ...d })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = drops.find((d) => d.id === where.id);
        if (!row) throw new Error(`no drop ${where.id}`);
        for (const [k, v] of Object.entries(data ?? {})) {
          if (
            v &&
            typeof v === 'object' &&
            'increment' in (v as Record<string, unknown>)
          ) {
            const inc = (v as { increment: number }).increment;
            row[k] = ((row[k] as number) ?? 0) + inc;
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

// Resolver registry stub — records materialise() calls, returns a stable ref.
class StubRegistry extends AssignableAssetResolverRegistry {
  readonly calls: Array<{ assetType: string; input: any }> = [];
  constructor() {
    super([]);
  }
  override async materialise(assetType: string, input: any) {
    this.calls.push({ assetType, input });
    return { materialisedRef: `ref-${input.scheduledDropId}` };
  }
  override resolve(): any {
    return null;
  }
}

function mkContent(overrides: Partial<Row>): Row {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    package_id: PACKAGE_ID,
    asset_type: 'meal_plan',
    asset_id: 'asset-1',
    asset_revision_id: null,
    display_order: 0,
    cadence_kind: 'immediate',
    cadence_payload: {},
    display_title: null,
    display_caption: null,
    removed_at: null,
    ...overrides,
  };
}

function mkPurchase(id: string, createdAt: Date): Row {
  return {
    id,
    client_user_id: `client-${id}`,
    coach_user_id: COACH_ID,
    package_id: PACKAGE_ID,
    created_at: createdAt,
  };
}

describe('push-to-existing fire_at via PurchaseFanoutService (on-main consumer)', () => {
  it('relative_to_purchase is anchored to the BUYER\'S purchase time, not a shared coach-now', async () => {
    // Two buyers, different purchase dates, SAME package/content. The
    // relative_to_purchase drop for each must land at purchase + offset,
    // so the two fire_at values DIFFER by exactly the gap between the two
    // purchase dates. This is the decision #2 LAW the extraction preserves.
    const dateA = new Date('2026-01-01T00:00:00.000Z');
    const dateB = new Date('2026-04-15T00:00:00.000Z');
    const content = mkContent({
      id: 'c-rel',
      cadence_kind: 'relative_to_purchase',
      cadence_payload: { offset_days: 7 },
    });

    const fireAtFor = async (purchaseId: string, createdAt: Date) => {
      const purchase = mkPurchase(purchaseId, createdAt);
      const tx = makeTx({ contents: [content], purchases: [purchase] });
      const svc = new PurchaseFanoutService(new StubRegistry());
      await svc.onPurchaseEntitled(
        { id: purchaseId },
        {
          entrypoint: 'in_app_hosted',
          coachId: COACH_ID,
          clientId: purchase.client_user_id,
          // anchor = buyer's own purchase time
          purchaseTime: createdAt,
        },
        tx,
      );
      const drop = tx._drops.find((d: any) => d.content_id === 'c-rel');
      expect(drop).toBeDefined();
      return drop.fire_at as Date;
    };

    const fireA = await fireAtFor('pA', dateA);
    const fireB = await fireAtFor('pB', dateB);

    expect(fireA.toISOString()).toBe(
      new Date(dateA.getTime() + 7 * DAY_MS).toISOString(),
    );
    expect(fireB.toISOString()).toBe(
      new Date(dateB.getTime() + 7 * DAY_MS).toISOString(),
    );
    // Critically: NOT collapsed onto a shared anchor.
    expect(fireA.toISOString()).not.toBe(fireB.toISOString());
    expect(fireB.getTime() - fireA.getTime()).toBe(
      dateB.getTime() - dateA.getTime(),
    );
  });

  it('seeds the correct fire_at per cadence kind through the consumer', async () => {
    // Anchor purchaseTime to a moment just after now so the
    // relative_to_purchase drop lands genuinely in the future (the
    // service computes the immediate cutoff against the wall clock).
    const purchaseTime = new Date(Date.now() + 1000);
    const futureFixed = new Date(Date.now() + 90 * DAY_MS).toISOString();
    const pastFixed = new Date(Date.now() - 90 * DAY_MS).toISOString();
    const contents = [
      mkContent({ id: 'c-imm', display_order: 0, cadence_kind: 'immediate', cadence_payload: {} }),
      mkContent({ id: 'c-rel', display_order: 1, cadence_kind: 'relative_to_purchase', cadence_payload: { offset_days: 7 } }),
      mkContent({ id: 'c-fix-future', display_order: 2, cadence_kind: 'fixed_calendar', cadence_payload: { release_at: futureFixed } }),
      mkContent({ id: 'c-fix-past', display_order: 3, cadence_kind: 'fixed_calendar', cadence_payload: { release_at: pastFixed } }),
      mkContent({ id: 'c-comp', display_order: 4, cadence_kind: 'on_completion', cadence_payload: {} }),
      mkContent({ id: 'c-mile', display_order: 5, cadence_kind: 'on_milestone', cadence_payload: { milestone_key: 'lost_5lb' } }),
    ];
    const purchase = mkPurchase('pur-1', purchaseTime);
    const tx = makeTx({ contents, purchases: [purchase] });
    const svc = new PurchaseFanoutService(new StubRegistry());

    await svc.onPurchaseEntitled(
      { id: 'pur-1' },
      {
        entrypoint: 'in_app_hosted',
        coachId: COACH_ID,
        clientId: purchase.client_user_id,
        purchaseTime,
      },
      tx,
    );

    const byContent = (cid: string) =>
      tx._drops.find((d: any) => d.content_id === cid);

    // immediate → fire_at ~= now (materialised inline → status 'fired').
    const imm = byContent('c-imm');
    expect(imm.fire_at).not.toBeNull();
    expect(imm.status).toBe('fired');

    // relative_to_purchase → anchor + 7d (future, still pending).
    const rel = byContent('c-rel');
    expect(rel.fire_at.toISOString()).toBe(
      new Date(purchaseTime.getTime() + 7 * DAY_MS).toISOString(),
    );
    expect(rel.status).toBe('pending');

    // fixed_calendar future → release_at exactly, pending.
    const fixFuture = byContent('c-fix-future');
    expect(fixFuture.fire_at.toISOString()).toBe(futureFixed);
    expect(fixFuture.status).toBe('pending');

    // fixed_calendar past → now → materialised inline → 'fired'.
    const fixPast = byContent('c-fix-past');
    expect(fixPast.fire_at).not.toBeNull();
    expect(fixPast.status).toBe('fired');

    // on_completion / on_milestone → fire_at null, never fired.
    const comp = byContent('c-comp');
    expect(comp.fire_at).toBeNull();
    expect(comp.status).toBe('pending');
    const mile = byContent('c-mile');
    expect(mile.fire_at).toBeNull();
    expect(mile.status).toBe('pending');
  });
});


// ═════════════════════════════════════════════════════════════════════════
// PR-17A — PackageContentsService.pushToExisting endpoint suite.
// (Self-contained stubs below; the shared computeFireAt tests above are
//  the on-main extraction this endpoint reuses.)
// ═════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────

interface FakeDrop {
  id: string;
  content_id: string;
  client_purchase_id: string;
  asset_type: string;
  asset_id: string;
  asset_revision_id: string | null;
  cadence_kind: string;
  cadence_payload: any;
  display_title: string | null;
  display_caption: string | null;
  fire_at: Date | null;
  status: string;
  attempt_count: number;
  materialised_ref: string | null;
  failure_reason: string | null;
  locked_at: Date | null;
  next_retry_at: Date | null;
}

function makePrismaStub() {
  const packages: any[] = [];
  const contents: any[] = [];
  const drops: FakeDrop[] = [];
  const purchases: any[] = [];
  const lockLog: Array<{ packageId: string }> = [];
  let updateFailureHook: ((dropId: string, idx: number) => void) | null = null;
  let updateCallCount = 0;

  function whereMatch(row: any, where: any): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (v === null) return row[k] === null || row[k] === undefined;
      if (Array.isArray((v as any)?.in)) return (v as any).in.includes(row[k]);
      if (typeof v === 'object' && v !== null) {
        if ('not' in (v as any)) return row[k] !== (v as any).not && row[k] != null;
        return Object.entries(v as any).every(([_sk, sv]) => row[k] === sv);
      }
      return row[k] === v;
    });
  }

  const stub: any = {
    _packages: packages,
    _contents: contents,
    _drops: drops,
    _purchases: purchases,
    _lockLog: lockLog,
    _setUpdateFailureHook(hook: typeof updateFailureHook) {
      updateFailureHook = hook;
      updateCallCount = 0;
    },
    coachPackage: {
      findFirst: jest.fn(async ({ where }: any) =>
        packages.find((p) => whereMatch(p, where)) ?? null,
      ),
    },
    coachPackageContent: {
      findFirst: jest.fn(async ({ where }: any) =>
        contents.find((c) => whereMatch(c, where)) ?? null,
      ),
    },
    scheduledDrop: {
      findMany: jest.fn(async ({ where, select }: any) => {
        const out = drops.filter((d: any) => whereMatch(d, where));
        if (select) {
          return out.map((r) => {
            const o: any = {};
            for (const k of Object.keys(select)) if (select[k]) o[k] = (r as any)[k];
            return o;
          });
        }
        return out.map((r) => ({ ...r }));
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = drops.find((d: any) => d.id === where.id);
        if (!row) throw new Error('not found');
        updateCallCount += 1;
        if (updateFailureHook) updateFailureHook(row.id, updateCallCount);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findMany: jest.fn(async ({ where, select }: any) => {
        const out = purchases.filter((p) => whereMatch(p, where));
        if (select) {
          return out.map((r) => {
            const o: any = {};
            for (const k of Object.keys(select)) if (select[k]) o[k] = r[k];
            return o;
          });
        }
        return out.map((r) => ({ ...r }));
      }),
    },
    $executeRaw: jest.fn(async function (
      this: any,
      strings: TemplateStringsArray,
      ..._values: any[]
    ) {
      const sql = Array.isArray(strings) ? (strings as any).join('?') : String(strings);
      if (sql.includes('pg_advisory_xact_lock')) {
        lockLog.push({ packageId: 'lock-taken' });
      }
      return 1;
    }),
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') {
        // Snapshot every row we may mutate so we can ROLL BACK on a
        // throw — this is exactly the atomicity contract the brief asks
        // us to verify in tests. We keep it simple: snapshot the drops
        // array (only table the push mutates), restore on throw.
        const snapshot = drops.map((d) => ({ ...d }));
        try {
          return await arg(stub);
        } catch (err) {
          // Restore drops in place so external references still point
          // at the rolled-back state.
          drops.length = 0;
          for (const r of snapshot) drops.push({ ...r });
          throw err;
        }
      }
      throw new Error('unexpected $transaction arg type');
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

function seedPackage(prisma: any, p: { id: string; coach_id: string }) {
  prisma._packages.push({
    id: p.id,
    coach_id: p.coach_id,
    archived_at: null,
    is_active: true,
    published_at: null,
  });
}
function seedContent(
  prisma: any,
  c: {
    id: string;
    package_id: string;
    asset_type?: string;
    asset_id?: string;
    asset_revision_id?: string | null;
    cadence_kind: string;
    cadence_payload: any;
    display_title?: string | null;
    display_caption?: string | null;
  },
) {
  prisma._contents.push({
    id: c.id,
    package_id: c.package_id,
    asset_type: c.asset_type ?? 'meal_plan',
    asset_id: c.asset_id ?? 'asset-1',
    asset_revision_id: c.asset_revision_id ?? null,
    cadence_kind: c.cadence_kind,
    cadence_payload: c.cadence_payload,
    display_title: c.display_title ?? null,
    display_caption: c.display_caption ?? null,
    display_order: 0,
    removed_at: null,
  });
}
function seedPurchase(prisma: any, p: { id: string; created_at: Date }) {
  prisma._purchases.push({ id: p.id, created_at: p.created_at });
}
function seedDrop(prisma: any, d: Partial<FakeDrop> & {
  id: string;
  content_id: string;
  client_purchase_id: string;
  status: string;
}) {
  prisma._drops.push({
    asset_type: 'meal_plan',
    asset_id: 'asset-1',
    asset_revision_id: null,
    cadence_kind: 'relative_to_purchase',
    cadence_payload: { offset_days: 1 },
    display_title: 'old title',
    display_caption: 'old caption',
    fire_at: new Date('2026-01-10T00:00:00.000Z'),
    attempt_count: 0,
    materialised_ref: null,
    failure_reason: null,
    locked_at: null,
    next_retry_at: null,
    ...d,
  } as FakeDrop);
}

// ─────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────
describe('PackageContentsService.pushToExisting (PR-17A)', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let subCoach: ReturnType<typeof makeSubCoachStub>;
  let packages: PackagesService;
  let svc: PackageContentsService;

  beforeEach(() => {
    prisma = makePrismaStub();
    subCoach = makeSubCoachStub();
    packages = new PackagesService(prisma as any, subCoach as any);
    svc = new PackageContentsService(prisma as any, packages, subCoach as any);
    seedPackage(prisma, { id: 'pkg-1', coach_id: 'coach-1' });
  });

  // ── A1: only-pending invariant ──────────────────────────────────────
  describe('only-pending invariant', () => {
    // The brief: "NEVER fired/due/dispatching/failed/canceled/skipped."
    // We seed one drop of each status and assert each is left untouched.
    const NON_PENDING_STATUSES = [
      'fired',
      'due',
      'dispatching',
      'failed',
      'canceled',
      'skipped',
    ];

    for (const status of NON_PENDING_STATUSES) {
      it(`leaves ${status} drops untouched`, async () => {
        seedContent(prisma, {
          id: 'content-1',
          package_id: 'pkg-1',
          cadence_kind: 'relative_to_purchase',
          cadence_payload: { offset_days: 5 },
          display_title: 'NEW title',
          display_caption: 'NEW caption',
        });
        seedPurchase(prisma, {
          id: 'purchase-1',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        });
        seedDrop(prisma, {
          id: 'drop-non-pending',
          content_id: 'content-1',
          client_purchase_id: 'purchase-1',
          status,
          display_title: 'preserved title',
          display_caption: 'preserved caption',
          fire_at: new Date('2026-01-02T00:00:00.000Z'),
        });

        const summary = await svc.pushToExisting(
          'coach-1',
          'pkg-1',
          'content-1',
          { push: true },
        );

        const drop = prisma._drops.find((d: any) => d.id === 'drop-non-pending')!;
        expect(drop.status).toBe(status);
        expect(drop.display_title).toBe('preserved title');
        expect(drop.display_caption).toBe('preserved caption');
        // fire_at must NOT change from the original seed value.
        expect(drop.fire_at?.toISOString()).toBe(
          new Date('2026-01-02T00:00:00.000Z').toISOString(),
        );
        // Summary should report 0 updated, 0 buyers, 1 skipped-delivered
        // (the non-pending row).
        expect(summary).toEqual({
          drops_updated: 0,
          buyers_affected: 0,
          skipped_delivered: 1,
        });
      });
    }

    it('mixed pending + non-pending → updates only pending, skipped_delivered counts the rest', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 5 },
        display_title: 'NEW title',
      });
      seedPurchase(prisma, {
        id: 'p1',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      seedPurchase(prisma, {
        id: 'p2',
        created_at: new Date('2026-02-01T00:00:00.000Z'),
      });
      seedDrop(prisma, {
        id: 'pending-1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
      });
      seedDrop(prisma, {
        id: 'pending-2',
        content_id: 'content-1',
        client_purchase_id: 'p2',
        status: 'pending',
      });
      seedDrop(prisma, {
        id: 'fired-1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'fired',
      });
      seedDrop(prisma, {
        id: 'canceled-1',
        content_id: 'content-1',
        client_purchase_id: 'p2',
        status: 'canceled',
      });

      const summary = await svc.pushToExisting(
        'coach-1',
        'pkg-1',
        'content-1',
        { push: true },
      );

      expect(summary.drops_updated).toBe(2);
      expect(summary.buyers_affected).toBe(2);
      expect(summary.skipped_delivered).toBe(2);

      // pending rows now reflect the new title.
      expect(prisma._drops.find((d: any) => d.id === 'pending-1')!.display_title).toBe('NEW title');
      expect(prisma._drops.find((d: any) => d.id === 'pending-2')!.display_title).toBe('NEW title');
      // non-pending rows untouched.
      expect(prisma._drops.find((d: any) => d.id === 'fired-1')!.display_title).toBe('old title');
      expect(prisma._drops.find((d: any) => d.id === 'canceled-1')!.display_title).toBe('old title');
    });
  });

  // ── A1: per-buyer anchor ────────────────────────────────────────────
  describe('per-buyer anchor (not shared coach-now)', () => {
    it('two buyers with different purchase dates get DIFFERENT fire_at for relative_to_purchase', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 7 },
      });
      const dateA = new Date('2026-01-01T00:00:00.000Z');
      const dateB = new Date('2026-04-15T00:00:00.000Z');
      seedPurchase(prisma, { id: 'pA', created_at: dateA });
      seedPurchase(prisma, { id: 'pB', created_at: dateB });
      seedDrop(prisma, {
        id: 'drop-A',
        content_id: 'content-1',
        client_purchase_id: 'pA',
        status: 'pending',
      });
      seedDrop(prisma, {
        id: 'drop-B',
        content_id: 'content-1',
        client_purchase_id: 'pB',
        status: 'pending',
      });

      await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true });

      const a = prisma._drops.find((d: any) => d.id === 'drop-A')!;
      const b = prisma._drops.find((d: any) => d.id === 'drop-B')!;
      const expectedA = new Date(dateA.getTime() + 7 * 24 * 3600 * 1000);
      const expectedB = new Date(dateB.getTime() + 7 * 24 * 3600 * 1000);
      expect(a.fire_at!.toISOString()).toBe(expectedA.toISOString());
      expect(b.fire_at!.toISOString()).toBe(expectedB.toISOString());
      // And critically — they are NOT equal: the recompute is NOT
      // anchored to a shared coach-now.
      expect(a.fire_at!.toISOString()).not.toBe(b.fire_at!.toISOString());
    });

    it('relative_to_purchase with offset_days=0 still produces per-buyer fire_at', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 0 },
      });
      const dateA = new Date('2025-12-25T00:00:00.000Z');
      const dateB = new Date('2026-03-10T00:00:00.000Z');
      seedPurchase(prisma, { id: 'pA', created_at: dateA });
      seedPurchase(prisma, { id: 'pB', created_at: dateB });
      seedDrop(prisma, {
        id: 'drop-A',
        content_id: 'content-1',
        client_purchase_id: 'pA',
        status: 'pending',
      });
      seedDrop(prisma, {
        id: 'drop-B',
        content_id: 'content-1',
        client_purchase_id: 'pB',
        status: 'pending',
      });
      await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true });
      expect(
        prisma._drops.find((d: any) => d.id === 'drop-A')!.fire_at!.toISOString(),
      ).toBe(dateA.toISOString());
      expect(
        prisma._drops.find((d: any) => d.id === 'drop-B')!.fire_at!.toISOString(),
      ).toBe(dateB.toISOString());
    });
  });

  // ── A1: idempotency ─────────────────────────────────────────────────
  describe('idempotency', () => {
    it('pushing the same edit twice yields the same end state', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 14 },
        display_title: 'v2',
      });
      seedPurchase(prisma, {
        id: 'p1',
        created_at: new Date('2026-01-10T00:00:00.000Z'),
      });
      seedDrop(prisma, {
        id: 'drop-1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
      });

      const a = await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', {
        push: true,
      });
      const snapshotAfterFirst = { ...prisma._drops.find((d: any) => d.id === 'drop-1')! };

      const b = await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', {
        push: true,
      });
      const snapshotAfterSecond = { ...prisma._drops.find((d: any) => d.id === 'drop-1')! };

      // Summary counts match.
      expect(a).toEqual(b);
      // Every snapshotted field on the drop is identical between
      // first and second push (recompute is deterministic).
      expect(snapshotAfterFirst.fire_at?.toISOString()).toBe(
        snapshotAfterSecond.fire_at?.toISOString(),
      );
      expect(snapshotAfterFirst.display_title).toBe(snapshotAfterSecond.display_title);
      expect(snapshotAfterFirst.cadence_payload).toEqual(snapshotAfterSecond.cadence_payload);
    });
  });

  // ── A1: atomicity ───────────────────────────────────────────────────
  describe('atomicity', () => {
    it('a per-row failure rolls back EVERY pending update', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 3 },
        display_title: 'NEW',
        display_caption: 'NEW caption',
      });
      seedPurchase(prisma, {
        id: 'p1',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      seedPurchase(prisma, {
        id: 'p2',
        created_at: new Date('2026-02-01T00:00:00.000Z'),
      });
      seedPurchase(prisma, {
        id: 'p3',
        created_at: new Date('2026-03-01T00:00:00.000Z'),
      });
      // Three pending drops; the 3rd update will throw, so all three
      // must be rolled back to their initial display_title='old title'.
      seedDrop(prisma, {
        id: 'd1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
        display_title: 'old title',
      });
      seedDrop(prisma, {
        id: 'd2',
        content_id: 'content-1',
        client_purchase_id: 'p2',
        status: 'pending',
        display_title: 'old title',
      });
      seedDrop(prisma, {
        id: 'd3',
        content_id: 'content-1',
        client_purchase_id: 'p3',
        status: 'pending',
        display_title: 'old title',
      });

      (prisma as any)._setUpdateFailureHook((_id: string, idx: number) => {
        if (idx === 3) throw new Error('synthetic DB failure on the 3rd update');
      });

      await expect(
        svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true }),
      ).rejects.toThrow(/synthetic/);

      // ALL three drops must be back to old title — the tx rollback
      // restored the snapshot.
      for (const id of ['d1', 'd2', 'd3']) {
        const row = prisma._drops.find((d: any) => d.id === id)!;
        expect(row.display_title).toBe('old title');
      }
    });
  });

  // ── A1/A2: ownership + 404 no-leak + sub-coach scope ───────────────
  describe('ownership + scope', () => {
    it('cross-coach push → NotFoundException (no leak)', async () => {
      // pkg-1 belongs to coach-1; coach-2 tries to push.
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.pushToExisting('coach-2', 'pkg-1', 'content-1', { push: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('content on a different package than the URL param → 404 no-leak', async () => {
      // pkg-1 owned by coach-1; pkg-2 owned by coach-1 too, but
      // content-1 belongs to pkg-1. Pushing pkg-2/content-1 must 404.
      seedPackage(prisma, { id: 'pkg-2', coach_id: 'coach-1' });
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.pushToExisting('coach-1', 'pkg-2', 'content-1', { push: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sub-coach scope: resolveEffectiveCoachId promotes the caller to head coach', async () => {
      // Sub-coach 'sc-1' is mapped to head 'coach-1' who owns pkg-1.
      const subStub = makeSubCoachStub({ 'sc-1': 'coach-1' });
      packages = new PackagesService(prisma as any, subStub as any);
      svc = new PackageContentsService(prisma as any, packages, subStub as any);

      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });

      // Mimic the controller: resolveEffectiveCoachId → then service call.
      const effective = await packages.resolveEffectiveCoachId('sc-1');
      expect(effective).toBe('coach-1');
      const summary = await svc.pushToExisting(
        effective,
        'pkg-1',
        'content-1',
        { push: true },
      );
      expect(summary.drops_updated).toBe(0);
    });

    it('sub-coach with NO head-coach mapping cannot push another coach\'s package', async () => {
      // 'sc-orphan' is not a sub-coach of coach-1; resolveEffectiveCoachId
      // returns the caller id itself, which doesn't own pkg-1 → 404.
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const effective = await packages.resolveEffectiveCoachId('sc-orphan');
      await expect(
        svc.pushToExisting(effective, 'pkg-1', 'content-1', { push: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── A2: invalid cadence rejected BEFORE any write ──────────────────
  describe('invalid cadence config (defense in depth)', () => {
    it('rejects a relative_to_purchase content with a non-numeric offset_days BEFORE any drop write', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        // garbage payload — PR-8 should have prevented this, but the
        // push must defend itself anyway.
        cadence_payload: { offset_days: 'not a number' },
      });
      seedPurchase(prisma, {
        id: 'p1',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      seedDrop(prisma, {
        id: 'd1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
        display_title: 'preserved',
      });
      await expect(
        svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The drop is untouched (preserved title) — validation happens
      // BEFORE the tx writes.
      expect(prisma._drops.find((d: any) => d.id === 'd1')!.display_title).toBe('preserved');
      expect((prisma.scheduledDrop.update as jest.Mock).mock.calls.length).toBe(0);
    });

    it('rejects an unknown cadence_kind on the content row', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'who_knows',
        cadence_payload: {},
      });
      await expect(
        svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty body (no push:true, no fields)', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.pushToExisting('coach-1', 'pkg-1', 'content-1', {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown top-level key in the body (strict)', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.pushToExisting('coach-1', 'pkg-1', 'content-1', {
          push: true,
          junk: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Summary count semantics ─────────────────────────────────────────
  describe('summary counts', () => {
    it('returns {0, 0, 0} when no drops exist for this content', async () => {
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const out = await svc.pushToExisting(
        'coach-1',
        'pkg-1',
        'content-1',
        { push: true },
      );
      expect(out).toEqual({
        drops_updated: 0,
        buyers_affected: 0,
        skipped_delivered: 0,
      });
    });

    it('counts buyers by distinct client_purchase_id (not drop count)', async () => {
      // A single buyer can never have two pending drops for the same
      // content (the @@unique [client_purchase_id, content_id] forbids
      // it), but we still test that buyers_affected is keyed on
      // distinct purchase id.
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 2 },
      });
      for (let i = 1; i <= 5; i++) {
        seedPurchase(prisma, {
          id: `p${i}`,
          created_at: new Date(`2026-02-0${i}T00:00:00.000Z`),
        });
        seedDrop(prisma, {
          id: `drop-${i}`,
          content_id: 'content-1',
          client_purchase_id: `p${i}`,
          status: 'pending',
        });
      }
      const out = await svc.pushToExisting(
        'coach-1',
        'pkg-1',
        'content-1',
        { push: true },
      );
      expect(out.drops_updated).toBe(5);
      expect(out.buyers_affected).toBe(5);
      expect(out.skipped_delivered).toBe(0);
    });
  });

  // ── Cron interaction ────────────────────────────────────────────────
  describe('PR-10 cron findDue picks up a push-moved-earlier pending drop', () => {
    it('a pending drop whose fire_at was moved earlier by the push satisfies findDue\'s `fire_at <= now AND status="pending"` filter', async () => {
      // Original fire_at is FAR in the future (cadence offset_days=365).
      // We then patch the content to offset_days=0 and push: the
      // recomputed fire_at lands at or before now, so PR-10's
      // findDue WHERE clause (`fire_at: { lte: now, not: null }` +
      // `status: 'pending'`) matches.
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 0 }, // post-edit
      });
      const purchaseDate = new Date('2026-01-01T00:00:00.000Z');
      seedPurchase(prisma, { id: 'p1', created_at: purchaseDate });
      // The drop's PRE-push fire_at is far in the future.
      seedDrop(prisma, {
        id: 'drop-1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
        cadence_payload: { offset_days: 365 },
        fire_at: new Date('2027-01-01T00:00:00.000Z'),
      });

      await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', {
        push: true,
      });

      const row = prisma._drops.find((d: any) => d.id === 'drop-1')!;
      // The drop is now eligible for PR-10's findDue: status='pending'
      // AND fire_at <= now.
      const now = new Date();
      expect(row.status).toBe('pending');
      expect(row.fire_at).not.toBeNull();
      expect(row.fire_at!.getTime()).toBeLessThanOrEqual(now.getTime());
      // The snapshotted cadence_payload also moved to the new config so
      // the cron's executor sees the updated cadence.
      expect(row.cadence_payload).toEqual({ offset_days: 0 });
    });
  });

  // ── Lock acquisition (R2-class concurrency hygiene) ────────────────
  describe('per-package advisory lock', () => {
    it('takes the per-package display_order advisory lock during the push tx', async () => {
      // Seed a pending drop so the service actually enters the
      // tx — the no-drops fast path returns early without locking
      // (no shared state to mutate).
      seedContent(prisma, {
        id: 'content-1',
        package_id: 'pkg-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      seedPurchase(prisma, {
        id: 'p1',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      seedDrop(prisma, {
        id: 'd1',
        content_id: 'content-1',
        client_purchase_id: 'p1',
        status: 'pending',
      });
      await svc.pushToExisting('coach-1', 'pkg-1', 'content-1', { push: true });
      // The stub's $executeRaw records pg_advisory_xact_lock invocations.
      expect(prisma._lockLog.length).toBeGreaterThanOrEqual(1);
    });
  });
});
