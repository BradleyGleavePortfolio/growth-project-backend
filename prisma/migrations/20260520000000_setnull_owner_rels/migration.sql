-- Pre-TestFlight P0 (audit ref: GDPR/data, master report line 200):
-- Switch the coach / client FKs on CoachMessage, CoachNudge, MealPlan, and
-- CoachGuideline from ON DELETE CASCADE to ON DELETE SET NULL so a hard-
-- deleted user does not cascade away historical thread / plan rows that
-- operators may still need to inspect for support or compliance.
--
-- The GDPR scrub worker (src/users/gdpr-scrub.service.ts) is soft-delete
-- today, so this migration is defense-in-depth: if the worker is ever
-- changed to issue real DELETEs on the User table, the related rows are
-- preserved with the FK columns nulled rather than disappearing.
--
-- The migration is also defensive against rare manual cleanups
-- (Supabase admin → "delete user") which DO cascade to Postgres today.
-- Operators have hit this once in staging.
--
-- Steps:
--   1. Relax NOT NULL on the FK columns (Prisma generates these as nullable
--      String? in the schema after this PR).
--   2. Null-out any existing orphans (rows whose coach_id / client_id /
--      sender_id no longer reference an extant User row — should be zero
--      in prod, but the UPDATE is idempotent and cheap).
--   3. Drop the existing CASCADE FK constraints.
--   4. Re-add the constraints with ON DELETE SET NULL.

BEGIN;

-- 1) Relax NOT NULL.
ALTER TABLE "CoachMessage"   ALTER COLUMN "coach_id"  DROP NOT NULL;
ALTER TABLE "CoachMessage"   ALTER COLUMN "client_id" DROP NOT NULL;
ALTER TABLE "CoachMessage"   ALTER COLUMN "sender_id" DROP NOT NULL;
ALTER TABLE "CoachNudge"     ALTER COLUMN "coach_id"  DROP NOT NULL;
ALTER TABLE "CoachNudge"     ALTER COLUMN "client_id" DROP NOT NULL;
ALTER TABLE "MealPlan"       ALTER COLUMN "coach_id"  DROP NOT NULL;
ALTER TABLE "MealPlan"       ALTER COLUMN "client_id" DROP NOT NULL;
ALTER TABLE "CoachGuideline" ALTER COLUMN "coach_id"  DROP NOT NULL;
ALTER TABLE "CoachGuideline" ALTER COLUMN "client_id" DROP NOT NULL;

-- 2) Orphan cleanup. The UPDATE is a no-op if all rows are referentially
--    intact (the FK constraints below would have prevented orphans up to
--    this point). Cheap on small tables; safe on large ones because the
--    correlated subquery is index-supported by User_pkey.
UPDATE "CoachMessage"   SET "coach_id"  = NULL WHERE "coach_id"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachMessage"."coach_id");
UPDATE "CoachMessage"   SET "client_id" = NULL WHERE "client_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachMessage"."client_id");
UPDATE "CoachMessage"   SET "sender_id" = NULL WHERE "sender_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachMessage"."sender_id");
UPDATE "CoachNudge"     SET "coach_id"  = NULL WHERE "coach_id"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachNudge"."coach_id");
UPDATE "CoachNudge"     SET "client_id" = NULL WHERE "client_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachNudge"."client_id");
UPDATE "MealPlan"       SET "coach_id"  = NULL WHERE "coach_id"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "MealPlan"."coach_id");
UPDATE "MealPlan"       SET "client_id" = NULL WHERE "client_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "MealPlan"."client_id");
UPDATE "CoachGuideline" SET "coach_id"  = NULL WHERE "coach_id"  IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachGuideline"."coach_id");
UPDATE "CoachGuideline" SET "client_id" = NULL WHERE "client_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = "CoachGuideline"."client_id");

-- 3) Drop existing CASCADE constraints.
ALTER TABLE "CoachMessage"   DROP CONSTRAINT IF EXISTS "CoachMessage_coach_id_fkey";
ALTER TABLE "CoachMessage"   DROP CONSTRAINT IF EXISTS "CoachMessage_client_id_fkey";
ALTER TABLE "CoachMessage"   DROP CONSTRAINT IF EXISTS "CoachMessage_sender_id_fkey";
ALTER TABLE "CoachNudge"     DROP CONSTRAINT IF EXISTS "CoachNudge_coach_id_fkey";
ALTER TABLE "CoachNudge"     DROP CONSTRAINT IF EXISTS "CoachNudge_client_id_fkey";
ALTER TABLE "MealPlan"       DROP CONSTRAINT IF EXISTS "MealPlan_coach_id_fkey";
ALTER TABLE "MealPlan"       DROP CONSTRAINT IF EXISTS "MealPlan_client_id_fkey";
ALTER TABLE "CoachGuideline" DROP CONSTRAINT IF EXISTS "CoachGuideline_coach_id_fkey";
ALTER TABLE "CoachGuideline" DROP CONSTRAINT IF EXISTS "CoachGuideline_client_id_fkey";

-- 4) Re-add with ON DELETE SET NULL.
ALTER TABLE "CoachMessage"   ADD CONSTRAINT "CoachMessage_coach_id_fkey"   FOREIGN KEY ("coach_id")  REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachMessage"   ADD CONSTRAINT "CoachMessage_client_id_fkey"  FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachMessage"   ADD CONSTRAINT "CoachMessage_sender_id_fkey"  FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachNudge"     ADD CONSTRAINT "CoachNudge_coach_id_fkey"     FOREIGN KEY ("coach_id")  REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachNudge"     ADD CONSTRAINT "CoachNudge_client_id_fkey"    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MealPlan"       ADD CONSTRAINT "MealPlan_coach_id_fkey"       FOREIGN KEY ("coach_id")  REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MealPlan"       ADD CONSTRAINT "MealPlan_client_id_fkey"      FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachGuideline" ADD CONSTRAINT "CoachGuideline_coach_id_fkey" FOREIGN KEY ("coach_id")  REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachGuideline" ADD CONSTRAINT "CoachGuideline_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
