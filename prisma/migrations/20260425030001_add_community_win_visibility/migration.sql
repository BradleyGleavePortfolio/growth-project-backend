-- Adds the missing "visibility" column to "CommunityWin".
--
-- WHY: schema.prisma's CommunityWin model declares
--   visibility String @default("circle")   // "circle" | "public"
-- and the RLS policy p_communitywin_select in
-- 20261213000000_rls_tier5_notifications_community references
-- "visibility" = 'public'. But the original CreateTable in
-- 20260425030000_add_community_win_and_coach_guideline never added the
-- column, so the policy creation failed with: column "visibility" does
-- not exist. This forward migration adds the column with the same default
-- the schema declares, ordered after the table is created and before any
-- policy/diff references it.
--
-- IF NOT EXISTS keeps it idempotent and safe against environments where
-- the column may already have been added manually.

ALTER TABLE "CommunityWin"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'circle';
