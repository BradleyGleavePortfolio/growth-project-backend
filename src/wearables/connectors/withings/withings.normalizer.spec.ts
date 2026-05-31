import { WearableProvider } from '@prisma/client';
import { computeDedupKey } from '../../ingestion/dedup.util';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  normalizeWithings,
  normalizeWithingsRecord,
  WithingsRawPayload,
} from './withings.normalizer';

/**
 * PR-HK-2.i normalizer contract tests — real-value assertions (no
 * `toBeDefined`). Each known Withings JSON maps to an EXACT NormalizedSample
 * list: metric, value (decoded/unit-converted), unit, bucket, start/end window,
 * and the deterministic dedup_key the ingestion lane will compute for that
 * sample (verified via the shared `computeDedupKey` util on the produced
 * fields).
 */

const USER = '11111111-1111-1111-1111-111111111111';
const CONN = '22222222-2222-2222-2222-222222222222';

function wrap(
  collection: WithingsRawPayload['collection'],
  record: unknown,
): RawRecord {
  return {
    provider: WearableProvider.WITHINGS,
    payload: {
      collection,
      userId: USER,
      connectionId: CONN,
      sourceTz: null,
      record,
    } satisfies WithingsRawPayload,
  };
}

/** Re-derive the dedup_key the ingestion lane will assign to a sample. */
function dedup(sample: {
  metric: import('@prisma/client').WearableMetricType;
  startAt: Date;
  endAt: Date;
}): string {
  return computeDedupKey({
    userId: USER,
    provider: WearableProvider.WITHINGS,
    metric: sample.metric,
    startAt: sample.startAt,
    endAt: sample.endAt,
  });
}

describe('withings.normalizer — measure (weight)', () => {
  it('decodes type 1 value*10^unit → BODY_WEIGHT_KG (H&F, kg) at the group instant', () => {
    // 2026-05-31T08:00:00Z = epoch 1780214400; 70.5 kg = { value: 70500, unit: -3 }.
    const out = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9001,
        date: 1780214400,
        category: 1,
        measures: [{ type: 1, value: 70500, unit: -3 }],
      }).payload as WithingsRawPayload,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'BODY_WEIGHT_KG',
      value: 70.5,
      unit: 'kg',
      bucket: 'HEALTH_FITNESS',
      provider: 'WITHINGS',
      userId: USER,
      connectionId: CONN,
      sourceRecordId: '9001',
    });
    // Instantaneous: start == end == the group instant.
    expect(out[0].startAt.toISOString()).toBe('2026-05-31T08:00:00.000Z');
    expect(out[0].endAt.toISOString()).toBe('2026-05-31T08:00:00.000Z');
    expect(dedup(out[0])).toBe(
      computeDedupKey({
        userId: USER,
        provider: WearableProvider.WITHINGS,
        metric: 'BODY_WEIGHT_KG',
        startAt: new Date('2026-05-31T08:00:00.000Z'),
        endAt: new Date('2026-05-31T08:00:00.000Z'),
      }),
    );
  });

  it('decodes type 6 → BODY_FAT_PCT (H&F, %)', () => {
    // 18.25 % = { value: 1825, unit: -2 }.
    const out = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9002,
        date: 1780214400,
        measures: [{ type: 6, value: 1825, unit: -2 }],
      }).payload as WithingsRawPayload,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'BODY_FAT_PCT',
      value: 18.25,
      unit: '%',
      bucket: 'HEALTH_FITNESS',
    });
  });

  it('emits BOTH systolic (type 10) and diastolic (type 9) from one BP group', () => {
    const out = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9003,
        date: 1780214400,
        measures: [
          { type: 9, value: 80, unit: 0 }, // diastolic mmHg
          { type: 10, value: 120, unit: 0 }, // systolic mmHg
        ],
      }).payload as WithingsRawPayload,
    );
    expect(out).toHaveLength(2);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));
    expect(byMetric.BLOOD_PRESSURE_DIA).toMatchObject({
      value: 80,
      unit: 'mmHg',
      bucket: 'HEALTH_FITNESS',
    });
    expect(byMetric.BLOOD_PRESSURE_SYS).toMatchObject({
      value: 120,
      unit: 'mmHg',
      bucket: 'HEALTH_FITNESS',
    });
    // Distinct metrics → distinct dedup keys for the same instant.
    expect(dedup(byMetric.BLOOD_PRESSURE_DIA)).not.toBe(
      dedup(byMetric.BLOOD_PRESSURE_SYS),
    );
  });

  it('drops unmapped measure types and user-objective groups (category 2)', () => {
    // Unmapped type 11 (pulse) is dropped.
    const unmapped = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9004,
        date: 1780214400,
        measures: [{ type: 11, value: 60, unit: 0 }],
      }).payload as WithingsRawPayload,
    );
    expect(unmapped).toEqual([]);

    // Category-2 (objective) groups carry no observations.
    const objective = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9005,
        date: 1780214400,
        category: 2,
        measures: [{ type: 1, value: 65000, unit: -3 }],
      }).payload as WithingsRawPayload,
    );
    expect(objective).toEqual([]);
  });

  it('skips a group with a non-positive / absent date', () => {
    const out = normalizeWithingsRecord(
      wrap('measure', {
        grpid: 9006,
        date: 0,
        measures: [{ type: 1, value: 70000, unit: -3 }],
      }).payload as WithingsRawPayload,
    );
    expect(out).toEqual([]);
  });
});

