/**
 * WEAR-AI (owner 161-1 op 1): the second AI_GATEWAY_CAPABILITIES value lets the
 * two wearable insight capabilities reach the provider. This runs the real
 * insight routes, service, gateway and allow-list config with only the provider
 * faked, and proves the client's live box-2 grant still decides first:
 * - two-capability value (manifest today): the provider is never called;
 * - new value, no grant: 403 ai_consent_required, the provider is never called;
 * - new value, grant: the provider is called once per route;
 * - a connected watch: no raw heart-rate reading reaches either prompt (Sol B2).
 */
import { WearableMetricBucket } from '@prisma/client';
import { ENV_RULES } from '../../src/common/env-validation';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import { WearableInsightsController } from '../../src/wearables/insights/wearable-insights.controller';
import { WearableInsightsService } from '../../src/wearables/insights/wearable-insights.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';

const COACH = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const BUCKET = WearableMetricBucket.SLEEP_RECOVERY;
const VALUES = ENV_RULES.find((r) => r.name === 'AI_GATEWAY_CAPABILITIES')?.values ?? [];
const WORKOUT_ONLY = VALUES[0] ?? '';
const WITH_INSIGHTS = VALUES.find((v) => v.includes('wearable_insight.client')) ?? '';

const CLIENT_JSON = {
  observation: 'Your sleep has been a bit short this week.',
  norm_comparison: 'Your 6h average is below your usual 7h.',
  intervention: 'Aim to be in bed 30 minutes earlier tonight.',
  optional_cta: null,
  confidence_level: 'fairly_sure',
  source_metrics: ['SLEEP_TOTAL_MIN'],
};
const COACH_JSON = {
  observation: 'Sleep was shorter on five of the last seven nights.',
  hypothesis: 'Later bedtimes on training days.',
  suggested_action: 'Keep tonight light and protect sleep.',
  suggested_message_draft: 'Your sleep has been short this week. Lets keep tonight light.',
  confidence_level: 'fairly_sure',
  source_metrics: ['SLEEP_TOTAL_MIN'],
};

type Sample = { metric: string; value: number; unit: string; start_at: Date; end_at: Date };
type SampleWhere = { metric?: { notIn?: string[] } };

function build(
  capabilities: string,
  granted: string[],
  bucket: WearableMetricBucket = BUCKET,
  samples: Sample[] = [],
) {
  process.env.AI_GATEWAY_CAPABILITIES = capabilities;
  // A schema-valid answer for each audience, so the service makes no repair call.
  const complete = jest.fn(async (req: { capability: string }) => ({
    text: JSON.stringify(req.capability === 'wearable_insight.coach' ? COACH_JSON : CLIENT_JSON),
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    promptTokenEstimate: 10,
    responseTokenEstimate: 5,
    meta: {},
  }));
  const registry = new AiProviderRegistry(
    new StubProviderAdapter(),
    fakeOf({ name: 'anthropic', complete }),
  );
  const prisma = {
    // Applies the service's metric filter, so a real watch's rows are filtered as Postgres would.
    wearableSample: {
      findMany: jest.fn(async ({ where }: { where: SampleWhere }) =>
        samples.filter((r) => !(where.metric?.notIn ?? []).includes(r.metric)),
      ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Alex Carter', profile: null }),
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT }),
      findMany: jest.fn().mockResolvedValue([{ id: CLIENT }]),
    },
    aiRequestAudit: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'a', ...data })) },
    userBlock: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const { egress } = egressWithGrants(granted);
  const gateway = new AiGatewayService(
    fakeOf(prisma),
    new AiGatewayConfig(),
    new AiRedactionService(),
    registry,
    egress,
  );
  const cache = {
    get: jest.fn().mockResolvedValue(null),
    getEvenIfStale: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new WearableInsightsService(fakeOf(prisma), gateway, fakeOf(cache), egress);
  const ctrl = new WearableInsightsController(svc, fakeOf({}), fakeOf(prisma));
  const client = fakeOf<AuthedRequest>({ user: { id: CLIENT, role: 'student', coach_id: COACH } });
  const coach = fakeOf<AuthedRequest>({ user: { id: COACH, role: 'coach' } });
  return {
    complete,
    findMany: prisma.wearableSample.findMany,
    clientRoute: () => ctrl.getClientInsight(client, { bucket }),
    coachRoute: () => ctrl.getCoachInsight(coach, { clientId: CLIENT, bucket }),
  };
}

