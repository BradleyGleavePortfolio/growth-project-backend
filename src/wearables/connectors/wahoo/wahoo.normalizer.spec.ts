import { WearableProvider } from '@prisma/client';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  normalizeWahoo,
  normalizeWahooWorkout,
  WahooRawPayload,
} from './wahoo.normalizer';
import { WahooWorkout } from './wahoo.types';

/**
 * PR-HK-2.h normalizer tests — real-value assertions against provider-shaped
 * payloads. Every §3.1 metric mapping (WORKOUT_DURATION_MIN /
 * WORKOUT_DISTANCE_M / HEART_RATE_BPM) has ≥1 test asserting the exact
 * NormalizedSample produced.
 */

const USER = 'user-1';
const CONN = 'conn-1';

/** A realistic Wahoo workout with a populated string-valued summary. */
function workout(overrides: Partial<WahooWorkout> = {}): WahooWorkout {
  return {
    id: 555,
    starts: '2026-05-30T13:00:00.000Z',
    minutes: 45,
    name: 'Morning Ride',
    workout_token: 'tok-abc',
    workout_type_id: 0,
    workout_summary: {
      distance_accum: '24909.71',
      heart_rate_avg: '124.23',
      duration_active_accum: '2700.0',
      duration_total_accum: '2700.0',
      calories_accum: '600.0',
      speed_avg: '9.22',
      time_zone: 'America/Denver',
    },
    ...overrides,
  };
}

function ctx(w: WahooWorkout): WahooRawPayload {
  return {
    userId: USER,
    connectionId: CONN,
    sourceTz: w.workout_summary?.time_zone ?? null,
    workout: w,
  };
}

describe('normalizeWahooWorkout — §3.1 metric mapping', () => {
  it('maps minutes → WORKOUT_DURATION_MIN with min unit and a span window', () => {
    const samples = normalizeWahooWorkout(ctx(workout()));
    const dur = samples.find((s) => s.metric === 'WORKOUT_DURATION_MIN');
    expect(dur).toBeTruthy();
    expect(dur!.value).toBe(45);
    expect(dur!.unit).toBe('min');
    expect(dur!.bucket).toBe('HEALTH_FITNESS');
    expect(dur!.provider).toBe(WearableProvider.WAHOO);
    expect(dur!.startAt.toISOString()).toBe('2026-05-30T13:00:00.000Z');
    // endAt = start + 45 min
    expect(dur!.endAt.toISOString()).toBe('2026-05-30T13:45:00.000Z');
    expect(dur!.sourceRecordId).toBe('555');
    expect(dur!.sourceTz).toBe('America/Denver');
  });

  it('parseFloats distance_accum string → WORKOUT_DISTANCE_M in meters', () => {
    const samples = normalizeWahooWorkout(ctx(workout()));
    const dist = samples.find((s) => s.metric === 'WORKOUT_DISTANCE_M');
    expect(dist).toBeTruthy();
    expect(dist!.value).toBeCloseTo(24909.71, 2);
    expect(dist!.unit).toBe('m');
    expect(dist!.bucket).toBe('HEALTH_FITNESS');
  });

  it('parseFloats heart_rate_avg string → HEART_RATE_BPM', () => {
    const samples = normalizeWahooWorkout(ctx(workout()));
    const hr = samples.find((s) => s.metric === 'HEART_RATE_BPM');
    expect(hr).toBeTruthy();
    expect(hr!.value).toBeCloseTo(124.23, 2);
    expect(hr!.unit).toBe('bpm');
    expect(hr!.bucket).toBe('HEALTH_FITNESS');
  });

  it('emits exactly the three mapped metrics for a full workout', () => {
    const metrics = normalizeWahooWorkout(ctx(workout()))
      .map((s) => s.metric)
      .sort();
    expect(metrics).toEqual([
      'HEART_RATE_BPM',
      'WORKOUT_DISTANCE_M',
      'WORKOUT_DURATION_MIN',
    ]);
  });

  it('skips absent summary fields (no fabricated zeros)', () => {
    const w = workout({ workout_summary: { time_zone: 'UTC' } });
    const samples = normalizeWahooWorkout(ctx(w));
    // Only duration survives (from minutes); distance + HR are absent.
    expect(samples.map((s) => s.metric)).toEqual(['WORKOUT_DURATION_MIN']);
  });

  it('drops a metric whose string is non-finite', () => {
    const w = workout({
      workout_summary: { distance_accum: 'not-a-number', heart_rate_avg: '' },
    });
    const samples = normalizeWahooWorkout(ctx(w));
    expect(samples.find((s) => s.metric === 'WORKOUT_DISTANCE_M')).toBeUndefined();
    expect(samples.find((s) => s.metric === 'HEART_RATE_BPM')).toBeUndefined();
  });

  it('uses an instantaneous window when minutes is absent', () => {
    const w = workout({ minutes: null, workout_summary: { heart_rate_avg: '90' } });
    const samples = normalizeWahooWorkout(ctx(w));
    const hr = samples.find((s) => s.metric === 'HEART_RATE_BPM')!;
    expect(hr.startAt.toISOString()).toBe('2026-05-30T13:00:00.000Z');
    expect(hr.endAt.toISOString()).toBe('2026-05-30T13:00:00.000Z');
    // No duration emitted when minutes absent.
    expect(samples.find((s) => s.metric === 'WORKOUT_DURATION_MIN')).toBeUndefined();
  });

  it('returns [] for an unparseable start instant', () => {
    expect(normalizeWahooWorkout(ctx(workout({ starts: 'garbage' })))).toEqual(
      [],
    );
  });
});

describe('normalizeWahoo — batch over RawRecord[]', () => {
  it('normalizes wrapped records and skips malformed payloads', () => {
    const good: RawRecord = {
      id: '555',
      provider: WearableProvider.WAHOO,
      payload: ctx(workout()),
    };
    const missingUser: RawRecord = {
      provider: WearableProvider.WAHOO,
      payload: { connectionId: CONN, workout: workout() },
    };
    const notObject: RawRecord = {
      provider: WearableProvider.WAHOO,
      payload: undefined,
    };
    const samples = normalizeWahoo([good, missingUser, notObject]);
    // Only the well-formed record produces samples (3 metrics).
    expect(samples).toHaveLength(3);
    expect(samples.every((s) => s.userId === USER)).toBe(true);
    expect(samples.every((s) => s.connectionId === CONN)).toBe(true);
  });

  it('returns [] for an empty batch', () => {
    expect(normalizeWahoo([])).toEqual([]);
  });
});
