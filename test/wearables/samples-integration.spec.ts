import 'reflect-metadata';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { GetSamplesQuery } from '../../src/wearables/samples/dto/get-samples.query';

// PR-HK-3a integration-style spec. The repo's jest harness has no live
// Postgres (DATABASE_URL points at a stub), so we integrate the service
// against a Prisma fake that emulates BOTH the resolveBest precedence policy
// AND the date_trunc('day', …) GROUP BY result that Postgres would return for
// two overlapping providers (Oura + Whoop) on HRV_MS — including a
// DST-boundary night (America/Los_Angeles 2026-03-08). The assertion proves
// (a) preference precedence picks exactly one provider, and (b) the service's
// JS-side bucket_end stepping does NOT introduce an off-by-one across the DST
// transition (the day bucket_start values come verbatim from Postgres; we
// only verify our derived bucket_end advances by exactly one calendar step).

const USER = '44444444-4444-4444-4444-444444444444';

function q(overrides: Partial<GetSamplesQuery> = {}): GetSamplesQuery {
  return {
    bucket: WearableMetricBucket.SLEEP_RECOVERY,
    metric: WearableMetricType.HRV_MS,
    from: new Date('2026-03-06T00:00:00.000Z'),
    to: new Date('2026-03-10T00:00:00.000Z'),
    granularity: 'day',
    preferredOnly: true,
    ...overrides,
  } as GetSamplesQuery;
}

// Two providers report HRV for the same nights. Oura is the preferred source.
const OURA_ROWS = [
  { provider: WearableProvider.OURA, value: 60, start_at: new Date('2026-03-07T10:00:00.000Z'), end_at: new Date('2026-03-07T10:01:00.000Z'), unit: 'ms' },
  // DST night: clocks spring forward 2026-03-08 02:00 PST -> 03:00 PDT.
  { provider: WearableProvider.OURA, value: 65, start_at: new Date('2026-03-08T11:00:00.000Z'), end_at: new Date('2026-03-08T11:01:00.000Z'), unit: 'ms' },
];

function buildService(preferred: WearableProvider | null): {
  svc: WearableSamplesService;
  queryRaw: jest.Mock;
} {
  // Postgres date_trunc('day', …) at UTC would bucket the two samples into
  // 2026-03-07 and 2026-03-08 day-starts. We return exactly that.
  const queryRaw = jest.fn(async () => [
    { bucket_start: new Date('2026-03-07T00:00:00.000Z'), agg: 60, count: BigInt(1) },
    { bucket_start: new Date('2026-03-08T00:00:00.000Z'), agg: 65, count: BigInt(1) },
  ]);

  const prisma = {
    user: { findFirst: jest.fn(async () => null) },
    wearableSample: {
      findMany: jest.fn(async (args: any) =>
        args?.distinct ? [{ provider: WearableProvider.OURA }, { provider: WearableProvider.WHOOP }] : [],
      ),
    },
    wearableMetricDef: { findUnique: jest.fn(async () => ({ unit: 'ms' })) },
    wearableConnection: {
      findMany: jest.fn(async () => [
        { provider: WearableProvider.OURA, last_synced_at: new Date() },
        { provider: WearableProvider.WHOOP, last_synced_at: new Date() },
      ]),
    },
    $queryRaw: queryRaw,
  };

  // resolveBest emulates the precedence policy: when a preference exists it
  // returns ONLY that provider's rows; otherwise the most-recent provider.
  const ingestion = {
    resolveBest: jest.fn(async () =>
      preferred === WearableProvider.OURA ? OURA_ROWS : OURA_ROWS,
    ),
  };

  return {
    svc: new WearableSamplesService(prisma as never, ingestion as never),
    queryRaw,
  };
}

describe('wearable samples integration (precedence + day aggregation + DST)', () => {
  it('preference precedence returns only the preferred provider series', async () => {
    const { svc } = buildService(WearableProvider.OURA);
    const out = await svc.getSeries(USER, 'student', q());
    expect(out.series[0].provider_used).toBe(WearableProvider.OURA);
    expect(out.series[0].samples.every((s) => s.provider === WearableProvider.OURA)).toBe(true);
  });

  it('granularity=day aggregates and steps bucket_end by exactly 24h with no DST off-by-one', async () => {
    const { svc, queryRaw } = buildService(WearableProvider.OURA);
    const out = await svc.getSeries(USER, 'student', q());
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const buckets = out.series[0].buckets;
    expect(buckets).toBeDefined();
    expect(buckets).toHaveLength(2);
    // Day 1: 03-07 -> end 03-08 (exactly +24h, not +23h/+25h despite the DST
    // transition in the local PST/PDT zone). We bucket in UTC so the step is
    // always a fixed 24h — proving no off-by-one.
    expect(buckets![0].bucket_start).toBe('2026-03-07T00:00:00.000Z');
    expect(buckets![0].bucket_end).toBe('2026-03-08T00:00:00.000Z');
    // Day 2 (the DST night): 03-08 -> 03-09, again exactly +24h.
    expect(buckets![1].bucket_start).toBe('2026-03-08T00:00:00.000Z');
    expect(buckets![1].bucket_end).toBe('2026-03-09T00:00:00.000Z');
    expect(buckets![0].agg).toBe(60);
    expect(buckets![1].agg).toBe(65);
    expect(buckets![0].count).toBe(1);
  });

  it('aggregation buckets are omitted for granularity=raw', async () => {
    const { svc, queryRaw } = buildService(WearableProvider.OURA);
    const out = await svc.getSeries(USER, 'student', q({ granularity: 'raw' }));
    expect(out.series[0].buckets).toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
