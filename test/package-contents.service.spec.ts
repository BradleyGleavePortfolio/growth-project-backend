import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';
import { PackageContentsService } from '../src/packages/package-contents.service';

// PR-8 tests — Coach package CONTENTS authoring service. Covers:
//   - the discriminated-union zod schema per cadence_kind (accept valid,
//     reject wrong payload, reject unknown keys),
//   - attach/list/patch/soft-delete round-trip (list excludes removed),
//   - IDOR (caller can't touch another coach's package or attach another
//     coach's asset),
//   - display_order append + reorder,
//   - auto_message body contract (matches PR-7 resolver).

// ─────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────
function makePrismaStub() {
  const packages: any[] = [];
  const contents: any[] = [];
  const workoutPlans: any[] = [];
  const mealPlans: any[] = [];
  const mediaAssets: any[] = [];
  const lockLog: Array<{ packageId: string }> = [];
  // Per-packageId mutex chain. Each lock acquisition appends to the
  // queue; the next caller awaits the head before resolving. Lock is
  // "released" (chain head pops) when the surrounding $transaction
  // callback finishes — see the $transaction stub below.
  const lockChains = new Map<string, Promise<void>>();
  const lockReleasers = new Map<Promise<void>, () => void>();

  function filterMatch(row: any, where: any): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (v === null) return row[k] === null || row[k] === undefined;
      if (typeof v === 'object' && v !== null) {
        return Object.entries(v as any).every(([sk, sv]) => {
          if (sk === 'not') return row[k] !== sv && row[k] != null;
          return row[k] === sv;
        });
      }
      return row[k] === v;
    });
  }

  const stub: any = {
    _packages: packages,
    _contents: contents,
    _workoutPlans: workoutPlans,
    _mealPlans: mealPlans,
    _mediaAssets: mediaAssets,
    _lockLog: lockLog,
    coachPackage: {
      findFirst: jest.fn(async ({ where }: any) =>
        packages.find((p) => filterMatch(p, where)) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    coachPackageContent: {
      findMany: jest.fn(async ({ where, orderBy, select }: any) => {
        let out = contents.filter((c) => filterMatch(c, where));
        if (orderBy?.display_order === 'asc') {
          out = [...out].sort((a, b) => a.display_order - b.display_order);
        }
        if (select) {
          return out.map((r) => {
            const o: any = {};
            for (const k of Object.keys(select)) if (select[k]) o[k] = r[k];
            return o;
          });
        }
        return out.map((r) => ({ ...r }));
      }),
      findFirst: jest.fn(async ({ where, orderBy, select }: any) => {
        let matches = contents.filter((c) => filterMatch(c, where));
        if (orderBy?.display_order === 'desc') {
          matches = [...matches].sort((a, b) => b.display_order - a.display_order);
        }
        const row = matches[0] ?? null;
        if (!row) return null;
        if (select) {
          const o: any = {};
          for (const k of Object.keys(select)) if (select[k]) o[k] = row[k];
          return o;
        }
        return { ...row };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `c-${contents.length + 1}`,
          asset_revision_id: null,
          display_order: 0,
          display_title: null,
          display_caption: null,
          removed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        contents.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = contents.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
    },
    workoutPlan: {
      findFirst: jest.fn(async ({ where }: any) =>
        workoutPlans.find((p) => filterMatch(p, where)) ?? null,
      ),
    },
    dailyMealPlan: {
      findFirst: jest.fn(async ({ where }: any) =>
        mealPlans.find((p) => filterMatch(p, where)) ?? null,
      ),
    },
    coachMediaAsset: {
      findFirst: jest.fn(async ({ where }: any) =>
        mediaAssets.find((p) => filterMatch(p, where)) ?? null,
      ),
    },
    $executeRaw: jest.fn(async function (
      this: any,
      strings: TemplateStringsArray,
      ...values: any[]
    ) {
      const sql = Array.isArray(strings)
        ? (strings as any).join('?')
        : String(strings);
      if (sql.includes('pg_advisory_xact_lock')) {
        const packageId = values[1] as string;
        lockLog.push({ packageId });
        // Block on the prior holder (if any) of this packageId's lock.
        const prior = lockChains.get(packageId);
        // Create our own promise that the surrounding tx will resolve to
        // release the next caller. Stored on the tx handle (`this`) so
        // the $transaction wrapper can find it on completion.
        let release!: () => void;
        const held = new Promise<void>((res) => {
          release = res;
        });
        lockChains.set(packageId, held);
        lockReleasers.set(held, release);
        // Record on the tx handle (`this`) so $transaction can release.
        const holds: Array<{ packageId: string; held: Promise<void> }> =
          this._heldLocks ?? (this._heldLocks = []);
        holds.push({ packageId, held });
        if (prior) await prior;
      }
      return 1;
    }),
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) {
        const out: any[] = [];
        for (const op of arg) out.push(await op);
        return out;
      }
      if (typeof arg === 'function') {
        // Interactive tx: hand the same stub back as the tx-client. The
        // service only reaches for table-clients + $executeRaw on the
        // tx handle, which our stub satisfies. We attach a per-call
        // _heldLocks array so $executeRaw can register lock holders;
        // when the callback resolves, we release them in order so the
        // next caller can proceed. xact-scoped lock semantics.
        const txHandle: any = Object.create(stub);
        txHandle._heldLocks = [];
        try {
          return await arg(txHandle);
        } finally {
          // Release every lock this tx acquired, in LIFO order. xact
          // commit/rollback releases everything in one shot.
          for (const { packageId, held } of [...txHandle._heldLocks].reverse()) {
            const release = lockReleasers.get(held);
            if (release) release();
            lockReleasers.delete(held);
            // Only clear the chain head if it still points at our held
            // promise — otherwise a later attacher has already chained
            // behind us and owns the chain now.
            if (lockChains.get(packageId) === held) {
              lockChains.delete(packageId);
            }
          }
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

// Helpers to seed.
function seedPackage(prisma: any, p: { id: string; coach_id: string }) {
  prisma._packages.push({
    id: p.id,
    coach_id: p.coach_id,
    archived_at: null,
    is_active: true,
    published_at: null,
  });
}
function seedWorkoutPlan(prisma: any, p: { id: string; coach_id: string }) {
  prisma._workoutPlans.push({
    id: p.id,
    coach_id: p.coach_id,
    archived_at: null,
  });
}
function seedMealPlan(prisma: any, p: { id: string; coach_id: string }) {
  prisma._mealPlans.push({
    id: p.id,
    coach_id: p.coach_id,
    archived_at: null,
  });
}
function seedMediaAsset(
  prisma: any,
  p: { id: string; coach_id: string; kind: 'pdf' | 'video' },
) {
  prisma._mediaAssets.push({
    id: p.id,
    coach_id: p.coach_id,
    kind: p.kind,
    archived_at: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────
describe('PackageContentsService', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let subCoach: ReturnType<typeof makeSubCoachStub>;
  let packages: PackagesService;
  let svc: PackageContentsService;

  beforeEach(() => {
    prisma = makePrismaStub();
    subCoach = makeSubCoachStub();
    packages = new PackagesService(prisma as any, subCoach as any);
    svc = new PackageContentsService(prisma as any, packages);
    seedPackage(prisma, { id: 'pkg-1', coach_id: 'coach-1' });
    seedWorkoutPlan(prisma, { id: 'wp-1', coach_id: 'coach-1' });
    seedMealPlan(prisma, { id: 'mp-1', coach_id: 'coach-1' });
    seedMediaAsset(prisma, { id: 'pdf-1', coach_id: 'coach-1', kind: 'pdf' });
    seedMediaAsset(prisma, { id: 'vid-1', coach_id: 'coach-1', kind: 'video' });
  });

  // ── cadence validation ───────────────────────────────────────────────
  describe('cadence validation (zod discriminated union)', () => {
    it('accepts immediate with empty payload', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(row.cadence_kind).toBe('immediate');
      expect(row.display_order).toBe(0);
    });

    it('rejects immediate with extra keys (strict)', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'immediate',
          cadence_payload: { offset_days: 3 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts relative_to_purchase with offset_days', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 7 },
      });
      expect((row.cadence_payload as any).offset_days).toBe(7);
    });

    it('rejects relative_to_purchase with negative offset_days', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'relative_to_purchase',
          cadence_payload: { offset_days: -1 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects relative_to_purchase with wrong payload shape', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'relative_to_purchase',
          cadence_payload: { release_at: '2030-01-01T00:00:00Z' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts fixed_calendar with ISO release_at', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'fixed_calendar',
        cadence_payload: { release_at: '2030-01-01T00:00:00.000Z' },
      });
      expect((row.cadence_payload as any).release_at).toMatch(/2030-01-01/);
    });

    it('rejects fixed_calendar with non-ISO release_at', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'fixed_calendar',
          cadence_payload: { release_at: 'not-a-date' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts on_completion with empty payload', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'on_completion',
        cadence_payload: {},
      });
      expect(row.cadence_kind).toBe('on_completion');
    });

    it('accepts on_completion with depends_on_content_id', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'on_completion',
        cadence_payload: { depends_on_content_id: 'c-prior' },
      });
      expect((row.cadence_payload as any).depends_on_content_id).toBe('c-prior');
    });

    it('accepts on_milestone with milestone_key', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'on_milestone',
        cadence_payload: { milestone_key: 'week_1_complete' },
      });
      expect((row.cadence_payload as any).milestone_key).toBe('week_1_complete');
    });

    it('rejects on_milestone without milestone_key', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'on_milestone',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown cadence_kind', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'martian',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown top-level keys (strict)', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'immediate',
          cadence_payload: {},
          surprise: 'extra',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unknown payload keys for relative_to_purchase', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'relative_to_purchase',
          cadence_payload: { offset_days: 7, extra: true },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── round-trip CRUD ──────────────────────────────────────────────────
  describe('attach/list/patch/soft-delete round-trip', () => {
    it('list returns rows ordered by display_order, excludes removed', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(a.display_order).toBe(0);
      expect(b.display_order).toBe(1);
      let list = await svc.listForPackage('coach-1', 'pkg-1');
      expect(list.map((r) => r.id)).toEqual([a.id, b.id]);

      await svc.softDelete('coach-1', 'pkg-1', a.id);
      list = await svc.listForPackage('coach-1', 'pkg-1');
      expect(list.map((r) => r.id)).toEqual([b.id]);
    });

    it('patch updates cadence as a pair and rejects partial', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const updated = await svc.patch('coach-1', 'pkg-1', a.id, {
        cadence_kind: 'relative_to_purchase',
        cadence_payload: { offset_days: 3 },
      });
      expect(updated.cadence_kind).toBe('relative_to_purchase');
      expect((updated.cadence_payload as any).offset_days).toBe(3);

      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, {
          cadence_kind: 'fixed_calendar',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, {
          cadence_payload: { offset_days: 4 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch rejects unknown keys (strict)', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, { surprise: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('softDelete is idempotent', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const first = await svc.softDelete('coach-1', 'pkg-1', a.id);
      const removedAt = first.removed_at;
      expect(removedAt).not.toBeNull();
      const second = await svc.softDelete('coach-1', 'pkg-1', a.id);
      expect(second.removed_at).toEqual(removedAt);
    });

    it('patch on a non-existent content id 404s', async () => {
      await expect(
        svc.patch('coach-1', 'pkg-1', 'nope', { display_order: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── IDOR / sub-coach scope ───────────────────────────────────────────
  describe('IDOR & cross-coach refusal', () => {
    beforeEach(() => {
      seedPackage(prisma, { id: 'pkg-2', coach_id: 'coach-2' });
      seedWorkoutPlan(prisma, { id: 'wp-2', coach_id: 'coach-2' });
    });

    it("coach-1 cannot attach to coach-2's package", async () => {
      await expect(
        svc.attach('coach-1', 'pkg-2', {
          asset_type: 'workout_plan',
          asset_id: 'wp-1',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach-1 cannot list coach-2's package contents", async () => {
      await expect(
        svc.listForPackage('coach-1', 'pkg-2'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach-1 cannot attach coach-2's workout asset to their own package", async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'workout_plan',
          asset_id: 'wp-2',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach-1 cannot attach a meal_plan owned by another coach", async () => {
      seedMealPlan(prisma, { id: 'mp-2', coach_id: 'coach-2' });
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'meal_plan',
          asset_id: 'mp-2',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach-1 cannot attach a pdf media_asset owned by another coach", async () => {
      seedMediaAsset(prisma, { id: 'pdf-2', coach_id: 'coach-2', kind: 'pdf' });
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'pdf',
          asset_id: 'pdf-2',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses pdf attach when CoachMediaAsset row missing (PR-12 not shipped)', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'pdf',
          asset_id: 'missing-pdf',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── display_order append + reorder ───────────────────────────────────
  describe('display_order append + reorder', () => {
    it('appends new rows to max+1', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const c = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'pdf',
        asset_id: 'pdf-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(a.display_order).toBe(0);
      expect(b.display_order).toBe(1);
      expect(c.display_order).toBe(2);
    });

    it('reorders atomically and rejects mismatched id sets', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const c = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'pdf',
        asset_id: 'pdf-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });

      const reordered = await svc.reorder('coach-1', 'pkg-1', {
        content_ids: [c.id, a.id, b.id],
      });
      expect(reordered.map((r) => r.id)).toEqual([c.id, a.id, b.id]);

      // Missing id
      await expect(
        svc.reorder('coach-1', 'pkg-1', { content_ids: [a.id, b.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Extra id
      await expect(
        svc.reorder('coach-1', 'pkg-1', {
          content_ids: [a.id, b.id, c.id, 'phantom'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Duplicates
      await expect(
        svc.reorder('coach-1', 'pkg-1', {
          content_ids: [a.id, a.id, b.id],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reorder excludes soft-deleted rows from the expected set', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await svc.softDelete('coach-1', 'pkg-1', a.id);
      const rows = await svc.reorder('coach-1', 'pkg-1', {
        content_ids: [b.id],
      });
      expect(rows.map((r) => r.id)).toEqual([b.id]);
      expect(rows[0].display_order).toBe(0);
    });
  });

  // ── auto_message contract (matches PR-7 resolver) ────────────────────
  describe('auto_message body contract (PR-7 alignment)', () => {
    it('rejects attach without display_caption AND display_title', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'auto_message',
          asset_id: 'template-or-sentinel',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects attach with only whitespace in title/caption', async () => {
      await expect(
        svc.attach('coach-1', 'pkg-1', {
          asset_type: 'auto_message',
          asset_id: 'template-or-sentinel',
          display_caption: '   ',
          display_title: '   ',
          cadence_kind: 'immediate',
          cadence_payload: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts attach with display_caption (preferred body source)', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'auto_message',
        asset_id: 'template-or-sentinel',
        display_caption: 'Welcome to week 1!',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(row.display_caption).toBe('Welcome to week 1!');
    });

    it('accepts attach with only display_title (fallback body source)', async () => {
      const row = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'auto_message',
        asset_id: 'template-or-sentinel',
        display_title: 'Day 1 check-in',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(row.display_title).toBe('Day 1 check-in');
    });

    it('rejects patch that would clear the auto_message body to empty', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'auto_message',
        asset_id: 'template-or-sentinel',
        display_caption: 'hello',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, {
          display_caption: null,
          display_title: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── sub-coach scope ──────────────────────────────────────────────────
  describe('sub-coach scope (resolveEffectiveCoachId)', () => {
    it('promotes sub-coach to head coach when attaching', async () => {
      subCoach.getHeadCoachIdForSubCoach.mockResolvedValue('coach-1');
      const effective = await packages.resolveEffectiveCoachId('sub-1');
      const row = await svc.attach(effective, 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect(row.package_id).toBe('pkg-1');
    });
  });

  // ── concurrency / advisory-lock fix (P2-a, P2-b) ─────────────────────
  describe('display_order race fixes (per-package pg_advisory_xact_lock)', () => {
    it('attach acquires the per-package lock inside a transaction', async () => {
      await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      expect((prisma as any).$transaction).toHaveBeenCalled();
      expect((prisma as any).$executeRaw).toHaveBeenCalled();
      // The advisory-lock helper was given THIS packageId.
      expect((prisma as any)._lockLog).toEqual([{ packageId: 'pkg-1' }]);
    });

    it('reorder acquires the per-package lock inside a transaction', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      (prisma as any)._lockLog.length = 0;
      await svc.reorder('coach-1', 'pkg-1', { content_ids: [b.id, a.id] });
      expect((prisma as any)._lockLog).toEqual([{ packageId: 'pkg-1' }]);
    });

    it('concurrent attaches on the same package serialise into distinct display_order values (no duplicates)', async () => {
      // Three concurrent attaches: kicked off via Promise.all so the
      // jest-promise scheduler interleaves them. The advisory lock means
      // each one enters its read+write window with the previous attach
      // already committed, so display_order increments to 0, 1, 2 with
      // no collision.
      const inputs = ['wp-1', 'mp-1', 'pdf-1'].map((id, idx) => ({
        asset_type: ['workout_plan', 'meal_plan', 'pdf'][idx] as
          | 'workout_plan'
          | 'meal_plan'
          | 'pdf',
        asset_id: id,
        cadence_kind: 'immediate' as const,
        cadence_payload: {},
      }));
      const rows = await Promise.all(
        inputs.map((b) => svc.attach('coach-1', 'pkg-1', b)),
      );
      const orders = rows.map((r) => r.display_order).sort((a, b) => a - b);
      expect(orders).toEqual([0, 1, 2]);
      // Lock acquired once per attach.
      expect((prisma as any)._lockLog).toHaveLength(3);
      for (const e of (prisma as any)._lockLog) {
        expect(e.packageId).toBe('pkg-1');
      }
    });

    it('reorder-vs-attach interleaving (P2-b): parity read inside the tx sees the consistent set', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // Run reorder + a third attach concurrently. Both grab the same
      // per-package lock; one runs first, the other runs after. Either
      // ordering must end in a coherent state (no duplicate display_order;
      // every row in [0..N-1]).
      const reorderP = svc.reorder('coach-1', 'pkg-1', {
        content_ids: [b.id, a.id],
      });
      const attachP = svc.attach('coach-1', 'pkg-1', {
        asset_type: 'pdf',
        asset_id: 'pdf-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const [reordered] = await Promise.all([reorderP, attachP]);
      // After both: 3 non-removed rows, distinct contiguous display_order.
      const all = await svc.listForPackage('coach-1', 'pkg-1');
      expect(all).toHaveLength(3);
      const orders = all.map((r) => r.display_order).sort((a, b) => a - b);
      expect(new Set(orders).size).toBe(3);
      // The reorder result itself never includes duplicates.
      expect(new Set(reordered.map((r) => r.display_order)).size).toBe(
        reordered.length,
      );
    });
  });

  // ── P2-c (R2 audit): patch+display_order race / duplicate rejection ──
  describe('patch with display_order is locked + reject duplicates (P2-c)', () => {
    it('patch that does NOT include display_order skips the lock (cheap path)', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      (prisma as any)._lockLog.length = 0;
      await svc.patch('coach-1', 'pkg-1', a.id, {
        display_title: 'edit',
      });
      // No lock acquired for title-only patches — kept cheap.
      expect((prisma as any)._lockLog).toEqual([]);
    });

    it('patch that includes display_order acquires the per-package lock inside a transaction', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      (prisma as any)._lockLog.length = 0;
      // a is at 0, b is at 1; move a to 2 (free slot).
      await svc.patch('coach-1', 'pkg-1', a.id, { display_order: 2 });
      expect((prisma as any)._lockLog).toEqual([{ packageId: 'pkg-1' }]);
    });

    it('patch rejects display_order already held by another non-removed row (DISPLAY_ORDER_TAKEN)', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // b holds order=1; trying to set a to 1 must reject.
      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, { display_order: b.display_order }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch allows setting display_order to the row’s own current value (no-op)', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const updated = await svc.patch('coach-1', 'pkg-1', a.id, {
        display_order: a.display_order,
      });
      expect(updated.display_order).toBe(a.display_order);
    });

    it('patch ignores soft-deleted rows when checking for collisions (and 404s on soft-deleted target)', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // soft-delete b; its order=1 should now be reusable.
      await svc.softDelete('coach-1', 'pkg-1', b.id);
      const moved = await svc.patch('coach-1', 'pkg-1', a.id, {
        display_order: 1,
      });
      expect(moved.display_order).toBe(1);

      // Patch on the soft-deleted row STILL 404s, even on the locked path.
      await expect(
        svc.patch('coach-1', 'pkg-1', b.id, { display_order: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch-vs-attach interleaving: serialised; never produces duplicate display_order', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // Concurrent: move `a` to display_order=5; attach a new row (which
      // should append). Both grab the per-package lock; whichever runs
      // first commits before the other reads.
      const patchP = svc.patch('coach-1', 'pkg-1', a.id, { display_order: 5 });
      const attachP = svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await Promise.all([patchP, attachP]);
      const list = await svc.listForPackage('coach-1', 'pkg-1');
      const orders = list.map((r) => r.display_order);
      expect(new Set(orders).size).toBe(orders.length); // no duplicates
    });

    it('patch-vs-reorder interleaving: serialised; never produces duplicate display_order', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const c = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'pdf',
        asset_id: 'pdf-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // Run reorder + a patch concurrently. Either ordering must end with
      // a coherent state (no duplicate display_order). If reorder wins
      // first, the patch sees orders [0,1,2] of [c,a,b] and may collide
      // → our lock + duplicate check guarantees the collision is rejected,
      // not silently written. Either rejection or success — never a dup.
      const reorderP = svc.reorder('coach-1', 'pkg-1', {
        content_ids: [c.id, a.id, b.id],
      });
      const patchP = svc
        .patch('coach-1', 'pkg-1', a.id, { display_order: 7 })
        .catch((e) => e); // tolerate either outcome (locked sequencing)

      await Promise.all([reorderP, patchP]);
      const list = await svc.listForPackage('coach-1', 'pkg-1');
      const orders = list.map((r) => r.display_order);
      expect(new Set(orders).size).toBe(orders.length); // no duplicates
    });

    it('two concurrent patches targeting the SAME display_order on the same package: at most one wins', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const b = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'meal_plan',
        asset_id: 'mp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const c = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'pdf',
        asset_id: 'pdf-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      // Both patches target display_order=10. Lock serialises; second
      // sees the first's write and must EITHER succeed (if the second
      // patch is the row that already holds 10 — our no-op case) OR
      // reject as DISPLAY_ORDER_TAKEN. Either way: no duplicate.
      const p1 = svc.patch('coach-1', 'pkg-1', a.id, { display_order: 10 });
      const p2 = svc
        .patch('coach-1', 'pkg-1', b.id, { display_order: 10 })
        .catch((e) => e);
      const [r1, r2] = await Promise.all([p1, p2]);
      // Only one wrote 10.
      const list = await svc.listForPackage('coach-1', 'pkg-1');
      const tens = list.filter((r) => r.display_order === 10);
      expect(tens.length).toBe(1);
      // The other call must have been rejected.
      const successCount = [r1, r2].filter(
        (r) => r && typeof (r as any).id === 'string',
      ).length;
      expect(successCount).toBe(1);
      // Unused-var hush: third row exists.
      expect(c.id).toBeTruthy();
    });
  });

  // ── soft-delete + patch interaction (P3-a fix) ───────────────────────
  describe('patch on a soft-deleted content row (P3-a)', () => {
    it('patch on a soft-deleted row returns 404 — cannot mutate a removed row', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      await svc.softDelete('coach-1', 'pkg-1', a.id);
      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, { display_title: 'edit attempt' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.patch('coach-1', 'pkg-1', a.id, {
          cadence_kind: 'relative_to_purchase',
          cadence_payload: { offset_days: 1 },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('softDelete remains idempotent after the requireOwnedContent fix', async () => {
      const a = await svc.attach('coach-1', 'pkg-1', {
        asset_type: 'workout_plan',
        asset_id: 'wp-1',
        cadence_kind: 'immediate',
        cadence_payload: {},
      });
      const first = await svc.softDelete('coach-1', 'pkg-1', a.id);
      const second = await svc.softDelete('coach-1', 'pkg-1', a.id);
      expect(first.removed_at).not.toBeNull();
      expect(second.removed_at).toEqual(first.removed_at);
    });
  });
});
