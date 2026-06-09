-- MWB-1 — Master Workout Builder Phase 1 data model.
--
-- PURELY ADDITIVE. No DROP / RENAME / ALTER COLUMN TYPE / TRUNCATE / DELETE on
-- any existing table. Every new column on "WorkoutPlan" is nullable or carries
-- a default, so existing rows (program_id=null, is_template=false, version=1)
-- keep behaving exactly as before — the legacy flat "quick plan" path is
-- unchanged. Four new tables are added: WorkoutProgram, WorkoutPlanRevision,
-- WorkoutProgramRevision, ClientWorkoutAssignmentSnapshot. See spec §3 / §5 / §7.
--
-- RLS is the SECOND line of defence (operator standing instruction —
-- "don't half-ass cybersecurity"). All four new tables get ENABLE + FORCE RLS
-- plus the canonical 5-policy set (service_role bypass + per-verb policies)
-- wired to the app.* GUC helpers, matching the Tier-3 workouts pattern in
-- 20261213000000_rls_tier3_workouts. Ownership model:
--
--   WorkoutProgram               -> owner-self read/write (owner_user_id) with
--                                   tenant-shared + sub-coach read overlay.
--   WorkoutPlanRevision          -> child-via-plan (workout_plan_id ->
--                                   WorkoutPlan.coach_id, + sub-coach access).
--   WorkoutProgramRevision       -> child-via-program (program_id ->
--                                   WorkoutProgram owner/tenant rules).
--   ClientWorkoutAssignmentSnapshot -> child-via-assignment (assignment_id ->
--                                   ClientWorkoutAssignment: assigning coach,
--                                   the client, or that client's coach).
--
-- New helper: app.is_subcoach_of(text) — true when app.current_user_id() has an
-- OPEN SubCoachAssignment (unassigned_at IS NULL) to the supplied client. Mirrors
-- SubCoachScopeService.canAccessClient at the DB layer. SECURITY DEFINER +
-- search_path pinned, identical hardening to app.is_user_coached_by.
--
-- Rollback: DROP the policies + helper created here and, only on a confirmed P0
-- outage, ALTER TABLE <t> DISABLE ROW LEVEL SECURITY. Otherwise fix forward. The
-- additive DDL is forward-only (dropping the new tables/columns would be a data
-- loss event and must go through a separate reviewed migration).

BEGIN;

-- =====================================================================
-- 0) Schema additions (Prisma-generated additive DDL).
-- =====================================================================

-- AlterTable — additive columns on WorkoutPlan (all nullable or defaulted).
ALTER TABLE "WorkoutPlan" ADD COLUMN     "cloned_from_plan_id" TEXT,
ADD COLUMN     "day_index" INTEGER,
ADD COLUMN     "head_revision_id" TEXT,
ADD COLUMN     "is_template" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "program_id" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "week_index" INTEGER;

