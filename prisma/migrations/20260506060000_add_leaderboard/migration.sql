-- Phase 7C — Peer Leaderboard
-- Adds two opt-in fields to the User model:
--   show_on_leaderboard  — opt-in flag, defaults false (explicit consent required)
--   leaderboard_display_name — nullable; if null, the service derives
--                              "{firstName} {lastInitial}." at read time.
--
-- Migration name: 20260506060000_add_leaderboard
-- This migration is additive-only (no column drops, no renames).

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "show_on_leaderboard"       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "leaderboard_display_name"  TEXT;
