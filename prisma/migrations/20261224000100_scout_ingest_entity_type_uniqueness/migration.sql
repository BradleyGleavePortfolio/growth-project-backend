-- IMPORTER I1a — add entity_type to the ScoutIngestEntity idempotency key.
--
-- P0 SILENT DATA LOSS. The original key (20261222000000) is
--   UNIQUE (coach_id, intent_id, source_id)
-- but entity_type is part of the ingest envelope and is stored as a VALUE.
-- The extension posts one envelope per entity_type within a single intent, and
-- source ids are only unique WITHIN a type on every adapter we have modelled
-- (a TrueCoach client and a TrueCoach workout can both be id "1042"). So the
-- second envelope of a crawl session collides on (coach_id, intent_id,
-- source_id) and is dropped.
--
-- The drop is SILENT, which is what makes this a P0 rather than a P1. The
-- writer is createMany({ skipDuplicates: true }) — i.e. ON CONFLICT DO NOTHING
-- — so it does not raise P2002. The row simply never lands, and
-- `deduped = received - count` then reports the lost row as a successful
-- replay. A crawl reports success while silently discarding an entire
-- entity_type.
--
-- CORRECTION TO R-IDEMP-1 (2026-07-08). The original invariant is RIGHT about
-- captured_at and WRONG about completeness. Restated:
--
--   captured_at stays a VALUE, not a key column. A coach re-observes the same
--   source entity over time and each re-observation within an intent must be a
--   no-op replay; putting captured_at in the key would let an extension retry
--   with a fresh timestamp insert a duplicate and defeat replay-safety.
--
--   entity_type IS a key column. The unit of identity is "the coach saw entity
--   X OF TYPE T during crawl session Y", not "entity X during session Y".
--   source_id is namespaced by type at the source, so the key must be too.
--
-- The 20261222000000 migration is shipped and is NEVER edited (ENGINEERING
-- RULES §2, append-only). This migration is the correction; the stale reasoning
-- in that file's header stands as historical record (R5).
--
-- The corrected key matches the two sibling scout tables, which already got
-- this right and are the reason the defect is unambiguous rather than a
-- judgement call:
--   ScoutReconstructionLedger  UNIQUE (coach_id, intent_id, entity_type, source_id)
--   ScoutReconstructedEntity   UNIQUE (coach_id, source_platform, entity_type, source_id)
--
-- SAFETY. WIDENING a unique key can never fail on existing data: every row that
-- satisfied UNIQUE (a,b,c) also satisfies UNIQUE (a,b,c,d). There is no
-- backfill, no data rewrite, no lock beyond the index build, and no possible
-- constraint-violation abort. The change is purely permissive — batches that
-- were previously dropped now land.
--
-- REVERSIBLE (R82/R106): the reverse step is in the companion down.sql. Note
-- that the reverse is NARROWING and therefore CAN fail if rows that only the
-- widened key permits have already landed. That is correct behaviour, not a
-- defect: down.sql refuses rather than silently deleting a coach's crawl data.
-- The narrowing conflict is surfaced explicitly there.
--
-- FLAGS: FEATURE_SCOUT_INGEST remains default-OFF. This migration changes no
-- runtime behaviour on its own.
--
-- RLS: unchanged. ENABLE + FORCE ROW LEVEL SECURITY and the three policies from
-- 20261222000000 are attached to the TABLE, not to the index, and are untouched
-- by an index swap. Re-asserted below so the posture is verifiable at this
-- migration rather than only at the original one.
-- =====================================================================

BEGIN;

-- Create the widened key FIRST, then drop the narrow one. Both orders are safe
-- inside a transaction; this order means that if the DROP were ever moved out
-- of the transaction there is never a window with no uniqueness constraint.
CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key"
    ON "ScoutIngestEntity" ("coach_id", "intent_id", "entity_type", "source_id");

DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_source_id_key";

-- RLS re-assertion (idempotent). Not a posture change — these are the exact
-- policies from 20261222000000, restated so this migration is self-describing
-- and a reviewer does not have to cross-reference to confirm the table is still
-- service_role-only.
ALTER TABLE "ScoutIngestEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutIngestEntity" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_ingest_service_role_all" ON "ScoutIngestEntity";
CREATE POLICY "p_scout_ingest_service_role_all" ON "ScoutIngestEntity" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_ingest_service_role_all" ON "ScoutIngestEntity" IS 'service_role bypass: the crawl-envelope receiver writes/reads only via the server-side ingest engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_ingest" ON "ScoutIngestEntity";
CREATE POLICY "deny_all_anon_scout_ingest" ON "ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_ingest" ON "ScoutIngestEntity" IS 'RESTRICTIVE deny-all: anon can never read/write crawl data regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity";
CREATE POLICY "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write crawl data; only service_role may.';

COMMIT;
