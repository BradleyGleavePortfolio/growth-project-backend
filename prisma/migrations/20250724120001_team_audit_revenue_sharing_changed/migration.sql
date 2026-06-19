-- Migration: team_audit_revenue_sharing_changed
--
-- Fixes A1-C6-INF-1: schema declares the enum value but no migration
-- adds it to Postgres, so `prisma migrate deploy` in CI/prod would
-- surface drift detection. This migration adds the value explicitly.
--
-- Pair: A1-C6-P1-1 (revenue-sharing change has no audit row) — the
-- team.service.ts setRevenueSharing path writes a TeamAuditEvent with
-- event_kind: 'revenue_sharing_changed' inside the same $transaction
-- as the FeePolicy upsert; the Postgres enum must contain that value
-- for the insert to succeed.
--
-- ── ORDERING-BUG GUARD (no-op-on-missing) ──────────────────────────────────
-- Same pre-existing lexical-ordering defect as the sibling
-- 20250724120000_subcoach_invite_token_hash migration: the "TeamAuditEventKind"
-- enum is actually CREATEd in a LATER-dated migration
-- (20260510000000_add_team_mode), so on a clean DB a forward
-- `prisma migrate deploy` runs this ALTER TYPE before the enum exists and
-- aborts with P3018 / 42704 ("type \"TeamAuditEventKind\" does not exist").
--
-- Fix: guard the ALTER TYPE behind a pg_type presence check so a clean-DB
-- forward migration no-ops here and succeeds. The enum value is (re)added
-- AFTER the enum is created by the new sibling migration
-- 20260510000010_team_audit_revenue_sharing_changed_reapply. On production DBs
-- where this migration already applied, the body runs identically and the
-- ADD VALUE IF NOT EXISTS remains idempotent.
--
-- NOTE on Prisma checksum drift: editing this file changes its
-- `_prisma_migrations.checksum`; see the PR body / OPERATOR_ATTACH for the
-- one-time checksum reconcile the operator must run on prod. The edit is a
-- guard-only semantic no-op.

-- Postgres requires the enum-value add to run OUTSIDE a transaction
-- when paired with a subsequent use in the same migration. This
-- migration only adds the value, so it can run in the default tx;
-- IF NOT EXISTS makes the migration idempotent for re-runs and for
-- environments where the value was added out-of-band.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TeamAuditEventKind') THEN
    ALTER TYPE "TeamAuditEventKind" ADD VALUE IF NOT EXISTS 'revenue_sharing_changed';
  END IF;
END $$;
