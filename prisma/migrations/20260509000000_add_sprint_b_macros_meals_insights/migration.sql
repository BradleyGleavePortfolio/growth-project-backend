-- Sprint B — MacroTarget + MealTemplate + DailyMealPlan +
-- DailyMealPlanSlot + DailyMealPlanAssignment + HolisticInsightCache.
--
-- Reversibility: every CREATE TABLE has a matching DROP TABLE in the
-- README rollback section. No data migration is performed; all new
-- tables start empty.

CREATE TABLE "MacroTarget" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "calories_kcal" INTEGER NOT NULL,
    "protein_g" INTEGER NOT NULL,
    "carbs_g" INTEGER NOT NULL,
    "fats_g" INTEGER NOT NULL,
    "fiber_g" INTEGER,
    "notes" TEXT,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "MacroTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MacroTarget_client_id_effective_from_idx"
    ON "MacroTarget"("client_id", "effective_from");
CREATE INDEX "MacroTarget_coach_id_created_at_idx"
    ON "MacroTarget"("coach_id", "created_at");

ALTER TABLE "MacroTarget"
    ADD CONSTRAINT "MacroTarget_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MacroTarget"
    ADD CONSTRAINT "MacroTarget_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MealTemplate" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "calories_kcal" INTEGER NOT NULL,
    "protein_g" INTEGER NOT NULL,
    "carbs_g" INTEGER NOT NULL,
    "fats_g" INTEGER NOT NULL,
    "fiber_g" INTEGER,
    "items" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "MealTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MealTemplate_coach_id_archived_at_idx"
    ON "MealTemplate"("coach_id", "archived_at");
ALTER TABLE "MealTemplate"
    ADD CONSTRAINT "MealTemplate_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DailyMealPlan" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "DailyMealPlan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DailyMealPlan_coach_id_archived_at_idx"
    ON "DailyMealPlan"("coach_id", "archived_at");
ALTER TABLE "DailyMealPlan"
    ADD CONSTRAINT "DailyMealPlan_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DailyMealPlanSlot" (
    "id" TEXT NOT NULL,
    "daily_meal_plan_id" TEXT NOT NULL,
    "meal_template_id" TEXT NOT NULL,
    "slot_label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DailyMealPlanSlot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyMealPlanSlot_daily_meal_plan_id_slot_label_order_key"
    ON "DailyMealPlanSlot"("daily_meal_plan_id", "slot_label", "order");
CREATE INDEX "DailyMealPlanSlot_daily_meal_plan_id_idx"
    ON "DailyMealPlanSlot"("daily_meal_plan_id");
CREATE INDEX "DailyMealPlanSlot_meal_template_id_idx"
    ON "DailyMealPlanSlot"("meal_template_id");
ALTER TABLE "DailyMealPlanSlot"
    ADD CONSTRAINT "DailyMealPlanSlot_daily_meal_plan_id_fkey"
    FOREIGN KEY ("daily_meal_plan_id") REFERENCES "DailyMealPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyMealPlanSlot"
    ADD CONSTRAINT "DailyMealPlanSlot_meal_template_id_fkey"
    FOREIGN KEY ("meal_template_id") REFERENCES "MealTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DailyMealPlanAssignment" (
    "id" TEXT NOT NULL,
    "daily_meal_plan_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "assigned_by_coach_id" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyMealPlanAssignment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DailyMealPlanAssignment_client_id_starts_on_idx"
    ON "DailyMealPlanAssignment"("client_id", "starts_on");
CREATE INDEX "DailyMealPlanAssignment_daily_meal_plan_id_idx"
    ON "DailyMealPlanAssignment"("daily_meal_plan_id");
CREATE INDEX "DailyMealPlanAssignment_assigned_by_coach_id_idx"
    ON "DailyMealPlanAssignment"("assigned_by_coach_id");
ALTER TABLE "DailyMealPlanAssignment"
    ADD CONSTRAINT "DailyMealPlanAssignment_daily_meal_plan_id_fkey"
    FOREIGN KEY ("daily_meal_plan_id") REFERENCES "DailyMealPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyMealPlanAssignment"
    ADD CONSTRAINT "DailyMealPlanAssignment_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyMealPlanAssignment"
    ADD CONSTRAINT "DailyMealPlanAssignment_assigned_by_coach_id_fkey"
    FOREIGN KEY ("assigned_by_coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HolisticInsightCache" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "window_days" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HolisticInsightCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HolisticInsightCache_user_id_window_days_key"
    ON "HolisticInsightCache"("user_id", "window_days");
CREATE INDEX "HolisticInsightCache_expires_at_idx"
    ON "HolisticInsightCache"("expires_at");
ALTER TABLE "HolisticInsightCache"
    ADD CONSTRAINT "HolisticInsightCache_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
