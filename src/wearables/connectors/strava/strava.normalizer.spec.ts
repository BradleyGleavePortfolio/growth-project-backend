import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { RawRecord } from '../../normalization/normalizer.types';
import {
  computeStravaDedupKey,
  normalizeStravaActivities,
} from './strava.normalizer';
import { StravaActivity } from './strava.types';

/**
 * PR-HK-2.f — Strava normalizer golden-vector tests.
 *
 * A known StravaActivity JSON → an EXACT NormalizedSample list. The dedup-key
 * vectors are pinned to literal 64-char sha256 hex so a silent change to the
 * key recipe (segment order, separator, provider literal, value rendering)
 * fails the suite loudly.
 */
describe('normalizeStravaActivities (golden vector)', () => {
  const userId = 'user-123';
  const connectionId = 'conn-abc';
  const startIso = '2024-01-02T07:30:00Z';
  const startAt = new Date(startIso);
  const endAt = new Date(startAt.getTime() + 3600 * 1000); // +moving_time

  // A full HR activity: emits ALL FIVE metrics.
  const detailedRun: StravaActivity = {
    id: 987654321,
    type: 'Run',
    moving_time: 3600,
    elapsed_time: 3720,
    distance: 10234.5,
    calories: 612,
    has_heartrate: true,
    average_heartrate: 148.6,
    max_heartrate: 171,
    suffer_score: 98,
    start_date: startIso,
    start_date_local: '2024-01-02T07:30:00Z',
    timezone: '(GMT+00:00) Europe/London',
  };

  function findSample(
    samples: ReturnType<typeof normalizeStravaActivities>,
    metric: WearableMetricType,
  ) {
    return samples.find((s) => s.metric === metric);
  }

  it('maps a detailed HR activity to exactly five H&F samples', () => {
    const raw: RawRecord[] = [
      { id: '987654321', provider: WearableProvider.STRAVA, payload: detailedRun },
    ];
    const out = normalizeStravaActivities(userId, connectionId, raw);

    expect(out).toHaveLength(5);

    const metrics = out.map((s) => s.metric).sort();
    expect(metrics).toEqual(
      [
        WearableMetricType.ACTIVE_ENERGY_KCAL,
        WearableMetricType.HEART_RATE_BPM,
        WearableMetricType.TRAINING_LOAD,
        WearableMetricType.WORKOUT_DISTANCE_M,
        WearableMetricType.WORKOUT_DURATION_MIN,
      ].sort(),
    );

    // Every sample is H&F, STRAVA, correct window + provenance.
    for (const s of out) {
      expect(s.provider).toBe(WearableProvider.STRAVA);
      expect(s.bucket).toBe(WearableMetricBucket.HEALTH_FITNESS);
      expect(s.userId).toBe(userId);
      expect(s.connectionId).toBe(connectionId);
      expect(s.startAt.toISOString()).toBe(startAt.toISOString());
      expect(s.endAt.toISOString()).toBe(endAt.toISOString());
      expect(s.sourceTz).toBe('(GMT+00:00) Europe/London');
      expect(s.sourceRecordId).toBe('987654321');
    }
  });

  it('computes exact values + units for each metric', () => {
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: detailedRun },
    ]);

    const dur = findSample(out, WearableMetricType.WORKOUT_DURATION_MIN)!;
    expect(dur.value).toBe(60); // 3600s / 60
    expect(dur.unit).toBe('min');

    const dist = findSample(out, WearableMetricType.WORKOUT_DISTANCE_M)!;
    expect(dist.value).toBe(10234.5);
    expect(dist.unit).toBe('m');

    const kcal = findSample(out, WearableMetricType.ACTIVE_ENERGY_KCAL)!;
    expect(kcal.value).toBe(612);
    expect(kcal.unit).toBe('kcal');

    const load = findSample(out, WearableMetricType.TRAINING_LOAD)!;
    expect(load.value).toBe(98);
    expect(load.unit).toBe('score');

    const hr = findSample(out, WearableMetricType.HEART_RATE_BPM)!;
    expect(hr.value).toBe(148.6);
    expect(hr.unit).toBe('bpm');
  });

  it('pins exact dedup-key vectors (rawRef provenance)', () => {
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: detailedRun },
    ]);

    expect(findSample(out, WearableMetricType.WORKOUT_DURATION_MIN)!.rawRef).toBe(
      '0cea243d5b0c835fd5b960b7f27f3c695cd6b5b685d188967aae94fccc1cc480',
    );
    expect(findSample(out, WearableMetricType.WORKOUT_DISTANCE_M)!.rawRef).toBe(
      '8012d4e031c109c4b16b1921bd688e2e6facae0dcb6e0ce7b610b0556a92b6b4',
    );
    expect(findSample(out, WearableMetricType.ACTIVE_ENERGY_KCAL)!.rawRef).toBe(
      'c73f2a9312c92c504b488cfdb2c6a2b452cd403461a005e2df329399be193c50',
    );
    expect(findSample(out, WearableMetricType.TRAINING_LOAD)!.rawRef).toBe(
      'bb8ba18995464edea14c5c7e9796b1fa65109d59f72d993058ec92d598e4eddf',
    );
    expect(findSample(out, WearableMetricType.HEART_RATE_BPM)!.rawRef).toBe(
      'dfc33cc483c4ad36dac61ee4fef145d58c9cf0a36b36234c5166ec00ecc17d87',
    );
  });

  it('drops metrics whose source field is absent (no fabricated zeros)', () => {
    // A summary-list run with no HR + no calories + no effort: only the two
    // always-present metrics (duration, distance) are emitted.
    const summaryRun: StravaActivity = {
      id: 111,
      type: 'Run',
      moving_time: 1800,
      distance: 5000,
      start_date: startIso,
      timezone: 'UTC',
    };
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: summaryRun },
    ]);
    expect(out.map((s) => s.metric).sort()).toEqual(
      [
        WearableMetricType.WORKOUT_DISTANCE_M,
        WearableMetricType.WORKOUT_DURATION_MIN,
      ].sort(),
    );
  });

  it('prefers suffer_score but falls back to the training_load alias', () => {
    const aliased: StravaActivity = {
      id: 222,
      moving_time: 600,
      distance: 1000,
      training_load: 42,
      start_date: startIso,
    };
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: aliased },
    ]);
    const load = findSample(out, WearableMetricType.TRAINING_LOAD);
    expect(load?.value).toBe(42);
  });

  it('skips records with an unparseable or missing start_date', () => {
    const bad: StravaActivity = {
      id: 333,
      moving_time: 600,
      distance: 1000,
      start_date: 'not-a-date',
    };
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: bad },
      { provider: WearableProvider.STRAVA, payload: undefined as never },
    ]);
    expect(out).toHaveLength(0);
  });

  it('uses moving_time to compute end_at and uses start when duration absent', () => {
    const noDuration = {
      id: 444,
      distance: 1000,
      start_date: startIso,
    } as unknown as StravaActivity;
    const out = normalizeStravaActivities(userId, connectionId, [
      { provider: WearableProvider.STRAVA, payload: noDuration },
    ]);
    // No moving_time → no duration sample, and distance sample's end==start.
    const dist = findSample(out, WearableMetricType.WORKOUT_DISTANCE_M)!;
    expect(dist.endAt.toISOString()).toBe(dist.startAt.toISOString());
    expect(findSample(out, WearableMetricType.WORKOUT_DURATION_MIN)).toBeUndefined();
  });

  it('throws on missing userId / connectionId (fail loud)', () => {
    expect(() =>
      normalizeStravaActivities('', connectionId, []),
    ).toThrow(/userId/);
    expect(() =>
      normalizeStravaActivities(userId, '', []),
    ).toThrow(/connectionId/);
  });
});

describe('computeStravaDedupKey', () => {
  it('is deterministic and tz-invariant for the same instant', () => {
    const a = computeStravaDedupKey(
      'u',
      WearableMetricType.HEART_RATE_BPM,
      new Date('2024-01-02T07:30:00Z'),
      150,
    );
    const b = computeStravaDedupKey(
      'u',
      WearableMetricType.HEART_RATE_BPM,
      new Date('2024-01-02T08:30:00+01:00'),
      150,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when value differs', () => {
    const at = new Date('2024-01-02T07:30:00Z');
    expect(
      computeStravaDedupKey('u', WearableMetricType.HEART_RATE_BPM, at, 150),
    ).not.toBe(
      computeStravaDedupKey('u', WearableMetricType.HEART_RATE_BPM, at, 151),
    );
  });

  it('throws on an invalid Date', () => {
    expect(() =>
      computeStravaDedupKey(
        'u',
        WearableMetricType.HEART_RATE_BPM,
        new Date('nope'),
        1,
      ),
    ).toThrow(RangeError);
  });
});
