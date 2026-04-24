-- Tier-2: Meal-plan persistence + coach-visible check-ins.
--
-- Two changes, both strictly additive relative to previously-deployed state:
--
--   1. New MealPlan table backing the coach → client meal-plan feature which
--      had only been writing to local SQLite on-device.
--
--   2. Extend the existing CheckIn table with three new nullable columns
--      (coach_id, sleep_hours, weight_kg) + a unique (user_id, date) index so
--      the new POST /check-ins endpoint can upsert one row per client per day.
--      Also relax mood/energy from NOT NULL to NULL because the Tier-2 API
--      treats every subjective field as optional — existing rows already have
--      values and are unaffected.
--
-- All changes are additive: no column drops, no destructive rewrites, no
-- changes to existing FKs. Deploys can be rolled back by dropping the new
-- columns/table; no data loss.

-- -----------------------------------------------------------------
-- 1. MealPlan table
-- -----------------------------------------------------------------

CREATE TABLE "MealPlan" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "MealPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MealPlan_coach_id_idx" ON "MealPlan"("coach_id");
CREATE INDEX "MealPlan_client_id_idx" ON "MealPlan"("client_id");
CREATE INDEX "MealPlan_coach_id_client_id_created_at_idx"
    ON "MealPlan"("coach_id", "client_id", "created_at");

ALTER TABLE "MealPlan"
    ADD CONSTRAINT "MealPlan_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MealPlan"
    ADD CONSTRAINT "MealPlan_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------
-- 2. CheckIn additions
-- -----------------------------------------------------------------

ALTER TABLE "CheckIn" ADD COLUMN "coach_id"    TEXT;
ALTER TABLE "CheckIn" ADD COLUMN "sleep_hours" DOUBLE PRECISION;
ALTER TABLE "CheckIn" ADD COLUMN "weight_kg"   DOUBLE PRECISION;

-- Relax mood/energy to nullable so Tier-2 API clients can omit them.
-- Existing rows still have their prior values; no data rewrite.
ALTER TABLE "CheckIn" ALTER COLUMN "mood"   DROP NOT NULL;
ALTER TABLE "CheckIn" ALTER COLUMN "energy" DROP NOT NULL;

CREATE INDEX "CheckIn_coach_id_date_idx" ON "CheckIn"("coach_id", "date");

-- One check-in per client per calendar day — backs POST /check-ins upsert.
CREATE UNIQUE INDEX "CheckIn_user_id_date_key" ON "CheckIn"("user_id", "date");

ALTER TABLE "CheckIn"
    ADD CONSTRAINT "CheckIn_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
