import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { WearableSamplesService } from '../../src/wearables/samples/wearable-samples.service';
import type { GetSamplesQuery } from '../../src/wearables/samples/dto/get-samples.query';

// PR-HK-3a service unit tests. Drives the service with a hand-built Prisma +
// Ingestion fake so we assert the read-precedence (#preference vs recency),
// the empty-window behaviour (provider_used null but freshness still lists a
// connected-but-zero-data provider), the IDOR 403, and the 5s timeout -> 503
// (#35/#50). No real DB — same posture as the rest of the suite.

const USER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const COACH = '33333333-3333-3333-3333-333333333333';

function sample(
  provider: WearableProvider,
  value: number,
  startISO: string,
): {
  provider: WearableProvider;
  value: number;
  start_at: Date;
  end_at: Date;
  unit: string;
} {
  const start = new Date(startISO);
  return {
    provider,
    value,
    start_at: start,
    end_at: new Date(start.getTime() + 60_000),
    unit: 'count',
  };
}

interface FakeOpts {
  preferenceProvider?: WearableProvider | null;
  resolveBestRows?: ReturnType<typeof sample>[];
  allProviderRows?: ReturnType<typeof sample>[];
  connections?: Array<{
    provider: WearableProvider;
    last_synced_at: Date | null;
    status?: string;
  }>;
  bucketProviders?: WearableProvider[];
  metricDefUnit?: string | null;
  ownsClient?: boolean;
}

/** Default a connection to the healthy 'connected' state unless overridden. */
function withStatus(
  conns: Array<{ provider: WearableProvider; last_synced_at: Date | null; status?: string }> = [],
): Array<{ provider: WearableProvider; last_synced_at: Date | null; status: string }> {
  return conns.map((c) => ({ ...c, status: c.status ?? 'connected' }));
}

function buildService(opts: FakeOpts = {}): WearableSamplesService {
  const prisma = {
    user: {
      findFirst: jest.fn(async () =>
        opts.ownsClient ? { id: CLIENT } : null,
      ),
    },
    wearableSample: {
      findMany: jest.fn(async (args: any) => {
        // distinct-provider freshness query
        if (args?.distinct) {
          return (opts.bucketProviders ?? []).map((provider) => ({ provider }));
        }
        // compare-all-providers read (preferredOnly=false)
        return opts.allProviderRows ?? [];
      }),
    },
    wearableMetricDef: {
      findUnique: jest.fn(async () =>
        opts.metricDefUnit === undefined
          ? { unit: 'count' }
          : opts.metricDefUnit === null
            ? null
            : { unit: opts.metricDefUnit },
      ),
    },
    wearableConnection: {
      findMany: jest.fn(async () => withStatus(opts.connections ?? [])),
    },
    $queryRaw: jest.fn(async () => []),
  };

  const ingestion = {
    resolveBest: jest.fn(async () => opts.resolveBestRows ?? []),
  };

  return new WearableSamplesService(prisma as never, ingestion as never);
}

function query(overrides: Partial<GetSamplesQuery> = {}): GetSamplesQuery {
  return {
    bucket: WearableMetricBucket.HEALTH_FITNESS,
    metric: WearableMetricType.STEPS,
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-01-08T00:00:00.000Z'),
    granularity: 'raw',
    preferredOnly: true,
    ...overrides,
  } as GetSamplesQuery;
}

