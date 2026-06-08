-- PR-RLS-02 — Tier 2 coach/team admin row-level security.
--
-- Enables and FORCEs RLS on eight coach/team-admin tables and installs
-- SELECT/INSERT/UPDATE/DELETE policies plus a service_role bypass per the
-- canonical primitives in RLS_REMEDIATION_PLAN.md (§3, §5.02).
--
-- Auth convention (unchanged): the backend sets the session GUCs
--   app.current_user_id   — the acting user's id (TEXT), '' when anonymous.
--   app.current_user_role — the acting user's role ('owner' | 'coach' | 'student').
-- Helpers app.current_user_id(), app.is_owner(), app.is_current_coach_of(text)
-- resolve those GUCs. The NestJS service_role connection bypasses RLS, which is
-- why every table also carries an explicit PERMISSIVE service_role ALL policy
-- for server-side jobs and migrations.
--
-- Sub-Coach availability decision lock (product): a sub-coach (a `coach`-role
-- user who appears as a non-archived sub_coach_id in TeamSubCoachAssignment)
-- OWNS their own CoachAvailability / CoachAvailabilityOverride rows — those rows
-- carry coach_id = the sub-coach's user id, so the standard
-- `coach_id = app.current_user_id()` predicate already grants them full CRUD.
-- The head coach additionally gets SELECT-ONLY visibility on the availability of
-- sub-coaches assigned under their team, expressed via a non-archived
-- TeamSubCoachAssignment membership check that is present ONLY on the SELECT
-- policy (never on INSERT/UPDATE/DELETE).
--
-- Idempotent: every policy is DROP POLICY IF EXISTS'd before (re)creation so the
-- migration can be re-applied without error.

BEGIN;

-- =====================================================================
-- CoachAlert — coach/client alert. Primitive D: client-self-or-coach.
-- =====================================================================
ALTER TABLE "CoachAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachAlert" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachalert_service_role_all" ON "CoachAlert";
CREATE POLICY "p_coachalert_service_role_all" ON "CoachAlert" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachalert_service_role_all" ON "CoachAlert" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachalert_select" ON "CoachAlert";
CREATE POLICY "p_coachalert_select" ON "CoachAlert" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_select" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may read.';

DROP POLICY IF EXISTS "p_coachalert_insert" ON "CoachAlert";
CREATE POLICY "p_coachalert_insert" ON "CoachAlert" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_insert" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may insert.';

DROP POLICY IF EXISTS "p_coachalert_update" ON "CoachAlert";
CREATE POLICY "p_coachalert_update" ON "CoachAlert" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_update" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may update.';

DROP POLICY IF EXISTS "p_coachalert_delete" ON "CoachAlert";
CREATE POLICY "p_coachalert_delete" ON "CoachAlert" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachalert_delete" ON "CoachAlert" IS 'PR-RLS-02: owner, the alert coach, the alert client, or the client''s current coach may delete.';

-- =====================================================================
-- CoachNudge — coach nudge. Primitive D: client-self-or-coach.
-- =====================================================================
ALTER TABLE "CoachNudge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachNudge" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachnudge_service_role_all" ON "CoachNudge";
CREATE POLICY "p_coachnudge_service_role_all" ON "CoachNudge" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachnudge_service_role_all" ON "CoachNudge" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachnudge_select" ON "CoachNudge";
CREATE POLICY "p_coachnudge_select" ON "CoachNudge" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_select" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may read.';

DROP POLICY IF EXISTS "p_coachnudge_insert" ON "CoachNudge";
CREATE POLICY "p_coachnudge_insert" ON "CoachNudge" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_insert" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may insert.';

DROP POLICY IF EXISTS "p_coachnudge_update" ON "CoachNudge";
CREATE POLICY "p_coachnudge_update" ON "CoachNudge" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_update" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may update.';

DROP POLICY IF EXISTS "p_coachnudge_delete" ON "CoachNudge";
CREATE POLICY "p_coachnudge_delete" ON "CoachNudge" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_delete" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may delete.';

