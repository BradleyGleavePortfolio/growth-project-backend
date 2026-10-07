/**
 * B-AIB2-126 — POST /ai/gateway/workout-builder/propose through the REAL
 * AiGatewayService (stub + fake Anthropic adapters) and the real validator.
 */
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { AnthropicProviderAdapter } from '../src/ai/gateway/providers/anthropic-provider.adapter';
import { AiApprovalService, isWorkoutBuilderModelDraft } from '../src/ai/gateway/ai-approval.service';
import { CapabilityMaterializerRegistry } from '../src/ai/gateway/materialisers/capability-materialiser.registry';
import { WorkoutBuilderAiService } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';
import { WorkoutBuilderAiController } from '../src/ai/gateway/workout-builder/workout-builder-ai.controller';
import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { AuditService } from '../src/audit/audit.service';
import { AiEgressService } from '../src/ai-egress/ai-egress.service';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { egressWithGrants, fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

const PLAN = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const COACH = 'coach-1';

interface DraftRow {
  id: string;
  capability: string;
  payload: unknown;
  provenance: unknown;
  requester_id: string;
  tenant_coach_id: string | null;
  subject_user_id: string | null;
  status: string;
  rationale: string;
}

function buildPrisma() {
  const drafts: DraftRow[] = [];
  const prisma = {
    drafts,
    workoutPlan: {
      findUnique: jest.fn(async () => ({ id: PLAN, coach_id: COACH, version: 3, head_revision_id: 'rev-3', archived_at: null })),
    },
    workoutPlanRevision: {
      findUnique: jest.fn(async () => ({
        revision_index: 2,
        exercises_json: [
          { client_ref: 'r1', exercise_external_id: 'seed:push-001', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 120, superset_group_id: null, notes: null },
        ],
        plan_meta_json: { name: 'Upper', type: 'strength', duration_estimate_minutes: 60 },
      })),
    },
    userProfile: { findUnique: jest.fn(async () => ({ goal_type: 'muscle_gain', workout_experience: 'beginner', equipment_access: ['dumbbells'], workout_days_per_week: 3, injuries: ['knee'] })) },
    clientOnboardingIntake: { findUnique: jest.fn(async () => ({ screening_any_yes: false })) },
    user: {
      findMany: jest.fn(async () => [{ id: CLIENT }]),
      findUnique: jest.fn(async () => ({ id: CLIENT, role: 'client', coach_id: COACH })),
    },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    aiRequestAudit: { create: jest.fn(async () => ({ id: 'audit-1' })) },
    aiActionDraft: {
      create: jest.fn(async ({ data }: { data: Omit<DraftRow, 'id'> }) => {
        const row = { id: `draft-${drafts.length + 1}`, ...data };
        drafts.push(row);
        return row;
      }),
    },
  };
  return prisma;
}

function build(opts: { egress?: AiEgressService; anthropic?: jest.Mock; withBudget?: boolean } = {}) {
  const prisma = buildPrisma();
  const anthropic = opts.anthropic ?? jest.fn();
  const registry = new AiProviderRegistry(
    new StubProviderAdapter(),
    fakeOf<AnthropicProviderAdapter>({ name: 'anthropic', complete: anthropic }),
  );
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
    canCharge: jest.fn(async () => ({ budget: { actual_used_cents: 0, total_actual_available_cents: 1000 } })),
    recordUsage: jest.fn(async () => undefined),
    getBudgetDto: jest.fn(async () => ({ total_displayed_cents: 1000, remaining_displayed_cents: 400 })),
  };
  const config = new AiGatewayConfig();
  const gateway = new AiGatewayService(
    fakeOf<PrismaService>(prisma),
    config,
    new AiRedactionService(),
    registry,
    opts.egress ?? grantAllEgress(),
    opts.withBudget ? fakeOf<CoachAIBudgetService>(budget) : undefined,
  );
  const scope = fakeOf<SubCoachScopeService>({
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
    canAccessClient: jest.fn(async (_u: string, c: string) => c === CLIENT),
  });
  const svc = new WorkoutBuilderAiService(
    fakeOf<PrismaService>(prisma),
    gateway,
    config,
    scope,
    opts.withBudget ? fakeOf<CoachAIBudgetService>(budget) : undefined,
  );
  return { svc, prisma, anthropic, budget };
}

