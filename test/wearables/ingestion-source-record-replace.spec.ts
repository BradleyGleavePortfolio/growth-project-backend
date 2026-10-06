import {
  Prisma,
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { NormalizedSample } from '../../src/wearables/normalization/normalizer.types';
import { IngestionService } from '../../src/wearables/ingestion/ingestion.service';

/**
 * #732 — a record rewritten at the source (same source record id, new
 * interval or value) replaces its stored version instead of adding a second
 * row. The fake below is a tiny in-memory WearableSample table: unique
 * dedup_key, createMany(skipDuplicates) and a deleteMany that evaluates the
 * Prisma where shape the service builds (equality, OR, lt/gt/gte/lte).
 */
type Row = Prisma.WearableSampleCreateManyInput;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = (row as Record<string, unknown>)[field];
    if (cond instanceof Date || typeof cond !== 'object' || cond === null) {
      return value instanceof Date && cond instanceof Date
        ? value.getTime() === cond.getTime()
        : value === cond;
    }
    const t = (value as Date).getTime();
    const ops = cond as { lt?: Date; gt?: Date; gte?: Date; lte?: Date };
    return (
      (ops.lt === undefined || t < ops.lt.getTime()) &&
      (ops.gt === undefined || t > ops.gt.getTime()) &&
      (ops.gte === undefined || t >= ops.gte.getTime()) &&
      (ops.lte === undefined || t <= ops.lte.getTime())
    );
  });
}

function makeStore() {
  let table: Row[] = [];
  const wearableSample = {
    deleteMany: jest.fn(async ({ where }: { where: Where }) => {
      const before = table.length;
      table = table.filter((r) => !matches(r, where));
      return { count: before - table.length };
    }),
    createMany: jest.fn(async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const r of data) {
        if (table.some((t) => t.dedup_key === r.dedup_key)) continue;
        table.push(r);
        count += 1;
      }
      return { count };
    }),
  };
  const client = {
    wearableSample,
    wearableConnection: { updateMany: jest.fn(async () => ({ count: 1 })) },
    wearableInsightCache: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(),
  };
  client.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(client));
  return { client, rows: () => table };
}

const USER = '11111111-1111-1111-1111-111111111111';
const at = (iso: string) => new Date(`2026-10-0${iso}Z`);

function sleep(id: string | null, start: string, end: string, value: number): NormalizedSample {
  return {
    userId: USER,
    connectionId: 'conn-hc',
    provider: WearableProvider.HEALTH_CONNECT,
    metric: WearableMetricType.SLEEP_TOTAL_MIN,
    bucket: WearableMetricBucket.SLEEP_RECOVERY,
    value,
    unit: 'min',
    startAt: at(start),
    endAt: at(end),
    sourceRecordId: id,
  };
}

/** A heart-rate series record: `n` instantaneous samples one minute apart. */
function hrSeries(id: string, from: number, n: number): NormalizedSample[] {
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(2026, 9, 5, 7, 0) + (from + i) * 60_000);
    return {
      ...sleep(id, '5T07:00:00', '5T07:00:00', 60 + i),
      metric: WearableMetricType.HEART_RATE_BPM,
      bucket: WearableMetricBucket.HEALTH_FITNESS,
      unit: 'bpm',
      startAt: t,
      endAt: t,
    };
  });
}

const total = (rows: Row[]) => rows.reduce((sum, r) => sum + r.value, 0);

describe('IngestionService — rewritten source records replace (#732)', () => {
  let store: ReturnType<typeof makeStore>;
  let service: IngestionService;

  beforeEach(() => {
    store = makeStore();
    const prisma: PrismaService = Object.assign(
      Object.create(PrismaService.prototype),
      store.client,
    );
    service = new IngestionService(prisma);
  });

  it('a corrected sleep session (480 -> 450 min) replaces the stored row: total 450', async () => {
    await service.ingest([sleep('hc-sleep-1', '4T22:00:00', '5T06:00:00', 480)]);
    await service.ingest([sleep('hc-sleep-1', '4T22:30:00', '5T06:00:00', 450)]);

    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0].start_at).toEqual(at('4T22:30:00'));
    expect(total(store.rows())).toBe(450);
  });

  it('an unchanged re-post of the same record stays one row', async () => {
    const night = sleep('hc-sleep-1', '4T22:00:00', '5T06:00:00', 480);
    await service.ingest([night]);
    await service.ingest([night]);
    await service.ingest([night]);

    expect(store.rows()).toHaveLength(1);
    expect(total(store.rows())).toBe(480);
  });

  it('a same-id heart-rate series keeps the full incoming series (60 then 61 samples -> 61 rows)', async () => {
    await service.ingest(hrSeries('hc-hr-1', 0, 60));
    await service.ingest(hrSeries('hc-hr-1', 0, 61));

    expect(store.rows()).toHaveLength(61);
    // The series is grouped: ONE delete statement per request, not per row.
    expect(store.client.wearableSample.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('a heart-rate record split across two requests keeps both halves', async () => {
    // The phone caps a request at 250 samples, so one record can straddle
    // two consecutive requests of the same sync.
    const series = hrSeries('hc-hr-2', 0, 300);
    await service.ingest(series.slice(0, 250));
    await service.ingest(series.slice(250));
    expect(store.rows()).toHaveLength(300);

    // Re-syncing the same split record is still idempotent.
    await service.ingest(series.slice(0, 250));
    await service.ingest(series.slice(250));
    expect(store.rows()).toHaveLength(300);
  });

  it('does not touch other records, other metrics or other users', async () => {
    await service.ingest([
      sleep('hc-sleep-1', '4T22:00:00', '5T06:00:00', 480),
      sleep('hc-sleep-2', '3T22:00:00', '4T06:00:00', 470),
      { ...sleep('hc-sleep-1', '4T22:00:00', '5T06:00:00', 90), metric: WearableMetricType.SLEEP_REM_MIN },
      { ...sleep('hc-sleep-1', '4T22:00:00', '5T06:00:00', 400), userId: '22222222-2222-2222-2222-222222222222' },
    ]);
    await service.ingest([sleep('hc-sleep-1', '4T22:30:00', '5T06:00:00', 450)]);

    expect(store.rows()).toHaveLength(4);
    expect(store.rows().map((r) => r.value).sort((a, b) => a - b)).toEqual([90, 400, 450, 470]);
  });

  it('samples without a source record id keep interval-hash dedup only', async () => {
    await service.ingest([sleep(null, '4T22:00:00', '5T06:00:00', 480)]);
    await service.ingest([sleep(null, '4T22:00:00', '5T06:00:00', 480)]);
    await service.ingest([sleep(null, '4T22:30:00', '5T06:00:00', 450)]);

    expect(store.client.wearableSample.deleteMany).not.toHaveBeenCalled();
    expect(store.rows()).toHaveLength(2);
  });

  it('two different record ids with the same interval stay one row (dedup_key)', async () => {
    await service.ingest([sleep('hc-a', '4T22:00:00', '5T06:00:00', 480)]);
    await service.ingest([sleep('hc-b', '4T22:00:00', '5T06:00:00', 480)]);

    expect(store.rows()).toHaveLength(1);
  });
});
