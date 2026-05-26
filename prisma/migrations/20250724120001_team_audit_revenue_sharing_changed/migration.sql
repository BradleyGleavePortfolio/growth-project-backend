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

-- Postgres requires the enum-value add to run OUTSIDE a transaction
-- when paired with a subsequent use in the same migration. This
-- migration only adds the value, so it can run in the default tx;
-- IF NOT EXISTS makes the migration idempotent for re-runs and for
-- environments where the value was added out-of-band.
ALTER TYPE "TeamAuditEventKind" ADD VALUE IF NOT EXISTS 'revenue_sharing_changed';
