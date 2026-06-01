import { WearableProvider } from '@prisma/client';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  FitbitRawPayload,
  normalizeFitbit,
  normalizeFitbitRecord,
} from './fitbit.normalizer';

/**
 * PR-HK-2.e normalizer tests — one real-payload assertion per §3.1 metric.
 *
 * Each test feeds a Fitbit-shaped provider record (verbatim envelope keys and
 * string-typed time-series values, as Fitbit serialises them) and asserts the
 * EXACT canonical {@link NormalizedSample} fields: metric, bucket, value, unit,
 * and the UTC day window. No bare `toBeDefined` — every value is checked.
 */

const USER = 'user-1';
const CONN = 'conn-1';

function ctx<T>(collection: FitbitRawPayload['collection'], record: T): FitbitRawPayload<T> {
  return { collection, userId: USER, connectionId: CONN, sourceTz: 'America/Los_Angeles', record };
}

const DAY = '2026-05-30';
const DAY_START = new Date('2026-05-30T00:00:00.000Z');
const DAY_END = new Date('2026-05-30T23:59:59.999Z');

describe('normalizeFitbitRecord — activities/steps → STEPS (H&F)', () => {
  it('maps a daily step total (string value coerced to number) to STEPS', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/steps', {
        'activities-steps': [{ dateTime: DAY, value: '8421' }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      userId: USER,
      connectionId: CONN,
      provider: WearableProvider.FITBIT,
      metric: 'STEPS',
      bucket: 'HEALTH_FITNESS',
      value: 8421,
      unit: 'steps',
      startAt: DAY_START,
      endAt: DAY_END,
      sourceTz: 'America/Los_Angeles',
      sourceRecordId: null,
    });
  });

  it('drops a non-numeric step value rather than emit NaN (#42)', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/steps', {
        'activities-steps': [{ dateTime: DAY, value: 'n/a' }],
      }),
    );
    expect(out).toHaveLength(0);
  });
});

describe('normalizeFitbitRecord — activities/heart → RESTING_HEART_RATE_BPM (H&F)', () => {
  it('maps the day restingHeartRate to RESTING_HEART_RATE_BPM in bpm', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/heart', {
        'activities-heart': [
          { dateTime: DAY, value: { restingHeartRate: 54, heartRateZones: [] } },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'RESTING_HEART_RATE_BPM',
      bucket: 'HEALTH_FITNESS',
      value: 54,
      unit: 'bpm',
      startAt: DAY_START,
      endAt: DAY_END,
    });
  });

  it('drops a day with no restingHeartRate (null) rather than emit a zero', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/heart', {
        'activities-heart': [{ dateTime: DAY, value: { restingHeartRate: null } }],
      }),
    );
    expect(out).toHaveLength(0);
  });
});

