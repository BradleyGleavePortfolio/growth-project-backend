-- PR-RLS-03 — Tier 2 scheduling and sessions.
--
-- Enables and FORCEs Row Level Security on the three Tier 2 scheduling /
-- sessions tables and installs the canonical policy set for each. Every
-- policy traces to a primitive declared in RLS_REMEDIATION_PLAN.md §3:
--
--   * CoachingSession     — Primitive A (service-role bypass) + Primitive D
--                           (client-self-or-coach) on coach_id / client_id.
--   * SessionParticipant  — Primitive A + the session-participant primitive:
--                           any participant of the parent session may SELECT;
--                           writes are gated ONLY by access to the parent
--                           CoachingSession (owning coach, the lead client's
--                           current coach, or the lead client adding/removing
--                           only themselves). Implemented with Primitive C
--                           (self on user_id) for SELECT and Primitive E
--                           (child-via-parent EXISTS against CoachingSession)
--                           for both SELECT and writes.
--   * SessionType         — Primitive A + Primitive C (coach-self on coach_id).
--
-- Helper functions (app.is_owner(), app.current_user_id(),
-- app.is_current_coach_of(text)) are provided by PR-RLS-FN and prior
-- migrations; this migration does not redefine them.
--
-- Rollback: drop the policies created here and, only on a confirmed P0
-- production outage, ALTER TABLE <t> DISABLE ROW LEVEL SECURITY. Otherwise
-- fix forward with a policy patch.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- CoachingSession — Tier 2; session details; primitive: client-self-or-coach.
--
-- WRITE actors (INSERT/UPDATE/DELETE), per Primitive D: the platform owner
-- (app.is_owner()), the session's own coach (coach_id = current_user_id()),
-- the lead client of the session (client_id = current_user_id()), or the lead
-- client's current coach (app.is_current_coach_of(client_id)). Each of these
-- predicates binds the row to a relationship the caller actually holds — a
-- caller cannot write a session whose coach_id/client_id is not themselves and
-- whose client they do not currently coach. This is NOT the SessionParticipant
-- IDOR class: there is no free "set this column to my own id and pass" escape,
-- because coach_id / client_id ARE the authorization columns for this table
-- (writing client_id = me means I am the lead client of that very session, by
-- definition the row I am entitled to). No change required for R2; comments
-- restated to document the authorized write actors explicitly (Fix 2).
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "CoachingSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachingSession" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachingsession_service_role_all" ON "CoachingSession";
CREATE POLICY "p_coachingsession_service_role_all" ON "CoachingSession" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachingsession_service_role_all" ON "CoachingSession" IS 'PR-RLS-03 Primitive A: service_role full bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachingsession_select" ON "CoachingSession";
CREATE POLICY "p_coachingsession_select" ON "CoachingSession" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachingsession_select" ON "CoachingSession" IS 'PR-RLS-03 Primitive D: owner, the session coach, the lead client, or the client''s current coach may read the session.';

DROP POLICY IF EXISTS "p_coachingsession_insert" ON "CoachingSession";
CREATE POLICY "p_coachingsession_insert" ON "CoachingSession" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachingsession_insert" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write: only the owner, the session''s own coach (coach_id = caller), the session''s lead client (client_id = caller), or that client''s current coach may create the session. coach_id/client_id ARE the authorization columns, so there is no IDOR escape — passing client_id = me means I am that session''s lead client by definition.';

DROP POLICY IF EXISTS "p_coachingsession_update" ON "CoachingSession";
CREATE POLICY "p_coachingsession_update" ON "CoachingSession" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachingsession_update" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write (USING + WITH CHECK): only the owner, the session''s own coach, the session''s lead client, or that client''s current coach may update the session. coach_id/client_id are the authorization columns; WITH CHECK prevents re-pointing the session to a coach/client the caller is not.';

DROP POLICY IF EXISTS "p_coachingsession_delete" ON "CoachingSession";
CREATE POLICY "p_coachingsession_delete" ON "CoachingSession" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachingsession_delete" ON "CoachingSession" IS 'PR-RLS-03 Primitive D write: only the owner, the session''s own coach, the session''s lead client, or that client''s current coach may delete the session.';

