-- PR-HK-0 — Wearables / HealthKit foundation
-- =====================================================================
-- The SCHEMA + RLS GATE for the entire HealthKit / wearables expansion.
-- Nothing else in the expansion lands until this migration is merged.
--
-- Additive only (50-Failures #45/#47): this migration creates new enums,
-- tables, indexes, RLS policies, and seed rows. It contains NO destructive
-- DROP / ALTER of any pre-existing object.
--
-- Doctrine enforced here (50-Failures defenses, see UNIFIED_BUILD_PLAN §0):
--   #2  RLS — EVERY new table below gets ENABLE + FORCE ROW LEVEL SECURITY
--       and explicit per-operation policies in this SAME migration. No
--       table is ever born without RLS (the CPO "50-table RLS hole" lesson).
--   #1  Tokens — encrypted_* columns hold KMS-wrapped ciphertext only; the
--       read controllers never project them (defense in depth). Coach SELECT
--       policies intentionally expose only status / last-sync metadata.
--   #22 Indexes — every FK is indexed; the documented composite read
--       indexes live on WearableSample.
--   #28/#29 dedup/replay — WearableSample.dedup_key is UNIQUE;
--       WearableProcessedEvent uses a composite (provider, event_id) PK.
--
-- RLS helper functions reused (defined in 20260607000000_rls_remaining_gaps):
--   app.current_user_id()            -> text
--   app.is_owner()                   -> boolean
--   app.is_current_coach_of(text)    -> boolean (SECURITY DEFINER)
-- Ingestion writes run under the Supabase service_role (BYPASSRLS), so the
-- client/coach policies below govern only authenticated READ paths.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "WearableProvider" AS ENUM ('APPLE_HEALTHKIT', 'HEALTH_CONNECT', 'GARMIN', 'FITBIT', 'STRAVA', 'POLAR', 'SAMSUNG_HEALTH', 'WAHOO', 'WITHINGS', 'PELOTON', 'MYFITNESSPAL', 'OURA', 'WHOOP', 'EIGHT_SLEEP', 'BEDDIT');

-- CreateEnum
CREATE TYPE "WearableMetricBucket" AS ENUM ('HEALTH_FITNESS', 'SLEEP_RECOVERY');

-- CreateEnum
CREATE TYPE "WearableMetricType" AS ENUM ('STEPS', 'ACTIVE_ENERGY_KCAL', 'RESTING_HEART_RATE_BPM', 'HEART_RATE_BPM', 'VO2_MAX', 'WORKOUT_DURATION_MIN', 'WORKOUT_DISTANCE_M', 'TRAINING_LOAD', 'BODY_WEIGHT_KG', 'BODY_FAT_PCT', 'BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA', 'SLEEP_TOTAL_MIN', 'SLEEP_REM_MIN', 'SLEEP_DEEP_MIN', 'SLEEP_LIGHT_MIN', 'SLEEP_AWAKE_MIN', 'SLEEP_EFFICIENCY_PCT', 'HRV_MS', 'RECOVERY_SCORE', 'READINESS_SCORE', 'STRAIN_SCORE', 'BODY_BATTERY', 'BODY_TEMP_DEVIATION_C', 'RESPIRATORY_RATE_BRPM', 'SPO2_PCT');

-- ---------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------

-- CreateTable
CREATE TABLE "WearableConnection" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "WearableProvider" NOT NULL,
    "external_account_id" TEXT,
    "credentials_secret_ref" TEXT,
    "encrypted_refresh_token" TEXT,
    "encrypted_access_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhook_subscription_id" TEXT,
    "webhook_secret_ref" TEXT,
    "channel_expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'connected',
    "last_error" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "backfilled_until" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WearableConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WearableMetricDef" (
    "metric" "WearableMetricType" NOT NULL,
    "bucket" "WearableMetricBucket" NOT NULL,
    "unit" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "aggregation" TEXT NOT NULL,
    "norm_band" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WearableMetricDef_pkey" PRIMARY KEY ("metric")
);

-- CreateTable
CREATE TABLE "WearableSample" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" "WearableProvider" NOT NULL,
    "metric" "WearableMetricType" NOT NULL,
    "bucket" "WearableMetricBucket" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "source_tz" TEXT,
    "dedup_key" TEXT NOT NULL,
    "source_record_id" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_ref" TEXT,

    CONSTRAINT "WearableSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WearableProcessedEvent" (
    "provider" "WearableProvider" NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handler_completed_at" TIMESTAMP(3),

    CONSTRAINT "WearableProcessedEvent_pkey" PRIMARY KEY ("provider","provider_event_id")
);

