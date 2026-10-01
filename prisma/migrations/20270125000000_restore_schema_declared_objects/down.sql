-- Reverse of 20270125000000_restore_schema_declared_objects.
--
-- FOR THE CI REVERSIBILITY PROOF ONLY (migration-dry-run.yml: forward, down,
-- forward again, byte-identical schema). NEVER RUN AGAINST PRODUCTION: every
-- application release since April reads these objects, so removing them brings
-- back the outage the forward migration fixes, and the DROPs below delete every
-- row written to these tables and columns since the deploy. Production rollback
-- for this migration is forward-fix only.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Dropping a table also drops its indexes, constraints and policies.
DROP TABLE IF EXISTS "ListItem";
DROP TABLE IF EXISTS "SavedRecipe";
DROP TABLE IF EXISTS "Recipe";
DROP TABLE IF EXISTS "UserPreferences";
DROP TYPE IF EXISTS "ListType";

ALTER TABLE "NotificationPreferences"
  DROP COLUMN IF EXISTS "new_client_alerts",
  DROP COLUMN IF EXISTS "weekly_summary_enabled",
  DROP COLUMN IF EXISTS "daily_checkin_enabled";

ALTER TABLE "UserProfile"
  DROP COLUMN IF EXISTS "onboardingCompleted",
  DROP COLUMN IF EXISTS "calorie_display",
  DROP COLUMN IF EXISTS "water_goal_oz",
  DROP COLUMN IF EXISTS "meals_per_day",
  DROP COLUMN IF EXISTS "weight_unit",
  DROP COLUMN IF EXISTS "bio";

ALTER TABLE "User" DROP COLUMN IF EXISTS "archived_at";

COMMIT;