-- =====================================================================
-- CoachGuideline — coach guideline. Primitive D: client-self-or-coach.
-- =====================================================================
ALTER TABLE "CoachGuideline" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachGuideline" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachguideline_service_role_all" ON "CoachGuideline";
CREATE POLICY "p_coachguideline_service_role_all" ON "CoachGuideline" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachguideline_service_role_all" ON "CoachGuideline" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachguideline_select" ON "CoachGuideline";
CREATE POLICY "p_coachguideline_select" ON "CoachGuideline" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_select" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may read.';

DROP POLICY IF EXISTS "p_coachguideline_insert" ON "CoachGuideline";
CREATE POLICY "p_coachguideline_insert" ON "CoachGuideline" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_insert" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may insert.';

DROP POLICY IF EXISTS "p_coachguideline_update" ON "CoachGuideline";
CREATE POLICY "p_coachguideline_update" ON "CoachGuideline" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_update" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may update.';

DROP POLICY IF EXISTS "p_coachguideline_delete" ON "CoachGuideline";
CREATE POLICY "p_coachguideline_delete" ON "CoachGuideline" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachguideline_delete" ON "CoachGuideline" IS 'PR-RLS-02: owner, the guideline coach, the guideline client, or the client''s current coach may delete.';

-- =====================================================================
-- CoachOnboardingProgress — coach admin. Primitive C: coach-self.
-- =====================================================================
ALTER TABLE "CoachOnboardingProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachOnboardingProgress" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachonboardingprogress_service_role_all" ON "CoachOnboardingProgress";
CREATE POLICY "p_coachonboardingprogress_service_role_all" ON "CoachOnboardingProgress" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachonboardingprogress_service_role_all" ON "CoachOnboardingProgress" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachonboardingprogress_select" ON "CoachOnboardingProgress";
CREATE POLICY "p_coachonboardingprogress_select" ON "CoachOnboardingProgress" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachonboardingprogress_select" ON "CoachOnboardingProgress" IS 'PR-RLS-02: owner or the coach who owns the onboarding row may read.';

DROP POLICY IF EXISTS "p_coachonboardingprogress_insert" ON "CoachOnboardingProgress";
CREATE POLICY "p_coachonboardingprogress_insert" ON "CoachOnboardingProgress" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachonboardingprogress_insert" ON "CoachOnboardingProgress" IS 'PR-RLS-02: owner or the coach who owns the onboarding row may insert.';

DROP POLICY IF EXISTS "p_coachonboardingprogress_update" ON "CoachOnboardingProgress";
CREATE POLICY "p_coachonboardingprogress_update" ON "CoachOnboardingProgress" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachonboardingprogress_update" ON "CoachOnboardingProgress" IS 'PR-RLS-02: owner or the coach who owns the onboarding row may update.';

DROP POLICY IF EXISTS "p_coachonboardingprogress_delete" ON "CoachOnboardingProgress";
CREATE POLICY "p_coachonboardingprogress_delete" ON "CoachOnboardingProgress" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachonboardingprogress_delete" ON "CoachOnboardingProgress" IS 'PR-RLS-02: owner or the coach who owns the onboarding row may delete.';

-- =====================================================================
-- CoachEffectivenessScore — coach analytics.
-- Primitive: coach-self-read, owner-write. The coach may READ their own
-- score; only the owner (the analytics pipeline runs as service_role and
-- bypasses RLS) may INSERT/UPDATE/DELETE so a coach cannot fabricate scores.
-- =====================================================================
ALTER TABLE "CoachEffectivenessScore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachEffectivenessScore" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coacheffectivenessscore_service_role_all" ON "CoachEffectivenessScore";
CREATE POLICY "p_coacheffectivenessscore_service_role_all" ON "CoachEffectivenessScore" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coacheffectivenessscore_service_role_all" ON "CoachEffectivenessScore" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coacheffectivenessscore_select" ON "CoachEffectivenessScore";
CREATE POLICY "p_coacheffectivenessscore_select" ON "CoachEffectivenessScore" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coacheffectivenessscore_select" ON "CoachEffectivenessScore" IS 'PR-RLS-02: owner or the scored coach may read their own effectiveness score.';