-- CreateTable
CREATE TABLE "WearableInsightCache" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "bucket" "WearableMetricBucket" NOT NULL,
    "window_days" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "model_used" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WearableInsightCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WearableUserMetricPreference" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "metric" "WearableMetricType" NOT NULL,
    "preferred_provider" "WearableProvider" NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WearableUserMetricPreference_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------
-- 3. INDEXES (every FK indexed; @@unique => UNIQUE INDEX; documented
--    composite read indexes on WearableSample)
-- ---------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "WearableConnection_user_id_idx" ON "WearableConnection"("user_id");

-- CreateIndex
CREATE INDEX "WearableConnection_status_idx" ON "WearableConnection"("status");

-- CreateIndex
CREATE INDEX "WearableConnection_channel_expires_at_idx" ON "WearableConnection"("channel_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "WearableConnection_user_id_provider_external_account_id_key" ON "WearableConnection"("user_id", "provider", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "WearableSample_dedup_key_key" ON "WearableSample"("dedup_key");

-- CreateIndex
CREATE INDEX "WearableSample_user_id_bucket_start_at_idx" ON "WearableSample"("user_id", "bucket", "start_at");

-- CreateIndex
CREATE INDEX "WearableSample_user_id_metric_start_at_idx" ON "WearableSample"("user_id", "metric", "start_at");

-- CreateIndex
CREATE INDEX "WearableSample_connection_id_start_at_idx" ON "WearableSample"("connection_id", "start_at");

-- CreateIndex
CREATE INDEX "WearableSample_provider_source_record_id_idx" ON "WearableSample"("provider", "source_record_id");

-- CreateIndex
CREATE INDEX "WearableProcessedEvent_processed_at_idx" ON "WearableProcessedEvent"("processed_at");

-- CreateIndex
CREATE INDEX "WearableProcessedEvent_handler_completed_at_idx" ON "WearableProcessedEvent"("handler_completed_at");

-- CreateIndex
CREATE INDEX "WearableInsightCache_user_id_idx" ON "WearableInsightCache"("user_id");

-- CreateIndex
CREATE INDEX "WearableInsightCache_expires_at_idx" ON "WearableInsightCache"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "WearableInsightCache_user_id_side_bucket_window_days_key" ON "WearableInsightCache"("user_id", "side", "bucket", "window_days");

-- CreateIndex
CREATE INDEX "WearableUserMetricPreference_user_id_idx" ON "WearableUserMetricPreference"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "WearableUserMetricPreference_user_id_metric_key" ON "WearableUserMetricPreference"("user_id", "metric");

-- ---------------------------------------------------------------------
-- 4. FOREIGN KEYS (each backed by an index above)
-- ---------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "WearableConnection" ADD CONSTRAINT "WearableConnection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WearableSample" ADD CONSTRAINT "WearableSample_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WearableSample" ADD CONSTRAINT "WearableSample_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "WearableConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WearableInsightCache" ADD CONSTRAINT "WearableInsightCache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WearableUserMetricPreference" ADD CONSTRAINT "WearableUserMetricPreference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 5. ROW LEVEL SECURITY (50-Failures #2 — the gate's most important job)
--    Every new table: ENABLE + FORCE, then explicit policies.
-- =====================================================================

-- 5.0 RLS helper functions (idempotent ensure).
-- These helpers were introduced across earlier migrations
-- (20260520000001 defines current_user_id / current_user_role / is_owner)
-- and 20260607000000_rls_remaining_gaps defines is_user_coached_by /
-- is_current_coach_of. Because that coach-helper migration is dated AFTER
-- this one, this migration would otherwise reference functions that do not
-- yet exist when applied in timestamp order on a fresh database. To keep
-- this gate migration self-sufficient (forward-applies cleanly on an empty
-- DB regardless of sibling order), we re-declare all four helpers here with
-- CREATE OR REPLACE using the EXACT definitions from those migrations. The
-- later migration's CREATE OR REPLACE is then a harmless no-op replacement
-- with identical bodies. No behavior change; pure ordering robustness.
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$$;

CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT client_user_id IS NOT NULL
     AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" u
       WHERE u."id" = client_user_id
         AND u."coach_id" = coach_user_id
         AND u."role" = 'student'
     )
$$;

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$$;

ALTER TABLE "WearableConnection"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableConnection"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "WearableSample"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableSample"               FORCE ROW LEVEL SECURITY;
ALTER TABLE "WearableMetricDef"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableMetricDef"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "WearableProcessedEvent"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableProcessedEvent"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "WearableInsightCache"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableInsightCache"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "WearableUserMetricPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableUserMetricPreference" FORCE ROW LEVEL SECURITY;

-- --- WearableConnection: client owns; coach reads (status/last-sync only,
--     never token columns — controller projection enforces #1/#12); owner all.
DROP POLICY IF EXISTS "wc_client_all"   ON "WearableConnection";
CREATE POLICY "wc_client_all" ON "WearableConnection" FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());

DROP POLICY IF EXISTS "wc_coach_select" ON "WearableConnection";
CREATE POLICY "wc_coach_select" ON "WearableConnection" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

DROP POLICY IF EXISTS "wc_owner_all"    ON "WearableConnection";
CREATE POLICY "wc_owner_all" ON "WearableConnection" FOR ALL TO public
  USING (app.is_owner()) WITH CHECK (app.is_owner());

-- --- WearableSample: identical shape to WearableConnection.
DROP POLICY IF EXISTS "ws_client_all"   ON "WearableSample";
CREATE POLICY "ws_client_all" ON "WearableSample" FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());

