import { WearableProvider } from '@prisma/client';
import { computeDedupKey } from '../../ingestion/dedup.util';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  normalizePolar,
  normalizePolarRecord,
  parseIso8601DurationToMinutes,
  PolarRawPayload,
} from './polar.normalizer';

/**
 * PR-HK-2.g normalizer contract tests — real-value assertions (no
 * `toBeDefined`). Each known Polar JSON maps to an EXACT NormalizedSample
 * list: metric, value (unit-converted), unit, bucket, start/end window, and
 * the deterministic dedup_key the ingestion lane will compute for that sample
 * (verified via the shared `computeDedupKey` util on the produced fields).
 */

const USER = '11111111-1111-1111-1111-111111111111';
const CONN = '22222222-2222-2222-2222-222222222222';

function wrap(
  resource: PolarRawPayload['resource'],
  record: unknown,
): RawRecord {
  return {
    id: String((record as { id?: string })?.id ?? ''),
    provider: WearableProvider.POLAR,
    payload: {
      resource,
      userId: USER,
      connectionId: CONN,
      sourceTz: null,
      record,
    } satisfies PolarRawPayload,
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
    provider: WearableProvider.POLAR,
    metric: sample.metric,
    startAt: sample.startAt,
    endAt: sample.endAt,
  });
}

describe('parseIso8601DurationToMinutes', () => {
  it('parses hours+minutes+seconds rounding to whole minutes', () => {
    // PT2H44M45S = 9885s = 164.75 min → 165 (rounded).
    expect(parseIso8601DurationToMinutes('PT2H44M45S')).toBe(165);
  });

  it('parses minutes-only and seconds-only durations', () => {
    expect(parseIso8601DurationToMinutes('PT30M')).toBe(30);
    expect(parseIso8601DurationToMinutes('PT90S')).toBe(2); // 1.5 → 2
  });

  it('returns null for absent or unparseable input', () => {
    expect(parseIso8601DurationToMinutes(undefined)).toBeNull();
    expect(parseIso8601DurationToMinutes('')).toBeNull();
    expect(parseIso8601DurationToMinutes('garbage')).toBeNull();
    expect(parseIso8601DurationToMinutes('PT')).toBeNull();
  });
});

describe('polar.normalizer — exercises', () => {
  const EXERCISE = {
    id: 1937529874,
    'start-time': '2026-05-31T06:00:00',
    'start-time-utc-offset': 180, // +03:00
    duration: 'PT1H30M', // 90 min
    distance: 1600.2, // metres
    'heart-rate': { average: 129, maximum: 147 },
    calories: 530,
    sport: 'RUNNING',
  };

  it('maps duration, distance and average HR with correct units/buckets', () => {
    const out = normalizePolarRecord(
      wrap('exercises', EXERCISE).payload as PolarRawPayload,
    );
    expect(out).toHaveLength(3);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    expect(byMetric.WORKOUT_DURATION_MIN).toMatchObject({
      value: 90,
      unit: 'min',
      bucket: 'HEALTH_FITNESS',
      provider: 'POLAR',
      userId: USER,
      connectionId: CONN,
    });
    expect(byMetric.WORKOUT_DISTANCE_M).toMatchObject({
      value: 1600.2,
      unit: 'm',
      bucket: 'HEALTH_FITNESS',
    });
    expect(byMetric.HEART_RATE_BPM).toMatchObject({
      value: 129,
      unit: 'bpm',
      bucket: 'HEALTH_FITNESS',
    });
  });

  it('anchors the window to the offset-aware start + duration', () => {
    const out = normalizePolarRecord(
      wrap('exercises', EXERCISE).payload as PolarRawPayload,
    );
    const dur = out.find((s) => s.metric === 'WORKOUT_DURATION_MIN')!;
    // 06:00 local at +03:00 == 03:00:00Z; +90 min == 04:30:00Z.
    expect(dur.startAt.toISOString()).toBe('2026-05-31T03:00:00.000Z');
    expect(dur.endAt.toISOString()).toBe('2026-05-31T04:30:00.000Z');
  });

  it('drops distance/HR when absent but keeps duration', () => {
    const out = normalizePolarRecord(
      wrap('exercises', {
        id: 7,
        'start-time': '2026-05-31T06:00:00',
        'start-time-utc-offset': 0,
        duration: 'PT45M',
      }).payload as PolarRawPayload,
    );
    expect(out.map((s) => s.metric)).toEqual(['WORKOUT_DURATION_MIN']);
    expect(out[0].value).toBe(45);
  });

  it('returns no samples when start-time is missing (unanchorable window)', () => {
    const out = normalizePolarRecord(
      wrap('exercises', { id: 1, duration: 'PT10M' })
        .payload as PolarRawPayload,
    );
    expect(out).toEqual([]);
  });

  it('produces the expected dedup_key for WORKOUT_DURATION_MIN', () => {
    const out = normalizePolarRecord(
      wrap('exercises', EXERCISE).payload as PolarRawPayload,
    );
    const dur = out.find((s) => s.metric === 'WORKOUT_DURATION_MIN')!;
    expect(dedup(dur)).toBe(
      computeDedupKey({
        userId: USER,
        provider: WearableProvider.POLAR,
        metric: 'WORKOUT_DURATION_MIN',
        startAt: new Date('2026-05-31T03:00:00.000Z'),
        endAt: new Date('2026-05-31T04:30:00.000Z'),
      }),
    );
  });
});

