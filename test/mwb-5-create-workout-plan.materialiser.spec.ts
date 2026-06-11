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
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== store.draft.id) return { count: 0 };
        if (where.materialised_at === null && store.draft.materialised_at !== null) {
          return { count: 0 };
        }
        Object.assign(store.draft, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => store.draft),
    },
  };

  const prisma: any = {
    ...client,
    store,
    $transaction: jest.fn(async (fn: any) => fn(client)),
  };
  return prisma;
}

function scope(canAccess = true) {
  return {
    canAccessClient: jest.fn(async () => canAccess),
    isSubCoach: jest.fn(async () => false),
  } as any;
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
    const mat = new CreateWorkoutPlanMaterializer({} as any, {} as any);
    expect(mat.canHandle(CREATE_WORKOUT_PLAN_CAPABILITY)).toBe(true);
    expect(mat.canHandle('draft.edit_workout_plan')).toBe(false);
    expect(mat.canHandle('draft.coach_message')).toBe(false);
  });

  it('happy path: empty baseline + 5-op diff → plan, exercises, v0 revision; ref===plan.id (#1)', async () => {
    const prisma = buildPrisma(draft());
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
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
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
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
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
    await mat.materialize(prisma.store.draft);

    // No NEW program created, and no new program revision (no structural change).
    expect(prisma.store.programs).toHaveLength(1);
    expect(prisma.store.programRevisions).toHaveLength(0);
    expect(prisma.store.plans[0].program_id).toBe(PROG);
  });

  it('sub-coach scope honoured: rejects 403 when canAccessClient is false (#6)', async () => {
    const prisma = buildPrisma(draft());
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(false));
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing written.
    expect(prisma.store.plans).toHaveLength(0);
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('idempotency: an already-materialised draft returns already_materialised, no write (#8)', async () => {
    const prisma = buildPrisma(
      draft({ materialised_at: new Date(), materialised_ref: 'plan-prior' }),
    );
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
    const result = await mat.materialize(
      draft({ materialised_at: new Date(), materialised_ref: 'plan-prior' }),
    );
    expect(result).toEqual({ status: 'already_materialised', ref: 'plan-prior' });
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('coerces a P2034 serialization failure to a 409 ConflictException (#10)', async () => {
    const prisma = buildPrisma(draft());
    prisma.$transaction = jest.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
    });
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects materialisation when the feature flag is OFF (defence-in-depth)', async () => {
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'false';
    const prisma = buildPrisma(draft());
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(draft())).rejects.toThrow(/disabled|off/i);
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });

  it('rejects a drifted payload (missing target_client_id) before any write', async () => {
    const bad = draft({
      payload: { capability: CREATE_WORKOUT_PLAN_CAPABILITY, diff: DIFF_5 },
    });
    const prisma = buildPrisma(bad);
    const mat = new CreateWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(bad)).rejects.toThrow();
    expect(prisma.workoutPlan.create).not.toHaveBeenCalled();
  });
});
