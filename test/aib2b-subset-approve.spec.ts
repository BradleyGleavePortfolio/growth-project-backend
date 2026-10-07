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

function build(over: { provenance?: unknown; capability?: string; subCoaches?: number } = {}) {
  const draft = {
    id: 'draft-1', capability: over.capability ?? 'draft.edit_workout_plan', status: 'pending', requester_id: COACH, tenant_coach_id: COACH,
    subject_user_id: null, payload, rationale: 'text', provenance: over.provenance ?? MARKER, materialised_ref: null,
  };
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    aiActionDraft: { updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => { updates.push(args); return { count: 1 }; }) },
    aiRequestAudit: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    aiActionDraft: { findUnique: jest.fn(async () => draft) },
    teamSubCoachAssignment: { count: jest.fn(async () => over.subCoaches ?? 1) },
    workoutPlan: { findUnique: jest.fn(async () => ({ version: 4, head_revision_id: 'rev-4' })) },
    workoutPlanRevision: { findUnique: jest.fn(async () => ({ revision_index: 3 })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const materialize = jest.fn(async (_d: { payload: unknown }) => ({ status: 'sent', ref: PLAN }));
  const registry = fakeOf<CapabilityMaterializerRegistry>({ resolve: () => ({ materialize }) });
  const svc = new AiApprovalService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({ write: jest.fn(async () => undefined) }), registry);
  return { svc, materialize, updates };
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
