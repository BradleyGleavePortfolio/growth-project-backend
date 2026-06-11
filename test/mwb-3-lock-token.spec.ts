/**
 * mwb-3-lock-token.spec.ts — MWB-3 R1 fixer proof for the two P1 findings:
 *
 *   P1.1 — sub-coach authorization. The autosave/undo access gate must resolve
 *     the acting user's HEAD COACH via SubCoachScopeService.getHeadCoachIdForSubCoach
 *     and compare it to WorkoutPlan.coach_id (NOT route the head-coach FK through
 *     assertCanAccessClient, which only matches assigned STUDENT ids). This proves:
 *       - an in-team sub-coach CAN autosave AND undo a plan owned by their head
 *         coach (the regression the old gate caused — a valid sub-coach was denied),
 *       - a sub-coach on a DIFFERENT head coach's team is denied (403),
 *       - a foreign head coach is denied (403),
 *       - a STUDENT principal is denied (403).
 *
 *   P1.2 — deterministic optimistic-lock token. The lock_token is an
 *     HMAC-SHA256 (first 16 hex) of `<planId>:<version>:<headRevisionId>` keyed
 *     by MWB_AUTOSAVE_LOCK_TOKEN_SECRET — NOT a cosmetic random blob. This proves:
 *       - determinism (same inputs + secret => same token; pure unit, no DB),
 *       - the secret is mandatory (no silent default — derivation throws when
 *         the secret is absent/blank; R0),
 *       - rotating the secret rotates the token (the HMAC is genuinely keyed),
 *       - a STALE client token is rejected with a typed 409 'autosave_lock_stale'
 *         and writes NO revision (the lock is enforced, not cosmetic),
 *       - a successful autosave/undo ROTATES the token to one derived from the
 *         POST-commit persisted state, which the next request must echo.
 *
 * Lanes: the pure-unit token block needs no DB and always runs. The
 * authorization + enforcement block is gated on MWB3_TEST_DATABASE_URL and
 * describe.skips (with a logged reason — never a silent pass) when it is unset.
 */

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import { AutosaveConflictDto } from '../src/workout-builder/workout-builder-autosave.dto';
import {
  LOCK_TOKEN_HEX_LEN,
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
  assertLockTokenSecretConfigured,
  computeLockToken,
} from '../src/workout-builder/lock-token.helper';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const LOCK_SECRET = 'mwb3-test-lock-secret-0123456789abcdef';

// ─── Pure-unit lane: token determinism + secret handling (no DB) ─────────────