-- CreateTable
CREATE TABLE "WorkoutProgram" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'owner_only',
    "forked_from_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weeks" INTEGER NOT NULL,
    "days_per_week" INTEGER NOT NULL,
    "is_template" BOOLEAN NOT NULL DEFAULT true,
    "cloned_from_id" TEXT,
    "goal_tag" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "head_revision_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "WorkoutProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutPlanRevision" (
    "id" TEXT NOT NULL,
    "workout_plan_id" TEXT NOT NULL,
    "revision_index" INTEGER NOT NULL,
    "exercises_json" JSONB NOT NULL,
    "plan_meta_json" JSONB NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutPlanRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutProgramRevision" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "revision_index" INTEGER NOT NULL,
    "structure_json" JSONB NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutProgramRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientWorkoutAssignmentSnapshot" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "plan_type" "WorkoutPlanType" NOT NULL,
    "exercises_json" JSONB NOT NULL,
    "source_plan_id" TEXT NOT NULL,
    "source_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientWorkoutAssignmentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkoutProgram_coach_id_visibility_is_template_archived_at__idx" ON "WorkoutProgram"("coach_id", "visibility", "is_template", "archived_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "WorkoutProgram_owner_user_id_archived_at_idx" ON "WorkoutProgram"("owner_user_id", "archived_at");

-- CreateIndex
CREATE INDEX "WorkoutProgram_coach_id_cloned_from_id_idx" ON "WorkoutProgram"("coach_id", "cloned_from_id");

-- CreateIndex
CREATE INDEX "WorkoutPlanRevision_workout_plan_id_created_at_idx" ON "WorkoutPlanRevision"("workout_plan_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WorkoutPlanRevision_workout_plan_id_revision_index_key" ON "WorkoutPlanRevision"("workout_plan_id", "revision_index");

-- CreateIndex
CREATE INDEX "WorkoutProgramRevision_program_id_created_at_idx" ON "WorkoutProgramRevision"("program_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WorkoutProgramRevision_program_id_revision_index_key" ON "WorkoutProgramRevision"("program_id", "revision_index");

-- CreateIndex
CREATE UNIQUE INDEX "ClientWorkoutAssignmentSnapshot_assignment_id_key" ON "ClientWorkoutAssignmentSnapshot"("assignment_id");

-- CreateIndex
CREATE INDEX "WorkoutPlan_program_id_week_index_day_index_idx" ON "WorkoutPlan"("program_id", "week_index", "day_index");

-- CreateIndex
CREATE INDEX "WorkoutPlan_coach_id_is_template_archived_at_idx" ON "WorkoutPlan"("coach_id", "is_template", "archived_at");

-- AddForeignKey
ALTER TABLE "WorkoutPlan" ADD CONSTRAINT "WorkoutPlan_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "WorkoutProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutPlanRevision" ADD CONSTRAINT "WorkoutPlanRevision_workout_plan_id_fkey" FOREIGN KEY ("workout_plan_id") REFERENCES "WorkoutPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutProgramRevision" ADD CONSTRAINT "WorkoutProgramRevision_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "WorkoutProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWorkoutAssignmentSnapshot" ADD CONSTRAINT "ClientWorkoutAssignmentSnapshot_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "ClientWorkoutAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 1) RLS helper: app.is_subcoach_of(text).
--
-- True when app.current_user_id() has an OPEN SubCoachAssignment
-- (unassigned_at IS NULL) to the supplied client User.id. Mirrors
-- SubCoachScopeService.canAccessClient's sub-coach branch at the DB layer.
-- SECURITY DEFINER (the policy evaluator may not itself be able to read
-- "SubCoachAssignment") + search_path pinned to defeat search_path injection,
-- identical hardening to app.is_user_coached_by(text, text).
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.is_subcoach_of(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT client_user_id IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."SubCoachAssignment" sca
       WHERE sca."sub_coach_id" = app.current_user_id()
         AND sca."client_id" = client_user_id
         AND sca."unassigned_at" IS NULL
     )
$$;
COMMENT ON FUNCTION app.is_subcoach_of(text) IS
  'Security-definer RLS helper: true when app.current_user_id() has an open SubCoachAssignment (unassigned_at IS NULL) to the supplied client User.id. Mirrors SubCoachScopeService sub-coach scope.';

-- Companion helper: app.is_subcoach_on_coach_team(text) — true when
-- app.current_user_id() is a sub-coach (role='coach' AND coach_id non-null)
-- whose parent head coach is the supplied coach User.id. Used by
-- WorkoutPlanRevision read/write (a plan is coach_id-owned; a sub-coach on that
-- head coach's team may see/append plan history). SECURITY DEFINER + pinned
-- search_path, same hardening convention.
CREATE OR REPLACE FUNCTION app.is_subcoach_on_coach_team(head_coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT head_coach_user_id IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" u
       WHERE u."id" = app.current_user_id()
         AND u."role" = 'coach'
         AND u."coach_id" = head_coach_user_id
     )
$$;
COMMENT ON FUNCTION app.is_subcoach_on_coach_team(text) IS
  'Security-definer RLS helper: true when app.current_user_id() is a sub-coach (role=coach with a non-null coach_id) on the supplied head coach''s team.';

GRANT USAGE ON SCHEMA app TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_subcoach_of(text) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_subcoach_on_coach_team(text) TO service_role, anon, authenticated;

-- =====================================================================
-- 2) WorkoutProgram — owner-self read/write with tenant-shared + sub-coach
--    read overlay.
--
--    READ  : owner admin OR the row owner (owner_user_id) OR — when
--            visibility='tenant_shared' — any coach whose own coach_id ties
--            them to the same tenant (coach_id), OR a sub-coach with an open
--            assignment to ANY client whose coach_id matches this program's
--            tenant. (Sub-coach visibility into a shared template library is
--            scoped to teams they actively work under.)
--    WRITE : owner admin OR the row owner only. Forking writes a NEW row whose
--            owner_user_id = the forker, so the fork passes this CHECK; the
--            source template is never mutated by a fork (spec §7.3).
-- =====================================================================
ALTER TABLE "WorkoutProgram" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutProgram" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_workoutprogram_service_role_all" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_service_role_all" ON "WorkoutProgram" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutprogram_service_role_all" ON "WorkoutProgram" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_workoutprogram_select" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_select" ON "WorkoutProgram" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()) OR (app.current_user_id() IS NOT NULL AND "visibility" = 'tenant_shared' AND (app.is_current_coach_of("coach_id") OR app.is_subcoach_of("coach_id") OR EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = app.current_user_id() AND (u."id" = "WorkoutProgram"."coach_id" OR u."coach_id" = "WorkoutProgram"."coach_id"))))));
COMMENT ON POLICY "p_workoutprogram_select" ON "WorkoutProgram" IS 'Owner-self read with tenant-shared overlay: owner admin, the row owner (owner_user_id), or — for tenant_shared rows — a head coach / sub-coach in the same coach_id tenant may SELECT.';

