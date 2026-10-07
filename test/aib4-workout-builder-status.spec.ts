/**
 * AIB-4 (AI_MASTER_BUILDER_PLAN.md sections 3, 5): workout builder status
 * route, gateway status capability list, approval rule, manifest closed sets.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { WorkoutBuilderStatusService } from '../src/ai/gateway/workout-builder/workout-builder-status.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import * as fem from '../scripts/fly-env/fly-env-manifest';

const fake = <T>(v: unknown): T => v as T;
const CREATE = 'draft.create_workout_plan';
const EDIT = 'draft.edit_workout_plan';
const TWO_CAPS = `${CREATE},${EDIT}`;
const PERIOD_END = new Date('2026-11-01T00:00:00.000Z');
const NAMES = ['FEATURE_MWB_AI_LIVE_CREATE', 'AI_GATEWAY_ENABLED', 'AI_GATEWAY_PROVIDER', 'AI_GATEWAY_CAPABILITIES', 'AI_GATEWAY_REQUIRE_APPROVAL'];
const ENV_KEYS = [...NAMES, 'ANTHROPIC_API_KEY'];

function budget(used: number, available: number, throws = false) {
  return fake<CoachAIBudgetService>({
    resolveHeadCoachId: jest.fn(async (id: string) => (id === 'sub-1' ? 'head-1' : id)),
    canCharge: jest.fn(async () => {
      if (throws) throw new Error('db down');
      return {
        allowed: used < available,
        budget: {
          period_end: PERIOD_END,
          base_displayed_cents: 1000,
          pack_displayed_cents: 0,
          value_multiplier: 2,
          actual_used_cents: used,
          total_actual_available_cents: available,
        },
      };
    }),
  });
}

function liveEnv(): void {
  Object.assign(process.env, {
    FEATURE_MWB_AI_LIVE_CREATE: 'true',
    AI_GATEWAY_ENABLED: 'true',
    AI_GATEWAY_PROVIDER: 'anthropic',
    AI_GATEWAY_CAPABILITIES: TWO_CAPS,
    ANTHROPIC_API_KEY: 'test-key-not-real',
  });
}

const status = (b = budget(0, 500), user = 'head-1') =>
  new WorkoutBuilderStatusService(new AiGatewayConfig(), b).getStatus(user);

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

  it('flag off -> paused, both capabilities false, even with the gateway fully configured', async () => {
    liveEnv();
    delete process.env.FEATURE_MWB_AI_LIVE_CREATE;
    expect(await status()).toMatchObject({
      state: 'paused',
      create: false,
      edit: false,
      label: 'AI-suggested, coach-approved',
    });
  });

  it('flag + capabilities + key -> on, with the head coach pool share and reset date', async () => {
    liveEnv();
    const b = budget(125, 500);
    // used displayed = 125 * 2 = 250 of 1000 -> 75 percent left.
    expect(await status(b, 'sub-1')).toEqual({
      state: 'on',
      create: true,
      edit: true,
      credits: { remaining_pct: 75, resets_at: PERIOD_END.toISOString() },
      label: 'AI-suggested, coach-approved',
    });
    expect(b.canCharge).toHaveBeenCalledWith('head-1', 0);
  });

  it.each([['AI_GATEWAY_CAPABILITIES'], ['ANTHROPIC_API_KEY'], ['AI_GATEWAY_ENABLED']])(
    'flag on but %s missing -> not_configured',
    async (name) => {
      liveEnv();
      delete process.env[name];
      expect((await status()).state).toBe('not_configured');
    },
  );

  it('one capability allowed -> on with only that capability true', async () => {
    liveEnv();
    process.env.AI_GATEWAY_CAPABILITIES = EDIT;
    expect(await status()).toMatchObject({ state: 'on', create: false, edit: true });
  });

  it('pool used up -> no_credits, 0 percent; budget read failure -> credits null, state unchanged', async () => {
    liveEnv();
    expect(await status(budget(500, 500))).toMatchObject({ state: 'no_credits', credits: { remaining_pct: 0 } });
    expect(await status(budget(0, 500, true))).toMatchObject({
      state: 'on',
      credits: { remaining_pct: null, resets_at: null },
    });
  });

  it('GET /ai/gateway/status lists the two workout capabilities only while allowed', () => {
    const gateway = new AiGatewayService(fake({}), new AiGatewayConfig(), fake({}), fake({}), fake({}));
    liveEnv();
    expect(gateway.getStatus().capabilities).toEqual(expect.arrayContaining([CREATE, EDIT]));
    delete process.env.FEATURE_MWB_AI_LIVE_CREATE;
    expect(gateway.getStatus().capabilities).not.toEqual(expect.arrayContaining([CREATE]));
    expect(gateway.getStatus().capabilities).not.toEqual(expect.arrayContaining([EDIT]));
  });

  it('the workout capabilities need a coach decision whatever AI_GATEWAY_REQUIRE_APPROVAL says', () => {
    const config = new AiGatewayConfig();
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = 'draft.coach_message';
    expect([config.requireApprovalFor(CREATE), config.requireApprovalFor(EDIT)]).toEqual([true, true]);
    expect(config.requireApprovalFor('draft.assign_workout')).toBe(false);
  });
});

describe('AIB-4 manifest entries', () => {
  const ROOT = join(__dirname, '..');
  const rules = fem.extractEnvRules(readFileSync(join(ROOT, 'src/common/env-validation.ts'), 'utf8'));
  const manifest = () => fem.parseManifestText(readFileSync(join(ROOT, '.github/fly-env-desired-state.json'), 'utf8'));
  const errors = (flags: Record<string, string>) => {
    const m = manifest();
    return fem.validateManifest({ ...m, flags: { ...m.flags, ...flags } }, rules);
  };

  it('the five names are managed, unset, gated and not excluded; a comma value loads as one value', () => {
    const m = manifest();
    for (const n of NAMES) expect([n, m.flags[n], typeof m.gates[n], n in m.excluded]).toEqual([n, 'unset', 'string', false]);
    expect(fem.validateManifest(m, rules)).toEqual([]);
    expect(rules.get('AI_GATEWAY_CAPABILITIES')?.values).toEqual([TWO_CAPS]);
  });

  it("FLIP values validate; '*' and REQUIRE_APPROVAL=false are rejected; the live flag alone fails its precondition", () => {
    expect(
      errors({
        FEATURE_MWB_AI_LIVE_CREATE: 'true',
        AI_GATEWAY_ENABLED: 'true',
        AI_GATEWAY_PROVIDER: 'anthropic',
        AI_GATEWAY_CAPABILITIES: TWO_CAPS,
      }),
    ).toEqual([]);
    expect(errors({ AI_GATEWAY_CAPABILITIES: '*' }).join('\n')).toMatch(/flags\.AI_GATEWAY_CAPABILITIES is "\*"/);
    expect(errors({ AI_GATEWAY_REQUIRE_APPROVAL: 'false' }).join('\n')).toMatch(/AI_GATEWAY_REQUIRE_APPROVAL is "false"/);
    const e = errors({ FEATURE_MWB_AI_LIVE_CREATE: 'true' });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^precondition mwb-ai-live-needs-gateway: .*Fix: /);
  });
});
