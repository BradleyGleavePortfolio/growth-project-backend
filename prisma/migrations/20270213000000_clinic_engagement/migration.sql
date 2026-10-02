-- C05 items 6-7 — clinic engagement: coach welcome message (13 minutes after
-- onboarding completes) + workout reminders on plan days.
--
-- Additive-only. Adds two default-true columns to NotificationPreferences and
-- creates three tables with indexes/FKs. No existing table, column, type,
-- index or constraint is altered or dropped. User back-relations in
-- schema.prisma are Prisma-virtual and emit no DDL.
--
-- RLS POLICY CITATION (ENGINEERING_RULES §2), helpers from
-- 20261212000000_rls_helper_search_path / 20260704000000_rls01_helper_searchpath_hibp:
--   app.current_user_id()  session GUC set by RlsContextInterceptor
--   app.is_owner()         platform owner context
--
-- CoachWelcomeMessageSetting (per-coach config, written by the owner endpoint
-- or the operator script through service_role):
--   p_coachwelcomemessagesetting_service_role_all  service_role ALL
--   p_coachwelcomemessagesetting_select            SELECT owner OR coach self
--   no public INSERT/UPDATE/DELETE
--   RESTRICTIVE anon deny-all
--
-- CoachWelcomeMessageJob (scheduler state; rendered_body carries the client's
-- first name):
--   p_coachwelcomemessagejob_service_role_all  service_role ALL
--   p_coachwelcomemessagejob_select            SELECT owner only
--   no public INSERT/UPDATE/DELETE (the scheduler runs as service_role)
--   RESTRICTIVE anon deny-all
--
-- WorkoutReminderDelivery (one row per client per local day):
--   p_workoutreminderdelivery_service_role_all  service_role ALL
--   p_workoutreminderdelivery_select            SELECT owner OR client self
--   no public INSERT/UPDATE/DELETE
--   RESTRICTIVE anon deny-all
--
-- Rollback: down.sql drops the three tables and the two columns (scheduler
-- state only; no user-authored content). Otherwise fix forward.

-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "workout_reminder_inapp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "workout_reminder_push" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CoachWelcomeMessageSetting" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "template" TEXT,
    "enabled_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachWelcomeMessageSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachWelcomeMessageJob" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "rendered_body" TEXT,
    "message_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachWelcomeMessageJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutReminderDelivery" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "local_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "first_day" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoachWelcomeMessageSetting_coach_id_key" ON "CoachWelcomeMessageSetting"("coach_id");

-- CreateIndex
CREATE UNIQUE INDEX "CoachWelcomeMessageJob_client_id_key" ON "CoachWelcomeMessageJob"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "CoachWelcomeMessageJob_message_id_key" ON "CoachWelcomeMessageJob"("message_id");

-- CreateIndex
CREATE INDEX "CoachWelcomeMessageJob_status_fire_at_idx" ON "CoachWelcomeMessageJob"("status", "fire_at");

-- CreateIndex
CREATE INDEX "CoachWelcomeMessageJob_coach_id_idx" ON "CoachWelcomeMessageJob"("coach_id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkoutReminderDelivery_client_id_local_date_key" ON "WorkoutReminderDelivery"("client_id", "local_date");

-- AddForeignKey
ALTER TABLE "CoachWelcomeMessageSetting" ADD CONSTRAINT "CoachWelcomeMessageSetting_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachWelcomeMessageJob" ADD CONSTRAINT "CoachWelcomeMessageJob_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachWelcomeMessageJob" ADD CONSTRAINT "CoachWelcomeMessageJob_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutReminderDelivery" ADD CONSTRAINT "WorkoutReminderDelivery_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════

-- ─── 1) CoachWelcomeMessageSetting ──────────────────────────────────────
ALTER TABLE "CoachWelcomeMessageSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachWelcomeMessageSetting" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachwelcomemessagesetting_service_role_all" ON "CoachWelcomeMessageSetting";
CREATE POLICY "p_coachwelcomemessagesetting_service_role_all" ON "CoachWelcomeMessageSetting" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachwelcomemessagesetting_service_role_all" ON "CoachWelcomeMessageSetting" IS 'Primitive A: service_role bypass for the owner endpoint, operator script and scheduler.';

DROP POLICY IF EXISTS "p_coachwelcomemessagesetting_select" ON "CoachWelcomeMessageSetting";
CREATE POLICY "p_coachwelcomemessagesetting_select" ON "CoachWelcomeMessageSetting" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_coachwelcomemessagesetting_select" ON "CoachWelcomeMessageSetting" IS 'Coach reads own welcome setting; platform owner reads all. No public writes.';

DROP POLICY IF EXISTS "p_coachwelcomemessagesetting_anon_deny" ON "CoachWelcomeMessageSetting";
CREATE POLICY "p_coachwelcomemessagesetting_anon_deny" ON "CoachWelcomeMessageSetting" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ─── 2) CoachWelcomeMessageJob ──────────────────────────────────────────
ALTER TABLE "CoachWelcomeMessageJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachWelcomeMessageJob" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_coachwelcomemessagejob_service_role_all" ON "CoachWelcomeMessageJob";
CREATE POLICY "p_coachwelcomemessagejob_service_role_all" ON "CoachWelcomeMessageJob" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_coachwelcomemessagejob_service_role_all" ON "CoachWelcomeMessageJob" IS 'Primitive A: service_role bypass for the welcome scheduler.';

DROP POLICY IF EXISTS "p_coachwelcomemessagejob_select" ON "CoachWelcomeMessageJob";
CREATE POLICY "p_coachwelcomemessagejob_select" ON "CoachWelcomeMessageJob" AS PERMISSIVE FOR SELECT TO public USING (app.is_owner());
COMMENT ON POLICY "p_coachwelcomemessagejob_select" ON "CoachWelcomeMessageJob" IS 'Scheduler state: platform owner only. The delivered message itself lives in CoachMessage under its own policies.';

DROP POLICY IF EXISTS "p_coachwelcomemessagejob_anon_deny" ON "CoachWelcomeMessageJob";
CREATE POLICY "p_coachwelcomemessagejob_anon_deny" ON "CoachWelcomeMessageJob" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ─── 3) WorkoutReminderDelivery ─────────────────────────────────────────
ALTER TABLE "WorkoutReminderDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutReminderDelivery" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_workoutreminderdelivery_service_role_all" ON "WorkoutReminderDelivery";
CREATE POLICY "p_workoutreminderdelivery_service_role_all" ON "WorkoutReminderDelivery" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutreminderdelivery_service_role_all" ON "WorkoutReminderDelivery" IS 'Primitive A: service_role bypass for the reminder scheduler.';

DROP POLICY IF EXISTS "p_workoutreminderdelivery_select" ON "WorkoutReminderDelivery";
CREATE POLICY "p_workoutreminderdelivery_select" ON "WorkoutReminderDelivery" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutreminderdelivery_select" ON "WorkoutReminderDelivery" IS 'Client reads own reminder ledger; platform owner reads all. No public writes.';

DROP POLICY IF EXISTS "p_workoutreminderdelivery_anon_deny" ON "WorkoutReminderDelivery";
CREATE POLICY "p_workoutreminderdelivery_anon_deny" ON "WorkoutReminderDelivery" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
