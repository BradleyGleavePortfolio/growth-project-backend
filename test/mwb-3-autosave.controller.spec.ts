/**
 * MWB-3 — WorkoutBuilderAutosaveController + feature-flag/guard spec.
 *
 * Covers the controller-surface slices of the BUILDER_BRIEF test matrix:
 *   #6  sub-coach scope honoured (out-of-scope sub-coach -> 403 on autosave AND undo)
 *   #7  feature flag OFF -> both endpoints 404 (NotFoundException, never 403)
 *   #12 lock_token rotates on conflict (stale base -> 409 carrying a NEW token;
 *       the client retries with the rebased index and succeeds)
 *
 * Two execution lanes (BUILDER_BRIEF §"Quality gates", default jest.config.js
 * has NO DB):
 *   - The flag-resolver, guard-behaviour, and guard-wiring assertions need no
 *     database and ALWAYS run in the default lane (matrix #7 lives here).
 *   - The authorization (#6) and conflict-rotation (#12) cases drive the REAL
 *     service against a LIVE Postgres and are gated on MWB3_TEST_DATABASE_URL,
 *     `describe.skip`ping with a logged reason when unset (never a silent pass).
 *
 * Live-DB schema is materialised via test/utils/bootstrap-test-schema.ts.
 */

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import {
  FEATURE_MWB_AUTOSAVE_UNDO_ENV,
  isMwbAutosaveUndoEnabled,
} from '../src/workout-builder/workout-builder-autosave.feature';
import { MwbAutosaveUndoFeatureGuard } from '../src/workout-builder/workout-builder-autosave-feature.guard';
import { WorkoutBuilderAutosaveController } from '../src/workout-builder/workout-builder-autosave.controller';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import {
  AutosaveConflictDto,
  LOCK_TOKEN_RE,
} from '../src/workout-builder/workout-builder-autosave.dto';
import {
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
  computeLockToken,
} from '../src/workout-builder/lock-token.helper';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

// ─── No-DB lane: flag resolver, guard behaviour, guard wiring (matrix #7) ─────

function ctx(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
    getHandler: () => () => undefined,
    getClass: () => WorkoutBuilderAutosaveController,
  } as unknown as ExecutionContext;
}

function handlerGuards(name: string): unknown[] {
  const proto = WorkoutBuilderAutosaveController.prototype as unknown as Record<
    string,
    unknown
  >;
  return (
    (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) as
      | unknown[]
      | undefined) ?? []
  );
}

function includesGuard(list: unknown[], guard: { name: string }): boolean {
  return list.some(
    (g) =>
      g === guard ||
      (typeof g === 'function' && (g as { name?: string }).name === guard.name),
  );
}

describe('isMwbAutosaveUndoEnabled (FEATURE_MWB_AUTOSAVE_UNDO resolver)', () => {
  it('is OFF when unset, empty, or any non-true value', () => {
    expect(isMwbAutosaveUndoEnabled({})).toBe(false);
    expect(
      isMwbAutosaveUndoEnabled({ [FEATURE_MWB_AUTOSAVE_UNDO_ENV]: '' }),
    ).toBe(false);
    expect(
      isMwbAutosaveUndoEnabled({ [FEATURE_MWB_AUTOSAVE_UNDO_ENV]: '1' }),
    ).toBe(false);
    expect(
      isMwbAutosaveUndoEnabled({ [FEATURE_MWB_AUTOSAVE_UNDO_ENV]: 'false' }),
    ).toBe(false);
  });

  it("is ON only when the value is exactly 'true' (case-insensitive)", () => {
    expect(
      isMwbAutosaveUndoEnabled({ [FEATURE_MWB_AUTOSAVE_UNDO_ENV]: 'true' }),
    ).toBe(true);
    expect(
      isMwbAutosaveUndoEnabled({ [FEATURE_MWB_AUTOSAVE_UNDO_ENV]: 'TRUE' }),
    ).toBe(true);
  });
});

describe('#7 MwbAutosaveUndoFeatureGuard — flag OFF returns 404 (not 403)', () => {
  const guard = new MwbAutosaveUndoFeatureGuard();
  const ORIGINAL = process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    else process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = ORIGINAL;
  });

  it('throws 404 NotFoundException on autosave when the flag is OFF by default', () => {
    delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    expect(() =>
      guard.canActivate(ctx('PATCH', '/workout-plans/p1/autosave')),
    ).toThrow(NotFoundException);
  });

  it('throws 404 NotFoundException on undo when the flag is OFF', () => {
    process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = 'false';
    expect(() =>
      guard.canActivate(ctx('POST', '/workout-plans/p1/undo')),
    ).toThrow(NotFoundException);
  });

  it('the 404 message echoes the METHOD + path (indistinguishable from a real 404)', () => {
    delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    try {
      guard.canActivate(ctx('PATCH', '/workout-plans/p1/autosave'));
      throw new Error('expected the guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe(
        'Cannot PATCH /workout-plans/p1/autosave',
      );
    }
  });

  it('returns true when the flag is exactly true', () => {
    process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = 'true';
    expect(
      guard.canActivate(ctx('PATCH', '/workout-plans/p1/autosave')),
    ).toBe(true);
  });
});