-- ───────────────────────────────────────────────────────────────────────────
-- SessionParticipant — Tier 2; session participant; primitive: session-participant.
--
-- READ (SELECT): any participant of the parent session can read — their OWN
-- row via user_id (Primitive C self-row), or any row of a session they can
-- otherwise access via the parent CoachingSession's coach/client/current-coach
-- predicate (Primitive E child-via-parent EXISTS).
--
-- WRITE (INSERT/UPDATE/DELETE): authorization is derived ONLY from access to
-- the PARENT CoachingSession — never from the participant row's own user_id.
-- The self-row predicate ("user_id" = app.current_user_id()) is deliberately
-- ABSENT from every write policy: it would let any authenticated user insert /
-- update / delete their own participant row on a session they have no other
-- right to touch (IDOR — Failure #2 missing/incorrect RLS, Failure #5 broken
-- object-level authorization). Authorized writers are:
--   (a) the session's owning coach            (cs.coach_id = current_user_id())
--   (b) the current coach of the lead client   (app.is_current_coach_of(cs.client_id))
--   (c) the session's lead client, SELF-ONLY   (cs.client_id = current_user_id()
--                                                AND row.user_id = cs.client_id)
-- Clause (c) implements the self-service scheduling decision in
-- REORG_DECISIONS_LOCKED.md (the lead client may add / remove THEMSELVES only).
-- The lead client can never add, modify, or remove ANY OTHER participant. The
-- platform owner (app.is_owner()) and service_role retain full bypass.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "SessionParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SessionParticipant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_sessionparticipant_service_role_all" ON "SessionParticipant";
CREATE POLICY "p_sessionparticipant_service_role_all" ON "SessionParticipant" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_sessionparticipant_service_role_all" ON "SessionParticipant" IS 'PR-RLS-03 Primitive A: service_role full bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_sessionparticipant_select" ON "SessionParticipant";
CREATE POLICY "p_sessionparticipant_select" ON "SessionParticipant" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR EXISTS (SELECT 1 FROM public."CoachingSession" cs WHERE cs."id" = "SessionParticipant"."session_id" AND (cs."coach_id" = app.current_user_id() OR cs."client_id" = app.current_user_id() OR app.is_current_coach_of(cs."client_id")))))));
COMMENT ON POLICY "p_sessionparticipant_select" ON "SessionParticipant" IS 'PR-RLS-03 session-participant primitive (Primitive C + E): owner, the participant themselves (user_id self-row), or anyone with access to the parent session (its coach, lead client, or the lead client''s current coach) may read the participant row. The self-row predicate is correct for SELECT only — never for writes.';

-- INSERT: WITH CHECK gates the NEW row. No self-row clause. The lead-client
-- branch additionally constrains NEW.user_id = cs.client_id so a client can
-- only add THEMSELVES, never another participant.
DROP POLICY IF EXISTS "p_sessionparticipant_insert" ON "SessionParticipant";
CREATE POLICY "p_sessionparticipant_insert" ON "SessionParticipant" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."CoachingSession" cs WHERE cs."id" = "SessionParticipant"."session_id" AND (cs."coach_id" = app.current_user_id() OR app.is_current_coach_of(cs."client_id") OR (cs."client_id" = app.current_user_id() AND "SessionParticipant"."user_id" = cs."client_id"))))));
COMMENT ON POLICY "p_sessionparticipant_insert" ON "SessionParticipant" IS 'PR-RLS-03 session-participant write (Primitive E child-via-parent): INSERT allowed when (a) caller is the session''s owning coach, OR (b) caller is the current coach of the session''s lead client, OR (c) caller is the session''s lead client adding themselves only (user_id = client_id). Owner/service_role bypass. Self-insert by arbitrary user_id is intentionally disallowed — prevents IDOR-style participation in inaccessible sessions (Failure #2 / #5).';