const coach = { id: COACH, role: 'coach' };
const edit = { mode: 'edit' as const, plan_id: PLAN, instruction: 'Add a pulling exercise' };

describe('WorkoutBuilderAiService.propose (B-AIB2-126)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      FEATURE_MWB_AI_LIVE_CREATE: 'true',
      AI_GATEWAY_ENABLED: 'true',
      AI_GATEWAY_PROVIDER: 'stub',
      AI_GATEWAY_CAPABILITIES: 'draft.create_workout_plan,draft.edit_workout_plan',
      MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'test-secret-for-lock-token',
      NODE_ENV: 'test',
    };
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('the propose route exists on the controller', () => {
    expect(typeof WorkoutBuilderAiController.prototype.propose).toBe('function');
  });

  it('flag off -> 503 AI_PAUSED before any read or draft', async () => {
    delete process.env.FEATURE_MWB_AI_LIVE_CREATE;
    const { svc, prisma } = build();
    await expect(svc.propose(coach, edit)).rejects.toMatchObject({ status: 503, response: { code: 'AI_PAUSED' } });
    expect(prisma.workoutPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('stub provider returns a deterministic valid proposal stored as a model-marked pending draft', async () => {
    const { svc, prisma } = build();
    const res = await svc.propose(coach, edit);
    expect(res.draft_id).toBe('draft-1');
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({ change_id: 'c0', kind: 'changed', after: { rest_seconds: 90 } });
    const draft = prisma.drafts[0];
    expect(draft).toMatchObject({ capability: 'draft.edit_workout_plan', status: 'pending', requester_id: COACH, tenant_coach_id: COACH });
    expect(draft.payload).toEqual({ capability: 'draft.edit_workout_plan', target_plan_id: PLAN, base_revision_index: 2, diff: [res.changes[0].op] });
    expect(isWorkoutBuilderModelDraft(draft.payload, draft.provenance)).toBe(true);
  });

  it('stale lock token -> 409 REVISION_STALE', async () => {
    const { svc, prisma } = build();
    await expect(svc.propose(coach, { ...edit, lock_token: 'deadbeef' })).rejects.toMatchObject({ status: 409, response: { code: 'REVISION_STALE' } });
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    const ok = computeLockToken(PLAN, 3, 'rev-3');
    await expect(svc.propose(coach, { ...edit, lock_token: ok })).resolves.toMatchObject({ draft_id: 'draft-1' });
  });

  it("another coach's client -> 404", async () => {
    const { svc } = build();
    await expect(svc.propose(coach, { ...edit, client_id: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ status: 404 });
  });

  describe('real provider path', () => {
    beforeEach(() => {
      process.env.AI_GATEWAY_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    });
    const reply = (text: string) => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', text, enabled: true, promptTokenEstimate: 6000, responseTokenEstimate: 2000 });

    it('no box-2 grant -> 403 before any provider call', async () => {
      const anthropic = jest.fn();
      const { svc, prisma } = build({ egress: egressWithGrants([]).egress, anthropic });
      await expect(svc.propose(coach, { ...edit, client_id: CLIENT })).rejects.toMatchObject({ status: 403 });
      expect(anthropic).not.toHaveBeenCalled();
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });

    it('model diff is validated: knee-loading add dropped, library add kept, budget debited once', async () => {
      const anthropic = jest.fn(async () =>
        reply(JSON.stringify({
          summary: 'Knee-friendly pulling work. This will heal the knee.',
          changes: [
            { op: { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'seed:legs-001', sets: 3, reps_or_duration_seconds: 8 }, reason: 'Legs.' },
            { op: { kind: 'add_exercise', client_ref: 'ai-2', exercise_external_id: 'seed:pull-002', sets: 3, reps_or_duration_seconds: 10, weight_lbs: 200 }, reason: 'Back width.' },
          ],
        })),
      );
      const { svc, prisma, budget } = build({ anthropic, withBudget: true });
      const res = await svc.propose(coach, { ...edit, client_id: CLIENT });
      expect(anthropic).toHaveBeenCalledTimes(1);
      expect(res.summary).toBe('Knee-friendly pulling work.');
      expect(res.changes.map((c) => c.exercise?.id)).toEqual(['seed:pull-002']);
      expect(res.changes[0].after?.weight_lbs).toBeNull();
      expect(res.dropped[0].reason).toMatch(/loads the knee/);
      expect(res.context_used).toEqual(expect.arrayContaining(['goal', 'equipment', 'injuries']));
      expect(res.credits_remaining_pct).toBe(40);
      expect(budget.recordUsage).toHaveBeenCalledTimes(1);
      expect(prisma.drafts).toHaveLength(1);
      // SAFE 2/5: no client free text or identity in the prompt; instruction only in the user turn.
      const sent = anthropic.mock.calls[0][0];
      expect(sent.systemPrompt).not.toMatch(/Add a pulling exercise|email|snack/i);
      expect(sent.turns[sent.turns.length - 1].content).toContain('Add a pulling exercise');
    });

    it('invalid output twice -> one repair attempt, then 422 AI_NO_SAFE_PROPOSAL and no draft', async () => {
      const anthropic = jest.fn(async () => reply('{"summary":"x","changes":[{"op":{"kind":"add_exercise","client_ref":"a","exercise_external_id":"made-up","sets":40,"reps_or_duration_seconds":8},"reason":"x"}]}'));
      const { svc, prisma } = build({ anthropic });
      await expect(svc.propose(coach, edit)).rejects.toMatchObject({ status: 422, response: { code: 'AI_NO_SAFE_PROPOSAL' } });
      expect(anthropic).toHaveBeenCalledTimes(2);
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });

    it('explain returns a summary, no changes and no draft', async () => {
      const anthropic = jest.fn(async () => reply('{"summary":"Upper push day, 60 minutes.","changes":[]}'));
      const { svc, prisma } = build({ anthropic });
      const res = await svc.propose(coach, { ...edit, instruction: '', quick_action: 'explain' });
      expect(res).toMatchObject({ draft_id: null, summary: 'Upper push day, 60 minutes.', changes: [] });
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });
  });
});

describe('AiApprovalService subset approve (B-AIB2-126)', () => {
  it('the tenant coach approves their AI workout draft; only accepted ops are materialised', async () => {
    const payload = {
      capability: 'draft.edit_workout_plan',
      target_plan_id: PLAN,
      base_revision_index: 2,
      diff: [
        { kind: 'update_exercise', client_ref: 'r1', rest_seconds: 90 },
        { kind: 'remove_exercise', client_ref: 'r2' },
      ],
    };
    const { createHash } = await import('crypto');
    const draft = {
      id: 'draft-1',
      capability: 'draft.edit_workout_plan',
      status: 'pending',
      requester_id: COACH,
      tenant_coach_id: COACH,
      subject_user_id: null,
      payload,
      rationale: 'text',
      provenance: [{ source: 'workout_builder_model_diff', hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), count: 1 }],
    };
    const updates: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      aiActionDraft: { updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => { updates.push(args); return { count: 1 }; }), findUnique: jest.fn(async () => ({ ...draft, status: 'approved' })) },
      aiRequestAudit: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      aiActionDraft: { findUnique: jest.fn(async () => draft) },
      teamSubCoachAssignment: { count: jest.fn(async () => 2) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const materialize = jest.fn(async () => ({ status: 'sent', ref: 'plan:rev' }));
    const registry = fakeOf<CapabilityMaterializerRegistry>({ resolve: () => ({ materialize }) });
    const audit = fakeOf<AuditService>({ write: jest.fn(async () => undefined) });
    const svc = new AiApprovalService(fakeOf<PrismaService>(prisma), audit, registry);
    await svc.decide({ draftId: 'draft-1', decider: { id: COACH, role: 'coach' }, decision: 'approved', acceptedChangeIds: ['c0'] });
    expect(materialize).toHaveBeenCalledTimes(1);
    const sent = materialize.mock.calls[0] as unknown[];
    expect(sent[0]).toMatchObject({ payload: { diff: [payload.diff[0]] } });
    expect(updates[0].data.payload).toEqual({ ...payload, diff: [payload.diff[0]] });
  });
});
