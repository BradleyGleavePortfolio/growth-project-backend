-- Prevent concurrent active fasting windows per user
CREATE UNIQUE INDEX IF NOT EXISTS "FastingWindow_one_active_per_user"
ON "FastingWindow" ("user_id")
WHERE "end_time" IS NULL;
