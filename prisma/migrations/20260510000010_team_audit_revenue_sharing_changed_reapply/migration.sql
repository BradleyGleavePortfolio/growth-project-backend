-- Migration: team_audit_revenue_sharing_changed_reapply
--
-- IRREVERSIBLE: reapplies the 'revenue_sharing_changed' enum value to
-- "TeamAuditEventKind" AFTER the enum is created by
-- 20260510000000_add_team_mode. The original migration
-- (20250724120001_team_audit_revenue_sharing_changed) ran before the enum
-- existed due to a pre-existing lexical-ordering bug and is now guarded to
-- no-op on a clean DB; this sibling migration is what actually adds the value
-- on a freshly built DB. Postgres does not support removing an enum value, so
-- there is no safe down path.
--
-- Idempotent: ADD VALUE IF NOT EXISTS is a no-op on production DBs (and on the
-- add_team_mode base) that already carry the value. NOT wrapped in a DO/plpgsql
-- block on purpose — `ALTER TYPE ... ADD VALUE` cannot be executed from inside
-- a function body. By this point in the forward history the enum is guaranteed
-- to exist (created two migrations earlier), so no presence guard is needed.

ALTER TYPE "TeamAuditEventKind" ADD VALUE IF NOT EXISTS 'revenue_sharing_changed';