DROP POLICY IF EXISTS "p_workoutprogram_insert" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_insert" ON "WorkoutProgram" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_insert" ON "WorkoutProgram" IS 'Owner-self write: only owner admin or the row''s own owner_user_id may INSERT. Forking writes a new owner-stamped row so the fork passes.';

DROP POLICY IF EXISTS "p_workoutprogram_update" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_update" ON "WorkoutProgram" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_update" ON "WorkoutProgram" IS 'Owner-self update: owner admin or the row owner may UPDATE; CHECK prevents re-owning the row to another owner_user_id.';

DROP POLICY IF EXISTS "p_workoutprogram_delete" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_delete" ON "WorkoutProgram" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_delete" ON "WorkoutProgram" IS 'Owner-self delete: owner admin or the row owner may DELETE.';

-- =====================================================================
-- 3) WorkoutPlanRevision — child-via-plan
--    (workout_plan_id -> WorkoutPlan.coach_id; assigned/sub coach access).
--
--    A plan revision inherits the visibility of its parent WorkoutPlan. A plan
--    is owned by its coach_id (head coach). Sub-coaches who can access the plan
--    (via an open assignment to a client coached by that coach) may also read
--    history. Writes follow the same coach-scoped rule (revisions are written
--    by the coach/sub-coach editing the plan).
-- =====================================================================
ALTER TABLE "WorkoutPlanRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutPlanRevision" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_workoutplanrevision_service_role_all" ON "WorkoutPlanRevision";
CREATE POLICY "p_workoutplanrevision_service_role_all" ON "WorkoutPlanRevision" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutplanrevision_service_role_all" ON "WorkoutPlanRevision" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_workoutplanrevision_select" ON "WorkoutPlanRevision";
CREATE POLICY "p_workoutplanrevision_select" ON "WorkoutPlanRevision" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanRevision"."workout_plan_id" AND (wp."coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team(wp."coach_id"))))));
COMMENT ON POLICY "p_workoutplanrevision_select" ON "WorkoutPlanRevision" IS 'Child-via-plan read: owner admin, the parent plan''s coach (coach_id), or a sub-coach on that coach''s team may SELECT plan history.';

DROP POLICY IF EXISTS "p_workoutplanrevision_insert" ON "WorkoutPlanRevision";
CREATE POLICY "p_workoutplanrevision_insert" ON "WorkoutPlanRevision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanRevision"."workout_plan_id" AND (wp."coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team(wp."coach_id"))))));
COMMENT ON POLICY "p_workoutplanrevision_insert" ON "WorkoutPlanRevision" IS 'Child-via-plan write: owner admin, the parent plan''s coach, or a sub-coach on that coach''s team may INSERT a revision.';

DROP POLICY IF EXISTS "p_workoutplanrevision_update" ON "WorkoutPlanRevision";
CREATE POLICY "p_workoutplanrevision_update" ON "WorkoutPlanRevision" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanRevision"."workout_plan_id" AND (wp."coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team(wp."coach_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanRevision"."workout_plan_id" AND (wp."coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team(wp."coach_id"))))));
COMMENT ON POLICY "p_workoutplanrevision_update" ON "WorkoutPlanRevision" IS 'Child-via-plan update: owner admin or parent-plan coach/sub-coach may UPDATE; CHECK reverifies the parent plan (revisions are append-only in practice).';

DROP POLICY IF EXISTS "p_workoutplanrevision_delete" ON "WorkoutPlanRevision";
CREATE POLICY "p_workoutplanrevision_delete" ON "WorkoutPlanRevision" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanRevision"."workout_plan_id" AND (wp."coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team(wp."coach_id"))))));
COMMENT ON POLICY "p_workoutplanrevision_delete" ON "WorkoutPlanRevision" IS 'Child-via-plan delete: owner admin or parent-plan coach/sub-coach may DELETE.';