describe('normalizeFitbitRecord — activities/heart → HEART_RATE_BPM (H&F)', () => {
  it('emits the minutes-weighted day-average bpm from heartRateZones alongside resting HR', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/heart', {
        'activities-heart': [
          {
            dateTime: DAY,
            value: {
              restingHeartRate: 58,
              heartRateZones: [
                // Out of Range: midpoint (30+91)/2 = 60.5, 1200 min
                { name: 'Out of Range', min: 30, max: 91, minutes: 1200 },
                // Fat Burn: midpoint (91+127)/2 = 109, 180 min
                { name: 'Fat Burn', min: 91, max: 127, minutes: 180 },
                // Cardio: midpoint (127+153)/2 = 140, 60 min
                { name: 'Cardio', min: 127, max: 153, minutes: 60 },
                // Peak: zero minutes → excluded from the weighting
                { name: 'Peak', min: 153, max: 220, minutes: 0 },
              ],
            },
          },
        ],
      }),
    );
    // weightedSum = 60.5*1200 + 109*180 + 140*60 = 72600 + 19620 + 8400 = 100620
    // totalMinutes = 1440 → 100620/1440 = 69.875 → round → 70
    const hr = out.find((s) => s.metric === 'HEART_RATE_BPM');
    const resting = out.find((s) => s.metric === 'RESTING_HEART_RATE_BPM');
    expect(resting).toMatchObject({ value: 58, unit: 'bpm' });
    expect(hr).toEqual({
      userId: USER,
      connectionId: CONN,
      provider: WearableProvider.FITBIT,
      metric: 'HEART_RATE_BPM',
      bucket: 'HEALTH_FITNESS',
      value: 70,
      unit: 'bpm',
      startAt: DAY_START,
      endAt: DAY_END,
      sourceTz: 'America/Los_Angeles',
      sourceRecordId: null,
    });
  });

  it('drops HEART_RATE_BPM when no zone carries minutes rather than emit a zero (#42)', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/heart', {
        'activities-heart': [
          {
            dateTime: DAY,
            value: {
              restingHeartRate: 60,
              heartRateZones: [
                { name: 'Out of Range', min: 30, max: 91, minutes: 0 },
                { name: 'Fat Burn', min: 91, max: 127, minutes: 0 },
              ],
            },
          },
        ],
      }),
    );
    expect(out.some((s) => s.metric === 'HEART_RATE_BPM')).toBe(false);
    // The resting metric is still emitted independently.
    expect(out.some((s) => s.metric === 'RESTING_HEART_RATE_BPM')).toBe(true);
  });

  it('emits HEART_RATE_BPM even when restingHeartRate is absent (independent metrics)', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/heart', {
        'activities-heart': [
          {
            dateTime: DAY,
            value: {
              restingHeartRate: null,
              heartRateZones: [
                { name: 'Out of Range', min: 60, max: 100, minutes: 100 },
              ],
            },
          },
        ],
      }),
    );
    // midpoint (60+100)/2 = 80, single zone → 80
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ metric: 'HEART_RATE_BPM', value: 80 });
  });
});

describe('normalizeFitbitRecord — sleep → SLEEP_* (S&R)', () => {
  const SLEEP_LOG = {
    logId: 987654321,
    dateOfSleep: DAY,
    startTime: '2026-05-29T23:10:00.000',
    endTime: '2026-05-30T07:05:00.000',
    duration: 28_500_000,
    minutesAsleep: 430,
    minutesAwake: 25,
    efficiency: 93,
    type: 'stages',
    isMainSleep: true,
    levels: {
      summary: {
        deep: { minutes: 80, count: 4 },
        light: { minutes: 240, count: 20 },
        rem: { minutes: 110, count: 8 },
        wake: { minutes: 25, count: 12 },
      },
    },
  };

  it('maps total/rem/deep/light/awake minutes + efficiency with the explicit start/end window', () => {
    const out = normalizeFitbitRecord(ctx('sleep', { sleep: [SLEEP_LOG] }));
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    expect(out).toHaveLength(6);
    const start = new Date('2026-05-29T23:10:00.000');
    const end = new Date('2026-05-30T07:05:00.000');

    expect(byMetric['SLEEP_TOTAL_MIN']).toMatchObject({
      bucket: 'SLEEP_RECOVERY', value: 430, unit: 'min', startAt: start, endAt: end, sourceRecordId: '987654321',
    });
    expect(byMetric['SLEEP_REM_MIN']).toMatchObject({ value: 110, unit: 'min' });
    expect(byMetric['SLEEP_DEEP_MIN']).toMatchObject({ value: 80, unit: 'min' });
    expect(byMetric['SLEEP_LIGHT_MIN']).toMatchObject({ value: 240, unit: 'min' });
    expect(byMetric['SLEEP_AWAKE_MIN']).toMatchObject({ value: 25, unit: 'min' });
    expect(byMetric['SLEEP_EFFICIENCY_PCT']).toMatchObject({ value: 93, unit: '%' });
  });

  it('drops absent stage metrics for a classic (non-stages) log (#42)', () => {
    const out = normalizeFitbitRecord(
      ctx('sleep', {
        sleep: [
          {
            logId: 1,
            dateOfSleep: DAY,
            startTime: '2026-05-29T23:00:00.000',
            endTime: '2026-05-30T06:00:00.000',
            minutesAsleep: 400,
            minutesAwake: 20,
            efficiency: 90,
            type: 'classic',
            levels: { summary: { asleep: { minutes: 400 }, awake: { minutes: 20 }, restless: { minutes: 10 } } },
          },
        ],
      }),
    );
    const metrics = out.map((s) => s.metric).sort();
    // No deep/rem/light stage metrics for a classic log.
    expect(metrics).toEqual(
      ['SLEEP_AWAKE_MIN', 'SLEEP_EFFICIENCY_PCT', 'SLEEP_TOTAL_MIN'].sort(),
    );
  });
});

