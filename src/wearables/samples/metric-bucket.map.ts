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
  RESTING_HEART_RATE_BPM: WearableMetricBucket.HEALTH_FITNESS,
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
};

/** All metrics whose primary home is the given bucket, in enum order. */
export function metricsInBucket(
  bucket: WearableMetricBucket,
): WearableMetricType[] {
  return (Object.keys(METRIC_BUCKET) as WearableMetricType[]).filter(
    (metric) => METRIC_BUCKET[metric] === bucket,
  );
}
