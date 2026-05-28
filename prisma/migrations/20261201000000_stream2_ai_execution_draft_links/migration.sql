-- Stream 2 — AI Execution Capabilities (draft.assign_workout, draft.assign_meal_plan, draft.send_notification).
--
-- Adds ai_draft_id to the four target tables that AI-materialised side-effects land
-- in. The UNIQUE constraint is the schema-level idempotency guard the spec
-- explicitly requires (Stream 2 §4.1): concurrent approve calls against the
-- same draft cannot insert two rows because the second INSERT trips P2002
-- and the materialiser falls through to its "already_materialised" path.
--
-- Mirrors the round-1 Stream 1 migration pattern: same migration carries the
-- column + index. No RLS changes here (these tables' RLS is owned by their
-- original migrations; adding a nullable column does not change tenant scope).
--
-- Backfill: NOT NEEDED. All four columns are nullable with default NULL —
-- existing rows that pre-date the AI execution pipeline keep ai_draft_id = NULL
-- and continue to behave exactly as before. New rows produced by the four
-- materialisers will set the column.
--
-- The @unique constraint on a nullable column is the standard Postgres
-- behaviour we want: NULLs do not collide with each other, but every non-NULL
-- value must be distinct. This is exactly the idempotency guarantee the spec
-- calls for.

-- ---------------------------------------------------------------------------
-- 1. CoachMessage — ai_draft_id link for draft.coach_message materialiser
--    (and the merged draft.client_message — see CapabilityMaterializerRegistry
--    wiring in src/ai/gateway/materialisers/).
-- ---------------------------------------------------------------------------
ALTER TABLE "CoachMessage" ADD COLUMN "ai_draft_id" TEXT;

CREATE UNIQUE INDEX "CoachMessage_ai_draft_id_key" ON "CoachMessage"("ai_draft_id");

-- ---------------------------------------------------------------------------
-- 2. ClientWorkoutAssignment — ai_draft_id link for draft.assign_workout
-- ---------------------------------------------------------------------------
ALTER TABLE "ClientWorkoutAssignment" ADD COLUMN "ai_draft_id" TEXT;

CREATE UNIQUE INDEX "ClientWorkoutAssignment_ai_draft_id_key" ON "ClientWorkoutAssignment"("ai_draft_id");

-- ---------------------------------------------------------------------------
-- 3. DailyMealPlanAssignment — ai_draft_id link for draft.assign_meal_plan
-- ---------------------------------------------------------------------------
ALTER TABLE "DailyMealPlanAssignment" ADD COLUMN "ai_draft_id" TEXT;

CREATE UNIQUE INDEX "DailyMealPlanAssignment_ai_draft_id_key" ON "DailyMealPlanAssignment"("ai_draft_id");

-- ---------------------------------------------------------------------------
-- 4. Notification — ai_draft_id link for draft.send_notification
-- ---------------------------------------------------------------------------
ALTER TABLE "Notification" ADD COLUMN "ai_draft_id" TEXT;

CREATE UNIQUE INDEX "Notification_ai_draft_id_key" ON "Notification"("ai_draft_id");
