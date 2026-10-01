-- C05/C07 — clinic consultation intake (+ append-only revisions) + clinic program set.
--
-- Additive-only. Creates three tables and their indexes/FKs. No existing table,
-- column, type, index or constraint is altered or dropped. The User
-- back-relations in schema.prisma are Prisma-virtual and emit no DDL.
--
-- RLS POLICY CITATION (ENGINEERING_RULES §2), helpers from
-- 20261212000000_rls_helper_search_path / 20260704000000_rls01_helper_searchpath_hibp:
--   app.current_user_id()          session GUC set by RlsContextInterceptor
--   app.is_owner()                 platform owner context
--   app.is_current_coach_of(text)  caller is the client's CURRENT coach
--   app.can_read_client_consultation(text)  (defined below) the CURRENT-tenancy
--     coach audience of a client's consultation, identical to the API rule in
--     OnboardingService.canCoachRead (fix round A607-1 / B607-3):
--       a) the client's current coach, or
--       b) the current head coach of the client's current coach, or
--       c) a sub-coach whose CURRENT head is the client's current head AND who
--          holds an open SubCoachAssignment for this client issued by that head.
--     The client must be a live student; the reader and the client's coach must
--     be live coach-type users. A transfer (User.coach_id change) or a
--     revoked/moved sub-coach loses access in the same statement.
--
-- ClientOnboardingIntake (health-adjacent screening answers; T4):
--   p_clientonboardingintake_service_role_all  service_role ALL
--   p_clientonboardingintake_select            SELECT owner OR client self OR can_read_client_consultation
--   p_clientonboardingintake_insert            INSERT owner OR client self
--   p_clientonboardingintake_update            UPDATE owner OR client self (USING + CHECK)
--   no public DELETE (account deletion cascades through the FK)
--   RESTRICTIVE anon deny-all
--   Roman reads the intake only inside the client's own request context
--   (current_user_id = the client), so it is covered by "client self" and
--   can never read another client's row. A former coach loses read access the
--   moment User.coach_id changes, because the check reads live User rows,
--   not a denormalised coach id.
--
-- ClientOnboardingIntakeRevision (append-only history; owner ruling 18:11):
--   p_clientonboardingintakerevision_service_role_all  service_role ALL
--   p_clientonboardingintakerevision_select            SELECT owner OR client self OR can_read_client_consultation
--   p_clientonboardingintakerevision_insert            INSERT owner OR client self
--   NO UPDATE / DELETE policy: rows are immutable for every non-service role
--   RESTRICTIVE anon deny-all
--   Same coach audience as the intake (app.can_read_client_consultation).
--
-- ClinicProgramSet (seeded configuration, coach tenancy):
--   p_clinicprogramset_service_role_all        service_role ALL
--   p_clinicprogramset_select                  SELECT owner OR coach self
--   no public INSERT/UPDATE/DELETE (written by the seed script only)
--   RESTRICTIVE anon deny-all
--
-- Rollback: down.sql drops both tables (data loss of intake answers; only on a
-- confirmed defect before launch). Otherwise fix forward.