describe('WearableSamplesService', () => {
  it('preferredOnly: returns only the resolveBest provider rows', async () => {
    const svc = buildService({
      resolveBestRows: [
        sample(WearableProvider.OURA, 100, '2026-01-02T00:00:00.000Z'),
        sample(WearableProvider.OURA, 120, '2026-01-03T00:00:00.000Z'),
      ],
      connections: [{ provider: WearableProvider.OURA, last_synced_at: new Date() }],
      bucketProviders: [WearableProvider.OURA],
    });
    const out = await svc.getSeries(USER, 'student', query());
    expect(out.series).toHaveLength(1);
    expect(out.series[0].provider_used).toBe(WearableProvider.OURA);
    expect(out.series[0].sample_count).toBe(2);
    expect(out.series[0].samples.every((s) => s.provider === WearableProvider.OURA)).toBe(true);
  });

  it('P1 #2: connected+synced provider with ZERO bucket samples still appears in freshness', async () => {
    const lastSync = new Date(); // recent -> current
    const svc = buildService({
      resolveBestRows: [],
      connections: [
        { provider: WearableProvider.WHOOP, last_synced_at: lastSync, status: 'connected' },
      ],
      bucketProviders: [], // no samples in bucket at all
    });
    const out = await svc.getSeries(USER, 'student', query());
    expect(out.series[0].provider_used).toBeNull();
    expect(out.series[0].sample_count).toBe(0);
    expect(out.series[0].samples).toEqual([]);
    // The connected, recently-synced provider MUST surface even with zero
    // bucket data (previously it silently vanished — P1 #2).
    expect(out.freshness.providers).toEqual([
      {
        provider: WearableProvider.WHOOP,
        last_synced_at: lastSync.toISOString(),
        status: 'current',
      },
    ]);
  });

  it('freshness: a never-synced connected provider is retained as never_synced', async () => {
    const svc = buildService({
      resolveBestRows: [],
      connections: [
        { provider: WearableProvider.GARMIN, last_synced_at: null, status: 'connected' },
      ],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query());
    expect(out.freshness.providers).toEqual([
      { provider: WearableProvider.GARMIN, last_synced_at: null, status: 'never_synced' },
    ]);
  });

  it('P1 #3: a connection with status=expired and a recent last_synced_at reports needs_attention', async () => {
    const recent = new Date(); // would be 'current' if status were healthy
    const svc = buildService({
      resolveBestRows: [],
      connections: [
        { provider: WearableProvider.OURA, last_synced_at: recent, status: 'expired' },
      ],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query());
    // A recent sync must NOT mask an expired connection — it cannot pull data.
    expect(out.freshness.providers).toEqual([
      {
        provider: WearableProvider.OURA,
        last_synced_at: recent.toISOString(),
        status: 'needs_attention',
      },
    ]);
  });

  it('P1 #3: a connection with status=error and a recent last_synced_at reports needs_attention', async () => {
    const recent = new Date();
    const svc = buildService({
      resolveBestRows: [],
      connections: [
        { provider: WearableProvider.FITBIT, last_synced_at: recent, status: 'error' },
      ],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query());
    expect(out.freshness.providers[0].status).toBe('needs_attention');
  });

  it('freshness: derives current vs needs_attention from last_synced_at', async () => {
    const svc = buildService({
      resolveBestRows: [sample(WearableProvider.OURA, 1, '2026-01-02T00:00:00.000Z')],
      connections: [
        { provider: WearableProvider.OURA, last_synced_at: new Date(), status: 'connected' },
        { provider: WearableProvider.WHOOP, last_synced_at: new Date('2020-01-01T00:00:00.000Z'), status: 'connected' },
      ],
      bucketProviders: [WearableProvider.OURA, WearableProvider.WHOOP],
    });
    const out = await svc.getSeries(USER, 'student', query());
    const byProvider = Object.fromEntries(
      out.freshness.providers.map((p) => [p.provider, p.status]),
    );
    expect(byProvider[WearableProvider.OURA]).toBe('current');
    expect(byProvider[WearableProvider.WHOOP]).toBe('needs_attention');
  });

  it('preferredOnly=false: reads ALL providers joined across the window', async () => {
    const svc = buildService({
      allProviderRows: [
        sample(WearableProvider.OURA, 10, '2026-01-02T00:00:00.000Z'),
        sample(WearableProvider.WHOOP, 11, '2026-01-02T00:00:00.000Z'),
      ],
      connections: [],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query({ preferredOnly: false }));
    expect(out.series[0].sample_count).toBe(2);
  });

  it('P1 #1: preferredOnly=false multi-provider envelope matches the preferredOnly=true shape', async () => {
    // The aggregation must be scoped to EXACTLY the providers present in the
    // returned samples (both, here) — it must not silently pick rows[0].provider
    // and drop WHOOP from the buckets. We capture the $queryRaw call to assert
    // BOTH providers are bound into the IN-list (no provider-scope drift).
    const captured: unknown[] = [];
    const prisma = {
      user: { findFirst: jest.fn(async () => null) },
      wearableSample: {
        findMany: jest.fn(async (args: any) =>
          args?.distinct
            ? []
            : [
                sample(WearableProvider.OURA, 10, '2026-01-02T00:00:00.000Z'),
                sample(WearableProvider.WHOOP, 11, '2026-01-03T00:00:00.000Z'),
              ],
        ),
      },
      wearableMetricDef: { findUnique: jest.fn(async () => ({ unit: 'count' })) },
      wearableConnection: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async (...args: unknown[]) => {
        captured.push(args);
        return [
          { bucket_start: new Date('2026-01-02T00:00:00.000Z'), agg: 10, count: BigInt(1) },
          { bucket_start: new Date('2026-01-03T00:00:00.000Z'), agg: 11, count: BigInt(1) },
        ];
      }),
    };
    const ingestion = { resolveBest: jest.fn(async () => []) };
    const svc = new WearableSamplesService(prisma as never, ingestion as never);

    const out = await svc.getSeries(
      USER,
      'student',
      query({ preferredOnly: false, granularity: 'day' }),
    );

    // Envelope shape parity: same series keys as a preferredOnly=true read.
    const s = out.series[0];
    expect(Object.keys(s).sort()).toEqual(
      ['buckets', 'metric', 'provider_used', 'sample_count', 'samples', 'unit'].sort(),
    );
    // Spanning two providers -> provider_used is null (no single source).
    expect(s.provider_used).toBeNull();
    expect(s.sample_count).toBe(2);
    // Buckets are present and span the full window (both provider rows feed it).
    expect(s.buckets).toHaveLength(2);
    // Both providers were bound into the aggregation IN-list (parameterized).
    const sqlText = JSON.stringify(captured);
    expect(sqlText).toContain('OURA');
    expect(sqlText).toContain('WHOOP');
  });

  it('P1 #1: preferredOnly=true single-provider sets provider_used to that provider', async () => {
    const svc = buildService({
      resolveBestRows: [
        sample(WearableProvider.OURA, 5, '2026-01-02T00:00:00.000Z'),
        sample(WearableProvider.OURA, 6, '2026-01-03T00:00:00.000Z'),
      ],
      connections: [],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query({ granularity: 'day' }));
    expect(out.series[0].provider_used).toBe(WearableProvider.OURA);
  });

  it('IDOR: coach reading a foreign client -> 403 WEARABLE_SAMPLES_FORBIDDEN, no data read', async () => {
    const svc = buildService({ ownsClient: false });
    await expect(
      svc.getSeries(COACH, 'coach', query({ clientId: CLIENT })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('owner bypasses the coach-owns-client check', async () => {
    const svc = buildService({
      ownsClient: false, // would 403 for a coach, but owner bypasses
      resolveBestRows: [],
      connections: [],
      bucketProviders: [],
    });
    const out = await svc.getSeries(COACH, 'owner', query({ clientId: CLIENT }));
    expect(out.user_id).toBe(CLIENT);
  });

  it('rejects a metric that does not belong to the requested bucket (400, not 403)', async () => {
    const svc = buildService();
    const promise = svc.getSeries(
      USER,
      'student',
      query({ bucket: WearableMetricBucket.SLEEP_RECOVERY, metric: WearableMetricType.STEPS }),
    );
    // P1 #5: this is a query-validation failure (400), never an authorization
    // failure (403). 403 would trigger logout flows on the client.
    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.not.toBeInstanceOf(ForbiddenException);
    try {
      await svc.getSeries(
        USER,
        'student',
        query({ bucket: WearableMetricBucket.SLEEP_RECOVERY, metric: WearableMetricType.STEPS }),
      );
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as { error: string };
      expect(resp.error).toBe('WEARABLE_SAMPLES_QUERY_INVALID');
    }
  });

  it('timeout: a Prisma call exceeding the 5s budget -> 503 WEARABLE_SAMPLES_DEGRADED', async () => {
    jest.useFakeTimers();
    const slow = new Promise(() => {
      /* never resolves */
    });
    const prisma = {
      user: { findFirst: jest.fn() },
      wearableSample: { findMany: jest.fn(() => slow) },
      wearableMetricDef: { findUnique: jest.fn(() => slow) },
      wearableConnection: { findMany: jest.fn(() => slow) },
      $queryRaw: jest.fn(() => slow),
    };
    const ingestion = { resolveBest: jest.fn(() => slow) };
    const svc = new WearableSamplesService(prisma as never, ingestion as never);

    const promise = svc.getSeries(USER, 'student', query());
    const assertion = expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(WearableSamplesService.PRISMA_TIMEOUT_MS + 10);
    await assertion;
    jest.useRealTimers();
  });

  it('unit falls back to the sample unit when no metric def exists', async () => {
    const svc = buildService({
      metricDefUnit: null,
      resolveBestRows: [sample(WearableProvider.OURA, 5, '2026-01-02T00:00:00.000Z')],
      connections: [],
      bucketProviders: [],
    });
    const out = await svc.getSeries(USER, 'student', query());
    expect(out.series[0].unit).toBe('count');
  });
});
