-- HK-3a supplemental — seed WearableMetricDef rows for the three
-- sleep-consistency metric keys added in 20261211000000. Mirrors the structure
-- of the existing sleep defs (migration 20260531000000_wearables_foundation §6):
--
--   SLEEP_DURATION_MIN — total time asleep; additive minute total (aggregation
--                        'sum'), same healthy reference band as SLEEP_TOTAL_MIN.
--   SLEEP_ONSET_ISO     — bedtime as local minute-of-day; point-in-time latest
--                        reading per window (aggregation 'last').
--   SLEEP_WAKE_ISO      — wake time as local minute-of-day; point-in-time latest
--                        reading per window (aggregation 'last').
--
-- ON CONFLICT keeps the migration idempotent (the def table is keyed on metric).

INSERT INTO "WearableMetricDef" ("metric", "bucket", "unit", "display_name", "aggregation", "norm_band", "sort_order") VALUES
  ('SLEEP_DURATION_MIN', 'SLEEP_RECOVERY', 'min',        'Time asleep (duration)', 'sum',  '{"min": 420, "max": 540}', 225),
  ('SLEEP_ONSET_ISO',    'SLEEP_RECOVERY', 'min_of_day', 'Bedtime',                'last', NULL,                       226),
  ('SLEEP_WAKE_ISO',     'SLEEP_RECOVERY', 'min_of_day', 'Wake time',              'last', NULL,                       227)
ON CONFLICT ("metric") DO NOTHING;
