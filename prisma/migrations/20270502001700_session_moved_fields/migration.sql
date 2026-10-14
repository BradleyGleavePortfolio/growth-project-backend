-- C4MOVED (MOCKUP-3 C4 slice 6): a session records the start it had before its
-- most recent move, who moved it ('coach' or 'client') and when, so the client
-- can see what changed (C4-S-100, C4-S-101). Additive: three nullable columns
-- and their enum, no backfill (a session never moved, or moved before this
-- migration, reads null). The server writes them only when a move changes the
-- start (rescheduleSession); bookings, cancels and no-shows leave them alone.
-- Row rules unchanged: the columns are not in the authenticated column SELECT
-- grant (20270413000000), so no new reader exists at the row layer; the app
-- reads them only through the session API, which already scopes every session
-- to its own coach and client.
CREATE TYPE "SessionMovedBy" AS ENUM ('coach', 'client');

ALTER TABLE "CoachingSession"
  ADD COLUMN "moved_from_start_at" TIMESTAMP(3),
  ADD COLUMN "moved_by_role" "SessionMovedBy",
  ADD COLUMN "last_moved_at" TIMESTAMP(3);