describe('polar.normalizer — sleep', () => {
  const SLEEP = {
    date: '2026-05-31',
    sleep_start_time: '2026-05-31T00:39:07+03:00',
    sleep_end_time: '2026-05-31T09:19:37+03:00',
    light_sleep: 16800, // 280 min
    deep_sleep: 4800, // 80 min
    rem_sleep: 5400, // 90 min
    total_interruption_duration: 1200, // 20 min awake
    sleep_score: 80,
  };

  it('maps every §3.1-bound stage metric + derived total (no efficiency)', () => {
    const out = normalizePolarRecord(
      wrap('sleep', SLEEP).payload as PolarRawPayload,
    );
    // §3.1 Polar sleep binding = exactly 5 minute-based metrics; efficiency is
    // intentionally NOT emitted (it is outside the approved binding).
    expect(out).toHaveLength(5);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    // total asleep = light+deep+rem = 27000s = 450 min.
    expect(byMetric.SLEEP_TOTAL_MIN).toMatchObject({ value: 450, unit: 'min' });
    expect(byMetric.SLEEP_REM_MIN.value).toBe(90);
    expect(byMetric.SLEEP_DEEP_MIN.value).toBe(80);
    expect(byMetric.SLEEP_LIGHT_MIN.value).toBe(280);
    expect(byMetric.SLEEP_AWAKE_MIN.value).toBe(20);
    // The unapproved derived metric MUST NOT be present.
    expect(byMetric.SLEEP_EFFICIENCY_PCT).toBeUndefined();
    expect(out.some((s) => s.unit === '%')).toBe(false);
  });

  it('uses the explicit sleep_start/end window', () => {
    const out = normalizePolarRecord(
      wrap('sleep', SLEEP).payload as PolarRawPayload,
    );
    const total = out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')!;
    expect(total.startAt.toISOString()).toBe('2026-05-30T21:39:07.000Z');
    expect(total.endAt.toISOString()).toBe('2026-05-31T06:19:37.000Z');
  });

  it('falls back to the UTC calendar day when timestamps are absent', () => {
    const out = normalizePolarRecord(
      wrap('sleep', {
        date: '2026-05-31',
        light_sleep: 600,
        deep_sleep: 0,
        rem_sleep: 0,
        total_interruption_duration: 0,
      }).payload as PolarRawPayload,
    );
    const total = out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')!;
    expect(total.startAt.toISOString()).toBe('2026-05-31T00:00:00.000Z');
    expect(total.endAt.toISOString()).toBe('2026-05-31T23:59:59.999Z');
    // No efficiency metric is emitted regardless of interruption data.
    expect(out.find((s) => s.metric === 'SLEEP_EFFICIENCY_PCT')).toBeUndefined();
  });

  it('emits nothing when no stage data is present', () => {
    const out = normalizePolarRecord(
      wrap('sleep', { date: '2026-05-31' }).payload as PolarRawPayload,
    );
    expect(out.find((s) => s.metric === 'SLEEP_EFFICIENCY_PCT')).toBeUndefined();
    expect(out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')).toBeUndefined();
  });
});

describe('polar.normalizer — nightly-recharge', () => {
  const RECHARGE = {
    date: '2026-05-31',
    heart_rate_avg: 70,
    beat_to_beat_avg: 816,
    heart_rate_variability_avg: 28, // ms
    breathing_rate_avg: 14.1,
    nightly_recharge_status: 3, // → RECOVERY_SCORE
    ans_charge: 0,
  };

  it('maps recharge status → RECOVERY_SCORE and HRV avg → HRV_MS', () => {
    const out = normalizePolarRecord(
      wrap('nightly-recharge', RECHARGE).payload as PolarRawPayload,
    );
    expect(out).toHaveLength(2);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    expect(byMetric.RECOVERY_SCORE).toMatchObject({
      value: 3,
      unit: 'score',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(byMetric.HRV_MS).toMatchObject({
      value: 28,
      unit: 'ms',
      bucket: 'SLEEP_RECOVERY',
    });
    // Window anchored to the UTC calendar day.
    expect(byMetric.RECOVERY_SCORE.startAt.toISOString()).toBe(
      '2026-05-31T00:00:00.000Z',
    );
    expect(byMetric.RECOVERY_SCORE.endAt.toISOString()).toBe(
      '2026-05-31T23:59:59.999Z',
    );
  });

  it('produces stable dedup_keys for both recharge metrics', () => {
    const out = normalizePolarRecord(
      wrap('nightly-recharge', RECHARGE).payload as PolarRawPayload,
    );
    const score = out.find((s) => s.metric === 'RECOVERY_SCORE')!;
    const hrv = out.find((s) => s.metric === 'HRV_MS')!;
    expect(dedup(score)).toBe(
      computeDedupKey({
        userId: USER,
        provider: WearableProvider.POLAR,
        metric: 'RECOVERY_SCORE',
        startAt: new Date('2026-05-31T00:00:00.000Z'),
        endAt: new Date('2026-05-31T23:59:59.999Z'),
      }),
    );
    expect(dedup(hrv)).not.toBe(dedup(score));
  });

  it('drops metrics that are null', () => {
    const out = normalizePolarRecord(
      wrap('nightly-recharge', {
        date: '2026-05-31',
        heart_rate_variability_avg: 31,
      }).payload as PolarRawPayload,
    );
    expect(out.map((s) => s.metric)).toEqual(['HRV_MS']);
  });
});

describe('polar.normalizer — batch + defenses', () => {
  it('normalizes a mixed batch and skips non-Polar payloads', () => {
    const batch: RawRecord[] = [
      wrap('nightly-recharge', {
        date: '2026-05-31',
        nightly_recharge_status: 4,
        heart_rate_variability_avg: 40,
      }),
      { provider: WearableProvider.POLAR, payload: { not: 'a polar payload' } },
      { provider: WearableProvider.POLAR, payload: undefined },
    ];
    const out = normalizePolar(batch);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.provider === 'POLAR')).toBe(true);
  });

  it('returns [] for an unknown resource tag', () => {
    const out = normalizePolarRecord({
      resource: 'steps' as PolarRawPayload['resource'],
      userId: USER,
      connectionId: CONN,
      sourceTz: null,
      record: {},
    });
    expect(out).toEqual([]);
  });
});
