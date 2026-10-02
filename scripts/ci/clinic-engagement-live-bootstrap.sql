-- #609 (C05 items 6-7): live RLS bootstrap for the clinic engagement tables.
--
-- Runs in the rls-live-tests job AFTER scripts/ci/rls01-live-bootstrap.sql,
-- the PR-RLS-01 helper migration and the clinic onboarding intake steps
-- (which provide "User" with deleted_at, app.current_user_id(),
-- app.current_user_role() and app.is_owner()). Like the other live
-- bootstraps it materialises only what the engagement migration needs,
-- because the full migration chain is not deployable from an empty database
-- (see rls01-live-bootstrap.sql):
--   * "NotificationPreferences" (the migration adds the two
--     workout_reminder_* columns to it), with the production key columns.
-- The engagement migration itself is then applied VERBATIM
-- (prisma/migrations/20270213000000_clinic_engagement/migration.sql), so the
-- suite asserts the real tables, policies and column defaults.

CREATE TABLE IF NOT EXISTS "NotificationPreferences" (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES "User"(id)
);
