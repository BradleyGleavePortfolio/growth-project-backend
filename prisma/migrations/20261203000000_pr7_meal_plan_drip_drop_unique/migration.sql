-- PR-7 — Packages & Drip-Feed: race guard for meal-plan drip materialisation.
--
-- Adds a nullable `drip_drop_id` column on `DailyMealPlanAssignment` with a
-- unique constraint. NULL is allowed (Postgres treats NULLs as distinct in
-- a UNIQUE), so:
--   • every pre-existing row is unaffected (column defaults to NULL),
--   • manual coach-assigned plans continue to set NULL (no constraint hit),
--   • drip-materialised assignments set the originating ScheduledDrop.id
--     here, and a concurrent retry of the same drop trips the UNIQUE on
--     the second INSERT. The resolver catches P2002 and re-reads the
--     winner's id — exactly the same idempotency pattern that
--     ClientAssetGrant.@@unique(client_id, media_asset_id) gives the
--     media resolver, and the same pattern that
--     ClientWorkoutAssignment.ai_draft_id @unique already gives the
--     Stream-2 AI workout materialiser.
--
-- Additive-only confirmation: NO DROP, NO RENAME, NO type change on any
-- existing column. The new column is NULLABLE with no DEFAULT, so the
-- ALTER TABLE is metadata-only — no row rewrite, no backfill required.

-- AlterTable
ALTER TABLE "DailyMealPlanAssignment" ADD COLUMN "drip_drop_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DailyMealPlanAssignment_drip_drop_id_key" ON "DailyMealPlanAssignment"("drip_drop_id");
