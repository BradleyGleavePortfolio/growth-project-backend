-- Exercise video provider enrichment — Phase: video-providers
--
-- Adds two columns to ExerciseCatalogItem to permanently store matched
-- video URLs from third-party providers (MuscleWiki MP4, YMove HLS slug).
--
-- Design rationale:
--   * video_url      — stores stable MuscleWiki MP4 CDN URLs or a YMove
--                      exercise slug (NOT the pre-signed URL, which expires
--                      in 48h). For YMove the enrichment script stores the
--                      normalised exercise slug so the live endpoint can
--                      always fetch a fresh signed URL.
--   * video_provider — 'ymove' | 'musclewiki' — tells the runtime which
--                      provider owns the URL so it can apply the correct
--                      refresh strategy.
--
-- These columns are nullable: rows without a provider match retain NULL and
-- the runtime falls back to the existing gifUrl from ExerciseDB.
--
-- All columns are additive; no backfill is required at migration time.
-- Run scripts/enrich-exercise-catalog-videos.ts to populate them.

ALTER TABLE "ExerciseCatalogItem"
  ADD COLUMN IF NOT EXISTS "video_url"      TEXT,
  ADD COLUMN IF NOT EXISTS "video_provider" TEXT;

-- Index for analytics / filtering: find all rows that have been enriched.
CREATE INDEX IF NOT EXISTS "ExerciseCatalogItem_video_provider_idx"
  ON "ExerciseCatalogItem"("video_provider");