describe('withings.normalizer — sleep summary', () => {
  // Night window 2026-05-30T23:00:00Z → 2026-05-31T07:00:00Z.
  const START = 1780182000; // 2026-05-30T23:00:00Z
  const END = 1780210800; // 2026-05-31T07:00:00Z
  const SLEEP = {
    id: 555,
    startdate: START,
    enddate: END,
    data: {
      total_sleep_time: 25200, // 420 min
      remsleepduration: 6000, // 100 min
      deepsleepduration: 4200, // 70 min
      lightsleepduration: 15000, // 250 min
      wakeupduration: 900, // 15 min
      sleep_efficiency: 0.89, // ratio → 89 %
      rr_average: 14, // br/min
    },
  };

  it('maps every stage + efficiency + respiratory rate with correct units/buckets', () => {
    const out = normalizeWithingsRecord(
      wrap('sleep', SLEEP).payload as WithingsRawPayload,
    );
    expect(out).toHaveLength(7);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    expect(byMetric.SLEEP_TOTAL_MIN).toMatchObject({
      value: 420,
      unit: 'min',
      bucket: 'SLEEP_RECOVERY',
      provider: 'WITHINGS',
      userId: USER,
      connectionId: CONN,
      sourceRecordId: '555',
    });
    expect(byMetric.SLEEP_REM_MIN.value).toBe(100);
    expect(byMetric.SLEEP_DEEP_MIN.value).toBe(70);
    expect(byMetric.SLEEP_LIGHT_MIN.value).toBe(250);
    expect(byMetric.SLEEP_AWAKE_MIN.value).toBe(15);
    // 0.89 ratio → 89 percent.
    expect(byMetric.SLEEP_EFFICIENCY_PCT).toMatchObject({
      value: 89,
      unit: '%',
    });
    expect(byMetric.RESPIRATORY_RATE_BRPM).toMatchObject({
      value: 14,
      unit: 'br/min',
      bucket: 'SLEEP_RECOVERY',
    });

    // Window is the night's epoch span.
    expect(byMetric.SLEEP_TOTAL_MIN.startAt.toISOString()).toBe(
      '2026-05-30T23:00:00.000Z',
    );
    expect(byMetric.SLEEP_TOTAL_MIN.endAt.toISOString()).toBe(
      '2026-05-31T07:00:00.000Z',
    );
  });

  it('produces the canonical anchored dedup_key for SLEEP_TOTAL_MIN and RESPIRATORY_RATE_BRPM', () => {
    const out = normalizeWithingsRecord(
      wrap('sleep', SLEEP).payload as WithingsRawPayload,
    );
    const total = out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')!;
    const rr = out.find((s) => s.metric === 'RESPIRATORY_RATE_BRPM')!;
    expect(dedup(total)).toBe(
      computeDedupKey({
        userId: USER,
        provider: WearableProvider.WITHINGS,
        metric: 'SLEEP_TOTAL_MIN',
        startAt: new Date('2026-05-30T23:00:00.000Z'),
        endAt: new Date('2026-05-31T07:00:00.000Z'),
      }),
    );
    expect(dedup(rr)).toBe(
      computeDedupKey({
        userId: USER,
        provider: WearableProvider.WITHINGS,
        metric: 'RESPIRATORY_RATE_BRPM',
        startAt: new Date('2026-05-30T23:00:00.000Z'),
        endAt: new Date('2026-05-31T07:00:00.000Z'),
      }),
    );
  });

  it('drops null/absent stage fields (no speculative zero-rows)', () => {
    const out = normalizeWithingsRecord(
      wrap('sleep', {
        id: 556,
        startdate: START,
        enddate: END,
        data: { total_sleep_time: 25200 },
      }).payload as WithingsRawPayload,
    );
    expect(out.map((s) => s.metric).sort()).toEqual(['SLEEP_TOTAL_MIN']);
  });

  it('skips a night with a missing/zero window or inverted span', () => {
    expect(
      normalizeWithingsRecord(
        wrap('sleep', { id: 1, startdate: 0, enddate: END, data: {} })
          .payload as WithingsRawPayload,
      ),
    ).toEqual([]);
    expect(
      normalizeWithingsRecord(
        wrap('sleep', { id: 2, startdate: END, enddate: START, data: {} })
          .payload as WithingsRawPayload,
      ),
    ).toEqual([]);
  });
});

describe('withings.normalizer — batch', () => {
  it('normalizeWithings flattens a mixed batch and skips non-Withings payloads', () => {
    const batch: RawRecord[] = [
      wrap('measure', {
        grpid: 1,
        date: 1780214400,
        measures: [{ type: 1, value: 70000, unit: -3 }],
      }),
      { provider: WearableProvider.WITHINGS, payload: undefined as unknown },
      wrap('sleep', {
        id: 7,
        startdate: 1780182000,
        enddate: 1780210800,
        data: { total_sleep_time: 25200 },
      }),
    ];
    const out = normalizeWithings(batch);
    expect(out.map((s) => s.metric).sort()).toEqual([
      'BODY_WEIGHT_KG',
      'SLEEP_TOTAL_MIN',
    ]);
  });
});