describe('MWB-3 P1.2 — computeLockToken determinism + keyed-secret contract', () => {
  const ORIGINAL = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    } else {
      process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = ORIGINAL;
    }
  });

  it('is deterministic: identical inputs + secret yield the identical token', () => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
    const a = computeLockToken('plan-1', 7, 'rev-abc');
    const b = computeLockToken('plan-1', 7, 'rev-abc');
    expect(a).toBe(b);
  });

  it('emits exactly LOCK_TOKEN_HEX_LEN lowercase hex chars (wire shape)', () => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
    const token = computeLockToken('plan-1', 1, 'rev-abc');
    expect(token).toHaveLength(LOCK_TOKEN_HEX_LEN);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('changes when ANY of (planId, version, headRevisionId) changes', () => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
    const base = computeLockToken('plan-1', 1, 'rev-abc');
    expect(computeLockToken('plan-2', 1, 'rev-abc')).not.toBe(base);
    expect(computeLockToken('plan-1', 2, 'rev-abc')).not.toBe(base);
    expect(computeLockToken('plan-1', 1, 'rev-xyz')).not.toBe(base);
  });

  it('is genuinely KEYED: rotating the secret rotates the token', () => {
    const a = computeLockToken('plan-1', 1, 'rev-abc', {
      [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: 'secret-one',
    } as NodeJS.ProcessEnv);
    const b = computeLockToken('plan-1', 1, 'rev-abc', {
      [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: 'secret-two',
    } as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
  });

  it('THROWS (no silent default) when the secret is unset', () => {
    delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    expect(() => computeLockToken('plan-1', 1, 'rev-abc')).toThrow(
      MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
    );
  });

  it('THROWS when the secret is present but blank/whitespace', () => {
    expect(() =>
      computeLockToken('plan-1', 1, 'rev-abc', {
        [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: '   ',
      } as NodeJS.ProcessEnv),
    ).toThrow(MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV);
  });

  it('assertLockTokenSecretConfigured throws when the secret is absent, passes when present', () => {
    expect(() =>
      assertLockTokenSecretConfigured({} as NodeJS.ProcessEnv),
    ).toThrow(MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV);
    expect(() =>
      assertLockTokenSecretConfigured({
        [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: LOCK_SECRET,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

// ─── Live-DB lane: sub-coach authorization (P1.1) + lock enforcement (P1.2) ──

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb3-lock-token] MWB3_TEST_DATABASE_URL not set — sub-coach ' +
      'authorization + lock-enforcement live suite skipped.',
  );
}

const HEAD_COACH_ID = 'mwb3-lt-head-coach';
const IN_TEAM_SUBCOACH_ID = 'mwb3-lt-in-team-subcoach';
const OTHER_HEAD_COACH_ID = 'mwb3-lt-other-head-coach';
const OTHER_TEAM_SUBCOACH_ID = 'mwb3-lt-other-team-subcoach';
const STUDENT_ID = 'mwb3-lt-student';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';

liveDescribe('MWB-3 P1.1/P1.2 — sub-coach auth + lock enforcement (live DB)', () => {
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
    delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;

    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            HEAD_COACH_ID,
            IN_TEAM_SUBCOACH_ID,
            OTHER_HEAD_COACH_ID,
            OTHER_TEAM_SUBCOACH_ID,
            STUDENT_ID,
          ],
        },
      },
    });

    // Head coach who OWNS the plan (role='coach', coach_id NULL).
    await prisma.user.create({
      data: {
        id: HEAD_COACH_ID,
        supabase_id: `sb-${HEAD_COACH_ID}`,
        email: `${HEAD_COACH_ID}@example.test`,
        name: 'Head Coach',
        role: 'coach',
      },
    });
    // IN-TEAM sub-coach: role='coach', coach_id = the plan owner. The P1.1 gate
    // must resolve their head coach to HEAD_COACH_ID and ALLOW the edit.
    await prisma.user.create({
      data: {
        id: IN_TEAM_SUBCOACH_ID,
        supabase_id: `sb-${IN_TEAM_SUBCOACH_ID}`,
        email: `${IN_TEAM_SUBCOACH_ID}@example.test`,
        name: 'In-Team SubCoach',
        role: 'coach',
        coach_id: HEAD_COACH_ID,
      },
    });
    // A DIFFERENT head coach (foreign tenant).
    await prisma.user.create({
      data: {
        id: OTHER_HEAD_COACH_ID,
        supabase_id: `sb-${OTHER_HEAD_COACH_ID}`,
        email: `${OTHER_HEAD_COACH_ID}@example.test`,
        name: 'Other Head Coach',
        role: 'coach',
      },
    });
    // Sub-coach on the OTHER head coach's team — head coach != plan owner, so
    // the gate must DENY (403).
    await prisma.user.create({
      data: {
        id: OTHER_TEAM_SUBCOACH_ID,
        supabase_id: `sb-${OTHER_TEAM_SUBCOACH_ID}`,
        email: `${OTHER_TEAM_SUBCOACH_ID}@example.test`,
        name: 'Other-Team SubCoach',
        role: 'coach',
        coach_id: OTHER_HEAD_COACH_ID,
      },
    });
    // A STUDENT principal — never a coach; getHeadCoachIdForSubCoach returns
    // null, so the gate must DENY (403), never granting plan-edit rights.
    await prisma.user.create({
      data: {
        id: STUDENT_ID,
        supabase_id: `sb-${STUDENT_ID}`,
        email: `${STUDENT_ID}@example.test`,
        name: 'Student',
        role: 'student',
        coach_id: HEAD_COACH_ID,
      },
    });

    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: HEAD_COACH_ID,
        name: 'Pull Day',
        type: 'strength',
      },
    });
    const initial = await prisma.workoutPlanRevision.create({
      data: {
        workout_plan_id: PLAN_ID,
        revision_index: 0,
        exercises_json: [],
        plan_meta_json: {},
        author_id: HEAD_COACH_ID,
        author_kind: 'coach',
        cause: 'initial',
      },
    });
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: initial.id },
    });
  });

  const insertOp = (externalId: string) => ({
    op: 'upsert_exercise' as const,
    payload: {
      exercise_external_id: externalId,
      order: 1,
      sets: 3,
      reps_or_duration_seconds: 10,
    },
  });

  const tokenFor = async (planId: string): Promise<string> => {
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { version: true, head_revision_id: true },
    });
    return computeLockToken(planId, plan.version, plan.head_revision_id!);
  };

  const revisionCount = (planId: string) =>
    prisma.workoutPlanRevision.count({ where: { workout_plan_id: planId } });

  // ── P1.1: sub-coach authorization ─────────────────────────────────────────

  it('P1.1 an IN-TEAM sub-coach CAN autosave a plan owned by their head coach', async () => {
    const res = await autosave.applyAutosave(
      PLAN_ID,
      { userId: IN_TEAM_SUBCOACH_ID },
      {
        base_revision_index: 0,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('squat')],
        cause: 'manual_edit',
      },
    );
    expect(res.head_revision_index).toBe(1);
    // The revision is attributed to the sub-coach (author_kind='sub_coach').
    const head = await prisma.workoutPlanRevision.findFirstOrThrow({
      where: { workout_plan_id: PLAN_ID, revision_index: 1 },
      select: { author_id: true, author_kind: true },
    });
    expect(head.author_id).toBe(IN_TEAM_SUBCOACH_ID);
    expect(head.author_kind).toBe('sub_coach');
  }, 60_000);

  it('P1.1 an IN-TEAM sub-coach CAN undo a plan owned by their head coach', async () => {
    // Owner advances head 0 -> 1 first so there is an earlier index to restore.
    await autosave.applyAutosave(
      PLAN_ID,
      { userId: HEAD_COACH_ID },
      {
        base_revision_index: 0,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('squat')],
        cause: 'manual_edit',
      },
    );
    const res = await autosave.applyUndo(
      PLAN_ID,
      { userId: IN_TEAM_SUBCOACH_ID },
      { to_revision_index: 0 },
    );
    expect(res.head_revision_index).toBe(2);
  }, 60_000);

  it('P1.1 a sub-coach on a DIFFERENT head coach team is denied (403)', async () => {
    await expect(
      autosave.applyAutosave(
        PLAN_ID,
        { userId: OTHER_TEAM_SUBCOACH_ID },
        {
          base_revision_index: 0,
          lock_token: await tokenFor(PLAN_ID),
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  it('P1.1 a foreign head coach is denied (403)', async () => {
    await expect(
      autosave.applyAutosave(
        PLAN_ID,
        { userId: OTHER_HEAD_COACH_ID },
        {
          base_revision_index: 0,
          lock_token: await tokenFor(PLAN_ID),
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  it('P1.1 a STUDENT principal is denied (403) on autosave', async () => {
    await expect(
      autosave.applyAutosave(
        PLAN_ID,
        { userId: STUDENT_ID },
        {
          base_revision_index: 0,
          lock_token: await tokenFor(PLAN_ID),
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  // ── P1.2: lock-token enforcement ──────────────────────────────────────────

  it('P1.2 a STALE lock token is rejected with 409 autosave_lock_stale and writes NO revision', async () => {
    const before = await revisionCount(PLAN_ID);
    // A token derived from a WRONG version (the plan is at version 1; we hand
    // a token for version 4) is rejected BEFORE any mutation.
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: PLAN_ID },
      select: { head_revision_id: true },
    });
    const staleToken = computeLockToken(PLAN_ID, 4, plan.head_revision_id!);

    let conflict: ConflictException | undefined;
    try {
      await autosave.applyAutosave(
        PLAN_ID,
        { userId: HEAD_COACH_ID },
        {
          base_revision_index: 0,
          lock_token: staleToken,
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      );
    } catch (err) {
      conflict = err as ConflictException;
    }
    expect(conflict).toBeInstanceOf(ConflictException);
    const body = conflict!.getResponse() as AutosaveConflictDto;
    expect(body.error).toBe('autosave_lock_stale');
    expect(body.head_revision_index).toBe(0);
    // The rejected request rotated NOTHING and wrote NOTHING: same revision
    // count, head still at index 0 (the lock is enforced, not cosmetic).
    expect(await revisionCount(PLAN_ID)).toBe(before);
    const head = await prisma.workoutPlanRevision.findFirstOrThrow({
      where: { workout_plan_id: PLAN_ID },
      orderBy: { revision_index: 'desc' },
      select: { revision_index: true },
    });
    expect(head.revision_index).toBe(0);
  }, 60_000);

  it('P1.2 a successful autosave ROTATES the token to the post-commit derived value', async () => {
    const initialToken = await tokenFor(PLAN_ID);
    const res = await autosave.applyAutosave(
      PLAN_ID,
      { userId: HEAD_COACH_ID },
      {
        base_revision_index: 0,
        lock_token: initialToken,
        ops: [insertOp('squat')],
        cause: 'manual_edit',
      },
    );
    // The returned token is NOT the one the client sent ...
    expect(res.lock_token).not.toBe(initialToken);
    // ... and it EXACTLY equals the token derived from the new persisted state,
    // so the next request that echoes it passes the lock gate.
    expect(res.lock_token).toBe(await tokenFor(PLAN_ID));
  }, 60_000);
});
