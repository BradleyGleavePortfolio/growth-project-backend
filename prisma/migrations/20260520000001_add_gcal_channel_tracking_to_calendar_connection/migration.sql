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
-- SAFE TO RE-RUN: DROP POLICY IF EXISTS precedes every CREATE POLICY;
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS is idempotent.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add the three new columns (nullable — populated post-watchCalendar only)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CalendarConnection"
    ADD COLUMN IF NOT EXISTS "channel_id"         TEXT        UNIQUE,
    ADD COLUMN IF NOT EXISTS "resource_id"        TEXT,
    ADD COLUMN IF NOT EXISTS "channel_expires_at" TIMESTAMP(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Enable + force RLS (CalendarConnection was created without RLS in
--    20260512000000_concierge_scheduling; catching up here per ENGINEERING_RULES §2)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CalendarConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CalendarConnection" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS policies for CalendarConnection
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
