-- ED.2 (Roman three-arc router) — daily-rings review-arc composite index.
--
-- Additive only. The Coach Home daily-rings "review" arc counts a coach's
-- ConversationReview rows whose coach_reviewed_at lands inside today's UTC
-- window:
--
--   SELECT count(*) FROM "ConversationReview"
--   WHERE "coach_id" = $1 AND "coach_reviewed_at" BETWEEN $2 AND $3;
--
-- That is equality on coach_id + a range on coach_reviewed_at, which the
-- existing single-column @@index([coach_id]) cannot serve as a range scan. This
-- composite (coach_id, coach_reviewed_at) index serves the predicate directly.
-- CREATE INDEX IF NOT EXISTS keeps the apply idempotent and append-safe.
--
-- Timestamp 20261219000000 is strictly AFTER the most recent landed migration
-- (20261218000000_add_coach_reviewed_at) so the ordered apply never reorders
-- behind a landed migration (R76 §6 / ENGINEERING_RULES §2 append-only).
--
-- RLS: no policy change — "ConversationReview" already ENABLEs + FORCEs RLS
-- with its owner-bypass and participant-scoped policies
-- (20261218000000_add_coach_reviewed_at). An index carries no row visibility.
--
-- Rollback (reverse): DROP INDEX IF EXISTS
-- "ConversationReview_coach_id_coach_reviewed_at_idx". The index is purely a
-- read optimisation (no data, no constraint), so the down path is a single
-- DROP INDEX with no data loss. Only on a confirmed P0; otherwise fix forward.

BEGIN;

-- CreateIndex — composite index serving the daily-rings review-arc range query.
CREATE INDEX IF NOT EXISTS "ConversationReview_coach_id_coach_reviewed_at_idx" ON "ConversationReview"("coach_id", "coach_reviewed_at");

COMMIT;
