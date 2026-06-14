/**
 * Unit tests for PromptGeneratorService (v3-4).
 *
 * Mocks WearableSamplesService.getSeries + WearablePromptsRepository so these
 * run with NO DB. Pin the trend-computation + copy doctrine:
 *
 *   - Insufficient data (< 4 samples, or an empty half-window) → null (no_data).
 *   - A change below the signal threshold (8%) → null (no_signal).
 *   - A real drop computes a negative changePct and pulls REAL sample ids from
 *     the repository (audit trail, brief test 4).
 *   - build() copy is observational ("dropped"/"risen"), non-medicalized, names
 *     the client, and maps every trend sample to a source row.
 */
import { WearableMetricType, WearableMetricBucket } from '@prisma/client';
import { PromptGeneratorService } from '../prompt-generator.service';
import type { MetricTrend } from '../prompt-generator.service';

const CLIENT = 'client-1';
const COACH = 'coach-1';
const METRIC = WearableMetricType.HRV_MS;

function sample(start: string, value: number) {
  return { start_at: start, end_at: start, value, provider: 'oura' };
}

function build(opts?: { samples?: ReturnType<typeof sample>[]; ids?: Array<{ id: string; value: number }> }) {
  const series = {
    metric: METRIC,
    unit: 'ms',
    provider_used: 'oura',
    sample_count: opts?.samples?.length ?? 0,
    samples: opts?.samples ?? [],
  };
  const samples = {
    getSeries: jest.fn().mockResolvedValue({
      version: 1,
      user_id: CLIENT,
      bucket: WearableMetricBucket.SLEEP_RECOVERY,
      window: { from: 'x', to: 'y' },
      series: [series],
      freshness: { providers: [] },
    }),
  };
  const repo = {
    findRecentSampleIds: jest
      .fn()
      .mockResolvedValue(opts?.ids ?? [{ id: 'sample-real-1', value: 80 }]),
  };
  const service = new PromptGeneratorService(samples as never, repo as never);
  return { service, samples, repo };
}

const NOW = new Date('2026-06-14T00:00:00.000Z');
// 14-day window midpoint is 7 days before NOW.
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe('PromptGeneratorService.computeTrend', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns null when there are fewer than 4 samples (no_data)', async () => {
    const { service, repo } = build({
      samples: [sample(daysAgo(10), 100), sample(daysAgo(2), 80)],
    });
    const res = await service.computeTrend(CLIENT, COACH, METRIC, NOW);
    expect(res).toBeNull();
    expect(repo.findRecentSampleIds).not.toHaveBeenCalled();
  });

  it('returns null when the change is below the 8% signal threshold (no_signal)', async () => {
    const { service } = build({
      samples: [
        sample(daysAgo(12), 100),
        sample(daysAgo(10), 100),
        sample(daysAgo(3), 102),
        sample(daysAgo(1), 102),
      ],
    });
    const res = await service.computeTrend(CLIENT, COACH, METRIC, NOW);
    expect(res).toBeNull();
  });

  it('computes a negative changePct for a real drop and records REAL sample ids', async () => {
    const { service, repo } = build({
      samples: [
        sample(daysAgo(12), 100),
        sample(daysAgo(10), 100),
        sample(daysAgo(3), 80),
        sample(daysAgo(1), 80),
      ],
      ids: [
        { id: 'real-a', value: 80 },
        { id: 'real-b', value: 80 },
      ],
    });
    const res = await service.computeTrend(CLIENT, COACH, METRIC, NOW);
    expect(res).not.toBeNull();
    expect(res!.changePct).toBeCloseTo(-20, 5);
    expect(res!.samples).toEqual([
      { id: 'real-a', value: 80 },
      { id: 'real-b', value: 80 },
    ]);
    expect(repo.findRecentSampleIds).toHaveBeenCalledTimes(1);
  });

  it('returns null when no real sample ids back the trend', async () => {
    const { service } = build({
      samples: [
        sample(daysAgo(12), 100),
        sample(daysAgo(10), 100),
        sample(daysAgo(3), 80),
        sample(daysAgo(1), 80),
      ],
      ids: [],
    });
    const res = await service.computeTrend(CLIENT, COACH, METRIC, NOW);
    expect(res).toBeNull();
  });
});

describe('PromptGeneratorService.build', () => {
  const trend: MetricTrend = {
    metric: METRIC,
    baseline: 100,
    recent: 85,
    changePct: -15,
    unit: 'ms',
    samples: [
      { id: 'real-a', value: 85 },
      { id: 'real-b', value: 84 },
    ],
  };

  it('produces observational, named copy and a source row per sample', () => {
    const { service } = build();
    const result = service.build(trend, 'Sarah');
    expect(result.metricKey).toBe(METRIC);
    expect(result.promptText).toContain('Sarah');
    expect(result.promptText).toContain('dropped');
    expect(result.promptText).toContain('15%');
    // Non-medicalized: never a diagnosis verb.
    expect(result.promptText.toLowerCase()).not.toContain('diagnos');
    expect(result.sources).toEqual([
      { sampleId: 'real-a', metricKey: METRIC, observedValue: 85 },
      { sampleId: 'real-b', metricKey: METRIC, observedValue: 84 },
    ]);
  });

  it('uses "risen" for a positive change and falls back when name is blank', () => {
    const { service } = build();
    const result = service.build({ ...trend, changePct: 12 }, '   ');
    expect(result.promptText).toContain('risen');
    expect(result.promptText).toContain('Your client');
  });
});
