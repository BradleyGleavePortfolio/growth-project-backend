import { WearableMetricType, WearableProvider } from '@prisma/client';
import { RawRecord } from '../../normalization/normalizer.types';
import { computeDedupKey } from '../../ingestion/dedup.util';
import { normalizeWhoop, whoopDedupKey } from './whoop.normalizer';
import { WhoopRawPayload } from './whoop.types';

const USER = 'user-uuid-1';
const CONN = 'conn-uuid-1';

function raw(payload: WhoopRawPayload, id?: string): RawRecord {
  return {
    id: id ?? (payload.data as { id?: string }).id,
    provider: WearableProvider.WHOOP,
    payload: { ...payload, userId: USER, connectionId: CONN },
  };
}

describe('normalizeWhoop', () => {
  it('maps a SCORED recovery to RECOVERY_SCORE, HRV_MS, RESTING_HEART_RATE_BPM with exact values', () => {
    const created = '2026-05-20T08:00:00.000Z';
    const samples = normalizeWhoop([
      raw({
        kind: 'recovery',
        data: {
          id: 'aaaaaaaa-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: created,
          updated_at: created,
          score_state: 'SCORED',
          score: {
            recovery_score: 66,
            resting_heart_rate: 54,
            hrv_rmssd_milli: 48.5,
          },
        },
      }),
    ]);

    expect(samples).toHaveLength(3);
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s]));

    expect(byMetric[WearableMetricType.RECOVERY_SCORE]).toMatchObject({
      value: 66,
      unit: 'score',
      bucket: 'SLEEP_RECOVERY',
      provider: 'WHOOP',
      userId: USER,
      connectionId: CONN,
      sourceTz: 'UTC',
    });
    expect(byMetric[WearableMetricType.HRV_MS]).toMatchObject({
      value: 48.5,
      unit: 'ms',
    });
    expect(byMetric[WearableMetricType.RESTING_HEART_RATE_BPM]).toMatchObject({
      value: 54,
      unit: 'bpm',
    });
    // Point-in-time: start == end == created_at.
    expect(byMetric[WearableMetricType.RECOVERY_SCORE].startAt.toISOString()).toBe(
      created,
    );
    expect(byMetric[WearableMetricType.RECOVERY_SCORE].endAt.toISOString()).toBe(
      created,
    );
  });

  it('maps a SCORED cycle to STRAIN_SCORE over its window', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'cycle',
        data: {
          id: 'bbbbbbbb-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T00:00:00.000Z',
          updated_at: '2026-05-20T00:00:00.000Z',
          start: '2026-05-20T04:00:00.000Z',
          end: '2026-05-21T04:00:00.000Z',
          score_state: 'SCORED',
          score: { strain: 14.2 },
        },
      }),
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      metric: WearableMetricType.STRAIN_SCORE,
      value: 14.2,
      unit: 'score',
      bucket: 'SLEEP_RECOVERY',
    });
    expect(samples[0].startAt.toISOString()).toBe('2026-05-20T04:00:00.000Z');
    expect(samples[0].endAt.toISOString()).toBe('2026-05-21T04:00:00.000Z');
  });

  it('maps a SCORED sleep, converting milliseconds → minutes, and passing efficiency through', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'sleep',
        data: {
          id: 'cccccccc-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T06:00:00.000Z',
          updated_at: '2026-05-20T06:00:00.000Z',
          start: '2026-05-19T23:00:00.000Z',
          end: '2026-05-20T06:30:00.000Z',
          nap: false,
          score_state: 'SCORED',
          score: {
            stage_summary: {
              // 7h in bed = 25,200,000 ms = 420 min
              total_in_bed_time_milli: 25_200_000,
              // 30 min awake = 1,800,000 ms = 30 min
              total_awake_time_milli: 1_800_000,
              // 90 min light = 5,400,000 ms = 90 min
              total_light_sleep_time_milli: 5_400_000,
              // 120 min deep = 7,200,000 ms = 120 min
              total_slow_wave_sleep_time_milli: 7_200_000,
              // 105 min REM = 6,300,000 ms = 105 min
              total_rem_sleep_time_milli: 6_300_000,
            },
            sleep_efficiency_percentage: 91.5,
          },
        },
      }),
    ]);

    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s.value]));
    expect(byMetric[WearableMetricType.SLEEP_TOTAL_MIN]).toBe(420);
    expect(byMetric[WearableMetricType.SLEEP_AWAKE_MIN]).toBe(30);
    expect(byMetric[WearableMetricType.SLEEP_LIGHT_MIN]).toBe(90);
    expect(byMetric[WearableMetricType.SLEEP_DEEP_MIN]).toBe(120);
    expect(byMetric[WearableMetricType.SLEEP_REM_MIN]).toBe(105);
    expect(byMetric[WearableMetricType.SLEEP_EFFICIENCY_PCT]).toBe(91.5);

    const units = Object.fromEntries(samples.map((s) => [s.metric, s.unit]));
    expect(units[WearableMetricType.SLEEP_TOTAL_MIN]).toBe('min');
    expect(units[WearableMetricType.SLEEP_EFFICIENCY_PCT]).toBe('%');
  });

  it('maps a workout to WORKOUT_DURATION_MIN (from window) + WORKOUT_DISTANCE_M (H&F)', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'workout',
        data: {
          id: 'dddddddd-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T12:00:00.000Z',
          updated_at: '2026-05-20T12:00:00.000Z',
          start: '2026-05-20T12:00:00.000Z',
          // 45 minutes later
          end: '2026-05-20T12:45:00.000Z',
          score_state: 'SCORED',
          score: { distance_meter: 8000 },
        },
      }),
    ]);

    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s]));
    expect(byMetric[WearableMetricType.WORKOUT_DURATION_MIN]).toMatchObject({
      value: 45,
      unit: 'min',
      bucket: 'HEALTH_FITNESS',
    });
    expect(byMetric[WearableMetricType.WORKOUT_DISTANCE_M]).toMatchObject({
      value: 8000,
      unit: 'm',
      bucket: 'HEALTH_FITNESS',
    });
  });

  it('emits duration but NO distance for a SCORED workout lacking distance_meter', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'workout',
        data: {
          id: 'eeeeeeee-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T12:00:00.000Z',
          updated_at: '2026-05-20T12:00:00.000Z',
          start: '2026-05-20T12:00:00.000Z',
          end: '2026-05-20T12:30:00.000Z',
          score_state: 'SCORED',
          score: {},
        },
      }),
    ]);
    expect(samples.map((s) => s.metric)).toEqual([
      WearableMetricType.WORKOUT_DURATION_MIN,
    ]);
    expect(samples[0].value).toBe(30);
  });

  it('drops PENDING_SCORE / UNSCORABLE records (no half-baked samples)', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'recovery',
        data: {
          id: 'ffffffff-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T08:00:00.000Z',
          updated_at: '2026-05-20T08:00:00.000Z',
          score_state: 'PENDING_SCORE',
          score: null,
        },
      }),
    ]);
    expect(samples).toHaveLength(0);
  });

  it('drops naps (excluded from main sleep metrics)', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'sleep',
        data: {
          id: '11111111-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T14:00:00.000Z',
          updated_at: '2026-05-20T14:00:00.000Z',
          start: '2026-05-20T13:00:00.000Z',
          end: '2026-05-20T13:30:00.000Z',
          nap: true,
          score_state: 'SCORED',
          score: {
            stage_summary: {
              total_in_bed_time_milli: 1_800_000,
              total_awake_time_milli: 0,
              total_light_sleep_time_milli: 1_800_000,
              total_slow_wave_sleep_time_milli: 0,
              total_rem_sleep_time_milli: 0,
            },
            sleep_efficiency_percentage: 100,
          },
        },
      }),
    ]);
    expect(samples).toHaveLength(0);
  });

  it('ignores foreign-provider records defensively', () => {
    const samples = normalizeWhoop([
      {
        id: 'x',
        provider: WearableProvider.OURA,
        payload: { kind: 'recovery', data: {} } as unknown,
      } as RawRecord,
    ]);
    expect(samples).toHaveLength(0);
  });

  it('skips records with no resolvable user/connection context', () => {
    const samples = normalizeWhoop([
      {
        id: 'no-ctx',
        provider: WearableProvider.WHOOP,
        payload: {
          kind: 'recovery',
          data: {
            id: 'g',
            user_id: 1,
            created_at: '2026-05-20T08:00:00.000Z',
            updated_at: '2026-05-20T08:00:00.000Z',
            score_state: 'SCORED',
            score: { recovery_score: 50, resting_heart_rate: 60, hrv_rmssd_milli: 40 },
          },
        } as WhoopRawPayload,
      },
    ]);
    expect(samples).toHaveLength(0);
  });

  describe('whoopDedupKey', () => {
    it('is a deterministic sha256 of whoop:user_id:metric:start_at:value', () => {
      const startAt = new Date('2026-05-20T08:00:00.000Z');
      const k1 = whoopDedupKey({
        userId: 99,
        metric: WearableMetricType.RECOVERY_SCORE,
        startAt,
        value: 66,
      });
      const k2 = whoopDedupKey({
        userId: '99',
        metric: WearableMetricType.RECOVERY_SCORE,
        startAt: new Date('2026-05-20T08:00:00.000Z'),
        value: 66,
      });
      // 64 hex chars; stable across number/string user id and Date identity.
      expect(k1).toMatch(/^[0-9a-f]{64}$/);
      expect(k1).toBe(k2);
    });

    it('changes when the value changes (re-score is a distinct observation)', () => {
      const startAt = new Date('2026-05-20T08:00:00.000Z');
      const a = whoopDedupKey({
        userId: 99,
        metric: WearableMetricType.RECOVERY_SCORE,
        startAt,
        value: 66,
      });
      const b = whoopDedupKey({
        userId: 99,
        metric: WearableMetricType.RECOVERY_SCORE,
        startAt,
        value: 67,
      });
      expect(a).not.toBe(b);
    });
  });

  it('produced samples yield a valid foundation dedup_key (cross-check)', () => {
    const samples = normalizeWhoop([
      raw({
        kind: 'recovery',
        data: {
          id: 'aaaaaaaa-1111-2222-3333-444444444444',
          user_id: 99,
          created_at: '2026-05-20T08:00:00.000Z',
          updated_at: '2026-05-20T08:00:00.000Z',
          score_state: 'SCORED',
          score: { recovery_score: 66, resting_heart_rate: 54, hrv_rmssd_milli: 48.5 },
        },
      }),
    ]);
    const s = samples[0];
    const key = computeDedupKey({
      userId: s.userId,
      provider: s.provider,
      metric: s.metric,
      startAt: s.startAt,
      endAt: s.endAt,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
