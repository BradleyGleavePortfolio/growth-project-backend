import { WearableMetricType, WearableProvider } from '@prisma/client';
import { RawRecord } from '../../normalization/normalizer.types';
import { computeDedupKey } from '../../ingestion/dedup.util';
import {
  garminDedupKey,
  normalizeGarmin,
  offsetToSourceTz,
} from './garmin.normalizer';
import { GarminRawPayload, GarminSummaryKind } from './garmin.types';

const USER = 'user-uuid-1';
const CONN = 'conn-uuid-1';

/** 2026-05-20T00:00:00Z in epoch seconds. */
const DAY_START_SEC = Math.floor(Date.parse('2026-05-20T00:00:00.000Z') / 1000);

function raw(
  kind: GarminSummaryKind,
  data: Record<string, unknown>,
): RawRecord {
  const payload: GarminRawPayload = {
    kind,
    data: data as never,
    userId: USER,
    connectionId: CONN,
  };
  return {
    id: String(data.summaryId),
    provider: WearableProvider.GARMIN,
    payload,
  };
}

function byMetric(samples: { metric: WearableMetricType }[]) {
  return Object.fromEntries(samples.map((s) => [s.metric, s])) as Record<
    WearableMetricType,
    {
      metric: WearableMetricType;
      value: number;
      unit: string;
      bucket: string;
      provider: string;
      userId: string;
      connectionId: string;
      startAt: Date;
      endAt: Date;
      sourceTz?: string | null;
    }
  >;
}