DROP POLICY IF EXISTS "p_coacheffectivenessscore_insert" ON "CoachEffectivenessScore";
CREATE POLICY "p_coacheffectivenessscore_insert" ON "CoachEffectivenessScore" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_coacheffectivenessscore_insert" ON "CoachEffectivenessScore" IS 'PR-RLS-02: owner-only insert; coaches cannot fabricate their own analytics.';

DROP POLICY IF EXISTS "p_coacheffectivenessscore_update" ON "CoachEffectivenessScore";
CREATE POLICY "p_coacheffectivenessscore_update" ON "CoachEffectivenessScore" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_coacheffectivenessscore_update" ON "CoachEffectivenessScore" IS 'PR-RLS-02: owner-only update; coaches cannot alter their own analytics.';

DROP POLICY IF EXISTS "p_coacheffectivenessscore_delete" ON "CoachEffectivenessScore";
CREATE POLICY "p_coacheffectivenessscore_delete" ON "CoachEffectivenessScore" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_coacheffectivenessscore_delete" ON "CoachEffectivenessScore" IS 'PR-RLS-02: owner-only delete; coaches cannot remove their own analytics.';

-- =====================================================================
-- CoachAvailability — coach scheduling. Primitive C: coach-self.
-- Decision lock: the owning coach (incl. a sub-coach over their OWN rows)
-- gets full CRUD via coach_id = app.current_user_id(); the head coach gets
-- SELECT-ONLY on a sub-coach's availability via a non-archived
-- TeamSubCoachAssignment membership (present ONLY on the SELECT policy).
-- =====================================================================
ALTER TABLE "CoachAvailability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachAvailability" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachavailability_service_role_all" ON "CoachAvailability";
CREATE POLICY "p_coachavailability_service_role_all" ON "CoachAvailability" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachavailability_service_role_all" ON "CoachAvailability" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachavailability_select" ON "CoachAvailability";
CREATE POLICY "p_coachavailability_select" ON "CoachAvailability" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR EXISTS (SELECT 1 FROM public."TeamSubCoachAssignment" tsca WHERE tsca."sub_coach_id" = "CoachAvailability"."coach_id" AND tsca."head_coach_id" = app.current_user_id() AND tsca."archived_at" IS NULL)))));
COMMENT ON POLICY "p_coachavailability_select" ON "CoachAvailability" IS 'PR-RLS-02: owner or the owning coach (sub-coaches own their rows) may read; the head coach gets SELECT-only on sub-coaches under their team (non-archived TeamSubCoachAssignment).';

DROP POLICY IF EXISTS "p_coachavailability_insert" ON "CoachAvailability";
CREATE POLICY "p_coachavailability_insert" ON "CoachAvailability" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailability_insert" ON "CoachAvailability" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may insert; head coach has no write access.';

DROP POLICY IF EXISTS "p_coachavailability_update" ON "CoachAvailability";
CREATE POLICY "p_coachavailability_update" ON "CoachAvailability" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailability_update" ON "CoachAvailability" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may update; head coach has no write access.';

DROP POLICY IF EXISTS "p_coachavailability_delete" ON "CoachAvailability";
CREATE POLICY "p_coachavailability_delete" ON "CoachAvailability" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailability_delete" ON "CoachAvailability" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may delete; head coach has no write access.';

-- =====================================================================
-- CoachAvailabilityOverride — coach scheduling override. Primitive C: coach-self.
-- Same decision-lock shape as CoachAvailability: owning coach full CRUD,
-- head coach SELECT-only on team sub-coaches.
-- =====================================================================
ALTER TABLE "CoachAvailabilityOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachAvailabilityOverride" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachavailabilityoverride_service_role_all" ON "CoachAvailabilityOverride";
CREATE POLICY "p_coachavailabilityoverride_service_role_all" ON "CoachAvailabilityOverride" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachavailabilityoverride_service_role_all" ON "CoachAvailabilityOverride" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_coachavailabilityoverride_select" ON "CoachAvailabilityOverride";
CREATE POLICY "p_coachavailabilityoverride_select" ON "CoachAvailabilityOverride" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR EXISTS (SELECT 1 FROM public."TeamSubCoachAssignment" tsca WHERE tsca."sub_coach_id" = "CoachAvailabilityOverride"."coach_id" AND tsca."head_coach_id" = app.current_user_id() AND tsca."archived_at" IS NULL)))));
COMMENT ON POLICY "p_coachavailabilityoverride_select" ON "CoachAvailabilityOverride" IS 'PR-RLS-02: owner or the owning coach (sub-coaches own their rows) may read; the head coach gets SELECT-only on sub-coaches under their team (non-archived TeamSubCoachAssignment).';

