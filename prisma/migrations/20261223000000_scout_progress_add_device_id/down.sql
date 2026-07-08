-- Reverse of migration.sql: restore the 2-column unique and drop device_id.
-- Collapsing distinct-device rows back to (coach_id, intent_id) could violate
-- the narrower unique, so de-duplicate first (keep the most recently updated
-- row per pair) before recreating the old index. IF EXISTS keeps it idempotent.
BEGIN;

DELETE FROM "ScoutProgressSnapshot" a
USING "ScoutProgressSnapshot" b
WHERE a."coach_id" = b."coach_id"
  AND a."intent_id" = b."intent_id"
  AND (a."updated_at" < b."updated_at"
       OR (a."updated_at" = b."updated_at" AND a."id" < b."id"));

DROP INDEX IF EXISTS "ScoutProgressSnapshot_coach_id_intent_id_device_id_key";
CREATE UNIQUE INDEX "ScoutProgressSnapshot_coach_id_intent_id_key" ON "ScoutProgressSnapshot"("coach_id", "intent_id");
ALTER TABLE "ScoutProgressSnapshot" DROP COLUMN "device_id";

COMMIT;