-- CreateTable
CREATE TABLE "ClientOnboardingIntake" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "completed_chapters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disclaimer_version" TEXT,
    "disclaimer_accepted_at" TIMESTAMP(3),
    "screening_any_yes" BOOLEAN NOT NULL DEFAULT false,
    "screening_flagged_at" TIMESTAMP(3),
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "first_session_date" DATE,
    "preferred_training_time" TEXT,
    "completion_claimed_at" TIMESTAMP(3),
    "completion_claim_token" TEXT,
    "completion_claim_revision" INTEGER,
    "selected_program_key" TEXT,
    "completed_at" TIMESTAMP(3),
    "completion_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientOnboardingIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientOnboardingIntakeRevision" (
    "id" TEXT NOT NULL,
    "intake_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "completed_chapters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disclaimer_version" TEXT,
    "disclaimer_accepted_at" TIMESTAMP(3),
    "screening_any_yes" BOOLEAN NOT NULL DEFAULT false,
    "cause" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientOnboardingIntakeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicProgramSet" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "fixture_version" TEXT NOT NULL,
    "fixture_sha256" TEXT NOT NULL,
    "approval_status" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "all_members_cohort_id" UUID NOT NULL,
    "programs" JSONB NOT NULL,
    "materialisation" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicProgramSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientOnboardingIntake_client_id_key" ON "ClientOnboardingIntake"("client_id");

-- CreateIndex
CREATE INDEX "ClientOnboardingIntake_screening_any_yes_screening_flagged__idx" ON "ClientOnboardingIntake"("screening_any_yes", "screening_flagged_at");

-- CreateIndex
CREATE INDEX "ClientOnboardingIntake_completed_at_idx" ON "ClientOnboardingIntake"("completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "ClientOnboardingIntakeRevision_intake_id_revision_key" ON "ClientOnboardingIntakeRevision"("intake_id", "revision");

-- CreateIndex
CREATE INDEX "ClientOnboardingIntakeRevision_client_id_created_at_idx" ON "ClientOnboardingIntakeRevision"("client_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicProgramSet_coach_id_fixture_version_key" ON "ClinicProgramSet"("coach_id", "fixture_version");

-- CreateIndex
CREATE INDEX "ClinicProgramSet_coach_id_active_idx" ON "ClinicProgramSet"("coach_id", "active");

-- AddForeignKey
ALTER TABLE "ClientOnboardingIntake" ADD CONSTRAINT "ClientOnboardingIntake_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientOnboardingIntakeRevision" ADD CONSTRAINT "ClientOnboardingIntakeRevision_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "ClientOnboardingIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientOnboardingIntakeRevision" ADD CONSTRAINT "ClientOnboardingIntakeRevision_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicProgramSet" ADD CONSTRAINT "ClinicProgramSet_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════
-- CONSULTATION AUDIENCE HELPER (API/RLS parity)
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION app.can_read_client_consultation(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM "User" c
      JOIN "User" cc ON cc.id = c.coach_id
      JOIN "User" r  ON r.id = app.current_user_id()
     WHERE c.id = client_user_id
       AND r.id <> c.id
       AND c.role::text = 'student'
       AND c.deleted_at IS NULL
       AND cc.deleted_at IS NULL
       AND cc.role::text IN ('coach', 'owner', 'sub_coach')
       AND r.deleted_at IS NULL
       AND r.role::text IN ('coach', 'owner', 'sub_coach')
       AND (
             r.id = cc.id
          OR (cc.coach_id IS NOT NULL AND r.id = cc.coach_id AND r.coach_id IS NULL)
          OR (
                r.coach_id IS NOT NULL
            AND r.coach_id = COALESCE(cc.coach_id, cc.id)
            AND EXISTS (
                  SELECT 1
                    FROM "SubCoachAssignment" a
                   WHERE a.sub_coach_id = r.id
                     AND a.client_id = c.id
                     AND a.head_coach_id = COALESCE(cc.coach_id, cc.id)
                     AND a.unassigned_at IS NULL
                )
          )
       )
  )
$fn$;

REVOKE ALL ON FUNCTION app.can_read_client_consultation(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.can_read_client_consultation(text) FROM anon;
GRANT EXECUTE ON FUNCTION app.can_read_client_consultation(text) TO authenticated, service_role;
COMMENT ON FUNCTION app.can_read_client_consultation(text) IS
  'Current-tenancy coach audience of a client consultation: current coach, current head of that coach, or a sub-coach on the current head''s team with an open assignment from that head. Mirrors OnboardingService.canCoachRead.';

-- ═════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════

-- ─── 1) ClientOnboardingIntake ──────────────────────────────────────────
ALTER TABLE "ClientOnboardingIntake" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientOnboardingIntake" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_clientonboardingintake_service_role_all" ON "ClientOnboardingIntake";
CREATE POLICY "p_clientonboardingintake_service_role_all" ON "ClientOnboardingIntake" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_clientonboardingintake_service_role_all" ON "ClientOnboardingIntake" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_clientonboardingintake_select" ON "ClientOnboardingIntake";
CREATE POLICY "p_clientonboardingintake_select" ON "ClientOnboardingIntake" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR app.can_read_client_consultation("client_id")))));
COMMENT ON POLICY "p_clientonboardingintake_select" ON "ClientOnboardingIntake" IS 'Client reads own intake (also the only context Roman reads it in); the client''s CURRENT coach reads it; platform owner reads all. Other clients, other coaches and anon see zero rows.';

