import { WearableMetricBucket, WearableMetricType } from '@prisma/client';

/**
 * PR-HK-3a — canonical metric → bucket mapping.
 *
 * The authoritative source of truth is the seeded `WearableMetricDef` table
 * (UNIFIED_BUILD_PLAN §3 / #40 single source of truth). This compile-time map
 * mirrors that taxonomy so the samples service can:
 *  - validate that a caller-supplied `metric` actually belongs to the
 *    requested `bucket` (reject mismatches loud — #8 input validation), and
 *  - enumerate "all metrics in a bucket" when the caller omits `metric`,
 *    WITHOUT an extra round-trip to `WearableMetricDef` on the hot read path.
 *
 * It is keyed off the Prisma enum so adding a `WearableMetricType` without
 * classifying it here is a COMPILE ERROR (`Record<WearableMetricType, …>` is
 * exhaustive) — the map can never silently drift from the enum.
 */
export const METRIC_BUCKET: Readonly<
  Record<WearableMetricType, WearableMetricBucket>
> = {
  // ── Health & Fitness ──
  STEPS: WearableMetricBucket.HEALTH_FITNESS,
  ACTIVE_ENERGY_KCAL: WearableMetricBucket.HEALTH_FITNESS,
  HEART_RATE_BPM: WearableMetricBucket.HEALTH_FITNESS,
  VO2_MAX: WearableMetricBucket.HEALTH_FITNESS,
  WORKOUT_DURATION_MIN: WearableMetricBucket.HEALTH_FITNESS,
  WORKOUT_DISTANCE_M: WearableMetricBucket.HEALTH_FITNESS,
  TRAINING_LOAD: WearableMetricBucket.HEALTH_FITNESS,
  BODY_WEIGHT_KG: WearableMetricBucket.HEALTH_FITNESS,
  BODY_FAT_PCT: WearableMetricBucket.HEALTH_FITNESS,
  BLOOD_PRESSURE_SYS: WearableMetricBucket.HEALTH_FITNESS,
  BLOOD_PRESSURE_DIA: WearableMetricBucket.HEALTH_FITNESS,
  // ── Sleep & Recovery ──
  SLEEP_TOTAL_MIN: WearableMetricBucket.SLEEP_RECOVERY,
  SLEEP_REM_MIN: WearableMetricBucket.SLEEP_RECOVERY,
  SLEEP_DEEP_MIN: WearableMetricBucket.SLEEP_RECOVERY,
  SLEEP_LIGHT_MIN: WearableMetricBucket.SLEEP_RECOVERY,
  SLEEP_AWAKE_MIN: WearableMetricBucket.SLEEP_RECOVERY,
  SLEEP_EFFICIENCY_PCT: WearableMetricBucket.SLEEP_RECOVERY,
  HRV_MS: WearableMetricBucket.SLEEP_RECOVERY,
  RECOVERY_SCORE: WearableMetricBucket.SLEEP_RECOVERY,
  READINESS_SCORE: WearableMetricBucket.SLEEP_RECOVERY,
  STRAIN_SCORE: WearableMetricBucket.SLEEP_RECOVERY,
  BODY_BATTERY: WearableMetricBucket.SLEEP_RECOVERY,
  BODY_TEMP_DEVIATION_C: WearableMetricBucket.SLEEP_RECOVERY,
  RESPIRATORY_RATE_BRPM: WearableMetricBucket.SLEEP_RECOVERY,
  SPO2_PCT: WearableMetricBucket.SLEEP_RECOVERY,
  // Resting heart rate's primary home is Sleep & Recovery (mirrors the seeded
  // WearableMetricDef, migration 20260531000000_wearables_foundation §6 line
  // 404 — `('RESTING_HEART_RATE_BPM', 'SLEEP_RECOVERY', …)`). It is the
  // overnight resting reading, NOT the continuous daytime HEART_RATE_BPM
  // (which is H&F). Keeping these two in lock-step with the seed is what the
  // bootstrap sanity check in WearableSamplesService asserts at module init.
  RESTING_HEART_RATE_BPM: WearableMetricBucket.SLEEP_RECOVERY,
};

