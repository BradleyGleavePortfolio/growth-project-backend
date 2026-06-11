/**
 * MWB-3 — revision-prune cron + pruneRevisionsForPlan spec
 * (MASTER_WORKOUT_BUILDER_SPEC.md §5.2, operator decision C: retain 30).
 *
 * Covers the prune slices of the BUILDER_BRIEF test matrix:
 *   #9  a plan with 40 revisions older than 24h -> EXACTLY 30 remain, the head
 *       is untouched, and the youngest 30 are the survivors
 *   #10 the cron NEVER deletes the head, even in a defensive synthetic case
 *       where the head is the OLDEST revision
 *
 * Plus the 24h safety net (recent revisions are never pruned) and the
 * cron-wrapper resilience contract (flag-off no-op; one bad plan never aborts
 * the sweep; the handler never throws).
 *
 * DECACORN: the prune cases run the REAL pruneRevisionsForPlan against a LIVE
 * Postgres (no stubbed DB) so the Serializable delete + retention arithmetic
 * are exercised for real. The cron-wrapper resilience cases use a tiny stubbed
 * service (no DB) to drive the failure branches deterministically.
 *
 * Live-DB gating: gated on MWB3_TEST_DATABASE_URL; logs + skips when unset.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import {
  REVISION_RETENTION_LIMIT,
  WorkoutBuilderAutosaveService,
} from '../src/workout-builder/workout-builder-autosave.service';
import { WorkoutBuilderRevisionPruneCron } from '../src/workout-builder/workout-builder-revision-prune.cron';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb3-revision-prune] MWB3_TEST_DATABASE_URL not set — live prune suite ' +
      'skipped.',
  );
}

const COACH_ID = 'mwb3-prune-coach';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── No-DB lane: cron wrapper resilience (flag-off, per-plan isolation) ───────

describe('WorkoutBuilderRevisionPruneCron — wrapper resilience (no DB)', () => {
  const ORIGINAL = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL;
  });

  it('no-ops when the flag is OFF (never enumerates plans)', async () => {
    delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    const find = jest.fn();
    const prune = jest.fn();
    const svc = {
      findPlanIdsExceedingRetention: find,
      pruneRevisionsForPlan: prune,
    } as unknown as WorkoutBuilderAutosaveService;
    const cron = new WorkoutBuilderRevisionPruneCron(svc);
    await expect(cron.handlePrune()).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('one failing plan never aborts the sweep; the handler never throws', async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    const prune = jest
      .fn()
      .mockResolvedValueOnce(5) // plan A pruned
      .mockRejectedValueOnce(new Error('boom')) // plan B blows up
      .mockResolvedValueOnce(3); // plan C still runs
    const svc = {
      findPlanIdsExceedingRetention: jest
        .fn()
        .mockResolvedValue(['A', 'B', 'C']),
      pruneRevisionsForPlan: prune,
    } as unknown as WorkoutBuilderAutosaveService;
    const cron = new WorkoutBuilderRevisionPruneCron(svc);
    await expect(cron.handlePrune()).resolves.toBeUndefined();
    // All three plans were attempted despite B failing.
    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune).toHaveBeenNthCalledWith(1, 'A');
    expect(prune).toHaveBeenNthCalledWith(2, 'B');
    expect(prune).toHaveBeenNthCalledWith(3, 'C');
  });

  it('a failure enumerating plans is swallowed (handler never throws)', async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    const svc = {
      findPlanIdsExceedingRetention: jest
        .fn()
        .mockRejectedValue(new Error('db down')),
      pruneRevisionsForPlan: jest.fn(),
    } as unknown as WorkoutBuilderAutosaveService;
    const cron = new WorkoutBuilderRevisionPruneCron(svc);
    await expect(cron.handlePrune()).resolves.toBeUndefined();
    expect(svc.pruneRevisionsForPlan).not.toHaveBeenCalled();
  });
});

// ─── Live-DB lane: real retention arithmetic (matrix #9, #10) ─────────────────

liveDescribe('Revision prune retention (live DB, MWB-3 §5.2)', () => {
  let prisma: PrismaClient;
  let autosave: WorkoutBuilderAutosaveService;
  let cron: WorkoutBuilderRevisionPruneCron;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);

    const scope = new SubCoachScopeService(prisma as unknown as PrismaService);
    const builder = new WorkoutBuilderService(
      prisma as unknown as PrismaService,
      undefined,
      scope,
    );
    autosave = new WorkoutBuilderAutosaveService(
      prisma as unknown as PrismaService,
      builder,
      new AnalyticsService(),
      scope,
    );
    cron = new WorkoutBuilderRevisionPruneCron(autosave);
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({ where: { id: COACH_ID } });

    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Prune Coach',
        role: 'coach',
      },
    });
    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: COACH_ID,
        name: 'Prune Plan',
        type: 'strength',
      },
    });
  });

  /**
   * Seed `count` revisions for the plan at indexes 0..count-1 with the given
   * age in ms (created_at = now - ageMs). Returns the created rows' ids by
   * index. We set created_at explicitly via an update because Prisma's create
   * defaults created_at to now().
   */
  async function seedRevisions(
    count: number,
    ageMs: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    const base = Date.now() - ageMs;
    for (let i = 0; i < count; i++) {
      const rev = await prisma.workoutPlanRevision.create({
        data: {
          workout_plan_id: PLAN_ID,
          revision_index: i,
          exercises_json: [],
          plan_meta_json: {},
          author_id: COACH_ID,
          author_kind: 'coach',
          cause: i === 0 ? 'initial' : 'manual_edit',
          // Older indexes are older in time so "oldest-first" prune == lowest
          // index first; +i ms keeps a stable strict ordering within the batch.
          created_at: new Date(base + i),
        },
      });
      ids.push(rev.id);
    }
    return ids;
  }

  async function survivingIndexes(): Promise<number[]> {
    return (
      await prisma.workoutPlanRevision.findMany({
        where: { workout_plan_id: PLAN_ID },
        orderBy: { revision_index: 'asc' },
        select: { revision_index: true },
      })
    ).map((r) => r.revision_index);
  }

  // ── Matrix #9: 40 old revisions -> exactly 30 remain, youngest retained ───
  it('#9 prunes 40 revisions (all > 24h) down to exactly 30, head untouched, youngest 30 kept', async () => {
    const ids = await seedRevisions(40, 2 * DAY_MS); // all comfortably > 24h
    // Head is the NEWEST revision (index 39) — the live state.
    const headId = ids[39];
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: headId },
    });

    const deleted = await autosave.pruneRevisionsForPlan(PLAN_ID);
    expect(deleted).toBe(10); // 40 - 30

    const remaining = await survivingIndexes();
    expect(remaining).toHaveLength(REVISION_RETENTION_LIMIT); // 30
    // The youngest 30 (indexes 10..39) survive; the oldest 10 (0..9) are gone.
    expect(remaining[0]).toBe(10);
    expect(remaining[remaining.length - 1]).toBe(39);
    expect(remaining).toEqual(
      Array.from({ length: 30 }, (_, k) => k + 10),
    );

    // The head revision is still present (never pruned).
    const headStillThere = await prisma.workoutPlanRevision.findUnique({
      where: { id: headId },
      select: { id: true },
    });
    expect(headStillThere).not.toBeNull();
  }, 120_000);

  it('#9 the cron sweep produces the same result end-to-end', async () => {
    const ids = await seedRevisions(40, 2 * DAY_MS);
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: ids[39] },
    });

    await expect(cron.handlePrune()).resolves.toBeUndefined();

    const remaining = await survivingIndexes();
    expect(remaining).toHaveLength(REVISION_RETENTION_LIMIT);
    expect(remaining).toEqual(Array.from({ length: 30 }, (_, k) => k + 10));
  }, 120_000);

  // ── Matrix #10: NEVER delete the head (defensive: head is the oldest) ─────
  it('#10 never deletes the head even when the head is the OLDEST revision', async () => {
    const ids = await seedRevisions(40, 2 * DAY_MS);
    // Defensive synthetic case: point the head at the OLDEST revision (index 0).
    // A naive "delete oldest until 30 remain" would remove it; the prune must
    // explicitly exclude the head pointer.
    const headId = ids[0];
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: headId },
    });

    const deleted = await autosave.pruneRevisionsForPlan(PLAN_ID);
    expect(deleted).toBe(10);

    // Head (index 0) survived despite being the oldest.
    const headStillThere = await prisma.workoutPlanRevision.findUnique({
      where: { id: headId },
      select: { revision_index: true },
    });
    expect(headStillThere?.revision_index).toBe(0);

    const remaining = await survivingIndexes();
    expect(remaining).toHaveLength(REVISION_RETENTION_LIMIT);
    expect(remaining).toContain(0); // head kept
    // The next-oldest non-head revisions (1..10) were the prune victims, so the
    // survivors are index 0 (head) plus 11..39.
    expect(remaining).toEqual([0, ...Array.from({ length: 29 }, (_, k) => k + 11)]);
  }, 120_000);

  // ── 24h safety net: recent revisions are never pruned ─────────────────────
  it('never prunes revisions younger than 24h even when over the limit', async () => {
    // 40 revisions, ALL just 1 hour old -> none are eligible for prune.
    const ids = await seedRevisions(40, 1 * HOUR_MS);
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: ids[39] },
    });

    const deleted = await autosave.pruneRevisionsForPlan(PLAN_ID);
    expect(deleted).toBe(0);
    expect(await survivingIndexes()).toHaveLength(40);
  }, 120_000);

  it('does nothing when the plan is at or under the retention limit', async () => {
    const ids = await seedRevisions(REVISION_RETENTION_LIMIT, 2 * DAY_MS); // exactly 30
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: ids[ids.length - 1] },
    });
    const deleted = await autosave.pruneRevisionsForPlan(PLAN_ID);
    expect(deleted).toBe(0);
    expect(await survivingIndexes()).toHaveLength(REVISION_RETENTION_LIMIT);
  }, 120_000);

  it('findPlanIdsExceedingRetention reports only plans over the limit', async () => {
    await seedRevisions(REVISION_RETENTION_LIMIT + 5, 2 * DAY_MS); // 35 > 30
    const ids = await autosave.findPlanIdsExceedingRetention();
    expect(ids).toContain(PLAN_ID);
  }, 120_000);
});