-- UPDATE: USING gates which existing row may be touched; WITH CHECK gates the
-- resulting row. The client branch on USING restricts to the client's OWN
-- participant row (OLD.user_id = client_id); the WITH CHECK branch forbids the
-- client from re-pointing the row to anyone else (NEW.user_id = client_id).
DROP POLICY IF EXISTS "p_sessionparticipant_update" ON "SessionParticipant";
CREATE POLICY "p_sessionparticipant_update" ON "SessionParticipant" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."CoachingSession" cs WHERE cs."id" = "SessionParticipant"."session_id" AND (cs."coach_id" = app.current_user_id() OR app.is_current_coach_of(cs."client_id") OR (cs."client_id" = app.current_user_id() AND "SessionParticipant"."user_id" = cs."client_id")))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."CoachingSession" cs WHERE cs."id" = "SessionParticipant"."session_id" AND (cs."coach_id" = app.current_user_id() OR app.is_current_coach_of(cs."client_id") OR (cs."client_id" = app.current_user_id() AND "SessionParticipant"."user_id" = cs."client_id"))))));
COMMENT ON POLICY "p_sessionparticipant_update" ON "SessionParticipant" IS 'PR-RLS-03 session-participant write (Primitive E child-via-parent): UPDATE allowed (USING + WITH CHECK) when (a) caller is the session''s owning coach, OR (b) caller is the current coach of the session''s lead client, OR (c) caller is the session''s lead client and the row is their own self-participation (user_id = client_id on both the existing and resulting row). Owner/service_role bypass. The self-row predicate user_id = current_user_id() is intentionally absent — prevents IDOR-style modification of participant rows on inaccessible sessions (Failure #2 / #5).';

-- DELETE: USING only. Same authorized-writer set; the client branch restricts
-- deletion to the client's own self-participation row.
DROP POLICY IF EXISTS "p_sessionparticipant_delete" ON "SessionParticipant";
CREATE POLICY "p_sessionparticipant_delete" ON "SessionParticipant" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."CoachingSession" cs WHERE cs."id" = "SessionParticipant"."session_id" AND (cs."coach_id" = app.current_user_id() OR app.is_current_coach_of(cs."client_id") OR (cs."client_id" = app.current_user_id() AND "SessionParticipant"."user_id" = cs."client_id"))))));
COMMENT ON POLICY "p_sessionparticipant_delete" ON "SessionParticipant" IS 'PR-RLS-03 session-participant write (Primitive E child-via-parent): DELETE allowed when (a) caller is the session''s owning coach, OR (b) caller is the current coach of the session''s lead client, OR (c) caller is the session''s lead client removing only their own self-participation row (user_id = client_id). Owner/service_role bypass. The self-row predicate user_id = current_user_id() is intentionally absent — prevents IDOR-style deletion of participant rows on inaccessible sessions (Failure #2 / #5).';

-- ───────────────────────────────────────────────────────────────────────────
-- SessionType — Tier 2; session type config; primitive: coach-self.
--
-- WRITE actors (INSERT/UPDATE/DELETE), per Primitive C: the platform owner
-- (app.is_owner()) or the owning coach (coach_id = current_user_id()). coach_id
-- IS the single authorization column for this table; a caller can only write a
-- row whose coach_id equals their own id, which by definition is a row they own.
-- This is NOT the SessionParticipant IDOR class — there is no parent object the
-- caller could be circumventing; the row's owner column and the authorization
-- column are one and the same. No change required for R2; comments restated to
-- document the authorized write actors explicitly (Fix 2).
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "SessionType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SessionType" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_sessiontype_service_role_all" ON "SessionType";
CREATE POLICY "p_sessiontype_service_role_all" ON "SessionType" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_sessiontype_service_role_all" ON "SessionType" IS 'PR-RLS-03 Primitive A: service_role full bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_sessiontype_select" ON "SessionType";
CREATE POLICY "p_sessiontype_select" ON "SessionType" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_sessiontype_select" ON "SessionType" IS 'PR-RLS-03 Primitive C: owner or the owning coach may read the session type.';

DROP POLICY IF EXISTS "p_sessiontype_insert" ON "SessionType";
CREATE POLICY "p_sessiontype_insert" ON "SessionType" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_sessiontype_insert" ON "SessionType" IS 'PR-RLS-03 Primitive C write: only the owner or the owning coach (coach_id = caller) may create the session type. coach_id is the sole authorization column, so the row the caller writes is by definition their own — no parent object to circumvent, not the SessionParticipant IDOR class.';

DROP POLICY IF EXISTS "p_sessiontype_update" ON "SessionType";
CREATE POLICY "p_sessiontype_update" ON "SessionType" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_sessiontype_update" ON "SessionType" IS 'PR-RLS-03 Primitive C write (USING + WITH CHECK): only the owner or the owning coach may update the session type; WITH CHECK prevents reassigning coach_id to another coach.';

DROP POLICY IF EXISTS "p_sessiontype_delete" ON "SessionType";
CREATE POLICY "p_sessiontype_delete" ON "SessionType" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_sessiontype_delete" ON "SessionType" IS 'PR-RLS-03 Primitive C write: only the owner or the owning coach may delete the session type.';

COMMIT;