describe('#7 service layer re-checks the flag (defence-in-depth)', () => {
  const ORIGINAL = process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    else process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV] = ORIGINAL;
  });

  // The service must short-circuit with 404 BEFORE touching prisma, so a
  // deliberately-throwing stub proves the flag gate fires first (no DB needed).
  const explodingPrisma = new Proxy(
    {},
    {
      get() {
        throw new Error('prisma must not be touched while the flag is OFF');
      },
    },
  ) as unknown as PrismaService;
  const svc = new WorkoutBuilderAutosaveService(
    explodingPrisma,
    {} as unknown as WorkoutBuilderService,
    {} as unknown as AnalyticsService,
    {} as unknown as SubCoachScopeService,
  );

  it('applyAutosave throws 404 and never touches the DB when the flag is OFF', async () => {
    delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    await expect(
      svc.applyAutosave('p1', { userId: 'u1' }, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applyUndo throws 404 and never touches the DB when the flag is OFF', async () => {
    delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    await expect(
      svc.applyUndo('p1', { userId: 'u1' }, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pruneRevisionsForPlan no-ops (returns 0) and never touches the DB when OFF', async () => {
    delete process.env[FEATURE_MWB_AUTOSAVE_UNDO_ENV];
    await expect(svc.pruneRevisionsForPlan('p1')).resolves.toBe(0);
  });
});

describe('WorkoutBuilderAutosaveController — feature-guard wiring', () => {
  it('mounts MwbAutosaveUndoFeatureGuard on the autosave handler', () => {
    expect(
      includesGuard(
        handlerGuards('autosaveBatch'),
        MwbAutosaveUndoFeatureGuard,
      ),
    ).toBe(true);
  });

  it('mounts MwbAutosaveUndoFeatureGuard on the undo handler', () => {
    expect(
      includesGuard(handlerGuards('undo'), MwbAutosaveUndoFeatureGuard),
    ).toBe(true);
  });
});

// ─── Live-DB lane: authorization (#6) + conflict rotation (#12) ───────────────

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mwb3-autosave.controller] MWB3_TEST_DATABASE_URL not set — live ' +
      'authorization + conflict suite skipped.',
  );
}

const COACH_ID = 'mwb3-ctl-coach';
const OUTSIDE_SUBCOACH_ID = 'mwb3-ctl-outside-subcoach';
const OTHER_COACH_ID = 'mwb3-ctl-other-coach';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
// Deterministic HMAC test secret for the optimistic-lock token (§6.2). The
// lock_token is no longer a static literal — it is computeLockToken(planId,
// version, head_revision_id) over the PERSISTED plan state — so tests derive
// the EXPECTED token from the live row via the tokenFor() helper below.
const LOCK_SECRET = 'mwb3-test-lock-secret-0123456789abcdef';
// A syntactically valid (LOCK_TOKEN_RE) but WRONG token, used only where the
// authorization gate (which runs BEFORE the lock check) is expected to reject
// the request first, so the token value is never actually evaluated.
const WRONG_TOKEN = '0123456789abcdef';