DROP POLICY IF EXISTS "p_clientonboardingintake_insert" ON "ClientOnboardingIntake";
CREATE POLICY "p_clientonboardingintake_insert" ON "ClientOnboardingIntake" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id())));
COMMENT ON POLICY "p_clientonboardingintake_insert" ON "ClientOnboardingIntake" IS 'Client-self write only. A coach cannot create or forge a client''s intake.';

DROP POLICY IF EXISTS "p_clientonboardingintake_update" ON "ClientOnboardingIntake";
CREATE POLICY "p_clientonboardingintake_update" ON "ClientOnboardingIntake" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id())));
COMMENT ON POLICY "p_clientonboardingintake_update" ON "ClientOnboardingIntake" IS 'Client-self update only; CHECK prevents re-owning the row. Coaches are read-only.';

DROP POLICY IF EXISTS "p_clientonboardingintake_anon_deny" ON "ClientOnboardingIntake";
CREATE POLICY "p_clientonboardingintake_anon_deny" ON "ClientOnboardingIntake" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "p_clientonboardingintake_anon_deny" ON "ClientOnboardingIntake" IS 'Defence in depth: anon can never read or write screening answers.';

-- ─── 1b) ClientOnboardingIntakeRevision (append-only) ──────────────────
ALTER TABLE "ClientOnboardingIntakeRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientOnboardingIntakeRevision" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_clientonboardingintakerevision_service_role_all" ON "ClientOnboardingIntakeRevision";
CREATE POLICY "p_clientonboardingintakerevision_service_role_all" ON "ClientOnboardingIntakeRevision" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "p_clientonboardingintakerevision_select" ON "ClientOnboardingIntakeRevision";
CREATE POLICY "p_clientonboardingintakerevision_select" ON "ClientOnboardingIntakeRevision" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR app.can_read_client_consultation("client_id")))));
COMMENT ON POLICY "p_clientonboardingintakerevision_select" ON "ClientOnboardingIntakeRevision" IS 'Same audience as the intake: client self, current coach, platform owner.';

DROP POLICY IF EXISTS "p_clientonboardingintakerevision_insert" ON "ClientOnboardingIntakeRevision";
CREATE POLICY "p_clientonboardingintakerevision_insert" ON "ClientOnboardingIntakeRevision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id())));
COMMENT ON POLICY "p_clientonboardingintakerevision_insert" ON "ClientOnboardingIntakeRevision" IS 'Client-self append only. No UPDATE or DELETE policy exists: submitted forms are immutable.';

DROP POLICY IF EXISTS "p_clientonboardingintakerevision_anon_deny" ON "ClientOnboardingIntakeRevision";
CREATE POLICY "p_clientonboardingintakerevision_anon_deny" ON "ClientOnboardingIntakeRevision" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ─── 2) ClinicProgramSet ────────────────────────────────────────────────
ALTER TABLE "ClinicProgramSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClinicProgramSet" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_clinicprogramset_service_role_all" ON "ClinicProgramSet";
CREATE POLICY "p_clinicprogramset_service_role_all" ON "ClinicProgramSet" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_clinicprogramset_service_role_all" ON "ClinicProgramSet" IS 'Primitive A: service_role bypass for the seed script and server-side reads.';

DROP POLICY IF EXISTS "p_clinicprogramset_select" ON "ClinicProgramSet";
CREATE POLICY "p_clinicprogramset_select" ON "ClinicProgramSet" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_clinicprogramset_select" ON "ClinicProgramSet" IS 'Owning coach reads own program set; platform owner reads all. No public writes.';

DROP POLICY IF EXISTS "p_clinicprogramset_anon_deny" ON "ClinicProgramSet";
CREATE POLICY "p_clinicprogramset_anon_deny" ON "ClinicProgramSet" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
