-- CreateEnum
CREATE TYPE "Role" AS ENUM ('coach', 'student');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('male', 'female', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "ActivityLevel" AS ENUM ('sedentary', 'light', 'moderate', 'active', 'very_active');

-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('fat_loss', 'muscle_gain', 'maintenance', 'performance');

-- CreateEnum
CREATE TYPE "WorkoutExperience" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "FoodCategory" AS ENUM ('generic', 'packaged', 'fast_food', 'restaurant', 'recipe_ingredient');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');

-- CreateEnum
CREATE TYPE "Intensity" AS ENUM ('light', 'moderate', 'hard', 'max');

-- CreateEnum
CREATE TYPE "MuscleGroup" AS ENUM ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body');

-- CreateEnum
CREATE TYPE "CheckInType" AS ENUM ('morning', 'evening');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "supabase_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'student',
    "coach_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "height_cm" DOUBLE PRECISION,
    "current_weight_lbs" DOUBLE PRECISION,
    "target_weight_lbs" DOUBLE PRECISION,
    "date_of_birth" TIMESTAMP(3),
    "sex" "Sex" NOT NULL DEFAULT 'prefer_not_to_say',
    "activity_level" "ActivityLevel" NOT NULL DEFAULT 'moderate',
    "goal_type" "GoalType" NOT NULL DEFAULT 'fat_loss',
    "workout_experience" "WorkoutExperience" NOT NULL DEFAULT 'beginner',
    "has_gym_membership" BOOLEAN NOT NULL DEFAULT false,
    "preferred_snacks" TEXT[],
    "macro_target_calories" DOUBLE PRECISION,
    "macro_target_protein_g" DOUBLE PRECISION,
    "macro_target_carbs_g" DOUBLE PRECISION,
    "macro_target_fat_g" DOUBLE PRECISION,
    "avatar_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand_or_restaurant" TEXT,
    "category" "FoodCategory" NOT NULL DEFAULT 'generic',
    "serving_description" TEXT NOT NULL,
    "serving_size_grams" DOUBLE PRECISION NOT NULL,
    "calories" DOUBLE PRECISION NOT NULL,
    "protein_g" DOUBLE PRECISION NOT NULL,
    "carbs_g" DOUBLE PRECISION NOT NULL,
    "fat_g" DOUBLE PRECISION NOT NULL,
    "saturated_fat_g" DOUBLE PRECISION,
    "mono_fat_g" DOUBLE PRECISION,
    "poly_fat_g" DOUBLE PRECISION,
    "fiber_g" DOUBLE PRECISION,
    "sugar_g" DOUBLE PRECISION,
    "sodium_mg" DOUBLE PRECISION,
    "tags" TEXT[],
    "search_aliases" TEXT[],
    "image_url" TEXT,
    "barcode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoggedFoodEntry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "meal_type" "MealType" NOT NULL,
    "food_item_id" TEXT NOT NULL,
    "quantity_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "notes" TEXT,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoggedFoodEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "workout_name" TEXT NOT NULL,
    "workout_type" TEXT NOT NULL,
    "duration_minutes" INTEGER,
    "intensity" "Intensity" NOT NULL DEFAULT 'moderate',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExerciseSet" (
    "id" TEXT NOT NULL,
    "workout_id" TEXT NOT NULL,
    "exercise_name" TEXT NOT NULL,
    "muscle_group" "MuscleGroup" NOT NULL,
    "sets_completed" INTEGER NOT NULL,
    "reps_per_set" INTEGER[],
    "weight_per_set" DOUBLE PRECISION[],
    "rpe" DOUBLE PRECISION,
    "notes" TEXT,
    "video_url" TEXT,

    CONSTRAINT "ExerciseSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkoutRoutine" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkoutRoutine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineExercise" (
    "id" TEXT NOT NULL,
    "routine_id" TEXT NOT NULL,
    "exercise_name" TEXT NOT NULL,
    "muscle_group" "MuscleGroup" NOT NULL,
    "default_sets" INTEGER NOT NULL,
    "default_reps" INTEGER NOT NULL,
    "default_rest_seconds" INTEGER NOT NULL DEFAULT 90,
    "video_url" TEXT,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "RoutineExercise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FastingWindow" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3),
    "protocol" TEXT,
    "notes" TEXT,

    CONSTRAINT "FastingWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightLog" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "weight_lbs" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeightLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "water_enabled" BOOLEAN NOT NULL DEFAULT true,
    "workout_enabled" BOOLEAN NOT NULL DEFAULT true,
    "eat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "mindset_enabled" BOOLEAN NOT NULL DEFAULT true,
    "fasting_enabled" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" TEXT NOT NULL DEFAULT '22:00',
    "quiet_hours_end" TEXT NOT NULL DEFAULT '06:00',
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Habit" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'custom',
    "target_value" DOUBLE PRECISION,
    "unit" TEXT,

    CONSTRAINT "Habit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HabitLog" (
    "id" TEXT NOT NULL,
    "habit_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HabitLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "video_url" TEXT,
    "article_url" TEXT,
    "tags" TEXT[],
    "goal_tags" "GoalType"[],
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonCompletion" (
    "id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "mood" INTEGER NOT NULL,
    "energy" INTEGER NOT NULL,
    "soreness" INTEGER NOT NULL,
    "notes" TEXT,
    "type" "CheckInType" NOT NULL DEFAULT 'morning',
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "water_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_ml" INTEGER NOT NULL,
    "logged_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "water_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_supabase_id_key" ON "User"("supabase_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_coach_id_idx" ON "User"("coach_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_user_id_key" ON "UserProfile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "FoodItem_barcode_key" ON "FoodItem"("barcode");

-- CreateIndex
CREATE INDEX "LoggedFoodEntry_user_id_date_idx" ON "LoggedFoodEntry"("user_id", "date");

-- CreateIndex
CREATE INDEX "WorkoutSession_user_id_date_idx" ON "WorkoutSession"("user_id", "date");

-- CreateIndex
CREATE INDEX "WorkoutRoutine_creator_id_idx" ON "WorkoutRoutine"("creator_id");

-- CreateIndex
CREATE INDEX "WeightLog_user_id_date_idx" ON "WeightLog"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreferences_user_id_key" ON "NotificationPreferences"("user_id");

-- CreateIndex
CREATE INDEX "HabitLog_habit_id_date_idx" ON "HabitLog"("habit_id", "date");

-- CreateIndex
CREATE INDEX "Lesson_coach_id_idx" ON "Lesson"("coach_id");

-- CreateIndex
CREATE INDEX "CheckIn_user_id_date_idx" ON "CheckIn"("user_id", "date");

-- CreateIndex
CREATE INDEX "water_logs_user_id_logged_at_idx" ON "water_logs"("user_id", "logged_at");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoggedFoodEntry" ADD CONSTRAINT "LoggedFoodEntry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoggedFoodEntry" ADD CONSTRAINT "LoggedFoodEntry_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "FoodItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutSession" ADD CONSTRAINT "WorkoutSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExerciseSet" ADD CONSTRAINT "ExerciseSet_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "WorkoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkoutRoutine" ADD CONSTRAINT "WorkoutRoutine_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineExercise" ADD CONSTRAINT "RoutineExercise_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "WorkoutRoutine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FastingWindow" ADD CONSTRAINT "FastingWindow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightLog" ADD CONSTRAINT "WeightLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Habit" ADD CONSTRAINT "Habit_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HabitLog" ADD CONSTRAINT "HabitLog_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "Habit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonCompletion" ADD CONSTRAINT "LessonCompletion_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "Lesson"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonCompletion" ADD CONSTRAINT "LessonCompletion_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "water_logs" ADD CONSTRAINT "water_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