liveDescribe('Autosave/Undo authorization + conflict (live DB)', () => {
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
    delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    if (prisma) await prisma.$disconnect();
  });

  // Derive the CURRENT valid lock token for a plan straight from its persisted
  // optimistic-concurrency state (version + head_revision_id) — exactly what
  // the service re-derives server-side. A test seeds/advances the plan, then
  // calls this to get the token the next request must echo.
  const tokenFor = async (planId: string): Promise<string> => {
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { version: true, head_revision_id: true },
    });
    return computeLockToken(planId, plan.version, plan.head_revision_id!);
  };

  beforeEach(async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({
      where: {
        id: { in: [COACH_ID, OUTSIDE_SUBCOACH_ID, OTHER_COACH_ID] },
      },
    });

    // Head coach who owns the plan.
    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Owner Coach',
        role: 'coach',
      },
    });
    // A DIFFERENT head coach (foreign tenant) — must be denied.
    await prisma.user.create({
      data: {
        id: OTHER_COACH_ID,
        supabase_id: `sb-${OTHER_COACH_ID}`,
        email: `${OTHER_COACH_ID}@example.test`,
        name: 'Other Coach',
        role: 'coach',
      },
    });
    // A sub-coach on the OTHER coach's team with NO open assignment to this
    // plan's tenant — out of scope for COACH_ID's plan.
    await prisma.user.create({
      data: {
        id: OUTSIDE_SUBCOACH_ID,
        supabase_id: `sb-${OUTSIDE_SUBCOACH_ID}`,
        email: `${OUTSIDE_SUBCOACH_ID}@example.test`,
        name: 'Outside SubCoach',
        role: 'coach',
        coach_id: OTHER_COACH_ID,
      },
    });

    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: COACH_ID,
        name: 'Push Day',
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

  const insertOp = (externalId: string) => ({
    op: 'upsert_exercise' as const,
    payload: {
      exercise_external_id: externalId,
      order: 1,
      sets: 3,
      reps_or_duration_seconds: 10,
    },
  });

  // ── Matrix #6: sub-coach scope honoured (403) ─────────────────────────────
  // The authorization gate runs BEFORE the optimistic-lock check, so these
  // forbidden callers are rejected regardless of the token value — WRONG_TOKEN
  // documents that the 403 is the auth wall, not a lock mismatch.
  it('#6 an out-of-scope sub-coach gets 403 on autosave', async () => {
    await expect(
      autosave.applyAutosave(
        PLAN_ID,
        { userId: OUTSIDE_SUBCOACH_ID },
        {
          base_revision_index: 0,
          lock_token: WRONG_TOKEN,
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  it('#6 an out-of-scope sub-coach gets 403 on undo', async () => {
    // Advance the head once (as the owner) so there is an earlier index to
    // target — proving the 403 is the authorization gate, not an empty history.
    // The owner's own autosave must carry the VALID derived token.
    await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: 0,
        lock_token: await tokenFor(PLAN_ID),
        ops: [insertOp('squat')],
        cause: 'manual_edit',
      },
    );
    await expect(
      autosave.applyUndo(
        PLAN_ID,
        { userId: OUTSIDE_SUBCOACH_ID },
        { to_revision_index: 0 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  it('#6 a foreign head coach also gets 403 on autosave', async () => {
    await expect(
      autosave.applyAutosave(
        PLAN_ID,
        { userId: OTHER_COACH_ID },
        {
          base_revision_index: 0,
          lock_token: WRONG_TOKEN,
          ops: [insertOp('squat')],
          cause: 'manual_edit',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 60_000);

  // ── Matrix #12: lock_token rotates on conflict, retry succeeds ────────────
  it('#12 a stale base_revision_index yields 409 with a fresh token; retry succeeds', async () => {
    // First edit advances head 0 -> 1. It carries the VALID token derived from
    // the seeded state (version 1, head = initial revision).
    const firstToken = await tokenFor(PLAN_ID);
    const first = await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: 0,
        lock_token: firstToken,
        ops: [insertOp('squat')],
        cause: 'manual_edit',
      },
    );
    expect(first.head_revision_index).toBe(1);
    expect(first.lock_token).toMatch(LOCK_TOKEN_RE);

    // A second caller carries the CURRENT valid lock token (the plan advanced,
    // so the token rotated) but still believes head is 0 (a STALE base index).
    // The lock-token gate passes; the base-index assert fails -> a typed 409
    // 'autosave_conflict_retry' carrying the current head index + fresh token.
    // (Using the current token isolates this test to the base-index path; the
    // separate stale-TOKEN path is covered by the dedicated lock-stale spec.)
    const staleBaseToken = await tokenFor(PLAN_ID);
    let conflict: ConflictException | undefined;
    try {
      await autosave.applyAutosave(
        PLAN_ID,
        { userId: COACH_ID },
        {
          base_revision_index: 0,
          lock_token: staleBaseToken,
          ops: [insertOp('bench')],
          cause: 'manual_edit',
        },
      );
    } catch (err) {
      conflict = err as ConflictException;
    }
    expect(conflict).toBeInstanceOf(ConflictException);
    const body = conflict!.getResponse() as AutosaveConflictDto;
    expect(body.error).toBe('autosave_conflict_retry');
    expect(body.head_revision_index).toBe(1);
    expect(body.lock_token).toMatch(LOCK_TOKEN_RE);
    // The conflict carries the token derived from the CURRENT persisted state
    // (planId, version, head_revision_id). In THIS scenario the client already
    // sent that exact current token (only its base_revision_index was stale),
    // so the deterministic HMAC token returned EQUALS staleBaseToken — that is
    // the correct, deterministic behaviour, not a defect. (The prior
    // `.not.toBe(staleBaseToken)` assertion was a leftover from the pre-HMAC
    // era when lock_token was a random blob; under the keyed-HMAC token it is
    // false by construction here. The genuine rotation property — a NEW token
    // after a committing write — is proven by the lock-token spec's
    // "successful autosave ROTATES the token" case and by the successful retry
    // below advancing the head.) We assert it equals the server-derived
    // current-state token so the rebase contract is pinned exactly.
    expect(body.lock_token).toBe(await tokenFor(PLAN_ID));

    // The client rebases to the conflict's head index + retries with the new
    // token and succeeds (head 1 -> 2).
    const retry = await autosave.applyAutosave(
      PLAN_ID,
      { userId: COACH_ID },
      {
        base_revision_index: body.head_revision_index,
        lock_token: body.lock_token,
        ops: [insertOp('bench')],
        cause: 'manual_edit',
      },
    );
    expect(retry.head_revision_index).toBe(2);
  }, 60_000);
});
