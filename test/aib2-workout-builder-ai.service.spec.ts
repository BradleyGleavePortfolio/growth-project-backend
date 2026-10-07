// B-AIB2-126 — propose through the REAL AiGatewayService (stub + fake Anthropic) and the real validator.
import { AiGatewayService, WORKOUT_BUILDER_MODEL_DIFF_SOURCE } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { AnthropicProviderAdapter } from '../src/ai/gateway/providers/anthropic-provider.adapter';
import type { AiProviderRequest, AiProviderResponse } from '../src/ai/gateway/providers/ai-provider.types';
import { WorkoutBuilderAiService } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';
import { WorkoutBuilderAiController } from '../src/ai/gateway/workout-builder/workout-builder-ai.controller';
import { WorkoutBuilderStatusService } from '../src/ai/gateway/workout-builder/workout-builder-status.service';
import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { AiEgressService } from '../src/ai-egress/ai-egress.service';
import { computeLockToken } from '../src/workout-builder/lock-token.helper';
import { egressWithGrants, fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

const PLAN = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const COACH = 'coach-1';

type DraftRow = Record<string, unknown> & { id: string; payload?: unknown; provenance?: unknown };

function buildPrisma() {
  const drafts: DraftRow[] = [];
  const prisma = {
    drafts,
    workoutPlan: { findUnique: jest.fn(async () => ({ id: PLAN, coach_id: COACH, version: 3, head_revision_id: 'rev-3', archived_at: null })) },
    workoutPlanRevision: {
      findUnique: jest.fn(async () => ({
        revision_index: 2, plan_meta_json: { name: 'Upper', type: 'strength', duration_estimate_minutes: 60 },
        exercises_json: [{ client_ref: 'r1', exercise_external_id: 'seed:push-001', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 120, superset_group_id: null, notes: null }],
      })),
    },
    userProfile: { findUnique: jest.fn(async () => ({ goal_type: 'muscle_gain', workout_experience: 'beginner', equipment_access: ['dumbbells'], workout_days_per_week: 3, injuries: ['knee'] })) },
    clientOnboardingIntake: { findUnique: jest.fn(async () => ({ screening_any_yes: false })) },
    user: { findMany: jest.fn(async () => [{ id: CLIENT }]), findUnique: jest.fn(async () => ({ id: CLIENT, role: 'client', coach_id: COACH })) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    aiRequestAudit: { create: jest.fn(async () => ({ id: 'audit-1' })) },
    aiActionDraft: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        drafts.push({ ...data, id: `draft-${drafts.length + 1}` });
        return drafts[drafts.length - 1];
      }),
    },
  };
  return prisma;
}

type Anthropic = jest.Mock<Promise<AiProviderResponse>, [AiProviderRequest]>;
function build(opts: { egress?: AiEgressService; anthropic?: Anthropic; withBudget?: boolean } = {}) {
  const prisma = buildPrisma();
  const anthropic: Anthropic = opts.anthropic ?? jest.fn();
  const registry = new AiProviderRegistry(new StubProviderAdapter(), fakeOf<AnthropicProviderAdapter>({ name: 'anthropic', complete: anthropic }));
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
    canCharge: jest.fn(async () => ({
      budget: { actual_used_cents: 600, total_actual_available_cents: 1000, base_displayed_cents: 1000, pack_displayed_cents: 0, value_multiplier: 1, period_end: new Date() },
    })),
    recordUsage: jest.fn(async () => undefined),
  };
  const config = new AiGatewayConfig();
  const meter = opts.withBudget ? fakeOf<CoachAIBudgetService>(budget) : undefined;
  const gateway = new AiGatewayService(fakeOf<PrismaService>(prisma), config, new AiRedactionService(), registry, opts.egress ?? grantAllEgress(), meter);
  const scope = fakeOf<SubCoachScopeService>({
    getHeadCoachIdForSubCoach: jest.fn(async () => null),
    canAccessClient: jest.fn(async (_u: string, c: string) => c === CLIENT),
  });
  const svc = new WorkoutBuilderAiService(fakeOf<PrismaService>(prisma), gateway, config, scope, new WorkoutBuilderStatusService(config, meter));
  return { svc, prisma, anthropic, budget };
}

const coach = { id: COACH, role: 'coach' };
const edit = { mode: 'edit' as const, plan_id: PLAN, instruction: 'Add a pulling exercise' };