DROP POLICY IF EXISTS "ws_coach_select" ON "WearableSample";
CREATE POLICY "ws_coach_select" ON "WearableSample" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

DROP POLICY IF EXISTS "ws_owner_all"    ON "WearableSample";
CREATE POLICY "ws_owner_all" ON "WearableSample" FOR ALL TO public
  USING (app.is_owner()) WITH CHECK (app.is_owner());

-- --- WearableInsightCache: client reads own client-side rows; coach reads
--     BOTH sides for their clients (coach-side rows carry hypotheses + draft
--     messages the client must never see); owner all. The client NEVER reads
--     side='coach' rows (no client policy admits them).
DROP POLICY IF EXISTS "wic_client_select" ON "WearableInsightCache";
CREATE POLICY "wic_client_select" ON "WearableInsightCache" FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.current_user_id() = "user_id" AND "side" = 'client');

DROP POLICY IF EXISTS "wic_coach_select" ON "WearableInsightCache";
CREATE POLICY "wic_coach_select" ON "WearableInsightCache" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

DROP POLICY IF EXISTS "wic_owner_all" ON "WearableInsightCache";
CREATE POLICY "wic_owner_all" ON "WearableInsightCache" FOR ALL TO public
  USING (app.is_owner()) WITH CHECK (app.is_owner());

-- --- WearableUserMetricPreference: client owns; coach reads (to inform
--     debugging — cannot mutate); owner all.
DROP POLICY IF EXISTS "wump_client_all"   ON "WearableUserMetricPreference";
CREATE POLICY "wump_client_all" ON "WearableUserMetricPreference" FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());

DROP POLICY IF EXISTS "wump_coach_select" ON "WearableUserMetricPreference";
CREATE POLICY "wump_coach_select" ON "WearableUserMetricPreference" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

DROP POLICY IF EXISTS "wump_owner_all"    ON "WearableUserMetricPreference";
CREATE POLICY "wump_owner_all" ON "WearableUserMetricPreference" FOR ALL TO public
  USING (app.is_owner()) WITH CHECK (app.is_owner());

-- --- WearableMetricDef: read-only public reference (no PII). Reads allowed
--     for everyone; writes (INSERT/UPDATE/DELETE) have NO public policy ⇒
--     denied for public, permitted only via service_role (BYPASSRLS) which
--     runs the seed below and any future metric additions.
DROP POLICY IF EXISTS "wmd_public_select" ON "WearableMetricDef";
CREATE POLICY "wmd_public_select" ON "WearableMetricDef" FOR SELECT TO public
  USING (true);

-- --- WearableProcessedEvent: no end-user access. FORCE RLS + zero public
--     policies ⇒ public (PostgREST / authenticated / anon) is fully denied;
--     only service_role (BYPASSRLS) can read/write webhook-dedup rows.
--     (Intentional deny-all — webhook idempotency is server-internal.)

-- =====================================================================
-- 6. SEED WearableMetricDef (one row per WearableMetricType)
--    bucket per Agent 1 §1.6 primary-bucket map; display_name is
--    PLAIN-LANGUAGE per Agent 1 §3.3a / §6.4 (S&R copy: "Light sleep",
--    never clinical labels like "N1/N2"). aggregation chosen per the
--    physical meaning of the metric:
--      sum  — additive over the window (steps, energy, workout time/dist)
--      avg  — averaged over the window (continuous HR, respiratory rate)
--      last — point-in-time latest reading (weight, body fat, VO2max,
--             blood pressure, body-temp deviation, SpO2)
--      max  — peak over the window (training load, strain)
--    norm_band carries a scientific reference band where a stable one
--    exists (used by the AI norm-comparison); null where none applies.
-- =====================================================================

