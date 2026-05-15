-- Video library v1 — ExerciseCatalogItem.
--
-- Canonical, owner-curated exercise catalog. Coexists with the legacy
-- ExerciseDB proxy (src/exercise-library) which remains the wider catalog
-- fallback for the workout builder. This table is the source of truth for
-- any exercise the platform owns a Mux demo video for.
--
-- All columns are additive; no backfill required.

-- 1. Status enum ----------------------------------------------------------
CREATE TYPE "ExerciseVideoStatus" AS ENUM (
    'none',
    'uploading',
    'processing',
    'ready',
    'errored'
);

-- 2. ExerciseCatalogItem table -------------------------------------------
CREATE TABLE "ExerciseCatalogItem" (
    "id"                   TEXT NOT NULL,
    "slug"                 TEXT NOT NULL,
    "name"                 TEXT NOT NULL,
    "category"             TEXT NOT NULL,
    "primary_muscle"       TEXT NOT NULL,
    "secondary_muscles"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "equipment"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "difficulty"           TEXT NOT NULL DEFAULT 'beginner',
    "instructions"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source_ref"           TEXT,
    "mux_asset_id"         TEXT,
    "mux_playback_id"      TEXT,
    "mux_playback_policy"  TEXT NOT NULL DEFAULT 'public',
    "mux_asset_status"     "ExerciseVideoStatus" NOT NULL DEFAULT 'none',
    "mux_duration_seconds" DOUBLE PRECISION,
    "mux_error_message"    TEXT,
    "mux_upload_id"        TEXT,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExerciseCatalogItem_pkey" PRIMARY KEY ("id")
);

-- Unique constraints (slug + upload id are functional keys).
CREATE UNIQUE INDEX "ExerciseCatalogItem_slug_key"
    ON "ExerciseCatalogItem"("slug");
CREATE UNIQUE INDEX "ExerciseCatalogItem_mux_upload_id_key"
    ON "ExerciseCatalogItem"("mux_upload_id");

-- Lookup indexes for the list endpoint's chip filters.
CREATE INDEX "ExerciseCatalogItem_category_idx"
    ON "ExerciseCatalogItem"("category");
CREATE INDEX "ExerciseCatalogItem_primary_muscle_idx"
    ON "ExerciseCatalogItem"("primary_muscle");
CREATE INDEX "ExerciseCatalogItem_mux_asset_id_idx"
    ON "ExerciseCatalogItem"("mux_asset_id");
