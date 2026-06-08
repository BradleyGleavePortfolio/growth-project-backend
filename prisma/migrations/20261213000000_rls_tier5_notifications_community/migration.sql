-- PR-RLS-07 — Tier 5 notifications / community / infra RLS policies.
--
-- Final RLS PR in the remediation cycle. Enables Row-Level Security on the six
-- remaining Tier-5 tables and installs the canonical policy primitives from
-- RLS_REMEDIATION_PLAN.md §3:
--
--   * EmailSendLog            — service-role-only (no owner column; email PII).
--   * NotificationDeliveryLog — user-self-owner on user_id.
--   * NotificationDigestLog   — user-self-owner on user_id.
--   * CommunityWin            — community-win: author (user_id) + assigned coach
--                               (coach_id) + current coach of the author. READS
--                               additionally include public-visibility rows;
--                               public visibility is NEVER a write path.
--   * HabitLog                — child-via-habit: ownership resolved through
--                               public."Habit".user_id (and the author's coach).
--   * _prisma_migrations      — service-role-only migration metadata. SPECIAL
--                               HANDLING — see the dedicated section below.
--
-- All five application tables use ENABLE + FORCE ROW LEVEL SECURITY. The runtime
-- app connects as Supabase `service_role` (BYPASSRLS) and scopes itself by
-- setting the app.current_user_id / app.current_user_role session GUCs, which the
-- helper functions (app.current_user_id(), app.is_owner(),
-- app.is_current_coach_of()) read; the `*_service_role_all` PERMISSIVE policy is
-- the explicit bypass for server-side jobs. FORCE is safe on these tables because
-- no non-bypass role legitimately owns them at runtime.
--
-- Helper functions are provided by the prior migrations (search_path-hardened in
-- 20261212000000_rls_helper_search_path): app.current_user_id(),
-- app.current_user_role(), app.is_owner(), app.is_current_coach_of(text).
--
-- Rollback: DROP the policies created here and run
--   ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ONLY if a confirmed P0 production outage requires it; otherwise fix forward
-- with a policy patch.

BEGIN;

-- Defensive, idempotent schema guard (matches every prior RLS migration). In the
-- migration chain `app` already exists; this keeps the migration self-sufficient
-- if replayed in isolation and is a no-op otherwise.
CREATE SCHEMA IF NOT EXISTS app;

-- ============================================================================
-- EmailSendLog — Primitive A (service-role-only) + Primitive B (owner admin).
-- No user_id column exists (see plan §6A): protect as service/owner-only. Email
-- recipient PII must never leak to tenant users.
-- ============================================================================
ALTER TABLE "EmailSendLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailSendLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_emailsendlog_service_role_all" ON "EmailSendLog";
CREATE POLICY "p_emailsendlog_service_role_all" ON "EmailSendLog" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_emailsendlog_service_role_all" ON "EmailSendLog" IS
  'PR-RLS-07: service_role bypass for server-side email-send jobs and migrations.';

DROP POLICY IF EXISTS "p_emailsendlog_select" ON "EmailSendLog";
CREATE POLICY "p_emailsendlog_select" ON "EmailSendLog" AS PERMISSIVE FOR SELECT TO public USING (app.is_owner());
COMMENT ON POLICY "p_emailsendlog_select" ON "EmailSendLog" IS
  'PR-RLS-07: owner-only SELECT — email delivery PII has no tenant owner column.';

DROP POLICY IF EXISTS "p_emailsendlog_insert" ON "EmailSendLog";
CREATE POLICY "p_emailsendlog_insert" ON "EmailSendLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_emailsendlog_insert" ON "EmailSendLog" IS
  'PR-RLS-07: owner-only INSERT — tenant users may not write email-send rows.';

DROP POLICY IF EXISTS "p_emailsendlog_update" ON "EmailSendLog";
CREATE POLICY "p_emailsendlog_update" ON "EmailSendLog" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_emailsendlog_update" ON "EmailSendLog" IS
  'PR-RLS-07: owner-only UPDATE — tenant users may not mutate email-send rows.';

DROP POLICY IF EXISTS "p_emailsendlog_delete" ON "EmailSendLog";
CREATE POLICY "p_emailsendlog_delete" ON "EmailSendLog" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_emailsendlog_delete" ON "EmailSendLog" IS
  'PR-RLS-07: owner-only DELETE — tenant users may not delete email-send rows.';

-- ============================================================================
-- NotificationDeliveryLog — Primitive C (user-self-owner on user_id).
-- A user reads/owns their own per-session notification delivery records; the
-- service role writes them. Cross-user reads/writes are denied.
-- ============================================================================
ALTER TABLE "NotificationDeliveryLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDeliveryLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_notificationdeliverylog_service_role_all" ON "NotificationDeliveryLog";
CREATE POLICY "p_notificationdeliverylog_service_role_all" ON "NotificationDeliveryLog" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_notificationdeliverylog_service_role_all" ON "NotificationDeliveryLog" IS
  'PR-RLS-07: service_role bypass for the notification dispatcher.';

DROP POLICY IF EXISTS "p_notificationdeliverylog_select" ON "NotificationDeliveryLog";
CREATE POLICY "p_notificationdeliverylog_select" ON "NotificationDeliveryLog" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdeliverylog_select" ON "NotificationDeliveryLog" IS
  'PR-RLS-07: owner or the user themselves may read their delivery records.';

DROP POLICY IF EXISTS "p_notificationdeliverylog_insert" ON "NotificationDeliveryLog";
CREATE POLICY "p_notificationdeliverylog_insert" ON "NotificationDeliveryLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdeliverylog_insert" ON "NotificationDeliveryLog" IS
  'PR-RLS-07: owner or self INSERT — a user may only write rows scoped to themselves.';

DROP POLICY IF EXISTS "p_notificationdeliverylog_update" ON "NotificationDeliveryLog";
CREATE POLICY "p_notificationdeliverylog_update" ON "NotificationDeliveryLog" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdeliverylog_update" ON "NotificationDeliveryLog" IS
  'PR-RLS-07: owner or self UPDATE — both the existing and the new row must be self-owned.';

DROP POLICY IF EXISTS "p_notificationdeliverylog_delete" ON "NotificationDeliveryLog";
CREATE POLICY "p_notificationdeliverylog_delete" ON "NotificationDeliveryLog" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdeliverylog_delete" ON "NotificationDeliveryLog" IS
  'PR-RLS-07: owner or self DELETE — a user may only delete their own delivery records.';

-- ============================================================================
-- NotificationDigestLog — Primitive C (user-self-owner on user_id).
-- A user reads/owns their own digest send records; the service role writes them.
-- ============================================================================
ALTER TABLE "NotificationDigestLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDigestLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_notificationdigestlog_service_role_all" ON "NotificationDigestLog";
CREATE POLICY "p_notificationdigestlog_service_role_all" ON "NotificationDigestLog" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_notificationdigestlog_service_role_all" ON "NotificationDigestLog" IS
  'PR-RLS-07: service_role bypass for the digest scheduler.';

DROP POLICY IF EXISTS "p_notificationdigestlog_select" ON "NotificationDigestLog";
CREATE POLICY "p_notificationdigestlog_select" ON "NotificationDigestLog" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdigestlog_select" ON "NotificationDigestLog" IS
  'PR-RLS-07: owner or the user themselves may read their digest records.';

DROP POLICY IF EXISTS "p_notificationdigestlog_insert" ON "NotificationDigestLog";
CREATE POLICY "p_notificationdigestlog_insert" ON "NotificationDigestLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdigestlog_insert" ON "NotificationDigestLog" IS
  'PR-RLS-07: owner or self INSERT — a user may only write digest rows scoped to themselves.';

DROP POLICY IF EXISTS "p_notificationdigestlog_update" ON "NotificationDigestLog";
CREATE POLICY "p_notificationdigestlog_update" ON "NotificationDigestLog" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdigestlog_update" ON "NotificationDigestLog" IS
  'PR-RLS-07: owner or self UPDATE — both the existing and the new row must be self-owned.';

DROP POLICY IF EXISTS "p_notificationdigestlog_delete" ON "NotificationDigestLog";
CREATE POLICY "p_notificationdigestlog_delete" ON "NotificationDigestLog" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_notificationdigestlog_delete" ON "NotificationDigestLog" IS
  'PR-RLS-07: owner or self DELETE — a user may only delete their own digest records.';

-- ============================================================================
-- CommunityWin — community-win primitive.
-- Visibility model (cohort semantics, per src/community/community.service.ts):
--   * The author (user_id) owns the row.
--   * The assigned coach (coach_id) — the win is stamped with the author's coach
--     at write time — reads the row; this is the "cohort" (roster) read path:
--     the feed query selects rows WHERE coach_id = <viewer's coach roster>.
--   * The author's *current* coach (app.is_current_coach_of(user_id)) reads and
--     moderates (UPDATE/DELETE) the row even if coach_id drifted.
--   * visibility='public' rows are world-readable to authenticated users — this
--     is a READ-ONLY path (p_communitywin_select). It is NOT a write
--     authorization path: INSERT/UPDATE/DELETE never consult visibility, so an
--     authenticated user cannot forge, mutate, or delete another user's public
--     win (IDOR / Failure #5 — broken object-level authorization).
--   * Backend owner (app.is_owner()) has full administrative access.
-- ============================================================================
ALTER TABLE "CommunityWin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommunityWin" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_communitywin_service_role_all" ON "CommunityWin";
CREATE POLICY "p_communitywin_service_role_all" ON "CommunityWin" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_communitywin_service_role_all" ON "CommunityWin" IS
  'PR-RLS-07: service_role bypass for server-side community jobs.';

DROP POLICY IF EXISTS "p_communitywin_select" ON "CommunityWin";
CREATE POLICY "p_communitywin_select" ON "CommunityWin" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR ("visibility" = 'public') OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_select" ON "CommunityWin" IS
  'PR-RLS-07: author, assigned/current coach (cohort read), public-visibility, or owner may read a win.';

DROP POLICY IF EXISTS "p_communitywin_insert" ON "CommunityWin";
CREATE POLICY "p_communitywin_insert" ON "CommunityWin" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_insert" ON "CommunityWin" IS
  'PR-RLS-07: INSERT allowed when caller is the win author (user_id = app.current_user_id()), the current coach of the author (app.is_current_coach_of(user_id)), or the service-role/owner bypass (app.is_owner()). visibility=''public'' grants READ access (see p_communitywin_select) but never WRITE access — preventing IDOR-style forging of public wins for other users.';

DROP POLICY IF EXISTS "p_communitywin_update" ON "CommunityWin";
CREATE POLICY "p_communitywin_update" ON "CommunityWin" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_update" ON "CommunityWin" IS
  'PR-RLS-07: UPDATE allowed when caller is the win author (user_id = app.current_user_id()), the assigned coach (coach_id = app.current_user_id()), the current coach of the author (app.is_current_coach_of(user_id)), or the service-role/owner bypass (app.is_owner()). visibility=''public'' grants READ access (see p_communitywin_select) but never WRITE access — preventing IDOR-style mutation of other users'' public wins.';

DROP POLICY IF EXISTS "p_communitywin_delete" ON "CommunityWin";
CREATE POLICY "p_communitywin_delete" ON "CommunityWin" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_delete" ON "CommunityWin" IS
  'PR-RLS-07: DELETE allowed when caller is the win author (user_id = app.current_user_id()), the assigned coach (coach_id = app.current_user_id()), the current coach of the author (app.is_current_coach_of(user_id)), or the service-role/owner bypass (app.is_owner()). visibility=''public'' grants READ access (see p_communitywin_select) but never WRITE access — preventing IDOR-style deletion of other users'' public wins.';

-- ============================================================================
-- HabitLog — Primitive E (child-via-habit). HabitLog has no direct owner column;
-- ownership is resolved through public."Habit".user_id. The habit owner and that
-- owner's current coach may read/write the logs.
-- ============================================================================
ALTER TABLE "HabitLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HabitLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_habitlog_service_role_all" ON "HabitLog";
CREATE POLICY "p_habitlog_service_role_all" ON "HabitLog" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_habitlog_service_role_all" ON "HabitLog" IS
  'PR-RLS-07: service_role bypass for server-side habit jobs.';

DROP POLICY IF EXISTS "p_habitlog_select" ON "HabitLog";
CREATE POLICY "p_habitlog_select" ON "HabitLog" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_select" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may read a habit log.';

DROP POLICY IF EXISTS "p_habitlog_insert" ON "HabitLog";
CREATE POLICY "p_habitlog_insert" ON "HabitLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_insert" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may write a habit log.';

DROP POLICY IF EXISTS "p_habitlog_update" ON "HabitLog";
CREATE POLICY "p_habitlog_update" ON "HabitLog" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_update" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may update a habit log.';

DROP POLICY IF EXISTS "p_habitlog_delete" ON "HabitLog";
CREATE POLICY "p_habitlog_delete" ON "HabitLog" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_delete" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may delete a habit log.';

-- ============================================================================
-- _prisma_migrations — SPECIAL HANDLING (migration metadata; service-role-only).
--
-- FOOT-GUN: this is the table Prisma's own migration runner writes to. With
-- `prisma migrate deploy` the runner INSERTs/UPDATEs a row here for every
-- migration it applies, connecting as the DATABASE_URL/DIRECT_URL role.
--
-- `FORCE ROW LEVEL SECURITY` subjects EVEN THE TABLE OWNER to RLS — only
-- superusers and BYPASSRLS roles are exempt. Under the plan's literal SQL
-- (FORCE + an app.is_owner()-gated INSERT policy), a NON-superuser owner role
-- (e.g. a self-hosted Postgres deployment, or this test harness's `rls_tester`
-- role) is BLOCKED from inserting its bookkeeping row, which breaks
-- `prisma migrate deploy` with:
--     ERROR: new row violates row-level security policy for table "_prisma_migrations"
-- (Verified empirically against this exact policy set.)
--
-- Supabase's runner connects as the `postgres` superuser, which DOES bypass
-- FORCE RLS, so production would survive — but a launch-grade migration must not
-- depend on the connecting role being a superuser. We therefore deliberately
-- DIVERGE from the plan's literal `FORCE` on THIS TABLE ONLY:
--
--   * ENABLE ROW LEVEL SECURITY  — satisfies the advisor's
--     `rls_disabled_in_public` gate and denies all non-owner, non-policy roles
--     (authenticated / anon / regular public).
--   * (NO FORCE)                 — the table owner (the role the Prisma runner
--     connects as in every deployment topology) retains its inherent
--     owner-bypass, so `prisma migrate deploy` keeps working whether the runner
--     is a superuser (Supabase) or a plain owner (self-hosted). This is the
--     intended "the migration runner runs as superuser/owner, which bypasses
--     RLS" behavior called out in the PR brief.
--   * service-role + owner policies — exactly as planned, so any non-owner code
--     path (app traffic, tenant users) is still denied.
--
-- Net effect matches the plan's INTENT (service-role-only; no tenant exposure of
-- deployment history) while removing the migration-runner foot-gun. See the
-- accompanying spec test `_prisma_migrations: a follow-up migration still
-- applies` which proves a subsequent migration INSERT succeeds as the owner role.
-- ============================================================================
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_prisma_migrations_service_role_all" ON "_prisma_migrations";
CREATE POLICY "p_prisma_migrations_service_role_all" ON "_prisma_migrations" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_prisma_migrations_service_role_all" ON "_prisma_migrations" IS
  'PR-RLS-07: service_role bypass — migration metadata is server-side-only.';

DROP POLICY IF EXISTS "p_prisma_migrations_select" ON "_prisma_migrations";
CREATE POLICY "p_prisma_migrations_select" ON "_prisma_migrations" AS PERMISSIVE FOR SELECT TO public USING (app.is_owner());
COMMENT ON POLICY "p_prisma_migrations_select" ON "_prisma_migrations" IS
  'PR-RLS-07: owner-only SELECT — deployment history is not exposed to tenant users.';

DROP POLICY IF EXISTS "p_prisma_migrations_insert" ON "_prisma_migrations";
CREATE POLICY "p_prisma_migrations_insert" ON "_prisma_migrations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_prisma_migrations_insert" ON "_prisma_migrations" IS
  'PR-RLS-07: owner-only INSERT for non-owner roles. NOTE: the table owner (the Prisma migration runner) bypasses this because the table is ENABLE-only (NOT FORCE) — preserving migrate deploy.';

DROP POLICY IF EXISTS "p_prisma_migrations_update" ON "_prisma_migrations";
CREATE POLICY "p_prisma_migrations_update" ON "_prisma_migrations" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_prisma_migrations_update" ON "_prisma_migrations" IS
  'PR-RLS-07: owner-only UPDATE for non-owner roles; the Prisma runner (table owner) bypasses via ENABLE-only.';

DROP POLICY IF EXISTS "p_prisma_migrations_delete" ON "_prisma_migrations";
CREATE POLICY "p_prisma_migrations_delete" ON "_prisma_migrations" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_prisma_migrations_delete" ON "_prisma_migrations" IS
  'PR-RLS-07: owner-only DELETE for non-owner roles; the Prisma runner (table owner) bypasses via ENABLE-only.';

COMMIT;
