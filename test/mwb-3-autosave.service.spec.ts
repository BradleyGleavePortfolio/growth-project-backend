/**
 * MWB-3 — WorkoutBuilderAutosaveService domain unit/integration spec.
 *
 * Covers the autosave-path slices of the BUILDER_BRIEF test matrix:
 *   #2  autosave revision index strictly monotonic (5 edits -> 1,2,3,4,5)
 *   #3  autosave full-snapshot integrity (replay revision[2] == state after edit #2)
 *   #11 author_kind correctness (head coach -> 'coach', sub-coach -> 'sub_coach',
 *       AI invocation -> 'ai')
 *
 * DECACORN (BUILDER_BRIEF §"Test matrix"): do NOT stub the database. This suite
 * runs the REAL WorkoutBuilderAutosaveService against a LIVE Postgres (no mocked
 * transaction), exercising the real Serializable transaction, the real
 * WorkoutPlanRevision writes, and the real exercise-row replace contract.
 *
 * Live-DB gating: the default jest lane (jest.config.js, the build-and-test CI
 * job) has NO database, so this suite is gated on MWB3_TEST_DATABASE_URL and
 * `describe.skip`s with a logged reason when it is unset — never a silent pass.
 * The full Prisma-faithful schema is materialised in beforeAll via
 * test/utils/bootstrap-test-schema.ts (the same helper the MWB-2 clone
 * concurrency proof uses), so the test exercises the real generated client.
 *
 * To run locally (the builder ran exactly this against the worktree PG17):
 *   MWB3_TEST_DATABASE_URL='postgresql://postgres@localhost:5433/mwb3_test?host=/path/to/pgsock' \
 *     npx jest test/mwb-3-autosave.service --runInBand
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import {
  WorkoutBuilderAutosaveService,
} from '../src/workout-builder/workout-builder-autosave.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

// DEDICATED env var (never the app DATABASE_URL): beforeAll materialises the
// whole schema into the target DB, which would destroy a real database.
const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb3-autosave.service] MWB3_TEST_DATABASE_URL not set — live autosave ' +
      'service suite skipped (point it at a throwaway Postgres to run).',
  );
}

const COACH_ID = 'mwb3-svc-coach';
const SUBCOACH_ID = 'mwb3-svc-subcoach';
const CLIENT_ID = 'mwb3-svc-client';
const PLAN_ID = '11111111-1111-4111-8111-111111111111';

liveDescribe('WorkoutBuilderAutosaveService (live DB, MWB-3 §6 autosave)', () => {
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
    // Feature ON for the matrix (default is OFF — the flag-off matrix case #7
    // lives in the controller spec).
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    // MWB-3 — the optimistic-lock token is an HMAC keyed by this secret; the
    // service refuses to derive a token without it (R0, no silent default).
    process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET =
      'mwb3-test-lock-secret-0123456789abcdef';

    // Clean slate (FK child order).
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({
      where: { id: { in: [COACH_ID, SUBCOACH_ID, CLIENT_ID] } },
    });

    // Head coach, a sub-coach on the coach team, and a student client.
    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'MWB3 Coach',
        role: 'coach',
      },
    });
    await prisma.user.create({
      data: {
        id: SUBCOACH_ID,
        supabase_id: `sb-${SUBCOACH_ID}`,
        email: `${SUBCOACH_ID}@example.test`,
        name: 'MWB3 SubCoach',
        role: 'coach',
        coach_id: COACH_ID,
      },
    });
    await prisma.user.create({
      data: {
        id: CLIENT_ID,
        supabase_id: `sb-${CLIENT_ID}`,
        email: `${CLIENT_ID}@example.test`,
        name: 'MWB3 Client',
        role: 'student',
        coach_id: COACH_ID,
      },
    });

    // A plan owned by the head coach with an initial revision baseline
    // (index 0), exactly as MWB-1 guarantees for every plan. The plan's head
    // points at that revision so the autosave path has an anchor.
    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: COACH_ID,
        name: 'Day 1 — Push',
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

  /** Build one upsert-insert op for a brand-new exercise row (no row_id). */
  const insertOp = (externalId: string, sets: number) => ({
    op: 'upsert_exercise' as const,
    payload: {
      exercise_external_id: externalId,
      order: 1,
      sets,
      reps_or_duration_seconds: 10,
    },
  });

  // The lock_token is a deterministic HMAC of the plan's PERSISTED state
  // (id, version, head_revision_id); read that state and derive the token the
  // service will expect for the NEXT request (matrix #12's optimistic lock).
  const tokenFor = async (planId: string): Promise<string> => {
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { version: true, head_revision_id: true },
    });
    return computeLockToken(planId, plan.version, plan.head_revision_id!);
  };

  const headIndex = async (): Promise<number> => {
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: PLAN_ID },
      select: { head_revision_id: true },
    });
    const rev = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: { id: plan.head_revision_id! },
      select: { revision_index: true },
    });
    return rev.revision_index;
  };

  // ── Matrix #2: revision index strictly monotonic ──────────────────────────
  it('#2 five sequential edits produce revision_index 1,2,3,4,5', async () => {
    for (let i = 1; i <= 5; i++) {
      const base = i - 1; // head before this edit is i-1 (starts at 0).
      const res = await autosave.applyAutosave(
        PLAN_ID,
        { userId: COACH_ID },
        {
          base_revision_index: base,
          lock_token: await tokenFor(PLAN_ID),
          ops: [insertOp(`ex-${i}`, i)],
          cause: 'manual_edit',
        },
      );
      expect(res.head_revision_index).toBe(i);
      expect(await headIndex()).toBe(i);
    }

    const indices = (
      await prisma.workoutPlanRevision.findMany({
        where: { workout_plan_id: PLAN_ID },
        orderBy: { revision_index: 'asc' },
        select: { revision_index: true },
      })
    ).map((r) => r.revision_index);
    // index 0 (initial) + 1..5 (the five edits).
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  }, 60_000);

  // ── Matrix #3: full-snapshot integrity ────────────────────────────────────
  it('#3 revision[2].exercises_json equals plan state right after edit #2', async () => {
    // Edit #1 -> revision 1: one exercise.
    await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: 0,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('squat', 3)],
        cause: 'manual_edit',
      },
    );
    // Edit #2 -> revision 2: add a second exercise.
    await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: 1,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('bench', 4)],
        cause: 'manual_edit',
      },
    );

    // Capture the live plan state right after edit #2 (the snapshot authority).
    const liveAfter2 = (
      await prisma.workoutPlanExercise.findMany({
        where: { workout_plan_id: PLAN_ID, archived_at: null },
        orderBy: { order: 'asc' },
        select: { exercise_external_id: true, order: true, sets: true },
      })
    ).map((r) => ({
      exercise_external_id: r.exercise_external_id,
      order: r.order,
      sets: r.sets,
    }));

    // Edit #3 -> revision 3: a third exercise (mutates live state past rev 2).
    await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: 2,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('row', 5)],
        cause: 'manual_edit',
      },
    );

    // Replay revision[2]'s frozen snapshot — must equal the state at edit #2,
    // NOT the post-edit-#3 live state. This is what makes undo deterministic.
    const rev2 = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: {
        workout_plan_id_revision_index: {
          workout_plan_id: PLAN_ID,
          revision_index: 2,
        },
      },
      select: { exercises_json: true },
    });
    const snapshot = (rev2.exercises_json as unknown as Array<{
      exercise_external_id: string;
      order: number;
      sets: number;
    }>).map((r) => ({
      exercise_external_id: r.exercise_external_id,
      order: r.order,
      sets: r.sets,
    }));

    expect(snapshot).toHaveLength(2);
    expect(snapshot).toEqual(liveAfter2);
    expect(snapshot.map((r) => r.exercise_external_id)).toEqual([
      'squat',
      'bench',
    ]);
  }, 60_000);

  // ── Matrix #11: author_kind correctness ───────────────────────────────────
  describe('#11 author_kind correctness', () => {
    it('a head coach writes author_kind="coach"', async () => {
      expect(await autosave.resolveAuthorKind({ userId: COACH_ID })).toBe(
        'coach',
      );
    });

    it('a sub-coach (User.coach_id set) writes author_kind="sub_coach"', async () => {
      expect(await autosave.resolveAuthorKind({ userId: SUBCOACH_ID })).toBe(
        'sub_coach',
      );
    });

    it('an AI invocation writes author_kind="ai"', async () => {
      expect(
        await autosave.resolveAuthorKind({ userId: COACH_ID, isAi: true }),
      ).toBe('ai');
    });

    it('the persisted revision row carries the resolved author_kind (coach)', async () => {
      await autosave.applyAutosave(
        PLAN_ID,
        { userId: COACH_ID },
        {
          base_revision_index: 0,
          lock_token: await tokenFor(PLAN_ID),
          ops: [insertOp('deadlift', 2)],
          cause: 'manual_edit',
        },
      );
      const rev = await prisma.workoutPlanRevision.findUniqueOrThrow({
        where: {
          workout_plan_id_revision_index: {
            workout_plan_id: PLAN_ID,
            revision_index: 1,
          },
        },
        select: { author_kind: true, author_id: true, cause: true },
      });
      expect(rev.author_kind).toBe('coach');
      expect(rev.author_id).toBe(COACH_ID);
      expect(rev.cause).toBe('manual_edit');
    }, 60_000);
  });
});
