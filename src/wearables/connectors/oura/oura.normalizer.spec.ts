import { WearableProvider } from '@prisma/client';
import { computeDedupKey } from '../../ingestion/dedup.util';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  normalizeOura,
  normalizeOuraRecord,
  OuraRawPayload,
} from './oura.normalizer';

/**
 * PR-HK-2.k normalizer contract tests — real-value assertions (no
 * `toBeDefined`). Each known Oura JSON maps to an EXACT NormalizedSample list:
 * metric, value (unit-converted), unit, bucket, start/end window, and the
 * deterministic dedup_key the ingestion lane will compute for that sample
 * (verified via the shared `computeDedupKey` util on the produced fields).
 */

const USER = '11111111-1111-1111-1111-111111111111';
const CONN = '22222222-2222-2222-2222-222222222222';

function wrap(
  collection: OuraRawPayload['collection'],
  record: unknown,
): RawRecord {
  return {
    id: (record as { id?: string })?.id,
    provider: WearableProvider.OURA,
    payload: {
      collection,
      userId: USER,
      connectionId: CONN,
      sourceTz: null,
      record,
    } satisfies OuraRawPayload,
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
    provider: WearableProvider.OURA,
    metric: sample.metric,
    startAt: sample.startAt,
    endAt: sample.endAt,
  });
}

describe('oura.normalizer — daily_sleep', () => {
  const DAILY_SLEEP = {
    id: 'sleep_2026-05-31',
    day: '2026-05-31',
    // Oura emits durations in SECONDS.
    total_sleep_duration: 27000, // 450 min
    rem_sleep_duration: 5400, // 90 min
    deep_sleep_duration: 4800, // 80 min
    light_sleep_duration: 16800, // 280 min
    awake_time: 1200, // 20 min
    efficiency: 92, // percent
    average_hrv: 65, // ms
  };

  it('maps every sleep stage + efficiency + HRV with correct units/buckets', () => {
    const out = normalizeOuraRecord(
      wrap('daily_sleep', DAILY_SLEEP).payload as OuraRawPayload,
    );

    expect(out).toHaveLength(7);

    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));

    expect(byMetric.SLEEP_TOTAL_MIN).toMatchObject({
      value: 450,
      unit: 'min',
      bucket: 'SLEEP_RECOVERY',
      provider: 'OURA',
      userId: USER,
      connectionId: CONN,
    });
    expect(byMetric.SLEEP_REM_MIN.value).toBe(90);
    expect(byMetric.SLEEP_DEEP_MIN.value).toBe(80);
    expect(byMetric.SLEEP_LIGHT_MIN.value).toBe(280);
    expect(byMetric.SLEEP_AWAKE_MIN.value).toBe(20);
    expect(byMetric.SLEEP_EFFICIENCY_PCT).toMatchObject({
      value: 92,
      unit: '%',
    });
    expect(byMetric.HRV_MS).toMatchObject({ value: 65, unit: 'ms' });

    // Window anchored to the UTC calendar day.
    expect(byMetric.SLEEP_TOTAL_MIN.startAt.toISOString()).toBe(
      '2026-05-31T00:00:00.000Z',
    );
    expect(byMetric.SLEEP_TOTAL_MIN.endAt.toISOString()).toBe(
      '2026-05-31T23:59:59.999Z',
    );
  });

  it('produces the anchored dedup_key for SLEEP_TOTAL_MIN and HRV_MS', () => {
    const out = normalizeOuraRecord(
      wrap('daily_sleep', DAILY_SLEEP).payload as OuraRawPayload,
    );
    const total = out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')!;
    const hrv = out.find((s) => s.metric === 'HRV_MS')!;

    expect(dedup(total)).toBe(
      '3e618059b58827742ba930be0f8b024b56b8c029b5600e854021a84f4303f4a4',
    );
    expect(dedup(hrv)).toBe(
      '32b4328a4d1846dcfaf9486c27d3ca9ba6bdca7af62c3216caebb0bf86d14eeb',
    );
  });

  it('prefers an explicit bedtime window over the calendar day when present', () => {
    const out = normalizeOuraRecord(
      wrap('daily_sleep', {
        ...DAILY_SLEEP,
        bedtime_start: '2026-05-30T22:15:00.000Z',
        bedtime_end: '2026-05-31T06:45:00.000Z',
      }).payload as OuraRawPayload,
    );
    const total = out.find((s) => s.metric === 'SLEEP_TOTAL_MIN')!;
    expect(total.startAt.toISOString()).toBe('2026-05-30T22:15:00.000Z');
    expect(total.endAt.toISOString()).toBe('2026-05-31T06:45:00.000Z');
  });

  it('drops null/absent stage fields (no speculative zero-rows)', () => {
    const out = normalizeOuraRecord(
      wrap('daily_sleep', {
        id: 's1',
        day: '2026-05-31',
        total_sleep_duration: 27000,
        // everything else absent
      }).payload as OuraRawPayload,
    );
    const metrics = out.map((s) => s.metric).sort();
    expect(metrics).toEqual(['SLEEP_TOTAL_MIN']);
  });
});

