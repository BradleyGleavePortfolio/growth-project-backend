/**
 * MWB-5 — EditWorkoutPlanMaterializer behaviour (brief Test matrix #4, #5, #6,
 * #8, #10).
 *
 * The edit path locks the target plan (SELECT … FOR UPDATE via tx.$queryRaw),
 * asserts the optimistic-concurrency token (base_revision_index === head
 * revision_index), applies the diff via the shared pure applier, archives the
 * current live exercise rows + inserts the new ordered set, writes a new
 * revision (cause='ai_apply', author_kind='ai') and advances the head pointer.
 * The model is NEVER called. Tests drive a Prisma stub that mirrors that slice.
 */

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EDIT_WORKOUT_PLAN_CAPABILITY,
  EditWorkoutPlanMaterializer,
  EditWorkoutPlanPayloadSchema,
} from '../src/ai/gateway/materialisers/edit-workout-plan.materialiser';
import { FEATURE_MWB_AI_LIVE_CREATE_ENV } from '../src/ai/gateway/mwb-live-create.feature';

const COACH = '00000000-0000-0000-0000-0000000000c1';
const CLIENT = '00000000-0000-0000-0000-0000000000a1';
const PLAN = '33333333-3333-3333-3333-333333333333';

const HEAD_REV = {
  id: 'head-rev-1',
  workout_plan_id: PLAN,
  revision_index: 2,
  exercises_json: [
    { client_ref: 'a', exercise_external_id: 'bench', order: 0, sets: 4, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 90, superset_group_id: null, notes: null },
    { client_ref: 'b', exercise_external_id: 'row', order: 1, sets: 4, reps_or_duration_seconds: 10, weight_lbs: 95, rest_seconds: 90, superset_group_id: null, notes: null },
  ],
  plan_meta_json: { name: 'Upper A', type: 'strength', duration_estimate_minutes: 50 },
};

function draft(overrides: Partial<any> = {}, payloadOverrides: Partial<any> = {}): any {
  return {
    id: 'draft-edit-1',
    capability: EDIT_WORKOUT_PLAN_CAPABILITY,
    status: 'pending',
    requester_id: COACH,
    tenant_coach_id: COACH,
    subject_user_id: CLIENT,
    materialised_at: null,
    materialised_ref: null,
    payload: {
      capability: EDIT_WORKOUT_PLAN_CAPABILITY,
      target_plan_id: PLAN,
      base_revision_index: 2,
      diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }],
      ...payloadOverrides,
    },
    ...overrides,
  };
}

function buildPrisma(initialDraft: any, opts: { assignments?: any[]; planCoachId?: string } = {}) {
  const store = {
    plans: [
      { id: PLAN, coach_id: opts.planCoachId ?? COACH, head_revision_id: HEAD_REV.id, version: 3, name: 'Upper A', type: 'strength', duration_estimate_minutes: 50 },
    ] as any[],
    exercises: [
      { id: 'ex-a', workout_plan_id: PLAN, exercise_external_id: 'bench', order: 0, sets: 4, reps_or_duration_seconds: 8, archived_at: null },
      { id: 'ex-b', workout_plan_id: PLAN, exercise_external_id: 'row', order: 1, sets: 4, reps_or_duration_seconds: 10, archived_at: null },
    ] as any[],
    planRevisions: [{ ...HEAD_REV }] as any[],
    assignments: opts.assignments ?? [] as any[],
    draft: { ...initialDraft },
    seq: 0,
  };
  const id = (p: string) => `${p}-${++store.seq}`;

  const client = {
    $queryRaw: jest.fn(async () => {
      // SELECT id, head_revision_id FROM WorkoutPlan WHERE id = ... FOR UPDATE
      return store.plans
        .filter((p) => p.id === store.draft.payload.target_plan_id)
        .map((p) => ({ id: p.id, head_revision_id: p.head_revision_id }));
    }),
    workoutPlanRevision: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.planRevisions.find((r) => r.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('rev'), ...data };
        store.planRevisions.push(row);
        return row;
      }),
    },
    workoutPlanExercise: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        store.exercises.forEach((e) => {
          if (e.workout_plan_id === where.workout_plan_id && e.archived_at == null) {
            Object.assign(e, data);
            count++;
          }
        });
        return { count };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        data.forEach((d: any) => store.exercises.push({ id: id('ex'), archived_at: null, ...d }));
        return { count: data.length };
      }),
    },
    workoutPlan: {
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.plans.find((p) => p.id === where.id);
        if (data.version && typeof data.version === 'object' && 'increment' in data.version) {
          row.version += data.version.increment;
          const { version: _v, ...rest } = data;
          Object.assign(row, rest);
        } else {
          Object.assign(row, data);
        }
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        store.plans.find((p) => p.id === where.id) ?? null,
      ),
    },
  };

  const prisma: any = {
    workoutPlan: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.plans.find((p) => p.id === where.id) ?? null,
      ),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async () => store.assignments),
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
    store,
    $transaction: jest.fn(async (fn: any) => fn(client)),
    _txClient: client,
  };
  return prisma;
}

