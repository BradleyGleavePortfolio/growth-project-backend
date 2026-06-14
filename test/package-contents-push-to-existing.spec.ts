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
