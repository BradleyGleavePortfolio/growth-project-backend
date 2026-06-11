/**
 * MWB-5 — CreateWorkoutPlanMaterializer behaviour (brief Test matrix #1, #2, #3,
 * #6, #8, #10).
 *
 * Exercises the materialiser against an in-memory Prisma surface that mirrors
 * the slice of models the create path touches (workoutPlan / workoutPlanExercise
 * / workoutPlanRevision / workoutProgram / workoutProgramRevision / aiActionDraft)
 * plus a SubCoachScopeService stub. The model is NEVER called — the diff is
 * pre-filled on the draft payload, so these tests drive materialisation directly.
 */

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CREATE_WORKOUT_PLAN_CAPABILITY,
  CreateWorkoutPlanMaterializer,
  CreateWorkoutPlanPayloadSchema,
} from '../src/ai/gateway/materialisers/create-workout-plan.materialiser';
import { FEATURE_MWB_AI_LIVE_CREATE_ENV } from '../src/ai/gateway/mwb-live-create.feature';

const COACH = '00000000-0000-0000-0000-0000000000c1';
const CLIENT = '00000000-0000-0000-0000-0000000000a1';

const DIFF_5 = [
  { kind: 'plan_meta', name: 'AI Push Day', type: 'strength' },
  { kind: 'add_exercise', client_ref: 'r1', exercise_external_id: 'bench', sets: 4, reps_or_duration_seconds: 8 },
  { kind: 'add_exercise', client_ref: 'r2', exercise_external_id: 'incline', sets: 3, reps_or_duration_seconds: 10 },
  { kind: 'add_exercise', client_ref: 'r3', exercise_external_id: 'fly', sets: 3, reps_or_duration_seconds: 12 },
  { kind: 'add_exercise', client_ref: 'r4', exercise_external_id: 'pushdown', sets: 3, reps_or_duration_seconds: 15 },
];

function draft(overrides: Partial<any> = {}): any {
  return {
    id: 'draft-create-1',
    capability: CREATE_WORKOUT_PLAN_CAPABILITY,
    status: 'pending',
    requester_id: COACH,
    tenant_coach_id: COACH,
    subject_user_id: CLIENT,
    materialised_at: null,
    materialised_ref: null,
    payload: {
      capability: CREATE_WORKOUT_PLAN_CAPABILITY,
      target_client_id: CLIENT,
      diff: DIFF_5,
    },
    ...overrides,
  };
}

