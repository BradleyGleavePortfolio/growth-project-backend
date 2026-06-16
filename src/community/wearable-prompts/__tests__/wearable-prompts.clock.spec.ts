/**
 * WearablePromptsService — injected-clock + 24h cooldown boundary (PR #405 N3).
 *
 * The re-audit (N3) found the service constructed wall-clock time inline with
 * `new Date()` and the cooldown was only pinned at the repository helper, never
 * at the service seam with timer mocking. This spec closes that:
 *
 *   - The service now takes an injectable Clock (default `() => new Date()`),
 *     so `jest.useFakeTimers().setSystemTime(T)` controls the time the service
 *     hands the repository.
 *   - A faithful fake repo implements the REAL cooldown predicate
 *     (`generatedAt >= now - 24h`) so the 24h boundary is genuinely exercised
 *     end-to-end through the service, not stubbed as a boolean.
 *
 * Boundary contract (WEARABLE_PROMPT_COOLDOWN_MS = 24h):
 *   T            → generate persists; repo.isWithinCooldown received now=T.
 *   T + 23h      → still within window → cooldown skip (blocks).
 *   T + 24h + 1ms→ window elapsed → cooldown clears → persists again.
 */
import { WearableMetricType } from '@prisma/client';
import { WearablePromptsService } from '../wearable-prompts.service';
import { WEARABLE_PROMPT_COOLDOWN_MS } from '../wearable-prompts.dto';
import type { BuiltPrompt, MetricTrend } from '../prompt-generator.service';
import { makeCoachUser } from './test-user.factory';

const WS = '11111111-1111-1111-1111-111111111111';
const COACH_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const SAMPLE_ID = '44444444-4444-4444-4444-444444444444';
const PROMPT_ID = '55555555-5555-5555-5555-555555555555';

const coach = makeCoachUser(COACH_ID, 'coach');

const T = new Date('2026-06-14T00:00:00.000Z');

function trend(): MetricTrend {
  return {
    metric: WearableMetricType.HRV_MS,
    baseline: 100,
    recent: 85,
    changePct: -15,
    unit: 'ms',
    samples: [{ id: SAMPLE_ID, value: 85 }],
  };
}

function built(): BuiltPrompt {
  return {
    metricKey: WearableMetricType.HRV_MS,
    promptText: 'HRV dropped 15% — consider a check-in.',
    sources: [
      { sampleId: SAMPLE_ID, metricKey: WearableMetricType.HRV_MS, observedValue: 85 },
    ],
  };
}

/**
 * A faithful in-memory repo. isWithinCooldown applies the REAL predicate
 * (a prompt exists with generatedAt >= now - 24h) against the `now` the
 * service passes — so the boundary is exercised through the real service clock.
 */
function makeRepo() {
  const persisted: Array<{ generatedAt: Date }> = [];
  const isWithinCooldown = jest.fn(
    async (_c: string, _cl: string, _m: string, now: Date) => {
      const since = now.getTime() - WEARABLE_PROMPT_COOLDOWN_MS;
      return persisted.some((p) => p.generatedAt.getTime() >= since);
    },
  );
  const createPromptWithSources = jest.fn(async () => {
    const generatedAt = new Date(); // honors fake timers
    persisted.push({ generatedAt });
    return {
      id: PROMPT_ID,
      workspaceId: WS,
      coachId: COACH_ID,
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
      promptText: built().promptText,
      generatedAt,
      dismissedAt: null,
      actedOnAt: null,
      sources: [
        {
          id: SAMPLE_ID,
          promptId: PROMPT_ID,
          sampleId: SAMPLE_ID,
          metricKey: WearableMetricType.HRV_MS,
          observedValue: 85,
        },
      ],
    };
  });
  return {
    findRecentSampleIds: jest.fn(),
    isWithinCooldown,
    createPromptWithSources,
    listForCoach: jest.fn(),
    findOneForCoach: jest.fn(),
    markDismissed: jest.fn(),
    markActedOn: jest.fn(),
  };
}

function buildService(repo: ReturnType<typeof makeRepo>) {
  const access = { isWorkspaceCoach: jest.fn().mockResolvedValue(true) };
  const consent = { coachCanAccess: jest.fn().mockResolvedValue(true) };
  const fallback = {
    gate: jest.fn().mockResolvedValue({ ok: true, reason: 'none' }),
  };
  const generator = {
    computeTrend: jest.fn().mockResolvedValue(trend()),
    build: jest.fn().mockReturnValue(built()),
  };
  const insights = {
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
  };
  const analytics = { capture: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Sarah Lee' }) },
  };
  // NOTE: no clock arg passed — the default `() => new Date()` is used, and
  // jest fake timers drive it. This is the production seam under test.
  return new WearablePromptsService(
    repo as never,
    access as never,
    consent as never,
    fallback as never,
    generator as never,
    insights as never,
    analytics as never,
    prisma as never,
  );
}

describe('WearablePromptsService — injected clock + 24h cooldown boundary (N3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('passes the mocked system time (T) into repo.isWithinCooldown', async () => {
    jest.setSystemTime(T);
    const repo = makeRepo();
    const service = buildService(repo);

    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });

    expect(res.generated).toHaveLength(1);
    expect(repo.isWithinCooldown).toHaveBeenCalledTimes(1);
    const [, , , nowArg] = repo.isWithinCooldown.mock.calls[0]!;
    expect((nowArg as Date).getTime()).toBe(T.getTime());
  });

  it('still BLOCKS (cooldown) at T + 23h after a prompt generated at T', async () => {
    const repo = makeRepo();
    const service = buildService(repo);

    jest.setSystemTime(T);
    await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(repo.createPromptWithSources).toHaveBeenCalledTimes(1);

    // 23h later — within the 24h window.
    jest.setSystemTime(new Date(T.getTime() + 23 * 60 * 60 * 1000));
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });

    expect(res.generated).toHaveLength(0);
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'cooldown' },
    ]);
    // No second persist — the cooldown blocked it.
    expect(repo.createPromptWithSources).toHaveBeenCalledTimes(1);
    // The service handed the repo the mocked T+23h, not a stale clock.
    const calls = repo.isWithinCooldown.mock.calls;
    const [, , , nowArg] = calls[calls.length - 1]!;
    expect((nowArg as Date).getTime()).toBe(T.getTime() + 23 * 60 * 60 * 1000);
  });

  it('CLEARS the cooldown at T + 24h + 1ms and persists again', async () => {
    const repo = makeRepo();
    const service = buildService(repo);

    jest.setSystemTime(T);
    await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });

    // Just past the 24h boundary.
    jest.setSystemTime(new Date(T.getTime() + WEARABLE_PROMPT_COOLDOWN_MS + 1));
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });

    expect(res.skipped).toHaveLength(0);
    expect(res.generated).toHaveLength(1);
    expect(repo.createPromptWithSources).toHaveBeenCalledTimes(2);
  });
});
