/**
 * AIB-4: GET /workout-plans/:planId/revisions — read-only, tenant-scoped
 * history for the builder's History sheet (same gate as autosave and undo).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import { parseRevisionsLimit } from '../src/workout-builder/workout-plan-revision-summary';

const fake = <T>(v: unknown): T => v as T;
const PLAN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HEAD = 'head-1';

const row = (id: string, reps = 10) => ({
  exercise_external_id: id,
  order: 1,
  sets: 3,
  reps_or_duration_seconds: reps,
  weight_lbs: null,
  notes: 'private coach note',
});
const rev = (index: number, cause: string, author: string, exercises: unknown) => ({
  revision_index: index,
  author_kind: author,
  cause,
  created_at: new Date(Date.UTC(2026, 9, 6, 12, index)),
  exercises_json: exercises,
});
const HISTORY = [
  rev(3, 'undo', 'coach', [row('squat'), row('row')]),
  rev(2, 'ai_apply', 'ai', [row('goblet_squat'), row('row', 12), row('plank')]),
  rev(1, 'autosave', 'coach', [row('squat'), row('row')]),
  rev(0, 'initial', 'coach', [row('squat')]),
];

function build(revisions = HISTORY) {
  const prisma = {
    workoutPlan: { findUnique: jest.fn(async () => ({ coach_id: HEAD, program_id: null, program: null })) },
    workoutPlanRevision: { findMany: jest.fn(async (a: { take: number }) => revisions.slice(0, a.take)) },
  };
  const scope = { getHeadCoachIdForSubCoach: jest.fn(async () => null), getAuthorizedClientIds: jest.fn(async () => []) };
  const service = new WorkoutBuilderAutosaveService(fake(prisma), fake(undefined), new AnalyticsService(), fake(scope));
  return { service, prisma };
}

describe('AIB-4 revisions list', () => {
  const ORIGINAL = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  beforeEach(() => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL;
  });

  it('the plan coach gets newest first, derived summaries, no notes', async () => {
    const { service, prisma } = build();
    const list = await service.listRevisions(PLAN_ID, { userId: HEAD }, '20');
    expect(prisma.workoutPlanRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workout_plan_id: PLAN_ID }, orderBy: { revision_index: 'desc' }, take: 21 }),
    );
    expect(list[1]).toEqual({
      revision_index: 2,
      author_kind: 'ai',
      cause: 'ai_apply',
      created_at: '2026-10-06T12:02:00.000Z',
      summary: 'AI-suggested, coach-approved: 2 added, 1 changed, 1 removed. 3 exercises.',
    });
    expect(list.map((r) => r.summary)).toEqual([
      'Restored an earlier version: 1 added, 1 changed, 2 removed. 2 exercises.',
      list[1].summary,
      'Edited: 1 added. 2 exercises.',
      'Created. 1 exercise.',
    ]);
    expect(JSON.stringify(list)).not.toContain('private coach note');
  });

  it("another coach's plan is 403 before any revision row is read; unknown plan 404; flag off 404", async () => {
    const a = build();
    await expect(a.service.listRevisions(PLAN_ID, { userId: 'head-9' }, undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(a.prisma.workoutPlanRevision.findMany).not.toHaveBeenCalled();
    a.prisma.workoutPlan.findUnique.mockResolvedValueOnce(fake(null));
    await expect(a.service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).rejects.toBeInstanceOf(NotFoundException);
    delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    const b = build();
    await expect(b.service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(b.prisma.workoutPlan.findUnique).not.toHaveBeenCalled();
  });

  it('limit defaults to 20, clamps to 1..50; the extra row is a baseline only; a gap or bad snapshot invents nothing', async () => {
    expect([undefined, '0', '500', 'abc'].map(parseRevisionsLimit)).toEqual([20, 1, 50, 20]);
    const list = await build().service.listRevisions(PLAN_ID, { userId: HEAD }, '2');
    expect(list.map((r) => r.revision_index)).toEqual([3, 2]);
    expect(list[1].summary).toContain('2 added');
    const gap = build([rev(9, 'autosave', 'coach', 'not-an-array'), rev(4, 'autosave', 'coach', [row('a')])]);
    expect((await gap.service.listRevisions(PLAN_ID, { userId: HEAD }, undefined)).map((r) => r.summary)).toEqual([
      'Edited. 0 exercises.',
      'Edited. 1 exercise.',
    ]);
  });
});