describe('WEAR-AI: wearable insight allow-list value, box-2 grant first', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-only-not-a-key';
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('ENV_RULES holds exactly the two values, and only the second names the insight capabilities', () => {
    expect(VALUES).toEqual([
      'draft.create_workout_plan,draft.edit_workout_plan',
      'draft.create_workout_plan,draft.edit_workout_plan,wearable_insight.client,wearable_insight.coach',
    ]);
    expect(WORKOUT_ONLY).not.toContain('wearable_insight');
  });

  it('two-capability value (today): granted client still gets the empty insight; the provider is never called', async () => {
    const t = build(WORKOUT_ONLY, [CLIENT]);
    await expect(t.clientRoute()).resolves.toMatchObject({ is_empty: true });
    await expect(t.coachRoute()).resolves.toMatchObject({ is_empty: true });
    expect(t.complete).not.toHaveBeenCalled();
  });

  it('new value, no box-2 grant: client route answers 403 ai_consent_required; the provider is never called', async () => {
    const t = build(WITH_INSIGHTS, []);
    const err = await t.clientRoute().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConsentRequiredException);
    expect((err as AiConsentRequiredException).getStatus()).toBe(403);
    expect((err as AiConsentRequiredException).getResponse()).toMatchObject({
      code: 'ai_consent_required',
    });
    expect(t.complete).not.toHaveBeenCalled();
  });

  it('new value, no client grant: coach route answers 403; the provider is never called', async () => {
    const t = build(WITH_INSIGHTS, []);
    await expect(t.coachRoute()).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(t.complete).not.toHaveBeenCalled();
  });

  it('new value, grant: each route calls the provider once with its own capability', async () => {
    const t = build(WITH_INSIGHTS, [CLIENT]);
    await expect(t.clientRoute()).resolves.toMatchObject({ observation: CLIENT_JSON.observation });
    expect(t.complete).toHaveBeenCalledTimes(1);
    expect(t.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ capability: 'wearable_insight.client' }),
    );
    await expect(t.coachRoute()).resolves.toMatchObject({ observation: COACH_JSON.observation });
    expect(t.complete).toHaveBeenCalledTimes(2);
    expect(t.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ capability: 'wearable_insight.coach' }),
    );
  });

  // Sol B2 on b#1117: the public pages say Roman never reads the raw heart-rate readings.
  it('a connected watch: neither prompt carries a raw heart-rate reading; daily figures stay', async () => {
    const at = (h: number) => new Date(Date.now() - h * 3_600_000);
    const row = (metric: string, value: number, unit: string, h: number): Sample => ({
      metric, value, unit, start_at: at(h), end_at: at(h - 0.01),
    });
    const t = build(WITH_INSIGHTS, [CLIENT], WearableMetricBucket.HEALTH_FITNESS, [
      row('HEART_RATE_BPM', 187, 'bpm', 30),
      row('HEART_RATE_BPM', 193, 'bpm', 2),
      row('RESTING_HEART_RATE_BPM', 58, 'bpm', 20),
      row('STEPS', 8421, 'count', 20),
    ]);
    await t.clientRoute().catch((e: unknown) => e);
    await t.coachRoute().catch((e: unknown) => e);
    expect(t.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of t.findMany.mock.calls) {
      expect((args as { where: SampleWhere }).where.metric?.notIn).toContain('HEART_RATE_BPM');
    }
    const caps = t.complete.mock.calls.map(([req]) => req.capability);
    expect(caps).toEqual(expect.arrayContaining(['wearable_insight.client', 'wearable_insight.coach']));
    for (const [req] of t.complete.mock.calls) {
      const sent = JSON.stringify(req);
      expect(sent).not.toMatch(/(?<!RESTING_)HEART_RATE_BPM/);
      expect(sent).not.toMatch(/=(187|190|193)bpm/);
      expect(sent).toContain('RESTING_HEART_RATE_BPM');
      expect(sent).toContain('STEPS');
    }
  });
});