function scope(canAccess = true, isSub = false) {
  return {
    canAccessClient: jest.fn(async () => canAccess),
    isSubCoach: jest.fn(async () => isSub),
  } as any;
}

describe('EditWorkoutPlanPayloadSchema', () => {
  it('accepts a canonical payload', () => {
    const r = EditWorkoutPlanPayloadSchema.safeParse({
      capability: EDIT_WORKOUT_PLAN_CAPABILITY,
      target_plan_id: PLAN,
      base_revision_index: 2,
      diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a negative base_revision_index', () => {
    const r = EditWorkoutPlanPayloadSchema.safeParse({
      capability: EDIT_WORKOUT_PLAN_CAPABILITY,
      target_plan_id: PLAN,
      base_revision_index: -1,
      diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('EditWorkoutPlanMaterializer', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'true';
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('canHandle identifies only draft.edit_workout_plan', () => {
    const mat = new EditWorkoutPlanMaterializer({} as any, {} as any);
    expect(mat.canHandle(EDIT_WORKOUT_PLAN_CAPABILITY)).toBe(true);
    expect(mat.canHandle('draft.create_workout_plan')).toBe(false);
  });

  it('happy path: head revision_index +1, cause ai_apply, author ai; head advances (#4)', async () => {
    const prisma = buildPrisma(draft());
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    const result = await mat.materialize(draft());

    expect(result.status).toBe('sent');
    expect(result.ref).toBe(PLAN);

    // New revision at index 3 (head was 2), authored by ai, cause ai_apply.
    const newRev = prisma.store.planRevisions.find((r: any) => r.revision_index === 3);
    expect(newRev).toBeDefined();
    expect(newRev.author_kind).toBe('ai');
    expect(newRev.cause).toBe('ai_apply');

    // Head pointer advanced + version bumped.
    const plan = prisma.store.plans[0];
    expect(plan.head_revision_id).toBe(newRev.id);
    expect(plan.version).toBe(4);

    // Old live rows archived; new ordered set inserted with the patched sets.
    const live = prisma.store.exercises.filter((e: any) => e.archived_at == null);
    expect(live).toHaveLength(2);
    const benchRow = live.find((e: any) => e.exercise_external_id === 'bench');
    expect(benchRow.sets).toBe(5);

    // Draft marked materialised.
    expect(prisma.store.draft.materialised_ref).toBe(PLAN);
  });

  it('optimistic concurrency: stale base_revision_index → 409 gateway_concurrent_edit_retry (#5)', async () => {
    const prisma = buildPrisma(draft({}, { base_revision_index: 1 }));
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    await expect(
      mat.materialize(draft({}, { base_revision_index: 1 })),
    ).rejects.toBeInstanceOf(ConflictException);
    // No new revision written.
    expect(prisma.store.planRevisions).toHaveLength(1);
    expect(prisma.store.draft.materialised_at).toBeNull();
  });

  it('sub-coach scope: rejects 403 when canAccessClient false for an assigned plan (#6)', async () => {
    const prisma = buildPrisma(draft(), {
      assignments: [{ client_id: CLIENT }],
    });
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(false, true));
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant plan with 403 before any write', async () => {
    const prisma = buildPrisma(draft(), { planCoachId: 'other-coach' });
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unassigned plan: head coach (requester===tenant) is allowed', async () => {
    const prisma = buildPrisma(draft(), { assignments: [] });
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    const result = await mat.materialize(draft());
    expect(result.status).toBe('sent');
  });

  it('idempotency: an already-materialised draft returns already_materialised, no write (#8)', async () => {
    const prisma = buildPrisma(
      draft({ materialised_at: new Date(), materialised_ref: PLAN }),
    );
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    const result = await mat.materialize(
      draft({ materialised_at: new Date(), materialised_ref: PLAN }),
    );
    expect(result).toEqual({ status: 'already_materialised', ref: PLAN });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('coerces a P2034 serialization failure to a 409 ConflictException (#10)', async () => {
    const prisma = buildPrisma(draft());
    prisma.$transaction = jest.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: 'test',
      });
    });
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(draft())).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects materialisation when the feature flag is OFF (defence-in-depth)', async () => {
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'false';
    const prisma = buildPrisma(draft());
    const mat = new EditWorkoutPlanMaterializer(prisma, scope(true));
    await expect(mat.materialize(draft())).rejects.toThrow(/disabled|off/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