DROP POLICY IF EXISTS "p_coachavailabilityoverride_insert" ON "CoachAvailabilityOverride";
CREATE POLICY "p_coachavailabilityoverride_insert" ON "CoachAvailabilityOverride" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailabilityoverride_insert" ON "CoachAvailabilityOverride" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may insert; head coach has no write access.';

DROP POLICY IF EXISTS "p_coachavailabilityoverride_update" ON "CoachAvailabilityOverride";
CREATE POLICY "p_coachavailabilityoverride_update" ON "CoachAvailabilityOverride" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailabilityoverride_update" ON "CoachAvailabilityOverride" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may update; head coach has no write access.';

DROP POLICY IF EXISTS "p_coachavailabilityoverride_delete" ON "CoachAvailabilityOverride";
CREATE POLICY "p_coachavailabilityoverride_delete" ON "CoachAvailabilityOverride" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachavailabilityoverride_delete" ON "CoachAvailabilityOverride" IS 'PR-RLS-02: owner or the owning coach (incl. a sub-coach over their own rows) may delete; head coach has no write access.';

-- =====================================================================
-- TeamAuditEvent — team audit. Primitive: head-coach-audit.
-- Visible to owner, the head coach who owns the feed, the actor who
-- performed the action, or the current coach of the target client.
-- =====================================================================
ALTER TABLE "TeamAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamAuditEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_teamauditevent_service_role_all" ON "TeamAuditEvent";
CREATE POLICY "p_teamauditevent_service_role_all" ON "TeamAuditEvent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_teamauditevent_service_role_all" ON "TeamAuditEvent" IS 'PR-RLS-02: service_role bypass for server-side jobs and migrations.';

DROP POLICY IF EXISTS "p_teamauditevent_select" ON "TeamAuditEvent";
CREATE POLICY "p_teamauditevent_select" ON "TeamAuditEvent" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "actor_user_id" = app.current_user_id() OR app.is_current_coach_of("target_client_id")))));
COMMENT ON POLICY "p_teamauditevent_select" ON "TeamAuditEvent" IS 'PR-RLS-02: owner, the head coach, the acting user, or the target client''s current coach may read.';

DROP POLICY IF EXISTS "p_teamauditevent_insert" ON "TeamAuditEvent";
CREATE POLICY "p_teamauditevent_insert" ON "TeamAuditEvent" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "actor_user_id" = app.current_user_id() OR app.is_current_coach_of("target_client_id")))));
COMMENT ON POLICY "p_teamauditevent_insert" ON "TeamAuditEvent" IS 'PR-RLS-02: owner, the head coach, the acting user, or the target client''s current coach may insert.';

DROP POLICY IF EXISTS "p_teamauditevent_update" ON "TeamAuditEvent";
CREATE POLICY "p_teamauditevent_update" ON "TeamAuditEvent" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "actor_user_id" = app.current_user_id() OR app.is_current_coach_of("target_client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "actor_user_id" = app.current_user_id() OR app.is_current_coach_of("target_client_id")))));
COMMENT ON POLICY "p_teamauditevent_update" ON "TeamAuditEvent" IS 'PR-RLS-02: owner, the head coach, the acting user, or the target client''s current coach may update.';

DROP POLICY IF EXISTS "p_teamauditevent_delete" ON "TeamAuditEvent";
CREATE POLICY "p_teamauditevent_delete" ON "TeamAuditEvent" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("head_coach_id" = app.current_user_id() OR "actor_user_id" = app.current_user_id() OR app.is_current_coach_of("target_client_id")))));
COMMENT ON POLICY "p_teamauditevent_delete" ON "TeamAuditEvent" IS 'PR-RLS-02: owner, the head coach, the acting user, or the target client''s current coach may delete.';

COMMIT;
