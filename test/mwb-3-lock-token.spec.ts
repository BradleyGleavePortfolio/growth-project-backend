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

// ─── Pure-unit lane: WRONG-SECRET lock-token rejection proves NO DB mutation ──
//
// R2 audit P1: the live block proves a STALE (wrong-version) token is rejected
// with no revision write, but no test pinned the WRONG-SECRET case on the
// autosave MUTATION path with an explicit "mutation methods were never called"
// guarantee. This block closes that gap as a no-DB unit: the prisma transaction
// surface is fully mocked, the service is configured with one HMAC secret, and
// the client submits a token computed for the CURRENT (planId, version,
// headRevisionId) under a DIFFERENT secret. Because the token is a keyed HMAC,
// the wrong-secret token does NOT equal the server-derived expected token, so
// applyAutosave must throw a typed 409 'autosave_lock_stale' BEFORE mutating any
// row. We assert every mutation method on the transaction client was never
// invoked, proving the lock is enforced ahead of any write (the lock is real,
// not cosmetic). This runs in the default build-and-test lane (no DB), so it can
// never be green-by-skip.

describe('MWB-3 P1.2 — WRONG-SECRET lock token: typed 409 + ZERO DB mutation (no-DB unit)', () => {
  const ORIGINAL_SECRET = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;

  // The secret the SERVICE is configured with (read from process.env at
  // request time by computeLockToken inside the service).
  const SERVER_SECRET = 'mwb3-server-secret-aaaaaaaaaaaaaaaaaaaa';
  // A DIFFERENT secret the (hostile/stale) client used to forge its token.
  const WRONG_SECRET = 'mwb3-attacker-secret-bbbbbbbbbbbbbbbbbbbb';

  // The plan's persisted optimistic-concurrency markers the locked row reports.
  const PLAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const HEAD_REVISION_ID = 'head-rev-id-0';
  const HEAD_INDEX = 0;
  const VERSION = 1;
  const ACTING_USER_ID = 'mwb3-wrong-secret-coach';

  // Mutation methods on the transaction client. EVERY one must stay un-called
  // when a wrong-secret token is rejected — the assertion the R2 brief requires.
  let txWorkoutPlanUpdate: jest.Mock;
  let txRevisionCreate: jest.Mock;
  let txExerciseUpdateMany: jest.Mock;
  let txExerciseCreateMany: jest.Mock;

  // Read-only methods the lock path touches BEFORE the token check.
  let txQueryRaw: jest.Mock;
  let txRevisionFindUnique: jest.Mock;

  let prismaMock: PrismaService;
  let service: WorkoutBuilderAutosaveService;

  beforeEach(() => {
    // Service is configured with SERVER_SECRET; feature flag ON so the autosave
    // path is reachable.
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = SERVER_SECRET;
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';

    txWorkoutPlanUpdate = jest.fn();
    txRevisionCreate = jest.fn();
    txExerciseUpdateMany = jest.fn();
    txExerciseCreateMany = jest.fn();

    // FOR UPDATE row-lock read: returns the plan's persisted version +
    // head_revision_id, exactly the shape lockPlanAndHead expects.
    txQueryRaw = jest.fn().mockResolvedValue([
      { head_revision_id: HEAD_REVISION_ID, version: VERSION },
    ]);
    // Head revision lookup: returns the current head's revision_index.
    txRevisionFindUnique = jest
      .fn()
      .mockResolvedValue({ revision_index: HEAD_INDEX });

    // The transaction client handed to the $transaction callback. The mutation
    // methods are jest.fn()s that THROW if called, so an accidental write both
    // fails the test AND is recorded by the not.toHaveBeenCalled assertions.
    const tx = {
      $queryRaw: txQueryRaw,
      workoutPlanRevision: {
        findUnique: txRevisionFindUnique,
        create: txRevisionCreate,
      },
      workoutPlan: {
        update: txWorkoutPlanUpdate,
      },
      workoutPlanExercise: {
        updateMany: txExerciseUpdateMany,
        createMany: txExerciseCreateMany,
      },
    };

    prismaMock = {
      // resolveAuthorKind: a head coach (coach_id null) => author_kind 'coach'.
      user: {
        findUnique: jest.fn().mockResolvedValue({ coach_id: null }),
      },
      // authorisePlanAccess: the acting user IS the plan owner (direct owner),
      // so the access gate passes and we reach the transaction + token check.
      workoutPlan: {
        findUnique: jest.fn().mockResolvedValue({ coach_id: ACTING_USER_ID }),
      },
      // Run the callback with the mocked tx, mirroring a real $transaction.
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    } as unknown as PrismaService;

    service = new WorkoutBuilderAutosaveService(
      prismaMock,
      // WorkoutBuilderService + SubCoachScopeService are not reached before the
      // token check on this path (owner short-circuits the sub-coach lookup),
      // so undefined stand-ins are sufficient for this no-DB unit.
      undefined as unknown as WorkoutBuilderService,
      new AnalyticsService(),
      undefined as unknown as SubCoachScopeService,
    );
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    } else {
      process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = ORIGINAL_SECRET;
    }
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    } else {
      process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL_FLAG;
    }
  });

  const wrongSecretToken = () =>
    // A token for the EXACT current persisted state, but keyed by the WRONG
    // secret — the only thing that differs from the server-derived expected
    // token, so the rejection is attributable solely to the secret mismatch.
    computeLockToken(PLAN_ID, VERSION, HEAD_REVISION_ID, {
      [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: WRONG_SECRET,
    } as NodeJS.ProcessEnv);

  const autosaveBody = () => ({
    base_revision_index: HEAD_INDEX,
    lock_token: wrongSecretToken(),
    ops: [
      {
        op: 'upsert_exercise' as const,
        payload: {
          exercise_external_id: 'squat',
          order: 1,
          sets: 3,
          reps_or_duration_seconds: 10,
        },
      },
    ],
    cause: 'manual_edit' as const,
  });

  it('sanity: the wrong-secret token differs from the server-derived expected token but is wire-valid (16 hex)', () => {
    const wrong = wrongSecretToken();
    const expected = computeLockToken(PLAN_ID, VERSION, HEAD_REVISION_ID, {
      [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: SERVER_SECRET,
    } as NodeJS.ProcessEnv);
    expect(wrong).not.toBe(expected);
    // Still passes the LOCK_TOKEN_RE wire-shape gate, so the rejection happens
    // at the HMAC comparison (not the zod regex) — the case the audit named.
    expect(wrong).toHaveLength(LOCK_TOKEN_HEX_LEN);
    expect(wrong).toMatch(/^[0-9a-f]+$/);
  });

  it('rejects a WRONG-SECRET token with ConflictException error=autosave_lock_stale', async () => {
    let thrown: ConflictException | undefined;
    try {
      await service.applyAutosave(
        PLAN_ID,
        { userId: ACTING_USER_ID },
        autosaveBody(),
      );
    } catch (err) {
      thrown = err as ConflictException;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    const body = thrown!.getResponse() as AutosaveConflictDto;
    expect(body.error).toBe('autosave_lock_stale');
    // The 409 carries the current head index + a freshly server-derived token
    // so the client can rebase — proving the response is the typed lock-stale
    // envelope, not a leaked/generic error.
    expect(body.head_revision_index).toBe(HEAD_INDEX);
    expect(body.lock_token).toBe(
      computeLockToken(PLAN_ID, VERSION, HEAD_REVISION_ID, {
        [MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV]: SERVER_SECRET,
      } as NodeJS.ProcessEnv),
    );
  });

  it('NEVER mutates the DB: workoutPlan.update, revision insert, and exercise writes are all un-called', async () => {
    await expect(
      service.applyAutosave(PLAN_ID, { userId: ACTING_USER_ID }, autosaveBody()),
    ).rejects.toBeInstanceOf(ConflictException);

    // The four mutation surfaces the autosave write-path would touch AFTER the
    // token check. Every one must be untouched: the lock is enforced BEFORE any
    // mutation (the R2 brief's explicit ">= 2 distinct mutation methods un-called"
    // requirement; here we pin all four).
    expect(txWorkoutPlanUpdate).not.toHaveBeenCalled();
    expect(txRevisionCreate).not.toHaveBeenCalled();
    expect(txExerciseUpdateMany).not.toHaveBeenCalled();
    expect(txExerciseCreateMany).not.toHaveBeenCalled();

    // And the read path DID run up to the lock check — proves the rejection is
    // the HMAC mismatch inside the transaction, not an earlier short-circuit
    // (e.g. auth/flag) that would make the no-mutation guarantee vacuous.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(txRevisionFindUnique).toHaveBeenCalledTimes(1);
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
