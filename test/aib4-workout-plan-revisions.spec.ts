/**
 * AIB-4: GET /workout-plans/:planId/revisions — read-only, tenant-scoped
 * revision history for the builder's History sheet (AI_MASTER_BUILDER_PLAN.md
 * section 3). Same owner/visibility gate as autosave and undo.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import {
  parseRevisionsLimit,
  summariseRevision,
} from '../src/workout-builder/workout-plan-revision-summary';

function fake<T>(value: unknown): T {
  return value as T;
}

const PLAN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HEAD = 'head-1';
const FOREIGN = 'head-9';

const row = (id: string, sets = 3, reps = 10) => ({
  exercise_external_id: id,
  order: 1,
  sets,
  reps_or_duration_seconds: reps,
  weight_lbs: null,
  rest_seconds: null,
  superset_group_id: null,
  notes: 'private coach note',
});

function rev(index: number, cause: string, author: string, exercises: unknown) {
  return {
    revision_index: index,
    author_kind: author,
    cause,
    created_at: new Date(Date.UTC(2026, 9, 6, 12, index)),
    exercises_json: exercises,
  };
}

function build(revisions: ReturnType<typeof rev>[]) {
  const prisma = {
    workoutPlan: {
      findUnique: jest.fn(async () => ({ coach_id: HEAD, program_id: null, program: null })),
    },
    workoutPlanRevision: {
      findMany: jest.fn(async (args: { take: number }) => revisions.slice(0, args.take)),
    },
  };
  const scope = {
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
    getAuthorizedClientIds: jest.fn(async () => []),
  };
  const service = new WorkoutBuilderAutosaveService(
    fake(prisma),
    fake(undefined),
    new AnalyticsService(),
    fake(scope),
  );
  return { service, prisma };
}

describe('AIB-4 revisions list', () => {
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  beforeEach(() => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL_FLAG;
  });

  const history = [
    rev(3, 'undo', 'coach', [row('squat'), row('row')]),
    rev(2, 'ai_apply', 'ai', [row('goblet_squat'), row('row', 3, 12), row('plank')]),
    rev(1, 'autosave', 'coach', [row('squat'), row('row')]),
    rev(0, 'initial', 'coach', [row('squat')]),
  ];

  it('the plan coach gets newest first with derived summaries and no notes', async () => {
    const { service, prisma } = build(history);
    const list = await service.listRevisions(PLAN_ID, { userId: HEAD }, '20');
    expect(prisma.workoutPlanRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workout_plan_id: PLAN_ID },
        orderBy: { revision_index: 'desc' },
        take: 21,
      }),
    );
    expect(list.map((r) => r.revision_index)).toEqual([3, 2, 1, 0]);
    expect(list[1]).toEqual({
      revision_index: 2,
      author_kind: 'ai',
      cause: 'ai_apply',
      created_at: '2026-10-06T12:02:00.000Z',
      summary: 'AI-suggested, coach-approved: 2 added, 1 changed, 1 removed. 3 exercises.',
    });
    expect(list[0].summary).toBe('Restored an earlier version: 1 added, 1 changed, 2 removed. 2 exercises.');
    expect(list[3].summary).toBe('Created. 1 exercise.');
    expect(JSON.stringify(list)).not.toContain('private coach note');
  });

  it("another coach's plan is refused before any revision row is read", async () => {
    const { service, prisma } = build(history);
    await expect(service.listRevisions(PLAN_ID, { userId: FOREIGN }, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.workoutPlanRevision.findMany).not.toHaveBeenCalled();
  });

  it('an unknown plan is 404', async () => {
    const { service, prisma } = build(history);
    prisma.workoutPlan.findUnique.mockResolvedValueOnce(fake(null));
    await expect(service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('feature off -> 404 and nothing is read', async () => {
    delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    const { service, prisma } = build(history);
    await expect(service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.workoutPlan.findUnique).not.toHaveBeenCalled();
  });

  it('limit: default 20, clamped to 1..50; the extra row is only a baseline', async () => {
    expect(parseRevisionsLimit(undefined)).toBe(20);
    expect(parseRevisionsLimit('0')).toBe(1);
    expect(parseRevisionsLimit('500')).toBe(50);
    expect(parseRevisionsLimit('abc')).toBe(20);
    const { service } = build(history);
    const list = await service.listRevisions(PLAN_ID, { userId: HEAD }, '2');
    expect(list.map((r) => r.revision_index)).toEqual([3, 2]);
    expect(list[1].summary).toContain('2 added');
  });

  it('a pruned gap or malformed snapshot never invents a diff', () => {
    expect(summariseRevision('autosave', null, [row('a')])).toBe('Edited. 1 exercise.');
    const { service } = build([rev(9, 'autosave', 'coach', 'not-an-array'), rev(4, 'autosave', 'coach', [row('a')])]);
    return expect(service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).resolves.toEqual([
      expect.objectContaining({ revision_index: 9, summary: 'Edited. 0 exercises.' }),
      expect.objectContaining({ revision_index: 4, summary: 'Edited. 1 exercise.' }),
    ]);
  });
});