describe('normalizeFitbitRecord — body/weight → BODY_WEIGHT_KG (H&F)', () => {
  it('maps a weight log entry to BODY_WEIGHT_KG anchored at the log instant', () => {
    const out = normalizeFitbitRecord(
      ctx('body/weight', {
        weight: [
          { logId: 555, date: DAY, time: '07:30:00', weight: 72.4, bmi: 22.1, source: 'Aria' },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    const instant = new Date('2026-05-30T07:30:00Z');
    expect(out[0]).toMatchObject({
      metric: 'BODY_WEIGHT_KG',
      bucket: 'HEALTH_FITNESS',
      value: 72.4,
      unit: 'kg',
      startAt: instant,
      endAt: instant,
      sourceRecordId: '555',
    });
  });
});

describe('normalizeFitbitRecord — br → RESPIRATORY_RATE_BRPM (S&R)', () => {
  it('maps the daily breathingRate to RESPIRATORY_RATE_BRPM in brpm', () => {
    const out = normalizeFitbitRecord(
      ctx('br', { br: [{ dateTime: DAY, value: { breathingRate: 15.4 } }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'RESPIRATORY_RATE_BRPM',
      bucket: 'SLEEP_RECOVERY',
      value: 15.4,
      unit: 'brpm',
      startAt: DAY_START,
      endAt: DAY_END,
    });
  });
});

describe('normalizeFitbitRecord — spo2 → SPO2_PCT (S&R)', () => {
  it('maps the daily SpO2 average to SPO2_PCT in percent (array form)', () => {
    const out = normalizeFitbitRecord(
      ctx('spo2', [{ dateTime: DAY, value: { avg: 96.5, min: 92, max: 99 } }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'SPO2_PCT',
      bucket: 'SLEEP_RECOVERY',
      value: 96.5,
      unit: '%',
      startAt: DAY_START,
      endAt: DAY_END,
    });
  });

  it('maps the single-object SpO2 form too', () => {
    const out = normalizeFitbitRecord(
      ctx('spo2', { dateTime: DAY, value: { avg: 97 } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ metric: 'SPO2_PCT', value: 97 });
  });
});

describe('normalizeFitbitRecord — defenses', () => {
  it('returns [] for an unmapped collection', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/steps' as never, { foo: 'bar' } as never),
    );
    expect(out).toEqual([]);
  });

  it('skips an entry with an unparseable dateTime', () => {
    const out = normalizeFitbitRecord(
      ctx('activities/steps', {
        'activities-steps': [{ dateTime: 'not-a-date', value: '100' }],
      }),
    );
    expect(out).toEqual([]);
  });
});

describe('normalizeFitbit — batch entry point', () => {
  it('normalizes a batch of wrapped RawRecords and skips non-Fitbit payloads', () => {
    const records: RawRecord[] = [
      {
        provider: WearableProvider.FITBIT,
        payload: ctx('activities/steps', {
          'activities-steps': [{ dateTime: DAY, value: '500' }],
        }),
      },
      // Defensive: a record whose payload is not a Fitbit payload is skipped.
      { provider: WearableProvider.FITBIT, payload: { not: 'fitbit' } },
    ];
    const out = normalizeFitbit(records);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ metric: 'STEPS', value: 500 });
  });
});
