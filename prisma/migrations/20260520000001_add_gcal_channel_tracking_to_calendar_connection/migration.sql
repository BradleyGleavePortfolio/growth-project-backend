-- B3: Add Google Calendar push-channel tracking columns to CalendarConnection
-- Migration: 20260520000001_add_gcal_channel_tracking_to_calendar_connection
--
-- Adds three nullable columns required for the channel-watch lifecycle:
--   channel_id         — UUID minted by us; Google echoes it on every
--                        push notification via X-Goog-Channel-ID. Unique
--                        so the webhook controller can look up the owning
--                        connection in O(1).
--   resource_id        — Opaque Google identifier returned by events.watch().
--                        Required as the body of a channels.stop() call.
--   channel_expires_at — Timestamp when the push channel expires (Google
--                        caps channels at 7 days). The channel-renewal
--                        cron (B5) queries WHERE channel_expires_at < now() + interval '48 hours'.
--
-- All three columns are nullable: they are only populated AFTER a successful
-- watchCalendar() call, which itself is only invoked from the OAuth callback
-- (B2, not yet shipped). Rows that pre-date the watch integration remain null
-- without any data migration.
--
-- RLS is also enabled here because CalendarConnection was created without it
-- in 20260512000000_concierge_scheduling. Engineering rules require RLS on every
-- tenant-scoped table; catching up in this migration is the correct pattern
-- (see rls_fitness_backend.sql, 20260606000003_rls_financial_tables for precedent).
--
-- FRESH-DATABASE SAFETY:
-- The RLS policies below reference two helpers — app.current_user_id() and
-- app.is_owner() — which are normally created by rls_fitness_backend.sql
-- (manual file) and reinforced by 20260607000000_rls_remaining_gaps.
-- Neither precedes us on a fresh `prisma migrate deploy`:
--   • rls_fitness_backend.sql is a loose .sql file in prisma/migrations and
--     is NOT executed by `prisma migrate deploy` (Prisma only runs
--     migration.sql inside numbered directories).
--   • 20260607000000_rls_remaining_gaps is dated AFTER this migration and
--     therefore runs LATER in deploy order.
-- To guarantee this migration applies cleanly on a fresh database AND a
-- partially migrated one, we self-bootstrap the schema + helpers below using
-- CREATE SCHEMA IF NOT EXISTS / CREATE OR REPLACE FUNCTION. These are no-ops
-- when the helpers already exist (idempotent on every re-run; the bodies match
-- the canonical definitions in rls_fitness_backend.sql and
-- 20260607000000_rls_remaining_gaps verbatim so a later CREATE OR REPLACE in
-- those scripts re-applies the same body).
--
-- SAFE TO RE-RUN:
--   • ADD COLUMN IF NOT EXISTS is idempotent.
--   • CREATE UNIQUE INDEX IF NOT EXISTS is idempotent.
--   • CREATE SCHEMA IF NOT EXISTS is idempotent.
--   • CREATE OR REPLACE FUNCTION matches the canonical body so it's a no-op
--     when the helper already exists, and a safe re-apply otherwise.
--   • DROP POLICY IF EXISTS precedes every CREATE POLICY.
--   • ENABLE/FORCE ROW LEVEL SECURITY are idempotent (no error when already on).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Self-bootstrap the `app` schema + RLS context helpers so this migration
--    is independent of rls_fitness_backend.sql and 20260607000000_rls_remaining_gaps.
--    Bodies are byte-for-byte the canonical definitions; later CREATE OR REPLACE
--    statements in those scripts are no-ops (or a safe re-install).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add the three new columns (nullable — populated post-watchCalendar only).
--    The unique index on channel_id is created separately with IF NOT EXISTS so
--    its name matches Prisma's expectation (CalendarConnection_channel_id_key)
--    and re-runs remain safe even if a prior partial run created the column
--    without the index.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CalendarConnection"
    ADD COLUMN IF NOT EXISTS "channel_id"         TEXT,
    ADD COLUMN IF NOT EXISTS "resource_id"        TEXT,
    ADD COLUMN IF NOT EXISTS "channel_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "CalendarConnection_channel_id_key"
    ON "CalendarConnection" ("channel_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Enable + force RLS (CalendarConnection was created without RLS in
--    20260512000000_concierge_scheduling; catching up here per ENGINEERING_RULES §2).
--    Both statements are idempotent — no error when already enabled.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CalendarConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarConnection" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS policies for CalendarConnection
--
-- Design:
--   • A coach (or any user) owns every CalendarConnection via user_id.
--     They may read and mutate only their own rows.
--   • Owner (platform admin) has unrestricted access for support tooling.
--   • The NestJS service_role connection (Supabase) bypasses RLS entirely
--     (BYPASSRLS on service_role), so no policy is needed for the API server
--     itself — these policies protect direct DB / Studio access and any future
--     anon-key paths.
-- ─────────────────────────────────────────────────────────────────────────────

-- Owner bypass (platform admin) -----------------------------------------------
DROP POLICY IF EXISTS "calendar_connection_owner_all" ON "CalendarConnection";
CREATE POLICY "calendar_connection_owner_all" ON "CalendarConnection"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- User self-access: each user sees and manages only their own connection --------
DROP POLICY IF EXISTS "calendar_connection_self_all" ON "CalendarConnection";
CREATE POLICY "calendar_connection_self_all" ON "CalendarConnection"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
  );

COMMIT;
