-- Phase 7A — Day 1 Win Sequence
--
-- Adds `first_win_completed_at` (nullable DateTime) to the User table.
-- This field is set once — on the first time a new client completes any
-- Day 1 Win action — and is never cleared. It gates the Day1WinScreen
-- in the mobile app: if the value is non-null the screen is permanently
-- skipped on every subsequent cold start.
--
-- Additive only. No existing column, row, or constraint is altered.
-- Nullable by design — existing rows stay valid (null = never completed).
-- The backend endpoint enforces the "set once, idempotent" rule so no
-- DEFAULT or CHECK constraint is needed here.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "first_win_completed_at" TIMESTAMP(3);

-- Index to let the gating query (lookup by user id, check for null) use
-- an index scan instead of a seq scan once the table is large.
CREATE INDEX IF NOT EXISTS "User_first_win_completed_at_idx"
  ON "User"("first_win_completed_at");
