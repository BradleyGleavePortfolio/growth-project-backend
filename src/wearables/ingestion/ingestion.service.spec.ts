import { IngestionService } from './ingestion.service';
import { computeDedupKey } from './dedup.util';
import { NormalizedSample } from '../normalization/normalizer.types';
import type { PrismaService } from '../../prisma.service';
import {
  WearableMetricType,
  WearableProvider,
  WearableMetricBucket,
} from '@prisma/client';

/**
 * A minimal mock of the slice of PrismaService that IngestionService touches.
 * Each delegate is a jest.fn() so we can assert call counts (no N+1, #21) and
 * the exact arguments (batch shapes, dedup keys, cache-invalidation pairs).
 */
interface PrismaMock {
  wearableSample: {
    createMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  wearableConnection: { updateMany: jest.Mock };
  wearableInsightCache: { deleteMany: jest.Mock };
  wearableUserMetricPreference: { findUnique: jest.Mock };
}

function makePrismaMock(): PrismaMock {
  return {
    wearableSample: {
      createMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    wearableConnection: { updateMany: jest.fn() },
    wearableInsightCache: { deleteMany: jest.fn() },
    wearableUserMetricPreference: { findUnique: jest.fn() },
  };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const CONN_1 = 'conn-1';
const CONN_2 = 'conn-2';

function sample(overrides: Partial<NormalizedSample> = {}): NormalizedSample {
  return {
    userId: USER_A,
    connectionId: CONN_1,
    provider: WearableProvider.OURA,
    metric: WearableMetricType.SLEEP_TOTAL_MIN,
    bucket: WearableMetricBucket.SLEEP_RECOVERY,
    value: 462,
    unit: 'min',
    startAt: new Date('2026-05-31T22:00:00.000Z'),
    endAt: new Date('2026-06-01T06:30:00.000Z'),
    sourceTz: 'America/Los_Angeles',
    sourceRecordId: 'oura-rec-1',
    rawRef: null,
    ...overrides,
  };
}

describe('IngestionService', () => {
  let prisma: PrismaMock;
  let service: IngestionService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prisma.wearableSample.createMany.mockResolvedValue({ count: 0 });
    prisma.wearableConnection.updateMany.mockResolvedValue({ count: 0 });
    prisma.wearableInsightCache.deleteMany.mockResolvedValue({ count: 0 });
    service = new IngestionService(prisma as unknown as PrismaService);
  });

  describe('ingest', () => {
    it('returns zero counts and touches no delegate for an empty batch', async () => {
      const result = await service.ingest([]);
      expect(result).toEqual({ inserted: 0, skipped: 0 });
      expect(prisma.wearableSample.createMany).not.toHaveBeenCalled();
      expect(prisma.wearableConnection.updateMany).not.toHaveBeenCalled();
      expect(prisma.wearableInsightCache.deleteMany).not.toHaveBeenCalled();
    });

    it('inserts via a SINGLE createMany (no N+1) with skipDuplicates', async () => {
      prisma.wearableSample.createMany.mockResolvedValue({ count: 3 });
      const batch = [
        sample(),
        sample({
          metric: WearableMetricType.SLEEP_REM_MIN,
          value: 90,
          sourceRecordId: 'oura-rec-2',
        }),
        sample({
          metric: WearableMetricType.SLEEP_DEEP_MIN,
          value: 75,
          sourceRecordId: 'oura-rec-3',
        }),
      ];

      const result = await service.ingest(batch);

      // Exactly one batch insert — never one-per-row.
      expect(prisma.wearableSample.createMany).toHaveBeenCalledTimes(1);
      const arg = prisma.wearableSample.createMany.mock.calls[0][0];
      expect(arg.skipDuplicates).toBe(true);
      expect(arg.data).toHaveLength(3);
      expect(result).toEqual({ inserted: 3, skipped: 0 });
    });

    it('maps NormalizedSample fields to snake_case row columns and computes the dedup_key', async () => {
      prisma.wearableSample.createMany.mockResolvedValue({ count: 1 });
      const s = sample();

      await service.ingest([s]);

      const row = prisma.wearableSample.createMany.mock.calls[0][0].data[0];
      const expectedKey = computeDedupKey({
        userId: s.userId,
        provider: s.provider,
        metric: s.metric,
        startAt: s.startAt,
        endAt: s.endAt,
      });
      expect(row).toMatchObject({
        user_id: USER_A,
        connection_id: CONN_1,
        provider: WearableProvider.OURA,
        metric: WearableMetricType.SLEEP_TOTAL_MIN,
        bucket: WearableMetricBucket.SLEEP_RECOVERY,
        value: 462,
        unit: 'min',
        start_at: s.startAt,
        end_at: s.endAt,
        source_tz: 'America/Los_Angeles',
        source_record_id: 'oura-rec-1',
        raw_ref: null,
        dedup_key: expectedKey,
      });
      // The dedup key must be a 64-char sha256 hex digest.
      expect(row.dedup_key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reports skipped = batch size - inserted when createMany skips duplicates', async () => {
      prisma.wearableSample.createMany.mockResolvedValue({ count: 1 });
      const batch = [
        sample(),
        sample({ metric: WearableMetricType.HRV_MS, value: 55 }),
      ];

      const result = await service.ingest(batch);

      expect(result).toEqual({ inserted: 1, skipped: 1 });
    });

    it('bumps connections via a SINGLE updateMany over the DISTINCT connection ids', async () => {
      prisma.wearableSample.createMany.mockResolvedValue({ count: 3 });
      const batch = [
        sample({ connectionId: CONN_1 }),
        sample({
          connectionId: CONN_1,
          metric: WearableMetricType.HRV_MS,
          value: 55,
        }),
        sample({
          connectionId: CONN_2,
          metric: WearableMetricType.STEPS,
          bucket: WearableMetricBucket.HEALTH_FITNESS,
          unit: 'count',
          value: 8000,
        }),
      ];

      await service.ingest(batch);

      expect(prisma.wearableConnection.updateMany).toHaveBeenCalledTimes(1);
      const arg = prisma.wearableConnection.updateMany.mock.calls[0][0];
      // Distinct connection ids only — CONN_1 appears once, not twice.
      expect(arg.where.id.in.slice().sort()).toEqual([CONN_1, CONN_2]);
      expect(arg.data.status).toBe('connected');
      expect(arg.data.last_error).toBeNull();
      expect(arg.data.last_synced_at).toBeInstanceOf(Date);
    });

    it('invalidates insight cache with ONE deleteMany per DISTINCT (user, bucket) pair', async () => {
      prisma.wearableSample.createMany.mockResolvedValue({ count: 4 });
      const batch = [
        // USER_A / SLEEP_RECOVERY  (x2 → collapses to one pair)
        sample({ userId: USER_A, bucket: WearableMetricBucket.SLEEP_RECOVERY }),
        sample({
          userId: USER_A,
          bucket: WearableMetricBucket.SLEEP_RECOVERY,
          metric: WearableMetricType.HRV_MS,
          value: 55,
        }),
        // USER_A / HEALTH_FITNESS
        sample({
          userId: USER_A,
          bucket: WearableMetricBucket.HEALTH_FITNESS,
          metric: WearableMetricType.STEPS,
          unit: 'count',
          value: 8000,
        }),
        // USER_B / SLEEP_RECOVERY
        sample({
          userId: USER_B,
          bucket: WearableMetricBucket.SLEEP_RECOVERY,
        }),
      ];

      await service.ingest(batch);

      // 3 distinct (user, bucket) pairs → exactly 3 deleteMany calls.
      expect(prisma.wearableInsightCache.deleteMany).toHaveBeenCalledTimes(3);
      const pairs = prisma.wearableInsightCache.deleteMany.mock.calls.map(
        (c) => `${c[0].where.user_id}::${c[0].where.bucket}`,
      );
      expect(pairs.slice().sort()).toEqual(
        [
          `${USER_A}::${WearableMetricBucket.HEALTH_FITNESS}`,
          `${USER_A}::${WearableMetricBucket.SLEEP_RECOVERY}`,
          `${USER_B}::${WearableMetricBucket.SLEEP_RECOVERY}`,
        ].sort(),
      );
    });

    it('orders operations: insert THEN connection-bump THEN cache-invalidation', async () => {
      const order: string[] = [];
      prisma.wearableSample.createMany.mockImplementation(async () => {
        order.push('createMany');
        return { count: 1 };
      });
      prisma.wearableConnection.updateMany.mockImplementation(async () => {
        order.push('updateMany');
        return { count: 1 };
      });
      prisma.wearableInsightCache.deleteMany.mockImplementation(async () => {
        order.push('deleteMany');
        return { count: 0 };
      });

      await service.ingest([sample()]);

      expect(order).toEqual(['createMany', 'updateMany', 'deleteMany']);
    });

    it('throws TypeError when samples is not an array', async () => {
      await expect(
        service.ingest(undefined as unknown as NormalizedSample[]),
      ).rejects.toBeInstanceOf(TypeError);
    });

    describe('input validation (#8) rejects before any DB write', () => {
      const cases: Array<[string, Partial<NormalizedSample>]> = [
        ['missing userId', { userId: '' }],
        ['missing connectionId', { connectionId: '' }],
        ['non-finite value', { value: Number.NaN }],
        ['infinite value', { value: Number.POSITIVE_INFINITY }],
        ['missing unit', { unit: '' }],
        ['invalid startAt', { startAt: new Date('not-a-date') }],
        ['invalid endAt', { endAt: new Date('not-a-date') }],
        [
          'start after end',
          {
            startAt: new Date('2026-06-01T06:30:00.000Z'),
            endAt: new Date('2026-05-31T22:00:00.000Z'),
          },
        ],
      ];

      it.each(cases)('rejects %s and writes nothing', async (_label, bad) => {
        await expect(service.ingest([sample(bad)])).rejects.toThrow(
          /invalid sample at index 0/,
        );
        expect(prisma.wearableSample.createMany).not.toHaveBeenCalled();
        expect(prisma.wearableConnection.updateMany).not.toHaveBeenCalled();
        expect(prisma.wearableInsightCache.deleteMany).not.toHaveBeenCalled();
      });

      it('reports the failing batch index in the error message', async () => {
        const batch = [sample(), sample({ value: Number.NaN })];
        await expect(service.ingest(batch)).rejects.toThrow(
          /invalid sample at index 1/,
        );
      });
    });
  });

  describe('resolveBest', () => {
    const START = new Date('2026-05-30T00:00:00.000Z');
    const END = new Date('2026-06-01T00:00:00.000Z');

    it('honors a WearableUserMetricPreference over recency (preference precedence)', async () => {
      prisma.wearableUserMetricPreference.findUnique.mockResolvedValue({
        user_id: USER_A,
        metric: WearableMetricType.HRV_MS,
        preferred_provider: WearableProvider.WHOOP,
      });
      const preferredRows = [
        { id: 's1', provider: WearableProvider.WHOOP, value: 60 },
      ];
      prisma.wearableSample.findMany.mockResolvedValue(preferredRows);

      const result = await service.resolveBest(
        USER_A,
        WearableMetricType.HRV_MS,
        START,
        END,
      );

      expect(result).toBe(preferredRows);
      // Preference lookup keyed on the composite unique.
      expect(
        prisma.wearableUserMetricPreference.findUnique,
      ).toHaveBeenCalledWith({
        where: {
          WearablePref_user_metric_key: {
            user_id: USER_A,
            metric: WearableMetricType.HRV_MS,
          },
        },
      });
      // It must NOT fall back to the recency query when a preference exists.
      expect(prisma.wearableSample.findFirst).not.toHaveBeenCalled();
      // The sample query is scoped to the PREFERRED provider + overlap window.
      const where = prisma.wearableSample.findMany.mock.calls[0][0].where;
      expect(where.provider).toBe(WearableProvider.WHOOP);
      expect(where.user_id).toBe(USER_A);
      expect(where.metric).toBe(WearableMetricType.HRV_MS);
      expect(where.start_at).toEqual({ lt: END });
      expect(where.end_at).toEqual({ gt: START });
    });

    it('falls back to the MOST-RECENTLY-RECORDED provider when no preference exists', async () => {
      prisma.wearableUserMetricPreference.findUnique.mockResolvedValue(null);
      prisma.wearableSample.findFirst.mockResolvedValue({
        provider: WearableProvider.GARMIN,
      });
      const garminRows = [
        { id: 's9', provider: WearableProvider.GARMIN, value: 48 },
      ];
      prisma.wearableSample.findMany.mockResolvedValue(garminRows);

      const result = await service.resolveBest(
        USER_A,
        WearableMetricType.HRV_MS,
        START,
        END,
      );

      expect(result).toBe(garminRows);
      // Recency probe orders by recorded_at desc.
      expect(prisma.wearableSample.findFirst).toHaveBeenCalledTimes(1);
      const probe = prisma.wearableSample.findFirst.mock.calls[0][0];
      expect(probe.orderBy).toEqual({ recorded_at: 'desc' });
      // Final fetch scoped to the resolved provider.
      const where = prisma.wearableSample.findMany.mock.calls[0][0].where;
      expect(where.provider).toBe(WearableProvider.GARMIN);
    });

    it('returns an empty array when no samples exist in the window', async () => {
      prisma.wearableUserMetricPreference.findUnique.mockResolvedValue(null);
      prisma.wearableSample.findFirst.mockResolvedValue(null);

      const result = await service.resolveBest(
        USER_A,
        WearableMetricType.HRV_MS,
        START,
        END,
      );

      expect(result).toEqual([]);
      // No wasted final query once the recency probe finds nothing.
      expect(prisma.wearableSample.findMany).not.toHaveBeenCalled();
    });

    it('throws TypeError when userId is missing', async () => {
      await expect(
        service.resolveBest('', WearableMetricType.HRV_MS, START, END),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('throws RangeError when startAt is after endAt', async () => {
      await expect(
        service.resolveBest(USER_A, WearableMetricType.HRV_MS, END, START),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });
});