describe('normalizeGarmin', () => {
  it('maps a daily summary to STEPS and ACTIVE_ENERGY_KCAL (H&F) with exact values', () => {
    const samples = normalizeGarmin([
      raw('dailies', {
        summaryId: 'daily-1',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        startTimeOffsetInSeconds: 3600, // UTC+01:00
        durationInSeconds: 86_400,
        steps: 8421,
        activeKilocalories: 612,
      }),
    ]);

    expect(samples).toHaveLength(2);
    const m = byMetric(samples);
    expect(m[WearableMetricType.STEPS]).toMatchObject({
      value: 8421,
      unit: 'steps',
      bucket: 'HEALTH_FITNESS',
      provider: 'GARMIN',
      userId: USER,
      connectionId: CONN,
      sourceTz: 'UTC+01:00',
    });
    expect(m[WearableMetricType.ACTIVE_ENERGY_KCAL]).toMatchObject({
      value: 612,
      unit: 'kcal',
      bucket: 'HEALTH_FITNESS',
    });
    expect(m[WearableMetricType.STEPS].startAt.toISOString()).toBe(
      '2026-05-20T00:00:00.000Z',
    );
    expect(m[WearableMetricType.STEPS].endAt.toISOString()).toBe(
      '2026-05-21T00:00:00.000Z',
    );
  });

  it('maps a sleep summary to all stages, derived TOTAL + EFFICIENCY, and BODY_BATTERY (S&R)', () => {
    // Stages in seconds: deep 1h, light 3h, rem 1.5h, awake 0.5h.
    const samples = normalizeGarmin([
      raw('sleeps', {
        summaryId: 'sleep-1',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 21_600, // 6h in bed
        validation: 'ENHANCED_CONFIRMED',
        deepSleepDurationInSeconds: 3600, // 60 min
        lightSleepDurationInSeconds: 10_800, // 180 min
        remSleepInSeconds: 5400, // 90 min
        awakeDurationInSeconds: 1800, // 30 min
        endingBodyBattery: 72,
      }),
    ]);

    const m = byMetric(samples);
    expect(m[WearableMetricType.SLEEP_DEEP_MIN]).toMatchObject({
      value: 60,
      unit: 'min',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(m[WearableMetricType.SLEEP_LIGHT_MIN].value).toBe(180);
    expect(m[WearableMetricType.SLEEP_REM_MIN].value).toBe(90);
    expect(m[WearableMetricType.SLEEP_AWAKE_MIN].value).toBe(30);
    // TOTAL = sum of all stages = 60+180+90+30 = 360 min.
    expect(m[WearableMetricType.SLEEP_TOTAL_MIN].value).toBe(360);
    // EFFICIENCY = asleep / (asleep + awake) = 330 / 360 = 91.6667%.
    expect(m[WearableMetricType.SLEEP_EFFICIENCY_PCT].unit).toBe('%');
    expect(m[WearableMetricType.SLEEP_EFFICIENCY_PCT].value).toBeCloseTo(
      91.6667,
      3,
    );
    expect(m[WearableMetricType.BODY_BATTERY]).toMatchObject({
      value: 72,
      unit: 'score',
      bucket: 'SLEEP_RECOVERY',
    });
  });

  it('falls back to bodyBatteryChange when endingBodyBattery is absent', () => {
    const samples = normalizeGarmin([
      raw('sleeps', {
        summaryId: 'sleep-2',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        durationInSeconds: 3600,
        validation: 'ENHANCED_TENTATIVE',
        deepSleepDurationInSeconds: 3600,
        bodyBatteryChange: 18,
      }),
    ]);
    const m = byMetric(samples);
    expect(m[WearableMetricType.BODY_BATTERY].value).toBe(18);
  });

  it('skips non-enhanced (manual) sleep entries', () => {
    const samples = normalizeGarmin([
      raw('sleeps', {
        summaryId: 'sleep-3',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        durationInSeconds: 3600,
        validation: 'MANUAL',
        deepSleepDurationInSeconds: 3600,
      }),
    ]);
    expect(samples).toHaveLength(0);
  });

  it('maps an hrv summary to HRV_MS (S&R) with exact value', () => {
    const samples = normalizeGarmin([
      raw('hrv', {
        summaryId: 'hrv-1',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        startTimeOffsetInSeconds: -18_000, // UTC-05:00
        durationInSeconds: 28_800,
        lastNightAvg: 47,
        lastNight5MinHigh: 80,
      }),
    ]);
    expect(samples).toHaveLength(1);
    const m = byMetric(samples);
    expect(m[WearableMetricType.HRV_MS]).toMatchObject({
      value: 47,
      unit: 'ms',
      bucket: 'SLEEP_RECOVERY',
      sourceTz: 'UTC-05:00',
    });
  });

  it('maps an activity to WORKOUT_DURATION_MIN, WORKOUT_DISTANCE_M and TRAINING_LOAD (H&F)', () => {
    const samples = normalizeGarmin([
      raw('activities', {
        summaryId: 'act-1',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 1800, // 30 min
        activityType: 'RUNNING',
        distanceInMeters: 5200,
        activityTrainingLoad: 137,
      }),
    ]);
    const m = byMetric(samples);
    expect(m[WearableMetricType.WORKOUT_DURATION_MIN]).toMatchObject({
      value: 30,
      unit: 'min',
      bucket: 'HEALTH_FITNESS',
    });
    expect(m[WearableMetricType.WORKOUT_DISTANCE_M]).toMatchObject({
      value: 5200,
      unit: 'm',
    });
    expect(m[WearableMetricType.TRAINING_LOAD]).toMatchObject({
      value: 137,
      unit: 'score',
    });
  });

  it('maps a body composition summary to BODY_WEIGHT_KG (g→kg) and BODY_FAT_PCT (H&F)', () => {
    const samples = normalizeGarmin([
      raw('bodyComps', {
        summaryId: 'bc-1',
        userId: 'garmin-99',
        startTimeInSeconds: DAY_START_SEC,
        durationInSeconds: 0,
        weightInGrams: 80_500, // 80.5 kg
        bodyFatInPercent: 18.4,
      }),
    ]);
    const m = byMetric(samples);
    expect(m[WearableMetricType.BODY_WEIGHT_KG]).toMatchObject({
      value: 80.5,
      unit: 'kg',
      bucket: 'HEALTH_FITNESS',
    });
    expect(m[WearableMetricType.BODY_FAT_PCT]).toMatchObject({
      value: 18.4,
      unit: '%',
    });
    // Point-in-time (no duration): start == end.
    expect(m[WearableMetricType.BODY_WEIGHT_KG].startAt.toISOString()).toBe(
      m[WearableMetricType.BODY_WEIGHT_KG].endAt.toISOString(),
    );
  });

  it('drops foreign-provider records and records with no ctx', () => {
    const foreign: RawRecord = {
      id: 'x',
      provider: WearableProvider.WHOOP,
      payload: { kind: 'dailies', data: { summaryId: 'x', userId: 'g' } },
    };
    const noCtx: RawRecord = {
      id: 'y',
      provider: WearableProvider.GARMIN,
      payload: {
        kind: 'dailies',
        data: {
          summaryId: 'y',
          userId: 'g',
          startTimeInSeconds: DAY_START_SEC,
          steps: 100,
        },
      } as GarminRawPayload,
    };
    expect(normalizeGarmin([foreign, noCtx])).toHaveLength(0);
  });

  it('skips a daily with an unparseable window', () => {
    const samples = normalizeGarmin([
      raw('dailies', {
        summaryId: 'daily-bad',
        userId: 'garmin-99',
        steps: 999, // no startTimeInSeconds → no window → skipped
      }),
    ]);
    expect(samples).toHaveLength(0);
  });
});

describe('offsetToSourceTz', () => {
  it('renders positive, negative, and zero offsets', () => {
    expect(offsetToSourceTz(3600)).toBe('UTC+01:00');
    expect(offsetToSourceTz(-18_000)).toBe('UTC-05:00');
    expect(offsetToSourceTz(0)).toBe('UTC+00:00');
    expect(offsetToSourceTz(undefined)).toBe('UTC');
  });
});

describe('garminDedupKey', () => {
  it('is deterministic and value-sensitive (sha256 hex)', () => {
    const at = new Date('2026-05-20T00:00:00.000Z');
    const a = garminDedupKey({
      userId: 'garmin-99',
      metric: WearableMetricType.STEPS,
      startAt: at,
      value: 8421,
    });
    const b = garminDedupKey({
      userId: 'garmin-99',
      metric: WearableMetricType.STEPS,
      startAt: at,
      value: 8421,
    });
    const c = garminDedupKey({
      userId: 'garmin-99',
      metric: WearableMetricType.STEPS,
      startAt: at,
      value: 8422, // different value
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('differs from the foundation row dedup_key (value is folded in)', () => {
    const at = new Date('2026-05-20T00:00:00.000Z');
    const connectorKey = garminDedupKey({
      userId: USER,
      metric: WearableMetricType.STEPS,
      startAt: at,
      value: 8421,
    });
    const rowKey = computeDedupKey({
      userId: USER,
      provider: WearableProvider.GARMIN,
      metric: WearableMetricType.STEPS,
      startAt: at,
      endAt: at,
    });
    expect(connectorKey).not.toBe(rowKey);
  });
});
