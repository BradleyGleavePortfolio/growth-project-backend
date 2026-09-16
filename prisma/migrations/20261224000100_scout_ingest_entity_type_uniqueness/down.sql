-- Reverse of 20261224000100_scout_ingest_entity_type_uniqueness (R82/R106).
-- Restores the narrow (coach_id, intent_id, source_id) key from 20261222000000.
--
-- ASYMMETRY, DELIBERATE. The forward step WIDENS and cannot fail; this one
-- NARROWS and CAN fail, because once the widened key is live two rows may
-- legitimately share (coach_id, intent_id, source_id) while differing in
-- entity_type. We do NOT delete one to make room: discarding a coach's crawl rows
-- to satisfy a constraint is worse than a failed rollback, so CREATE UNIQUE INDEX
-- below aborts with a duplicate-key error, leaving the widened key and every row
-- intact. Stay on the widened key and investigate why a rollback was wanted.

BEGIN;

CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
    ON "ScoutIngestEntity" ("coach_id", "intent_id", "source_id");

DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key";

COMMIT;