-- =====================================================================
-- 4) WorkoutProgramRevision — child-via-program
--    (program_id -> WorkoutProgram owner/tenant rules).
-- =====================================================================
ALTER TABLE "WorkoutProgramRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutProgramRevision" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_workoutprogramrevision_service_role_all" ON "WorkoutProgramRevision";
CREATE POLICY "p_workoutprogramrevision_service_role_all" ON "WorkoutProgramRevision" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutprogramrevision_service_role_all" ON "WorkoutProgramRevision" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_workoutprogramrevision_select" ON "WorkoutProgramRevision";
CREATE POLICY "p_workoutprogramrevision_select" ON "WorkoutProgramRevision" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutProgram" wprg WHERE wprg."id" = "WorkoutProgramRevision"."program_id" AND (wprg."owner_user_id" = app.current_user_id() OR (wprg."visibility" = 'tenant_shared' AND (app.is_current_coach_of(wprg."coach_id") OR app.is_subcoach_of(wprg."coach_id") OR app.is_subcoach_on_coach_team(wprg."coach_id"))))))));
COMMENT ON POLICY "p_workoutprogramrevision_select" ON "WorkoutProgramRevision" IS 'Child-via-program read: owner admin, the parent program owner, or a same-tenant coach/sub-coach for tenant_shared programs may SELECT structure history.';

DROP POLICY IF EXISTS "p_workoutprogramrevision_insert" ON "WorkoutProgramRevision";
CREATE POLICY "p_workoutprogramrevision_insert" ON "WorkoutProgramRevision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutProgram" wprg WHERE wprg."id" = "WorkoutProgramRevision"."program_id" AND wprg."owner_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_workoutprogramrevision_insert" ON "WorkoutProgramRevision" IS 'Child-via-program write: owner admin or the parent program owner may INSERT a structure revision.';

DROP POLICY IF EXISTS "p_workoutprogramrevision_update" ON "WorkoutProgramRevision";
CREATE POLICY "p_workoutprogramrevision_update" ON "WorkoutProgramRevision" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutProgram" wprg WHERE wprg."id" = "WorkoutProgramRevision"."program_id" AND wprg."owner_user_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutProgram" wprg WHERE wprg."id" = "WorkoutProgramRevision"."program_id" AND wprg."owner_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_workoutprogramrevision_update" ON "WorkoutProgramRevision" IS 'Child-via-program update: owner admin or parent program owner may UPDATE; CHECK reverifies the parent program.';

DROP POLICY IF EXISTS "p_workoutprogramrevision_delete" ON "WorkoutProgramRevision";
CREATE POLICY "p_workoutprogramrevision_delete" ON "WorkoutProgramRevision" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutProgram" wprg WHERE wprg."id" = "WorkoutProgramRevision"."program_id" AND wprg."owner_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_workoutprogramrevision_delete" ON "WorkoutProgramRevision" IS 'Child-via-program delete: owner admin or parent program owner may DELETE.';

-- =====================================================================
-- 5) ClientWorkoutAssignmentSnapshot — child-via-assignment
--    (assignment_id -> ClientWorkoutAssignment).
--
--    A snapshot inherits the visibility of its parent assignment: the
--    assigning coach (assigned_by_coach_id), the client themselves (client_id),
--    or that client's current coach / sub-coach may read. Writes are coach-side
--    (taken inside the assign transaction).
-- =====================================================================
ALTER TABLE "ClientWorkoutAssignmentSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientWorkoutAssignmentSnapshot" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_service_role_all" ON "ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_service_role_all" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_service_role_all" ON "ClientWorkoutAssignmentSnapshot" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_select" ON "ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_select" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."client_id" = app.current_user_id() OR cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_select" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment read: owner admin, the assigned client, the assigning coach, or that client''s current coach/sub-coach may SELECT the snapshot.';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment write: owner admin, the assigning coach, or that client''s current coach/sub-coach may INSERT the snapshot (taken inside the assign tx).';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment update: owner admin, the assigning coach, or that client''s coach/sub-coach may UPDATE; snapshots are immutable in practice but the policy keeps the parent check symmetric.';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment delete: owner admin, the assigning coach, or that client''s coach/sub-coach may DELETE.';

COMMIT;