describe('oura.normalizer — daily_readiness', () => {
  const READINESS = {
    id: 'readiness_2026-05-30',
    day: '2026-05-30',
    score: 78,
    temperature_deviation: -0.2,
  };

  it('maps score → READINESS_SCORE and temperature_deviation → BODY_TEMP_DEVIATION_C', () => {
    const out = normalizeOuraRecord(
      wrap('daily_readiness', READINESS).payload as OuraRawPayload,
    );
    expect(out).toHaveLength(2);
    const byMetric = Object.fromEntries(out.map((s) => [s.metric, s]));
    expect(byMetric.READINESS_SCORE).toMatchObject({
      value: 78,
      unit: 'score',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(byMetric.BODY_TEMP_DEVIATION_C).toMatchObject({
      value: -0.2,
      unit: '°C',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(dedup(byMetric.READINESS_SCORE)).toBe(
      '0b0f15c3df9c90f5291e5c66bc741fa8cd8baf2831bcd1ed387e4033c549a085',
    );
    expect(dedup(byMetric.BODY_TEMP_DEVIATION_C)).toBe(
      '03bdb3e1c3a4096dfe6d1b06b7d639cabdd860bf6be523948ae0e2baddbd29f0',
    );
  });
});

describe('oura.normalizer — daily_activity', () => {
  it('maps steps → STEPS (H&F) with the anchored dedup_key', () => {
    const out = normalizeOuraRecord(
      wrap('daily_activity', {
        id: 'activity_2026-05-29',
        day: '2026-05-29',
        steps: 8421,
      }).payload as OuraRawPayload,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'STEPS',
      value: 8421,
      unit: 'steps',
      bucket: 'HEALTH_FITNESS',
    });
    expect(dedup(out[0])).toBe(
      '038cf054a56f4a5f95c62e189b82384ffe709e7d808311192d850f29b49f8451',
    );
  });
});

describe('oura.normalizer — heartrate', () => {
  it('maps bpm → HEART_RATE_BPM (instantaneous, start == end)', () => {
    const out = normalizeOuraRecord(
      wrap('heartrate', {
        timestamp: '2026-05-31T07:30:00.000Z',
        bpm: 58,
        source: 'awake',
      }).payload as OuraRawPayload,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'HEART_RATE_BPM',
      value: 58,
      unit: 'bpm',
      bucket: 'HEALTH_FITNESS',
    });
    expect(out[0].startAt.toISOString()).toBe('2026-05-31T07:30:00.000Z');
    expect(out[0].endAt.toISOString()).toBe('2026-05-31T07:30:00.000Z');
    expect(dedup(out[0])).toBe(
      '119d81fa07bd2626c9b2d06606094d5dd025fd03704ba836738986e5629dcedb',
    );
  });

  it('skips a heartrate sample with an unparseable timestamp', () => {
    const out = normalizeOuraRecord(
      wrap('heartrate', { timestamp: 'not-a-date', bpm: 60 })
        .payload as OuraRawPayload,
    );
    expect(out).toEqual([]);
  });
});

describe('oura.normalizer — daily_spo2', () => {
  it('maps nested spo2_percentage.average → SPO2_PCT (S&R)', () => {
    const out = normalizeOuraRecord(
      wrap('daily_spo2', {
        id: 'spo2_2026-05-28',
        day: '2026-05-28',
        spo2_percentage: { average: 97 },
      }).payload as OuraRawPayload,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: 'SPO2_PCT',
      value: 97,
      unit: '%',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(dedup(out[0])).toBe(
      'e2ac61503bd511153715776b47b91dfd090450c351402b4e84654b4e52f031db',
    );
  });

  it('tolerates a flat numeric spo2_percentage', () => {
    const out = normalizeOuraRecord(
      wrap('daily_spo2', {
        id: 'spo2_x',
        day: '2026-05-28',
        spo2_percentage: 96,
      }).payload as OuraRawPayload,
    );
    expect(out[0].value).toBe(96);
  });
});

describe('oura.normalizer — unmapped collections + batch', () => {
  it('produces no samples for sleep/workout/session long-form collections', () => {
    expect(
      normalizeOuraRecord(
        wrap('workout', { id: 'w1', day: '2026-05-31' })
          .payload as OuraRawPayload,
      ),
    ).toEqual([]);
    expect(
      normalizeOuraRecord(
        wrap('session', { id: 's1', day: '2026-05-31' })
          .payload as OuraRawPayload,
      ),
    ).toEqual([]);
  });

  it('normalizeOura flattens a mixed batch and skips non-Oura payloads', () => {
    const batch: RawRecord[] = [
      wrap('daily_activity', { id: 'a', day: '2026-05-29', steps: 100 }),
      { provider: WearableProvider.OURA, payload: undefined as unknown },
      wrap('heartrate', { timestamp: '2026-05-31T07:30:00.000Z', bpm: 58 }),
    ];
    const out = normalizeOura(batch);
    expect(out.map((s) => s.metric).sort()).toEqual([
      'HEART_RATE_BPM',
      'STEPS',
    ]);
  });
});