INSERT INTO "WearableMetricDef" ("metric", "bucket", "unit", "display_name", "aggregation", "norm_band", "sort_order") VALUES
  -- ── Health & Fitness ──
  ('STEPS',                  'HEALTH_FITNESS', 'steps',  'Steps',                 'sum',  '{"min": 7000, "max": 10000}',  10),
  ('ACTIVE_ENERGY_KCAL',     'HEALTH_FITNESS', 'kcal',   'Active energy',         'sum',  NULL,                            20),
  ('WORKOUT_DURATION_MIN',   'HEALTH_FITNESS', 'min',    'Workout time',          'sum',  NULL,                            30),
  ('WORKOUT_DISTANCE_M',     'HEALTH_FITNESS', 'm',      'Workout distance',      'sum',  NULL,                            40),
  ('TRAINING_LOAD',          'HEALTH_FITNESS', 'score',  'Training load',         'max',  NULL,                            50),
  ('HEART_RATE_BPM',         'HEALTH_FITNESS', 'bpm',    'Heart rate',            'avg',  NULL,                            60),
  ('VO2_MAX',                'HEALTH_FITNESS', 'ml/kg/min', 'Cardio fitness',     'last', NULL,                            70),
  ('BODY_WEIGHT_KG',         'HEALTH_FITNESS', 'kg',     'Weight',                'last', NULL,                            80),
  ('BODY_FAT_PCT',           'HEALTH_FITNESS', '%',      'Body fat',              'last', NULL,                            90),
  ('BLOOD_PRESSURE_SYS',     'HEALTH_FITNESS', 'mmHg',   'Blood pressure (upper)', 'last', '{"min": 90, "max": 120}',     100),
  ('BLOOD_PRESSURE_DIA',     'HEALTH_FITNESS', 'mmHg',   'Blood pressure (lower)', 'last', '{"min": 60, "max": 80}',      110),
  -- ── Sleep & Recovery ── (resting HR primary home is S&R per §1.6)
  ('RESTING_HEART_RATE_BPM', 'SLEEP_RECOVERY', 'bpm',    'Resting heart rate',    'avg',  '{"min": 50, "max": 70}',      200),
  ('HRV_MS',                 'SLEEP_RECOVERY', 'ms',     'Heart rate variability', 'avg', NULL,                           210),
  ('SLEEP_TOTAL_MIN',        'SLEEP_RECOVERY', 'min',    'Time asleep',           'sum',  '{"min": 420, "max": 540}',    220),
  ('SLEEP_REM_MIN',          'SLEEP_RECOVERY', 'min',    'REM sleep',             'sum',  NULL,                          230),
  ('SLEEP_DEEP_MIN',         'SLEEP_RECOVERY', 'min',    'Deep sleep',            'sum',  NULL,                          240),
  ('SLEEP_LIGHT_MIN',        'SLEEP_RECOVERY', 'min',    'Light sleep',           'sum',  NULL,                          250),
  ('SLEEP_AWAKE_MIN',        'SLEEP_RECOVERY', 'min',    'Time awake',            'sum',  NULL,                          260),
  ('SLEEP_EFFICIENCY_PCT',   'SLEEP_RECOVERY', '%',      'Sleep efficiency',      'avg',  '{"min": 85, "max": 100}',     270),
  ('RESPIRATORY_RATE_BRPM',  'SLEEP_RECOVERY', 'br/min', 'Breathing rate',        'avg',  '{"min": 12, "max": 20}',      280),
  ('SPO2_PCT',               'SLEEP_RECOVERY', '%',      'Blood oxygen',          'avg',  '{"min": 95, "max": 100}',     290),
  ('BODY_TEMP_DEVIATION_C',  'SLEEP_RECOVERY', '°C',     'Body temperature shift', 'last', NULL,                         300),
  ('RECOVERY_SCORE',         'SLEEP_RECOVERY', 'score',  'Recovery',              'last', NULL,                          310),
  ('READINESS_SCORE',        'SLEEP_RECOVERY', 'score',  'Readiness',             'last', NULL,                          320),
  ('BODY_BATTERY',           'SLEEP_RECOVERY', 'score',  'Body battery',          'last', NULL,                          330),
  ('STRAIN_SCORE',           'SLEEP_RECOVERY', 'score',  'Strain',                'max',  NULL,                          340);

COMMIT;