/** In-memory Prisma surface. `$transaction(fn, opts)` runs fn with the same store. */
function buildPrisma(initialDraft: any, seedRows: any = {}) {
  const store = {
    plans: [] as any[],
    exercises: [] as any[],
    planRevisions: [] as any[],
    programs: [] as any[],
    programRevisions: [] as any[],
    draft: { ...initialDraft },
    seq: 0,
    ...seedRows,
  };
  const id = (p: string) => `${p}-${++store.seq}`;

  const client = {
    workoutPlan: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('plan'), head_revision_id: null, ...data };
        store.plans.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.plans.find((p: any) => p.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        store.plans.find((p: any) => p.id === where.id) ?? null,
      ),
    },
    workoutPlanExercise: {
      createMany: jest.fn(async ({ data }: any) => {
        data.forEach((d: any) => store.exercises.push({ id: id('ex'), ...d }));
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        store.exercises.filter(
          (e: any) => e.workout_plan_id === where.workout_plan_id && e.archived_at == null,
        ),
      ),
    },
    workoutPlanRevision: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('rev'), ...data };
        store.planRevisions.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        store.planRevisions.find((r: any) => r.id === where.id) ?? null,
      ),
    },
    workoutProgram: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('prog'), head_revision_id: null, ...data };
        store.programs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.programs.find((p: any) => p.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        store.programs.find((p: any) => p.id === where.id) ?? null,
      ),
    },
    workoutProgramRevision: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('progrev'), ...data };
        store.programRevisions.push(row);
        return row;
      }),
    },
    aiActionDraft: {
      // Mirrors Prisma updateMany conditional-claim semantics. The claim
      // requires materialised_at IS NULL AND materialised_ref IS NULL; the
      // post-commit finalise requires the claim be still ours
      // (materialised_at === claimAt AND materialised_ref IS NULL). When the
      // WHERE predicate does not match the current draft row, count is 0 and
      // nothing is written — exactly how Postgres would behave.
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== store.draft.id) return { count: 0 };
        // P1 (R2) — honour the `status: 'pending'` predicate exactly as
        // Postgres would: when the authoritative row has already been moved
        // off `pending` (e.g. a concurrent reject won the decision gate), the
        // claim's `where.status === 'pending'` no longer matches and count is
        // 0 — nothing is written, so no downstream plan/program row can land.
        if (
          where.status !== undefined &&
          store.draft.status !== where.status
        ) {
          return { count: 0 };
        }
        if (
          where.materialised_at === null &&
          store.draft.materialised_at !== null
        ) {
          return { count: 0 };
        }
        if (
          where.materialised_ref === null &&
          store.draft.materialised_ref !== null
        ) {
          return { count: 0 };
        }
        if (
          where.materialised_at instanceof Date &&
          (!(store.draft.materialised_at instanceof Date) ||
            store.draft.materialised_at.getTime() !==
              where.materialised_at.getTime())
        ) {
          return { count: 0 };
        }
        Object.assign(store.draft, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => store.draft),
    },
  };

  // Serialize $transaction bodies through a mutex chain. The production code
  // opens this txn with `Prisma.TransactionIsolationLevel.Serializable`, so the
  // faithful in-memory model runs one txn body to completion (commit OR
  // rollback) before the next begins. This is what makes the concurrent-
  // approver tests deterministic: the loser's txn starts only AFTER the
  // winner has committed + the draft row carries the winner's claim, so the
  // loser's claim sees count=0, throws, and its rollback restores ONLY its own
  // (no-op) snapshot — it cannot clobber the winner's committed claim.
  let txGate: Promise<unknown> = Promise.resolve();
  const prisma: any = {
    ...client,
    store,
    // Emulate Prisma $transaction ROLLBACK semantics (P1.1 requirement #3):
    // snapshot the mutable store before running fn; if fn throws (e.g. the
    // claim-conflict thrown by a race-loser, or a diff-apply error), restore
    // the snapshot so the in-txn claim's materialised_at write is reverted —
    // exactly as Postgres would roll back an aborted transaction.
    $transaction: jest.fn((fn: any) => {
      const run = async () => {
        const snap = {
          plans: store.plans.map((r: any) => ({ ...r })),
          exercises: store.exercises.map((r: any) => ({ ...r })),
          planRevisions: store.planRevisions.map((r: any) => ({ ...r })),
          programs: store.programs.map((r: any) => ({ ...r })),
          programRevisions: store.programRevisions.map((r: any) => ({ ...r })),
          draft: { ...store.draft },
          seq: store.seq,
        };
        try {
          return await fn(client);
        } catch (err) {
          store.plans.splice(0, store.plans.length, ...snap.plans);
          store.exercises.splice(0, store.exercises.length, ...snap.exercises);
          store.planRevisions.splice(
            0,
            store.planRevisions.length,
            ...snap.planRevisions,
          );
          store.programs.splice(0, store.programs.length, ...snap.programs);
          store.programRevisions.splice(
            0,
            store.programRevisions.length,
            ...snap.programRevisions,
          );
          Object.keys(store.draft).forEach(
            (k) => delete (store.draft as any)[k],
          );
          Object.assign(store.draft, snap.draft);
          store.seq = snap.seq;
          throw err;
        }
      };
      // Chain onto the gate so txn bodies never interleave (Serializable).
      const result = txGate.then(run, run);
      // Keep the gate alive regardless of this txn's outcome so a rejected
      // (rolled-back) txn still releases the lock for the next one.
      txGate = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  };
  return prisma;
}

function scope(canAccess = true) {
  return {
    canAccessClient: jest.fn(async () => canAccess),
    isSubCoach: jest.fn(async () => false),
  } as any;
}

/** Analytics stub mirroring AnalyticsService.capture's signature. */
function analyticsStub() {
  return { capture: jest.fn(), identify: jest.fn() } as any;
}

describe('CreateWorkoutPlanPayloadSchema', () => {
  it('accepts a canonical payload', () => {
    const r = CreateWorkoutPlanPayloadSchema.safeParse({
      capability: CREATE_WORKOUT_PLAN_CAPABILITY,
      target_client_id: CLIENT,
      diff: DIFF_5,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty diff', () => {
    const r = CreateWorkoutPlanPayloadSchema.safeParse({
      capability: CREATE_WORKOUT_PLAN_CAPABILITY,
      target_client_id: CLIENT,
      diff: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an update_exercise op that changes no field (array superRefine)', () => {
    const r = CreateWorkoutPlanPayloadSchema.safeParse({
      capability: CREATE_WORKOUT_PLAN_CAPABILITY,
      target_client_id: CLIENT,
      diff: [{ kind: 'update_exercise', client_ref: 'r1' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects extra top-level properties (strict)', () => {
    const r = CreateWorkoutPlanPayloadSchema.safeParse({
      capability: CREATE_WORKOUT_PLAN_CAPABILITY,
      target_client_id: CLIENT,
      diff: DIFF_5,
      smuggled: true,
    });
    expect(r.success).toBe(false);
  });
});

describe('CreateWorkoutPlanMaterializer', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'true';
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('canHandle identifies only draft.create_workout_plan', () => {
    const mat = new CreateWorkoutPlanMaterializer({} as any, {} as any, {} as any);
    expect(mat.canHandle(CREATE_WORKOUT_PLAN_CAPABILITY)).toBe(true);
    expect(mat.canHandle('draft.edit_workout_plan')).toBe(false);
    expect(mat.canHandle('draft.coach_message')).toBe(false);
  });

  it('happy path: empty baseline + 5-op diff → plan, exercises, v0 revision; ref===plan.id (#1)', async () => {
    const prisma = buildPrisma(draft());
    const analytics = analyticsStub();
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analytics);
    const result = await mat.materialize(draft());

    expect(result.status).toBe('sent');
    expect(prisma.store.plans).toHaveLength(1);
    const plan = prisma.store.plans[0];
    expect(result.ref).toBe(plan.id);
    expect(plan.is_template).toBe(false);
    expect(plan.name).toBe('AI Push Day');

    // Four exercises persisted in contiguous 0-based order.
    const exs = prisma.store.exercises.filter((e: any) => e.workout_plan_id === plan.id);
    expect(exs).toHaveLength(4);
    expect(exs.map((e: any) => e.order).sort()).toEqual([0, 1, 2, 3]);

    // v0 revision authored by ai with cause 'initial'; head pointer advanced.
    const rev = prisma.store.planRevisions[0];
    expect(rev.revision_index).toBe(0);
    expect(rev.author_kind).toBe('ai');
    expect(rev.cause).toBe('initial');
    expect(plan.head_revision_id).toBe(rev.id);

    // A fresh program was created (no target_program_id) with a v0 program revision.
    expect(prisma.store.programs).toHaveLength(1);
    expect(prisma.store.programRevisions).toHaveLength(1);

    // Draft marked materialised with the plan id.
    expect(prisma.store.draft.materialised_ref).toBe(plan.id);
    expect(prisma.store.draft.materialised_at).not.toBeNull();

    // P1.2 — PostHog telemetry fired once on success with the expected event
    // name + payload shape (capability, draft_id, plan_id, coach_id,
    // week_count, exercise_count, duration_ms). distinctId is the coach id.
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    const [distinctId, event, props] = analytics.capture.mock.calls[0];
    expect(distinctId).toBe(COACH);
    expect(event).toBe('mwb_live_create_invoked');
    expect(props).toEqual(
      expect.objectContaining({
        capability: CREATE_WORKOUT_PLAN_CAPABILITY,
        draft_id: 'draft-create-1',
        plan_id: plan.id,
        coach_id: COACH,
        week_count: 1,
        exercise_count: 4,
      }),
    );
    expect(typeof props.duration_ms).toBe('number');
  });

  it('template_seed: forks the seed exercises into a FRESH plan, never mutating the seed (#2)', async () => {
    const seedHeadRev = {
      id: 'seed-rev',
      exercises_json: [
        { client_ref: 's0', exercise_external_id: 'squat', order: 0, sets: 5, reps_or_duration_seconds: 5, weight_lbs: 225, rest_seconds: 120, superset_group_id: null, notes: null },
      ],
      plan_meta_json: { name: 'Template A', type: 'strength', duration_estimate_minutes: 60 },
    };
    const prisma = buildPrisma(
      draft({
        payload: {
          capability: CREATE_WORKOUT_PLAN_CAPABILITY,
          target_client_id: CLIENT,
          template_seed: { source_template_plan_id: '11111111-1111-1111-1111-111111111111' },
          diff: [
            { kind: 'add_exercise', client_ref: 'new1', exercise_external_id: 'deadlift', sets: 3, reps_or_duration_seconds: 5 },
          ],
        },
      }),
      {
        plans: [
          { id: '11111111-1111-1111-1111-111111111111', coach_id: COACH, name: 'Template A', type: 'strength', duration_estimate_minutes: 60, is_template: true, head_revision_id: 'seed-rev' },
        ],
        planRevisions: [seedHeadRev],
      },
    );
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    const result = await mat.materialize(
      prisma.store.draft,
    );

    // A NEW plan was created — not the seed id.
    const newPlan = prisma.store.plans.find((p: any) => p.id !== '11111111-1111-1111-1111-111111111111');
    expect(newPlan).toBeDefined();
    expect(result.ref).toBe(newPlan.id);

    // The new plan carries the forked seed exercise + the diff's added one.
    const exs = prisma.store.exercises.filter((e: any) => e.workout_plan_id === newPlan.id);
    expect(exs).toHaveLength(2);
    const extIds = exs.map((e: any) => e.exercise_external_id).sort();
    expect(extIds).toEqual(['deadlift', 'squat']);

    // The seed revision JSON is untouched (no write against it).
    expect(seedHeadRev.exercises_json).toHaveLength(1);
  });

  it('into existing program: appends without bumping program revision_index (#3)', async () => {
    const PROG = '22222222-2222-2222-2222-222222222222';
    const prisma = buildPrisma(
      draft({
        payload: {
          capability: CREATE_WORKOUT_PLAN_CAPABILITY,
          target_client_id: CLIENT,
          target_program_id: PROG,
          diff: DIFF_5,
        },
      }),
      {
        programs: [{ id: PROG, coach_id: COACH, head_revision_id: 'pre-existing-rev' }],
      },
    );
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    await mat.materialize(prisma.store.draft);

    // No NEW program created, and no new program revision (no structural change).
    expect(prisma.store.programs).toHaveLength(1);
    expect(prisma.store.programRevisions).toHaveLength(0);
    expect(prisma.store.plans[0].program_id).toBe(PROG);
  });

  it('sub-coach scope honoured: rejects 403 when canAccessClient is false (#6)', async () => {
    const prisma = buildPrisma(draft());
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(false), analyticsStub());
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing written.
    expect(prisma.store.plans).toHaveLength(0);
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('idempotency: an already-materialised draft returns already_materialised, no write (#8)', async () => {
    const prisma = buildPrisma(
      draft({ materialised_at: new Date(), materialised_ref: 'plan-prior' }),
    );
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    const result = await mat.materialize(
      draft({ materialised_at: new Date(), materialised_ref: 'plan-prior' }),
    );
    expect(result).toEqual({ status: 'already_materialised', ref: 'plan-prior' });
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('coerces a P2034 serialization failure to a 409 ConflictException (#10), and does NOT emit telemetry on failure (P1.2)', async () => {
    const prisma = buildPrisma(draft());
    const analytics = analyticsStub();
    prisma.$transaction = jest.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
    });
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analytics);
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ConflictException);
    // P1.2 — failures flow through the exception path only; no double-count.
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it('rejects materialisation when the feature flag is OFF (defence-in-depth)', async () => {
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'false';
    const prisma = buildPrisma(draft());
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    await expect(mat.materialize(draft())).rejects.toThrow(/disabled|off/i);
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('rejects a drifted payload (missing target_client_id) before any write', async () => {
    const bad = draft({
      payload: { capability: CREATE_WORKOUT_PLAN_CAPABILITY, diff: DIFF_5 },
    });
    const prisma = buildPrisma(bad);
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    await expect(mat.materialize(bad)).rejects.toThrow();
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('P1.1 — two approvers BOTH observe the same pending draft; exactly ONE succeeds and the OTHER throws mwb_materialise_conflict; exactly ONE WorkoutProgram exists', async () => {
    // Both approvers are handed the SAME stale pending-draft view (markers
    // null) — modelling two coaches who each read the draft as pending before
    // either approved. They share one in-memory store, so the conditional
    // in-txn claim (materialised_at IS NULL AND materialised_ref IS NULL)
    // behaves like a real row: only the FIRST claim lands. The second observes
    // count=0 and its transaction aborts at the claim BEFORE any program/plan
    // write; the $transaction mock then rolls the store back (so the loser's
    // claim write is reverted, exactly as Postgres would abort the txn).
    //
    // We invoke the two materialisations and collect results with
    // Promise.allSettled, then assert exactly-one-commit / exactly-one-409.
    // The store cannot model true row-lock interleaving, so the approvers are
    // sequenced A-then-B; the invariant under test (no duplicate plan) is the
    // same regardless of which approver wins the claim.
    const prisma = buildPrisma(draft());
    const staleView = draft(); // both approvers saw markers null
    const a = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    const b = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());

    const winnerResult = await a.materialize({ ...staleView });
    const loserOutcome = await b
      .materialize({ ...staleView })
      .then((v) => ({ ok: true as const, v }))
      .catch((e) => ({ ok: false as const, e }));

    const settled = [
      { status: 'fulfilled' as const, value: winnerResult },
      loserOutcome.ok
        ? { status: 'fulfilled' as const, value: loserOutcome.v }
        : { status: 'rejected' as const, reason: loserOutcome.e },
    ];
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect((fulfilled[0] as any).value.status).toBe('sent');
    const loserErr = (rejected[0] as any).reason;
    expect(loserErr).toBeInstanceOf(ConflictException);
    expect((loserErr as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ error: 'mwb_materialise_conflict' }),
    );

    // Exactly ONE program + ONE plan row — the duplicate-write window is closed.
    expect(prisma.store.programs).toHaveLength(1);
    expect(prisma.store.plans).toHaveLength(1);
    expect(prisma.store.draft.materialised_ref).toBe(prisma.store.plans[0].id);
  });

  it('P1 (R2) approve/reject race — a draft that concurrently became `rejected` throws mwb_materialise_conflict and writes ZERO downstream rows', async () => {
    // Trust-surface regression (R2 audit P1). `AiApprovalService.decide` reads
    // the draft, checks `status === 'pending'`, then calls this materialiser
    // BEFORE flipping the terminal status. A concurrent approve + reject can
    // both pass that initial pending read. Here the reject WON the status flip
    // first: the authoritative store row is `status='rejected'` with markers
    // still null (the reject path does not stamp materialised_at). The stale
    // approve then arrives at this materialiser carrying its OWN pending view
    // (markers null) so the idempotency short-circuit does NOT fire and we
    // reach the in-txn claim. Because the claim now includes `status:
    // 'pending'` (create-workout-plan.materialiser.ts:223-231) it matches ZERO
    // rows against the rejected draft → count=0 → ConflictException, BEFORE any
    // WorkoutProgram/WorkoutPlan/exercise/revision write. Without the status
    // predicate the claim would still match (markers are null) and we'd write a
    // real plan for a rejected draft.
    const prisma = buildPrisma(draft({ status: 'rejected' }));
    const analytics = analyticsStub();
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analytics);

    const staleApproveView = draft({ status: 'pending' }); // markers null
    let thrown: unknown;
    try {
      await mat.materialize(staleApproveView);
    } catch (e) {
      thrown = e;
    }

    // Typed conflict with the canonical error code.
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ error: 'mwb_materialise_conflict' }),
    );

    // ZERO downstream rows of every kind the create path can write.
    expect(prisma.store.programs).toHaveLength(0);
    expect(prisma.store.plans).toHaveLength(0);
    expect(prisma.store.exercises).toHaveLength(0);
    expect(prisma.store.planRevisions).toHaveLength(0);
    expect(prisma.store.programRevisions).toHaveLength(0);
    expect(prisma.workoutProgram.create).not.toHaveBeenCalled();
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
    expect(prisma.workoutPlanExercise.createMany).not.toHaveBeenCalled();

    // The draft stays rejected with no materialisation marker — no side-effect.
    expect(prisma.store.draft.status).toBe('rejected');
    expect(prisma.store.draft.materialised_at).toBeNull();
    expect(prisma.store.draft.materialised_ref).toBeNull();

    // No success telemetry on a conflict.
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it('P2 (R2) true concurrency — two approvers race via Promise.allSettled; exactly ONE fulfilled with a WorkoutProgram and ONE rejected with ConflictException', async () => {
    // Mirrors the edit spec's Promise.allSettled concurrency pattern. Both
    // approvers race against the SAME in-memory store; the conditional in-txn
    // claim (id + status='pending' + markers null) behaves like a real row, so
    // only the FIRST claim lands. The loser observes count=0 and aborts at the
    // claim BEFORE any program/plan write; the $transaction mock rolls its
    // claim write back. Asserts exactly one fulfilled (with a WorkoutProgram
    // row created) and exactly one ConflictException — no duplicate program.
    const prisma = buildPrisma(draft());
    const a = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    const b = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());

    const settled = await Promise.allSettled([
      a.materialize(draft()),
      b.materialize(draft()),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect((fulfilled[0] as PromiseFulfilledResult<any>).value.status).toBe('sent');
    const loser = rejected[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException);
    expect((loser.reason as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ error: 'mwb_materialise_conflict' }),
    );

    // Exactly ONE WorkoutProgram (and ONE plan) — the loser wrote nothing.
    expect(prisma.store.programs).toHaveLength(1);
    expect(prisma.store.plans).toHaveLength(1);
    expect(prisma.store.draft.materialised_ref).toBe(prisma.store.plans[0].id);
  });

  it('P1.1 — a draft already claimed-and-finalised throws mwb_materialise_conflict on re-claim without writes (defence-in-depth past the in-memory short-circuit)', async () => {
    // The in-memory draft passed to materialize() is STALE (both markers null),
    // so the early short-circuit does not fire; the authoritative row in the
    // store is already finalised. The in-txn claim must observe that and abort.
    const prisma = buildPrisma(
      draft({ materialised_at: new Date(), materialised_ref: 'plan-prior' }),
    );
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true), analyticsStub());
    await expect(
      mat.materialize(draft()), // stale view: markers null
    ).rejects.toBeInstanceOf(ConflictException);
    // No new program/plan written.
    expect(prisma.store.programs).toHaveLength(0);
    expect(prisma.store.plans).toHaveLength(0);
  });
});
