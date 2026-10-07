// B-AIB2-126 (stacked on the generator) — subset approve of an AI workout-builder draft, the marker after a JSONB round trip,
// and the materialised_ref the builder adopts.
import { BadRequestException } from '@nestjs/common';
import { AiApprovalService, isWorkoutBuilderModelDraft, selectAcceptedOps } from '../src/ai/gateway/ai-approval.service';
import { AiGatewayController } from '../src/ai/gateway/ai-gateway.controller';
import { AiGatewayService, WORKOUT_BUILDER_MODEL_DIFF_SOURCE } from '../src/ai/gateway/ai-gateway.service';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';
import { CapabilityMaterializerRegistry } from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const PLAN = '11111111-1111-4111-8111-111111111111';
const COACH = 'coach-1';
const MARKER = [{ source: WORKOUT_BUILDER_MODEL_DIFF_SOURCE, hash: 'written-before-the-round-trip', count: 1 }];

// As Postgres JSONB returns it: keys reordered (diff first, op keys sorted), so no hash of the written JSON can match.
const payload = {
  diff: [{ client_ref: 'r1', kind: 'update_exercise', rest_seconds: 90 }, { client_ref: 'r2', kind: 'remove_exercise' }],
  base_revision_index: 2, capability: 'draft.edit_workout_plan', target_plan_id: PLAN,
};

type HeadRow = { revision_index: number; exercises_json?: unknown; plan_meta_json?: unknown };
type Over = {
  provenance?: unknown; capability?: string; subCoaches?: number; payload?: Record<string, unknown>; head?: HeadRow;
  plan?: Record<string, unknown>; experience?: string; subject?: string | null;
};
function build(over: Over = {}) {
  const draft = {
    id: 'draft-1', capability: over.capability ?? 'draft.edit_workout_plan', status: 'pending', requester_id: COACH, tenant_coach_id: COACH,
    subject_user_id: over.subject ?? null, payload: over.payload ?? payload, rationale: 'text', provenance: over.provenance ?? MARKER, materialised_ref: null,
  };
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    aiActionDraft: { updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => { updates.push(args); return { count: 1 }; }) },
    aiRequestAudit: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    aiActionDraft: { findUnique: jest.fn(async () => draft) },
    teamSubCoachAssignment: { count: jest.fn(async () => over.subCoaches ?? 1) },
    workoutPlan: {
      findUnique: jest.fn(async () => ({ id: PLAN, coach_id: COACH, version: 4, head_revision_id: 'rev-4', program_id: null, week_index: null, ...over.plan })),
      findMany: jest.fn(async () => [{ id: 'day-2', head_revision_id: null }]),
    },
    workoutPlanRevision: { findUnique: jest.fn(async () => over.head ?? { revision_index: 3 }), findMany: jest.fn(async () => []) },
    // The week's other day: 13 lat sets.
    workoutPlanExercise: { findMany: jest.fn(async () => [{ exercise_external_id: 'seed:pull-001', sets: 13 }]) },
    userProfile: { findUnique: jest.fn(async () => ({ workout_experience: over.experience ?? 'beginner' })) },
    user: { findUnique: jest.fn(async () => ({ coach_id: COACH })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const materialize = jest.fn(async (_d: { payload: unknown }) => ({ status: 'sent', ref: PLAN }));
  const registry = fakeOf<CapabilityMaterializerRegistry>({ resolve: () => ({ materialize }) });
  const svc = new AiApprovalService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({ write: jest.fn(async () => undefined) }), registry);
  return { svc, materialize, updates, prisma };
}
const approve = { draftId: 'draft-1', decider: { id: COACH, role: 'coach' }, decision: 'approved' as const };

