/**
 * AIB-4 (AI_MASTER_BUILDER_PLAN.md sections 3 and 5): the workout builder
 * status route, the gateway status capability list, the approval rule for the
 * two workout capabilities, and the ENV_RULES / manifest closed sets that make
 * the FLIP a values-only PR.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import {
  WORKOUT_BUILDER_AI_LABEL,
  WorkoutBuilderStatusService,
} from '../src/ai/gateway/workout-builder/workout-builder-status.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import {
  validateAiGatewayCapabilityList,
  validateAiGatewayRequireApproval,
} from '../src/common/env-validation';
import * as fem from '../scripts/fly-env/fly-env-manifest';
import type { FlyEnvManifest } from '../scripts/fly-env/fly-env-manifest';

function fake<T>(value: unknown): T {
  return value as T;
}

const CREATE = 'draft.create_workout_plan';
const EDIT = 'draft.edit_workout_plan';
const TWO_CAPS = `${CREATE},${EDIT}`;
const PERIOD_END = new Date('2026-11-01T00:00:00.000Z');
const ENV_KEYS = [
  'FEATURE_MWB_AI_LIVE_CREATE',
  'AI_GATEWAY_ENABLED',
  'AI_GATEWAY_PROVIDER',
  'AI_GATEWAY_CAPABILITIES',
  'AI_GATEWAY_REQUIRE_APPROVAL',
  'ANTHROPIC_API_KEY',
];

function budgetFake(opts: { used: number; available: number; throws?: boolean }) {
  return fake<CoachAIBudgetService>({
    resolveHeadCoachId: jest.fn(async (id: string) => (id === 'sub-1' ? 'head-1' : id)),
    canCharge: jest.fn(async () => {
      if (opts.throws) throw new Error('db down');
      return {
        allowed: opts.used < opts.available,
        budget: {
          period_end: PERIOD_END,
          base_displayed_cents: 1000,
          pack_displayed_cents: 0,
          value_multiplier: 2,
          actual_used_cents: opts.used,
          total_actual_available_cents: opts.available,
        },
      };
    }),
  });
}

function liveEnv(): void {
  process.env.FEATURE_MWB_AI_LIVE_CREATE = 'true';
  process.env.AI_GATEWAY_ENABLED = 'true';
  process.env.AI_GATEWAY_PROVIDER = 'anthropic';
  process.env.AI_GATEWAY_CAPABILITIES = TWO_CAPS;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
}

describe('AIB-4 workout builder status', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('flag off -> paused, both capabilities false, label present (even with the gateway fully configured)', async () => {
    liveEnv();
    delete process.env.FEATURE_MWB_AI_LIVE_CREATE;
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budgetFake({ used: 0, available: 500 }));
    const s = await svc.getStatus('head-1');
    expect(s).toMatchObject({ state: 'paused', create: false, edit: false, label: WORKOUT_BUILDER_AI_LABEL });
    expect(s.label).toBe('AI-suggested, coach-approved');
  });

  it('flag + capabilities + provider key -> on, with remaining share and reset date from the head coach pool', async () => {
    liveEnv();
    const budget = budgetFake({ used: 125, available: 500 });
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budget);
    const s = await svc.getStatus('sub-1');
    expect(s.state).toBe('on');
    expect(s.create).toBe(true);
    expect(s.edit).toBe(true);
    // used displayed = 125 * 2 = 250 of 1000 -> 75 percent left.
    expect(s.credits).toEqual({ remaining_pct: 75, resets_at: PERIOD_END.toISOString() });
    expect(budget.canCharge).toHaveBeenCalledWith('head-1', 0);
  });

  it('flag on but no capability allow-list -> not_configured', async () => {
    liveEnv();
    delete process.env.AI_GATEWAY_CAPABILITIES;
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budgetFake({ used: 0, available: 500 }));
    expect((await svc.getStatus('head-1')).state).toBe('not_configured');
  });

  it('flag on but provider key missing -> not_configured', async () => {
    liveEnv();
    delete process.env.ANTHROPIC_API_KEY;
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budgetFake({ used: 0, available: 500 }));
    expect((await svc.getStatus('head-1')).state).toBe('not_configured');
  });

  it('only one capability allowed -> on, with that capability alone true', async () => {
    liveEnv();
    process.env.AI_GATEWAY_CAPABILITIES = EDIT;
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budgetFake({ used: 0, available: 500 }));
    expect(await svc.getStatus('head-1')).toMatchObject({ state: 'on', create: false, edit: true });
  });

  it('pool used up -> no_credits with 0 percent left', async () => {
    liveEnv();
    const svc = new WorkoutBuilderStatusService(new AiGatewayConfig(), budgetFake({ used: 500, available: 500 }));
    const s = await svc.getStatus('head-1');
    expect(s.state).toBe('no_credits');
    expect(s.credits.remaining_pct).toBe(0);
  });

  it('budget read failure -> credits null, state unchanged (propose re-checks the budget)', async () => {
    liveEnv();
    const svc = new WorkoutBuilderStatusService(
      new AiGatewayConfig(),
      budgetFake({ used: 0, available: 500, throws: true }),
    );
    expect(await svc.getStatus('head-1')).toMatchObject({
      state: 'on',
      credits: { remaining_pct: null, resets_at: null },
    });
  });

  it('GET /ai/gateway/status lists the two workout capabilities only while they are allowed', () => {
    const gateway = new AiGatewayService(
      fake({}),
      new AiGatewayConfig(),
      fake({}),
      fake({}),
      fake({}),
    );
    liveEnv();
    expect(gateway.getStatus().capabilities).toEqual(expect.arrayContaining([CREATE, EDIT]));
    delete process.env.FEATURE_MWB_AI_LIVE_CREATE;
    expect(gateway.getStatus().capabilities).not.toContain(CREATE);
    expect(gateway.getStatus().capabilities).not.toContain(EDIT);
  });

  it('the workout capabilities need a coach decision whatever AI_GATEWAY_REQUIRE_APPROVAL says', () => {
    const config = new AiGatewayConfig();
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = 'draft.coach_message';
    expect(config.requireApprovalFor(CREATE)).toBe(true);
    expect(config.requireApprovalFor(EDIT)).toBe(true);
    expect(config.requireApprovalFor('draft.coach_message')).toBe(true);
    expect(config.requireApprovalFor('draft.assign_workout')).toBe(false);
  });
});

describe('AIB-4 ENV_RULES validators', () => {
  it("AI_GATEWAY_CAPABILITIES rejects '*' and unknown ids, accepts the two workout capabilities", () => {
    expect(validateAiGatewayCapabilityList('*')).toMatch(/every gateway capability/);
    expect(validateAiGatewayCapabilityList(`${CREATE},*`)).toMatch(/every gateway capability/);
    expect(validateAiGatewayCapabilityList(`${CREATE},draft.made_up`)).toBe('unknown capability ids: draft.made_up');
    expect(validateAiGatewayCapabilityList(TWO_CAPS)).toBeNull();
  });

  it('AI_GATEWAY_REQUIRE_APPROVAL rejects false and any list without both workout capabilities', () => {
    expect(validateAiGatewayRequireApproval('false')).toMatch(/must keep draft\.create_workout_plan, draft\.edit_workout_plan/);
    expect(validateAiGatewayRequireApproval(`draft.coach_message,${CREATE}`)).toMatch(/must keep draft\.edit_workout_plan/);
    expect(validateAiGatewayRequireApproval(`draft.coach_message,${TWO_CAPS}`)).toBeNull();
  });
});

describe('AIB-4 manifest entries', () => {
  const ROOT = join(__dirname, '..');
  const rules = fem.extractEnvRules(readFileSync(join(ROOT, 'src/common/env-validation.ts'), 'utf8'));
  const manifest = (): FlyEnvManifest =>
    fem.parseManifestText(readFileSync(join(ROOT, '.github/fly-env-desired-state.json'), 'utf8'));
  const withFlags = (flags: Record<string, string>): FlyEnvManifest => {
    const m = manifest();
    return { ...m, flags: { ...m.flags, ...flags } };
  };
  const NAMES = [
    'FEATURE_MWB_AI_LIVE_CREATE',
    'AI_GATEWAY_ENABLED',
    'AI_GATEWAY_PROVIDER',
    'AI_GATEWAY_CAPABILITIES',
    'AI_GATEWAY_REQUIRE_APPROVAL',
  ];

  it('all five names are managed flags, all unset, each with a gate, none excluded', () => {
    const m = manifest();
    for (const n of NAMES) {
      expect([n, m.flags[n]]).toEqual([n, 'unset']);
      expect([n, typeof m.gates[n]]).toEqual([n, 'string']);
      expect([n, n in m.excluded]).toEqual([n, false]);
    }
    expect(fem.validateManifest(m, rules)).toEqual([]);
  });

  it('the loader reads a closed value that contains commas as one value', () => {
    expect(rules.get('AI_GATEWAY_CAPABILITIES')?.values).toEqual([TWO_CAPS]);
    expect(rules.get('AI_GATEWAY_PROVIDER')?.values).toEqual(['stub', 'anthropic']);
  });

  it("the FLIP values validate; '*' and REQUIRE_APPROVAL=false do not", () => {
    const flip = withFlags({
      FEATURE_MWB_AI_LIVE_CREATE: 'true',
      AI_GATEWAY_ENABLED: 'true',
      AI_GATEWAY_PROVIDER: 'anthropic',
      AI_GATEWAY_CAPABILITIES: TWO_CAPS,
    });
    expect(fem.validateManifest(flip, rules)).toEqual([]);
    expect(fem.validateManifest(withFlags({ AI_GATEWAY_CAPABILITIES: '*' }), rules).join('\n')).toMatch(
      /flags\.AI_GATEWAY_CAPABILITIES is "\*"/,
    );
    expect(fem.validateManifest(withFlags({ AI_GATEWAY_REQUIRE_APPROVAL: 'false' }), rules).join('\n')).toMatch(
      /flags\.AI_GATEWAY_REQUIRE_APPROVAL is "false"/,
    );
  });

  it('precondition: the live flag without the gateway switches is refused', () => {
    const e = fem.validateManifest(withFlags({ FEATURE_MWB_AI_LIVE_CREATE: 'true' }), rules);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^precondition mwb-ai-live-needs-gateway: .*Fix: /);
  });
});