/** All metrics whose primary home is the given bucket, in enum order. */
export function metricsInBucket(
  bucket: WearableMetricBucket,
): WearableMetricType[] {
  return (Object.keys(METRIC_BUCKET) as WearableMetricType[]).filter(
    (metric) => METRIC_BUCKET[metric] === bucket,
  );
}

/**
 * Canonical time-bucketing aggregation semantics, as a closed string union.
 *
 * `WearableMetricDef.aggregation` is a `String` column (not a Prisma enum) whose
 * domain is fixed by the seed (migration 20260531000000_wearables_foundation §6
 * header): exactly `'sum' | 'avg' | 'last' | 'max'`. We model that domain as a
 * TypeScript union so the read service can drive a per-metric aggregation off
 * the seeded def with an EXHAUSTIVE `switch` (a future seed value that is not
 * one of these four becomes a compile error at the switch's `never` arm).
 */
export const METRIC_AGGREGATIONS = ['sum', 'avg', 'last', 'max'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

/** Type-guard: is an arbitrary string one of the four canonical aggregations? */
export function isMetricAggregation(value: string): value is MetricAggregation {
  return (METRIC_AGGREGATIONS as readonly string[]).includes(value);
}

/**
 * Canonical metric → aggregation mapping, mirroring the seeded
 * `WearableMetricDef.aggregation` column exactly (migration
 * 20260531000000_wearables_foundation §6 lines 392–417). Keyed off the Prisma
 * enum so adding a `WearableMetricType` without classifying it here is a COMPILE
 * ERROR — the map can never silently drift from the enum.
 *
 * Used as the in-memory fallback for the read aggregation: the service builds
 * its working map from the live `WearableMetricDef` rows at module init, and
 * this compile-time mirror is both the cold-start default and the value the
 * bootstrap sanity check asserts the database against.
 *
 * Physical meaning (seed header):
 *  - sum  — additive over the window (steps, energy, workout time/distance,
 *           and the sleep-stage minute totals).
 *  - avg  — averaged over the window (continuous/resting HR, HRV, respiratory
 *           rate, SpO2, sleep efficiency).
 *  - last — point-in-time latest reading (weight, body fat, VO2max, blood
 *           pressure, body-temp deviation, recovery/readiness/body-battery).
 *  - max  — peak over the window (training load, strain).
 */
export const METRIC_AGGREGATION: Readonly<
  Record<WearableMetricType, MetricAggregation>
> = {
  // ── Health & Fitness ──
  STEPS: 'sum',
  ACTIVE_ENERGY_KCAL: 'sum',
  WORKOUT_DURATION_MIN: 'sum',
  WORKOUT_DISTANCE_M: 'sum',
  TRAINING_LOAD: 'max',
  HEART_RATE_BPM: 'avg',
  VO2_MAX: 'last',
  BODY_WEIGHT_KG: 'last',
  BODY_FAT_PCT: 'last',
  BLOOD_PRESSURE_SYS: 'last',
  BLOOD_PRESSURE_DIA: 'last',
  // ── Sleep & Recovery ──
  RESTING_HEART_RATE_BPM: 'avg',
  HRV_MS: 'avg',
  SLEEP_TOTAL_MIN: 'sum',
  SLEEP_REM_MIN: 'sum',
  SLEEP_DEEP_MIN: 'sum',
  SLEEP_LIGHT_MIN: 'sum',
  SLEEP_AWAKE_MIN: 'sum',
  SLEEP_EFFICIENCY_PCT: 'avg',
  RESPIRATORY_RATE_BRPM: 'avg',
  SPO2_PCT: 'avg',
  BODY_TEMP_DEVIATION_C: 'last',
  RECOVERY_SCORE: 'last',
  READINESS_SCORE: 'last',
  BODY_BATTERY: 'last',
  STRAIN_SCORE: 'max',
};