describe('AiApprovalService subset approve (B-AIB2-126)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'test-secret-for-lock-token' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });
  it('a head coach with a sub-coach approves the AI draft after the JSONB round trip; only accepted ops are applied', async () => {
    const { svc, materialize, updates } = build();
    const res = await svc.decide({ ...approve, acceptedChangeIds: ['c0'] });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0]).toMatchObject({ payload: { diff: [payload.diff[0]] } });
    expect(updates[0].data.payload).toEqual({ ...payload, diff: [payload.diff[0]] });
    expect(res.materialised_ref).toEqual({ plan_id: PLAN, revision_index: 3, lock_token: computeLockToken(PLAN, 4, 'rev-4') });
  });
  it('without the gateway marker, or on another capability, the requester rule still applies', async () => {
    await expect(build({ provenance: [] }).svc.decide(approve)).rejects.toMatchObject({ status: 403 });
    await expect(build({ capability: 'draft.coach_message' }).svc.decide(approve)).rejects.toMatchObject({ status: 403 });
    expect(isWorkoutBuilderModelDraft('draft.coach_message', MARKER)).toBe(false);
  });
  it('no lock-token secret: materialised_ref still names the plan and head revision', async () => {
    delete process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET;
    const res = await build().svc.decide(approve);
    expect(res.materialised_ref).toEqual({ plan_id: PLAN, revision_index: 3 });
  });
  it('selectAcceptedOps keeps a reorder only when every other op is accepted', () => {
    const diff = [{ kind: 'add_exercise' }, { kind: 'remove_exercise' }, { kind: 'reorder' }];
    expect(selectAcceptedOps(diff, ['c0', 'c2'])).toEqual([{ kind: 'add_exercise' }]);
    expect(selectAcceptedOps(diff, ['c0', 'c1', 'c2'])).toHaveLength(3);
  });
  it('the controller refuses malformed accepted_change_ids', async () => {
    const decide = jest.fn();
    const ctl = new AiGatewayController(fakeOf<AiGatewayService>({}), fakeOf<AiApprovalService>({ decide }), fakeOf<PrivateContextService>({}));
    const req = fakeOf<AuthedRequest>({ user: { id: COACH, role: 'coach' }, headers: {} });
    await expect(ctl.decide(req, 'draft-1', { decision: 'approved', accepted_change_ids: ['all'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('B-815-1: a partial selection is re-checked against the training ceilings', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'test-secret-for-lock-token' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });
  const ex = (ref: string, id: string, order: number, sets = 3) => ({
    client_ref: ref, exercise_external_id: id, order, sets, reps_or_duration_seconds: 10, weight_lbs: null, rest_seconds: 90, superset_group_id: null, notes: null,
  });
  // Four lat exercises x 3 sets = 12 (the per-workout ceiling). The model swaps one for another 3-set lat exercise (still 12).
  const backDay = { revision_index: 3, plan_meta_json: { name: 'Back', type: 'strength' }, exercises_json: [
    ex('r1', 'seed:pull-001', 0), ex('r2', 'seed:pull-002', 1), ex('r3', 'seed:pull-004', 2), ex('r4', 'seed:pull-001', 3),
  ] };
  const swapPayload = {
    diff: [
      { kind: 'remove_exercise', client_ref: 'r4' },
      { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'seed:pull-002', sets: 3, reps_or_duration_seconds: 10, rest_seconds: 90 },
    ],
    base_revision_index: 3, capability: 'draft.edit_workout_plan', target_plan_id: PLAN,
  };
  it('keeping the add but unticking its removal (15 lat sets) is refused with 422 and nothing is written', async () => {
    const { svc, materialize, updates } = build({ payload: swapPayload, head: backDay });
    await expect(svc.decide({ ...approve, acceptedChangeIds: ['c1'] })).rejects.toMatchObject({
      status: 422, response: { code: 'SELECTION_OVER_LIMITS', message: expect.stringMatching(/^More than 12 hard sets for one muscle in a workout\./) },
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
  it('the full proposal, or only the removal, still applies', async () => {
    const all = build({ payload: swapPayload, head: backDay });
    await all.svc.decide({ ...approve, acceptedChangeIds: ['c0', 'c1'] });
    expect(all.materialize).toHaveBeenCalledTimes(1);
    const removal = build({ payload: swapPayload, head: backDay });
    await removal.svc.decide({ ...approve, acceptedChangeIds: ['c0'] });
    expect(removal.materialize).toHaveBeenCalledTimes(1);
  });
  it('a program day also holds the beginner weekly ceiling, but a normal partial pick under it applies', async () => {
    // This day 3 lat sets + the week's other day 13 = 16 (beginner cap). The model swaps the row for another lat exercise.
    const light = { revision_index: 3, plan_meta_json: { name: 'Pull', type: 'strength' }, exercises_json: [ex('r1', 'seed:pull-001', 0), ex('r2', 'seed:push-001', 1)] };
    const p = {
      ...swapPayload,
      diff: [
        { kind: 'remove_exercise', client_ref: 'r1' },
        { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'seed:pull-002', sets: 3, reps_or_duration_seconds: 10, rest_seconds: 90 },
        { kind: 'update_exercise', client_ref: 'r2', rest_seconds: 60 },
      ],
    };
    const plan = { program_id: 'prog-1', week_index: 0 };
    const beginner = build({ payload: p, head: light, plan, subject: 'client-1' });
    await expect(beginner.svc.decide({ ...approve, acceptedChangeIds: ['c1'] })).rejects.toMatchObject({
      status: 422, response: { code: 'SELECTION_OVER_LIMITS', message: expect.stringMatching(/^More than 16 hard sets for one muscle in this program week\./) },
    });
    expect(beginner.prisma.workoutPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { program_id: 'prog-1', coach_id: COACH, week_index: 0, archived_at: null, id: { not: PLAN } },
    }));
    const intermediate = build({ payload: p, head: light, plan, subject: 'client-1', experience: 'intermediate' });
    await intermediate.svc.decide({ ...approve, acceptedChangeIds: ['c1'] });
    expect(intermediate.materialize).toHaveBeenCalledTimes(1);
    const restOnly = build({ payload: p, head: light, plan, subject: 'client-1' });
    await restOnly.svc.decide({ ...approve, acceptedChangeIds: ['c2'] });
    expect(restOnly.materialize).toHaveBeenCalledTimes(1);
  });
});