describe('WorkoutBuilderAiService.propose (B-AIB2-126)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV, FEATURE_MWB_AI_LIVE_CREATE: 'true', AI_GATEWAY_ENABLED: 'true', AI_GATEWAY_PROVIDER: 'stub', NODE_ENV: 'test',
      AI_GATEWAY_CAPABILITIES: 'draft.create_workout_plan,draft.edit_workout_plan', MWB_AUTOSAVE_LOCK_TOKEN_SECRET: 'test-secret-for-lock-token',
    };
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });
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
  it('stub provider (no lock_token: stale check skipped) returns a deterministic proposal as a model-marked pending draft', async () => {
    const { svc, prisma } = build();
    const res = await svc.propose(coach, edit);
    expect(res).toMatchObject({ draft_id: 'draft-1', changes: [{ change_id: 'c0', kind: 'changed', after: { rest_seconds: 90 } }] });
    const draft = prisma.drafts[0];
    expect(draft).toMatchObject({ capability: 'draft.edit_workout_plan', status: 'pending', requester_id: COACH, tenant_coach_id: COACH });
    expect(draft.payload).toEqual({ capability: 'draft.edit_workout_plan', target_plan_id: PLAN, base_revision_index: 2, diff: [res.changes[0].op] });
    expect(draft.provenance).toEqual([expect.objectContaining({ source: WORKOUT_BUILDER_MODEL_DIFF_SOURCE })]);
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
    const reply = (text: string): AiProviderResponse => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', text, enabled: true, promptTokenEstimate: 6000, responseTokenEstimate: 2000 });
    const fake = (text: string): Anthropic => jest.fn(async (_req: AiProviderRequest) => reply(text));
    it('no box-2 grant -> 403 before any provider call', async () => {
      const anthropic: Anthropic = jest.fn();
      const { svc, prisma } = build({ egress: egressWithGrants([]).egress, anthropic });
      await expect(svc.propose(coach, { ...edit, client_id: CLIENT })).rejects.toMatchObject({ status: 403 });
      expect(anthropic).not.toHaveBeenCalled();
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });
    it('model diff is validated: knee-loading add dropped, library add kept, budget debited once', async () => {
      const anthropic = fake(JSON.stringify({
        summary: 'Knee-friendly pulling work. This will heal the knee.',
        changes: [
          { op: { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'seed:legs-001', sets: 3, reps_or_duration_seconds: 8 }, reason: 'Legs.' },
          { op: { kind: 'add_exercise', client_ref: 'ai-2', exercise_external_id: 'seed:pull-002', sets: 3, reps_or_duration_seconds: 10, weight_lbs: 200 }, reason: 'Back width.' },
        ],
      }));
      const { svc, prisma, budget } = build({ anthropic, withBudget: true });
      const res = await svc.propose(coach, { ...edit, client_id: CLIENT });
      expect(res).toMatchObject({
        summary: 'Knee-friendly pulling work.', credits_remaining_pct: 40, dropped: [{ reason: expect.stringMatching(/loads the knee/) }],
        changes: [{ exercise: { id: 'seed:pull-002' }, after: { weight_lbs: null } }], context_used: expect.arrayContaining(['goal', 'equipment', 'injuries']),
      });
      expect([anthropic.mock.calls.length, budget.recordUsage.mock.calls.length, prisma.drafts.length]).toEqual([1, 1, 1]);
      const [sent] = anthropic.mock.calls[0];
      expect(sent.maxTokens).toBe(6000);
      expect(sent.systemPrompt).not.toMatch(/Add a pulling exercise|email|snack/i);
      expect(sent.turns[sent.turns.length - 1].content).toContain('Add a pulling exercise');
    });
    it('invalid output twice -> one repair attempt, then 422 AI_NO_SAFE_PROPOSAL and no draft', async () => {
      const anthropic = fake('{"summary":"x","changes":[{"op":{"kind":"add_exercise","client_ref":"a","exercise_external_id":"made-up","sets":40,"reps_or_duration_seconds":8},"reason":"x"}]}');
      const { svc, prisma } = build({ anthropic });
      await expect(svc.propose(coach, edit)).rejects.toMatchObject({ status: 422, response: { code: 'AI_NO_SAFE_PROPOSAL' } });
      expect(anthropic).toHaveBeenCalledTimes(2);
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });
    it('B-809-2: a program day reads the same week\'s other days and caps weekly sets for a beginner', async () => {
      const anthropic = fake(JSON.stringify({
        summary: 'More chest volume.',
        changes: [
          { op: { kind: 'update_exercise', client_ref: 'r1', sets: 4 }, reason: 'More volume.' },
          { op: { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'seed:pull-002', sets: 3, reps_or_duration_seconds: 10 }, reason: 'Back.' },
        ],
      }));
      const { svc, prisma } = build({ anthropic });
      prisma.workoutPlan.findUnique.mockResolvedValue({ id: PLAN, coach_id: COACH, version: 3, head_revision_id: 'rev-3', archived_at: null, program_id: 'prog-1', week_index: 0 });
      const benchDay = (sets: number) => [{ client_ref: 'x', exercise_external_id: 'seed:push-001', order: 0, sets, reps_or_duration_seconds: 8, weight_lbs: null, rest_seconds: 90, superset_group_id: null, notes: null }];
      Object.assign(prisma.workoutPlan, { findMany: jest.fn(async () => [{ id: 'day-2', head_revision_id: 'rev-d2' }, { id: 'day-3', head_revision_id: null }]) });
      Object.assign(prisma.workoutPlanRevision, { findMany: jest.fn(async () => [{ exercises_json: benchDay(8), plan_meta_json: { name: 'Push', type: 'strength' } }]) });
      Object.assign(prisma, { workoutPlanExercise: { findMany: jest.fn(async () => [{ exercise_external_id: 'seed:push-002', sets: 5 }]) } });
      const res = await svc.propose(coach, { ...edit, client_id: CLIENT, quick_action: 'more_volume' });
      // this day 3 + other days 8 + 5 = 16 pectoral sets (beginner cap): one more set is dropped, the back add is kept.
      expect(res.dropped).toEqual([{ reason: 'More than 16 hard sets for one muscle in this program week.' }]);
      expect(res.changes.map((c) => c.exercise.id)).toEqual(['seed:pull-002']);
      expect(prisma.workoutPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { program_id: 'prog-1', coach_id: COACH, week_index: 0, archived_at: null, id: { not: PLAN } },
      }));
    });
    it('explain returns a summary, no changes and no draft', async () => {
      const anthropic = fake('{"summary":"Upper push day, 60 minutes.","changes":[]}');
      const { svc, prisma } = build({ anthropic });
      const res = await svc.propose(coach, { ...edit, instruction: '', quick_action: 'explain' });
      expect(res).toMatchObject({ draft_id: null, summary: 'Upper push day, 60 minutes.', changes: [] });
      expect(anthropic.mock.calls[0][0].maxTokens).toBe(1500);
      expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    });
  });
});

