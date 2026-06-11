/**
 * MWB-3 — real undo / redo spec (MASTER_WORKOUT_BUILDER_SPEC.md §5.1).
 *
 * Covers the undo-path slices of the BUILDER_BRIEF test matrix:
 *   #4  undo to revision N writes a NEW head revision (index N+1, cause='undo',
 *       exercises = revision[N].exercises_json) — never mutates history in place
 *   #5  redo = undo to a LATER index works after an undo
 *
 * DECACORN (BUILDER_BRIEF §"Test matrix"): do NOT stub the database. Runs the
 * REAL service against a LIVE Postgres so the Serializable transaction, the
 * live-row replace, and the head-pointer advance are all exercised end-to-end.
 *
 * Live-DB gating: gated on MWB3_TEST_DATABASE_URL; `describe.skip`s with a
 * logged reason when unset (never a silent pass). Schema materialised via
 * test/utils/bootstrap-test-schema.ts.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb3-undo] MWB3_TEST_DATABASE_URL not set — live undo/redo suite skipped.',
  );
}

const COACH_ID = 'mwb3-undo-coach';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';

liveDescribe('Real undo / redo (live DB, MWB-3 §5.1)', () => {
  let prisma: PrismaClient;
  let autosave: WorkoutBuilderAutosaveService;

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
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET =
      'mwb3-test-lock-secret-0123456789abcdef';
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({ where: { id: COACH_ID } });

    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Undo Coach',
        role: 'coach',
      },
    });
    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: COACH_ID,
        name: 'Undo Plan',
        type: 'strength',
      },
    });
    const initial = await prisma.workoutPlanRevision.create({
      data: {
        workout_plan_id: PLAN_ID,
        revision_index: 0,
        exercises_json: [],
        plan_meta_json: {},
        author_id: COACH_ID,
        author_kind: 'coach',
        cause: 'initial',
      },
    });
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: initial.id },
    });
  });

  const insertOp = (externalId: string, sets: number) => ({
    op: 'upsert_exercise' as const,
    payload: {
      exercise_external_id: externalId,
      order: 1,
      sets,
      reps_or_duration_seconds: 10,
    },
  });

  // Derive the lock_token from the plan's persisted (version, head_revision_id)
  // so each sequential edit echoes the deterministic token the service expects.
  const tokenFor = async (planId: string): Promise<string> => {
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { version: true, head_revision_id: true },
    });
    return computeLockToken(planId, plan.version, plan.head_revision_id!);
  };

  const edit = async (base: number, externalId: string, sets: number) =>
    autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: base,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp(externalId, sets)],
        cause: 'manual_edit',
      },
    );

  const liveExternalIds = async (): Promise<string[]> =>
    (
      await prisma.workoutPlanExercise.findMany({
        where: { workout_plan_id: PLAN_ID, archived_at: null },
        orderBy: { order: 'asc' },
        select: { exercise_external_id: true },
      })
    ).map((r) => r.exercise_external_id);

  const revisionExternalIds = async (index: number): Promise<string[]> => {
    const rev = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: {
        workout_plan_id_revision_index: {
          workout_plan_id: PLAN_ID,
          revision_index: index,
        },
      },
      select: { exercises_json: true },
    });
    return (
      rev.exercises_json as unknown as Array<{ exercise_external_id: string }>
    ).map((r) => r.exercise_external_id);
  };

  // ── Matrix #4: undo to revision N writes a NEW revision ───────────────────
  it('#4 undo to revision 1 writes revision 3 with cause="undo" and rev1 exercises', async () => {
    await edit(0, 'squat', 3); // rev 1: [squat]
    await edit(1, 'bench', 4); // rev 2: [squat, bench]
    expect(await liveExternalIds()).toEqual(['squat', 'bench']);

    // Undo to revision 1 (head is 2). A NEW head revision (index 3) is written.
    const res = await autosave.applyUndo(
      PLAN_ID,
      { userId: COACH_ID },
      { to_revision_index: 1 },
    );
    expect(res.head_revision_index).toBe(3);

    // History is append-only: revisions 0,1,2 untouched, 3 is the undo result.
    const rev3 = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: {
        workout_plan_id_revision_index: {
          workout_plan_id: PLAN_ID,
          revision_index: 3,
        },
      },
      select: { cause: true },
    });
    expect(rev3.cause).toBe('undo');

    // rev3 exercises == rev1 exercises ([squat]); live rows match too.
    expect(await revisionExternalIds(3)).toEqual(await revisionExternalIds(1));
    expect(await revisionExternalIds(3)).toEqual(['squat']);
    expect(await liveExternalIds()).toEqual(['squat']);

    // The head pointer now references the new undo revision.
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: PLAN_ID },
      select: { head_revision_id: true },
    });
    const head = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: { id: plan.head_revision_id! },
      select: { revision_index: true },
    });
    expect(head.revision_index).toBe(3);
  }, 60_000);

  // ── Matrix #5: redo = undo to a later index ───────────────────────────────
  it('#5 redo (undo to a later index) restores the later state after an undo', async () => {
    await edit(0, 'squat', 3); // rev 1: [squat]
    await edit(1, 'bench', 4); // rev 2: [squat, bench]

    // Undo back to rev 1 -> writes rev 3 == [squat].
    const undo = await autosave.applyUndo(
      PLAN_ID,
      { userId: COACH_ID },
      { to_revision_index: 1 },
    );
    expect(undo.head_revision_index).toBe(3);
    expect(await liveExternalIds()).toEqual(['squat']);

    // Redo = undo to a LATER index (rev 2, which still exists in history).
    // Head is 3, target 2 is strictly earlier than head, so it is permitted.
    const redo = await autosave.applyUndo(
      PLAN_ID,
      { userId: COACH_ID },
      { to_revision_index: 2 },
    );
    expect(redo.head_revision_index).toBe(4);

    // The redo restored rev 2's state ([squat, bench]).
    expect(await revisionExternalIds(4)).toEqual(['squat', 'bench']);
    expect(await liveExternalIds()).toEqual(['squat', 'bench']);

    const rev4 = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: {
        workout_plan_id_revision_index: {
          workout_plan_id: PLAN_ID,
          revision_index: 4,
        },
      },
      select: { cause: true },
    });
    expect(rev4.cause).toBe('undo'); // redo is implemented as an undo write.
  }, 60_000);

  // ── Guard rails: target must be strictly earlier than head, and must exist ─
  it('rejects undo to the current head index (must be strictly earlier)', async () => {
    await edit(0, 'squat', 3); // head -> 1
    await expect(
      autosave.applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  }, 60_000);

  it('rejects undo to a future index beyond the head', async () => {
    await edit(0, 'squat', 3); // head -> 1
    await expect(
      autosave.applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  }, 60_000);

  it('rejects undo to a non-existent (gap) revision index with 404', async () => {
    // Advance the head far enough that the target index is < head but no such
    // revision row exists (we never created a revision at index 5 here; head
    // climbs to 2, so request index... we need target < head but missing).
    await edit(0, 'a', 1); // rev 1
    await edit(1, 'b', 2); // rev 2 (head = 2)
    // Delete revision 1 to synthesise a gap (index 1 < head 2 but missing).
    await prisma.workoutPlanRevision.delete({
      where: {
        workout_plan_id_revision_index: {
          workout_plan_id: PLAN_ID,
          revision_index: 1,
        },
      },
    });
    await expect(
      autosave.applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  }, 60_000);
});
