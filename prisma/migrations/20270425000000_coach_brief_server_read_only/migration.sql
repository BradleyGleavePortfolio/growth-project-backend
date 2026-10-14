-- BRIEFTEAM2 (agent 143; Sol B4 on #987): a coach no longer reads CoachBrief
-- rows directly through the Data API. TIGHTENING ONLY: one SELECT policy is
-- dropped; no data change, no other table touched.
--
-- GAP: coach_select_own_brief (20260525120000) let the brief's coach SELECT
-- the whole row by coach_id alone. A stored brief holds client names, message
-- previews and check-in counts; the server re-checks them against the
-- client's current coach, delegation and Coach sharing switches before it
-- returns a brief (CoachBriefService: writtenBefore, headBriefMisfits,
-- briefsNamingLostClients). A direct SELECT skipped every one of those checks,
-- so a client's withdrawal or move did not reach a coach who read the row.
--
-- NOW: briefs are read only through GET /coach/brief/today and /history
-- (Prisma on the server). Writes were already server-only. service_role keeps
-- coach_brief_service_role_bypass. Nothing in the mobile app reads the table.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "coach_select_own_brief" ON "CoachBrief";

COMMIT;
