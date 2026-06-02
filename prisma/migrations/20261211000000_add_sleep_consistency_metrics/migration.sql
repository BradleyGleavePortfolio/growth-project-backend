-- HK-3a supplemental — sleep-consistency metric keys (HK-3b recovery-bucket
-- wire parity). Adds three values to the existing Postgres enum
-- "WearableMetricType". Postgres requires each enum value to be added in its
-- own statement; we make each idempotent with IF NOT EXISTS (Postgres 12+) so
-- the migration is safe to re-apply.
--
--   SLEEP_DURATION_MIN — total time asleep, in minutes (additive over the night)
--   SLEEP_ONSET_ISO     — bedtime, encoded as local minute-of-day (point-in-time)
--   SLEEP_WAKE_ISO      — wake time, encoded as local minute-of-day (point-in-time)
--
-- The new values are seeded into WearableMetricDef in the immediately following
-- migration (20261211000001_seed_sleep_consistency_metric_defs); Postgres does
-- not allow a freshly-added enum value to be referenced in the same transaction
-- that adds it, so the INSERT is intentionally split into its own migration.

ALTER TYPE "WearableMetricType" ADD VALUE IF NOT EXISTS 'SLEEP_DURATION_MIN';
ALTER TYPE "WearableMetricType" ADD VALUE IF NOT EXISTS 'SLEEP_ONSET_ISO';
ALTER TYPE "WearableMetricType" ADD VALUE IF NOT EXISTS 'SLEEP_WAKE_ISO';
