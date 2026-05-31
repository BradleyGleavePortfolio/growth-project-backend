import { WearableMetricBucket } from '@prisma/client';
import {
  WearableInsightsService,
  COACH_INSIGHT_CAPABILITY,
  CLIENT_INSIGHT_CAPABILITY,
} from './wearable-insights.service';
import type { PrismaService } from '../../prisma.service';
import type { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import type { InsightCacheService } from './insight-cache.service';
import {
  CoachInsight,
  ClientInsight,
  EMPTY_OBSERVATION,
  EmptyInsightSchema,
  isEmptyInsight,
} from './insight-output.schema';

// PR-HK-4 service contract tests. The gateway, cache, and prisma are all
// mocked so we exercise the orchestration: cache short-circuit, LLM
// validate/repair, guardrail rejection, timeout fallback, audit-via-gateway.

const COACH = 'coach-1111-1111-1111-111111111111';
const CLIENT = 'clnt-2222-2222-2222-222222222222';
const BUCKET = WearableMetricBucket.SLEEP_RECOVERY;

function validCoachJson(overrides: Partial<CoachInsight> = {}): string {
  const payload: CoachInsight = {
    observation: 'HRV trended down across five of the last seven nights.',
    hypothesis: 'Accumulated training load alongside shorter sleep windows.',
    suggested_action: 'Pull back tonight session intensity and protect sleep.',
    suggested_message_draft:
      'Your recovery has dipped this week. Lets keep tonight light and aim for an earlier night.',
    confidence_level: 'confident',
    source_metrics: ['HRV_MS', 'SLEEP_TOTAL_MIN'],
    ...overrides,
  };
  return JSON.stringify(payload);
}

function validClientJson(overrides: Partial<ClientInsight> = {}): string {
  const payload: ClientInsight = {
    observation: 'Your sleep has been a bit short this week.',
    norm_comparison: 'Your 6h average is below the typical adult 7-9h range.',
    intervention: 'Aim to be in bed 30 minutes earlier tonight.',
    optional_cta: { label: 'Set a bedtime reminder', deep_link: 'tgp://sleep/reminder' },
    confidence_level: 'fairly_sure',
    source_metrics: ['SLEEP_TOTAL_MIN'],
    ...overrides,
  };
  return JSON.stringify(payload);
}

interface Mocks {
  prisma: {
    wearableSample: { findMany: jest.Mock };
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
  };
  gateway: { invoke: jest.Mock };
  cache: {
    get: jest.Mock;
    getEvenIfStale: jest.Mock;
    set: jest.Mock;
    invalidate: jest.Mock;
  };
}

function makeMocks(): Mocks {
  return {
    prisma: {
      wearableSample: {
        findMany: jest.fn().mockResolvedValue([
          {
            metric: 'HRV_MS',
            value: 42,
            unit: 'ms',
            start_at: new Date('2026-06-01T06:00:00Z'),
            end_at: new Date('2026-06-01T06:00:00Z'),
          },
          {
            metric: 'SLEEP_TOTAL_MIN',
            value: 360,
            unit: 'min',
            start_at: new Date('2026-06-01T05:00:00Z'),
            end_at: new Date('2026-06-01T05:00:00Z'),
          },
        ]),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Alex Carter', profile: null }),
        findFirst: jest.fn().mockResolvedValue({ id: CLIENT }),
      },
    },
    gateway: {
      invoke: jest.fn(),
    },
    cache: {
      get: jest.fn().mockResolvedValue(null),
      getEvenIfStale: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function build(mocks: Mocks): WearableInsightsService {
  return new WearableInsightsService(
    mocks.prisma as unknown as PrismaService,
    mocks.gateway as unknown as AiGatewayService,
    mocks.cache as unknown as InsightCacheService,
  );
}

function gatewayReply(text: string) {
  return {
    requestId: 'req-1',
    auditId: 'audit-1',
    approvalDraftId: null,
    approvalRequired: false,
    approvalStatus: 'not_required',
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4.5',
    reply: text,
    redactionsApplied: {},
    provenance: [],
    draftMode: false,
  };
}

describe('WearableInsightsService', () => {
  describe('cache hit', () => {
    it('returns the cached coach insight without calling the LLM', async () => {
      const mocks = makeMocks();
      const cached = JSON.parse(validCoachJson()) as CoachInsight;
      mocks.cache.get.mockResolvedValue(cached);
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);

      expect(out).toEqual(cached);
      expect(mocks.gateway.invoke).not.toHaveBeenCalled();
      expect(mocks.cache.set).not.toHaveBeenCalled();
    });
  });

  describe('cache miss', () => {
    it('calls the LLM, validates output, writes cache (audit via gateway)', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(gatewayReply(validCoachJson()));
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);

      expect(out.observation).toContain('HRV trended down');
      expect(isEmptyInsight(out)).toBe(false);
      expect((out as CoachInsight).hypothesis).toBe(
        'Accumulated training load alongside shorter sleep windows.',
      );
      // Gateway called once with the coach capability — the gateway writes
      // the AiRequestAudit row internally (audit criteria #34).
      expect(mocks.gateway.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.gateway.invoke.mock.calls[0][0].capability).toBe(
        COACH_INSIGHT_CAPABILITY,
      );
      expect(mocks.gateway.invoke.mock.calls[0][0].requester).toEqual({
        id: COACH,
        role: 'coach',
      });
      // Cache write happened with the model id reported by the gateway.
      expect(mocks.cache.set).toHaveBeenCalledTimes(1);
      const setArgs = mocks.cache.set.mock.calls[0];
      expect(setArgs[0]).toBe('coach');
      expect(setArgs[4].modelUsed).toBe('claude-sonnet-4.5');
    });

    it('client path uses the client capability + the user as subject', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(gatewayReply(validClientJson()));
      const svc = build(mocks);

      const out = await svc.generateForClient(CLIENT, BUCKET);

      expect(isEmptyInsight(out)).toBe(false);
      expect((out as ClientInsight).norm_comparison).toBe(
        'Your 6h average is below the typical adult 7-9h range.',
      );
      // Client schema must NOT carry coach-only fields.
      expect((out as unknown as Record<string, unknown>).hypothesis).toBeUndefined();
      expect((out as unknown as Record<string, unknown>).suggested_message_draft).toBeUndefined();
      const call = mocks.gateway.invoke.mock.calls[0][0];
      expect(call.capability).toBe(CLIENT_INSIGHT_CAPABILITY);
      expect(call.subjectUserId).toBe(CLIENT);
      expect(call.requester).toEqual({ id: CLIENT, role: 'student' });
    });

    it('extracts JSON even when the model wraps it in prose/fences', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(
        gatewayReply('Here you go:\n```json\n' + validCoachJson() + '\n```'),
      );
      const svc = build(mocks);
      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);
      expect(out.observation).toContain('HRV');
    });
  });

  describe('invalid output → repair → fail-explicit', () => {
    it('retries once on invalid JSON then succeeds', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke
        .mockResolvedValueOnce(gatewayReply('not json at all'))
        .mockResolvedValueOnce(gatewayReply(validCoachJson()));
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);

      expect(out.observation).toContain('HRV');
      expect(mocks.gateway.invoke).toHaveBeenCalledTimes(2);
      // The repair call carries the repair instruction in userMessage.
      expect(mocks.gateway.invoke.mock.calls[1][0].userMessage).toContain(
        'invalid JSON',
      );
    });

    it('falls back to empty insight when output is invalid after repair', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(gatewayReply('{"garbage": true}'));
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);

      // Empty fallback is now its OWN strict schema, not a cast full insight.
      expect(isEmptyInsight(out)).toBe(true);
      expect(EmptyInsightSchema.safeParse(out).success).toBe(true);
      expect(out.observation).toBe(EMPTY_OBSERVATION);
      expect(out.confidence_level).toBe('i_think');
      expect(out.source_metrics).toEqual([]);
      // No fabricated coach fields leak onto the empty state.
      expect((out as unknown as Record<string, unknown>).hypothesis).toBeUndefined();
      expect(mocks.gateway.invoke).toHaveBeenCalledTimes(2);
      expect(mocks.cache.set).not.toHaveBeenCalled();
    });

    it('falls back to STALE cache (not empty) when repair fails and stale exists', async () => {
      const mocks = makeMocks();
      const stale = JSON.parse(validCoachJson({ observation: 'stale obs here' })) as CoachInsight;
      mocks.cache.getEvenIfStale.mockResolvedValue(stale);
      mocks.gateway.invoke.mockResolvedValue(gatewayReply('still not json'));
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);
      expect(out.observation).toBe('stale obs here');
    });
  });

  describe('guardrail enforcement', () => {
    it('rejects a medicalizing output and falls back to empty insight', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(
        gatewayReply(
          validCoachJson({ hypothesis: 'This is clearly sleep apnea and needs treatment.' }),
        ),
      );
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);

      // Rejected → safe empty fallback, NEVER the medicalizing text.
      expect(isEmptyInsight(out)).toBe(true);
      expect(out.observation).toBe(EMPTY_OBSERVATION);
      // The empty state has no hypothesis field at all (cannot echo apnea).
      expect((out as unknown as Record<string, unknown>).hypothesis).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('apnea');
      expect(mocks.cache.set).not.toHaveBeenCalled();
    });

    it('passes clean output through and caches it', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockResolvedValue(gatewayReply(validCoachJson()));
      const svc = build(mocks);
      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);
      expect(out.observation).toContain('HRV');
      expect(mocks.cache.set).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout / graceful degradation', () => {
    it('returns stale cache on LLM timeout when present', async () => {
      const mocks = makeMocks();
      const stale = JSON.parse(validCoachJson({ observation: 'last good insight' })) as CoachInsight;
      mocks.cache.getEvenIfStale.mockResolvedValue(stale);
      // Gateway never resolves → our 30s race rejects. We simulate by
      // rejecting immediately to keep the test fast (the race wrapper
      // treats any rejection the same as a timeout for fallback).
      mocks.gateway.invoke.mockRejectedValue(new Error('boom'));
      const svc = build(mocks);

      const out = await svc.generateForCoach(COACH, CLIENT, BUCKET);
      expect(out.observation).toBe('last good insight');
    });

    it('returns empty insight on failure when no cache exists', async () => {
      const mocks = makeMocks();
      mocks.gateway.invoke.mockRejectedValue(new Error('boom'));
      const svc = build(mocks);
      const out = await svc.generateForClient(CLIENT, BUCKET);
      expect(isEmptyInsight(out)).toBe(true);
      expect(EmptyInsightSchema.safeParse(out).success).toBe(true);
      expect(out.observation).toBe(EMPTY_OBSERVATION);
      expect(out.source_metrics).toEqual([]);
      // Empty state has no optional_cta field (it's the empty schema, not client).
      expect((out as unknown as Record<string, unknown>).optional_cta).toBeUndefined();
    });
  });

  describe('assertCoachOwnsClient', () => {
    it('passes when the client is assigned to the coach', async () => {
      const mocks = makeMocks();
      const svc = build(mocks);
      await expect(
        svc.assertCoachOwnsClient(COACH, CLIENT, 'coach'),
      ).resolves.toBeUndefined();
    });

    it('throws Forbidden when the client is not assigned', async () => {
      const mocks = makeMocks();
      mocks.prisma.user.findFirst.mockResolvedValue(null);
      const svc = build(mocks);
      await expect(svc.assertCoachOwnsClient(COACH, CLIENT, 'coach')).rejects.toThrow(
        /not assigned/,
      );
    });

    it('owner bypasses the ownership check', async () => {
      const mocks = makeMocks();
      mocks.prisma.user.findFirst.mockResolvedValue(null);
      const svc = build(mocks);
      await expect(
        svc.assertCoachOwnsClient(COACH, CLIENT, 'owner'),
      ).resolves.toBeUndefined();
      expect(mocks.prisma.user.findFirst).not.toHaveBeenCalled();
    });
  });
});
