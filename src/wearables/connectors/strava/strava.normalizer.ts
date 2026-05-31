import { createHash } from 'crypto';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { NormalizedSample, RawRecord } from '../../normalization/normalizer.types';
import { StravaActivity } from './strava.types';

/**
 * PR-HK-2.f — Strava → canonical normalizer.
 *
 * Maps a Strava summary/detailed activity to canonical {@link NormalizedSample}
 * rows per AGENT_2_CODING_PLAN §3.1:
 *
 *   activities → WORKOUT_DURATION_MIN  (moving_time / 60,  "min")
 *              → WORKOUT_DISTANCE_M    (distance,          "m")
 *              → ACTIVE_ENERGY_KCAL    (calories,          "kcal")
 *              → TRAINING_LOAD         (suffer_score,      "score")
 *              → HEART_RATE_BPM        (average_heartrate, "bpm")
 *
 * ALL five metrics are HEALTH_FITNESS bucket — Strava is an H&F-only provider
 * (no sleep/recovery surface). Anything else Strava returns is DROPPED (no
 * speculative ingestion, 50-Failures #42).
 *
 * Timestamps: workouts are an interval [start_date, start_date + moving_time).
 * `start_date` is the provider's UTC ISO instant; we parse it to a UTC Date so
 * dedup is tz-invariant. `end_at` = start + moving_time seconds. The Strava
 * `timezone` string is threaded to `sourceTz` for downstream day-bucketing
 * across DST/travel (it is NOT part of identity).
 *
 * A metric is emitted ONLY when its source field is present and finite — a
 * summary-list activity has no `calories` and a non-HR activity has no
 * `average_heartrate`/`suffer_score`, so those rows are simply skipped rather
 * than fabricated as 0 (which would corrupt averages).
 */

/**
 * The five canonical metrics Strava maps to (all HEALTH_FITNESS). Narrowing
 * the union lets `UNIT[metric]` index safely without `any`.
 */
type StravaMetric =
  | typeof WearableMetricType.WORKOUT_DURATION_MIN
  | typeof WearableMetricType.WORKOUT_DISTANCE_M
  | typeof WearableMetricType.ACTIVE_ENERGY_KCAL
  | typeof WearableMetricType.TRAINING_LOAD
  | typeof WearableMetricType.HEART_RATE_BPM;

/** Canonical unit strings — must match WearableMetricDef.unit seeds. */
const UNIT: Record<StravaMetric, string> = {
  [WearableMetricType.WORKOUT_DURATION_MIN]: 'min',
  [WearableMetricType.WORKOUT_DISTANCE_M]: 'm',
  [WearableMetricType.ACTIVE_ENERGY_KCAL]: 'kcal',
  [WearableMetricType.TRAINING_LOAD]: 'score',
  [WearableMetricType.HEART_RATE_BPM]: 'bpm',
};

/**
 * Compute the Strava-native sample dedup key per the PR-HK-2.f spec:
 *
 *   sha256( "strava:" + userId + ":" + metric + ":" + startIso + ":" + value )
 *
 * NOTE (deviation, documented): the canonical ingestion lane keys
 * WearableSample on the foundation's `computeDedupKey`
 * (sha256(user|provider|metric|start_iso|end_iso), PR-HK-0). This connector-
 * level key is the *normalizer-spec* key the task pins for its golden vector
 * and per-sample provenance; it adds `value` and uses the lowercase provider
 * literal "strava" exactly as the spec mandates. It is exposed for tests and
 * for attaching to the sample's `rawRef` provenance trail, and never replaces
 * the foundation's DB-unique key.
 */
export function computeStravaDedupKey(
  userId: string,
  metric: WearableMetricType,
  startAt: Date,
  value: number,
): string {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    throw new RangeError(
      `computeStravaDedupKey: startAt is not a valid Date (got ${String(startAt)})`,
    );
  }
  const canonical = [
    'strava',
    userId,
    metric,
    startAt.toISOString(),
    String(value),
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Normalize a batch of Strava {@link RawRecord}s (each payload is a
 * {@link StravaActivity}) into canonical samples. Pure + synchronous so it is
 * trivially unit-tested against a golden vector.
 *
 * @param userId       subject client User.id (key segment + sample field).
 * @param connectionId the WearableConnection these records arrived through.
 * @param raw          provider-native records from backfill / webhook fetch.
 */
export function normalizeStravaActivities(
  userId: string,
  connectionId: string,
  raw: RawRecord[],
): NormalizedSample[] {
  if (!userId) throw new TypeError('normalizeStravaActivities: userId required');
  if (!connectionId) {
    throw new TypeError('normalizeStravaActivities: connectionId required');
  }
  if (!Array.isArray(raw)) {
    throw new TypeError('normalizeStravaActivities: raw must be an array');
  }

  const out: NormalizedSample[] = [];
  for (const record of raw) {
    const a = record?.payload as StravaActivity | undefined;
    if (!a || typeof a !== 'object') continue;

    const startAt = parseUtc(a.start_date);
    if (!startAt) continue; // a record with no usable timestamp is unusable

    // Duration drives the observation window end. moving_time is seconds.
    const durationSec =
      typeof a.moving_time === 'number' && Number.isFinite(a.moving_time)
        ? a.moving_time
        : null;
    const endAt =
      durationSec !== null
        ? new Date(startAt.getTime() + durationSec * 1000)
        : startAt;

    const sourceTz = typeof a.timezone === 'string' ? a.timezone : null;
    const sourceRecordId =
      a.id !== undefined && a.id !== null ? String(a.id) : null;

    const push = (metric: StravaMetric, value: number): void => {
      out.push({
        userId,
        connectionId,
        provider: WearableProvider.STRAVA,
        metric,
        bucket: WearableMetricBucket.HEALTH_FITNESS,
        value,
        unit: UNIT[metric],
        startAt,
        endAt,
        sourceTz,
        sourceRecordId,
        // Provenance: the spec dedup key for this exact (metric,value) sample.
        rawRef: computeStravaDedupKey(userId, metric, startAt, value),
      });
    };

    // WORKOUT_DURATION_MIN — moving_time seconds → minutes.
    if (durationSec !== null) {
      push(WearableMetricType.WORKOUT_DURATION_MIN, durationSec / 60);
    }

    // WORKOUT_DISTANCE_M — metres, as reported.
    if (typeof a.distance === 'number' && Number.isFinite(a.distance)) {
      push(WearableMetricType.WORKOUT_DISTANCE_M, a.distance);
    }

    // ACTIVE_ENERGY_KCAL — only on detailed activities.
    if (typeof a.calories === 'number' && Number.isFinite(a.calories)) {
      push(WearableMetricType.ACTIVE_ENERGY_KCAL, a.calories);
    }

    // TRAINING_LOAD — suffer_score (preferred) or the training_load alias.
    const effort =
      typeof a.suffer_score === 'number' && Number.isFinite(a.suffer_score)
        ? a.suffer_score
        : typeof a.training_load === 'number' &&
            Number.isFinite(a.training_load)
          ? a.training_load
          : null;
    if (effort !== null) {
      push(WearableMetricType.TRAINING_LOAD, effort);
    }

    // HEART_RATE_BPM — average heart rate (HR activities only).
    if (
      typeof a.average_heartrate === 'number' &&
      Number.isFinite(a.average_heartrate)
    ) {
      push(WearableMetricType.HEART_RATE_BPM, a.average_heartrate);
    }
  }

  return out;
}

/** Parse a Strava UTC ISO instant to a Date; returns null if unparseable. */
function parseUtc(iso: string | undefined): Date | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
