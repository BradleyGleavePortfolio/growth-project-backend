-- Doctrine cleanup: remove streak/badge/reaction primitives. See PR title.
--
-- Removes the gamification primitives that drifted into the data model
-- before the luxury-redesign doctrine cleanup. Mirror of the schema.prisma
-- excisions: WinReaction, UserBadge, and the BadgeSlug enum.
--
-- The `WinReaction` rows hung off `CommunityWin`; dropping the table also
-- drops the WinReaction -> CommunityWin and WinReaction -> User foreign
-- keys (Postgres drops dependent constraints with the table). The
-- `CommunityWin` rows themselves are preserved — only the per-Win
-- reactions go away. `UserBadge` is removed in full; nothing else in the
-- product references its rows or its slugs.
--
-- Reversibility: this is a non-`--accept-data-loss` shape. To roll back,
-- re-create the two tables and the enum (the original CREATE TABLE shapes
-- are recoverable from `git show <prior-commit>:prisma/schema.prisma`).
-- Bradley applies this migration manually via the Fly release_command
-- after taking a fresh database backup; it is NOT yet applied to prod.

-- -----------------------------------------------------------------
-- 1. Drop WinReaction table (and its dependent constraints/indexes).
-- -----------------------------------------------------------------

DROP TABLE IF EXISTS "WinReaction";

-- -----------------------------------------------------------------
-- 2. Drop UserBadge table (and its dependent constraints/indexes).
-- -----------------------------------------------------------------

DROP TABLE IF EXISTS "UserBadge";

-- -----------------------------------------------------------------
-- 3. Drop the BadgeSlug enum type. Must come AFTER the table that
--    referenced it; Postgres refuses to drop a type still in use.
-- -----------------------------------------------------------------

DROP TYPE IF EXISTS "BadgeSlug";
