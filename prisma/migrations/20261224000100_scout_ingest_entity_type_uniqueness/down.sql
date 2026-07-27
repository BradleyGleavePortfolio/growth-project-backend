-- Reverse of 20261224000100_scout_ingest_entity_type_uniqueness (R82/R106).
-- Restores the narrow (coach_id, intent_id, source_id) key from 20261222000000.
--
-- ASYMMETRY, DELIBERATE. The forward step WIDENS a unique key and therefore
-- cannot fail. This reverse step NARROWS it and therefore CAN fail — by design.
-- Once the widened key is live, two rows may legitimately share
-- (coach_id, intent_id, source_id) while differing in entity_type. Recreating
-- the narrow index over that data is impossible without deleting one of them.
--
-- We do NOT delete. A coach's crawl data is not disposable, and a down
-- migration that silently discards rows to satisfy a constraint is a worse
-- outcome than a failed rollback. The CREATE UNIQUE INDEX below will abort the
-- transaction with a duplicate-key error if such rows exist, leaving the
-- widened key in place and the data intact.
--
-- If that happens the correct operator response is to stay on the widened key
-- (it is the correct one) and investigate why a rollback was wanted, NOT to
-- force the narrow key back by deleting rows.

BEGIN;

CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
    ON "ScoutIngestEntity" ("coach_id", "intent_id", "source_id");

DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key";

COMMIT;
