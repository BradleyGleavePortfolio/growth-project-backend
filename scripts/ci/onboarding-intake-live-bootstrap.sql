-- Fix round B607-3: live RLS bootstrap for the clinic onboarding intake tables.
--
-- Runs in the rls-live-tests job AFTER scripts/ci/rls01-live-bootstrap.sql and
-- the PR-RLS-01 helper migration (which provide "User", app.current_user_id(),
-- app.current_user_role() and app.is_owner()). Like the RLS-01 bootstrap it
-- materialises only what the suite needs, because the full migration chain is
-- not deployable from an empty database (see rls01-live-bootstrap.sql):
--   * "User".deleted_at (the audience predicate refuses soft-deleted users)
--   * "SubCoachAssignment" with the production column names/types
-- The onboarding migration itself is then applied VERBATIM
-- (prisma/migrations/20270212000000_clinic_onboarding_intake/migration.sql),
-- so the suite asserts the real tables, helper and policies.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "SubCoachAssignment" (
  id             TEXT PRIMARY KEY,
  head_coach_id  TEXT NOT NULL REFERENCES "User"(id),
  sub_coach_id   TEXT NOT NULL REFERENCES "User"(id),
  client_id      TEXT NOT NULL REFERENCES "User"(id),
  assigned_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unassigned_at  TIMESTAMP(3),
  assigned_by_id TEXT,
  reason         TEXT
);
