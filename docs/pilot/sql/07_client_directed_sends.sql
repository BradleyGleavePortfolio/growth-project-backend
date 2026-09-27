-- S12-B4 read-only observation pack — 07_client_directed_sends.sql
-- Purpose: §3.5 stop-immediately trigger "any client-directed message"; §3.4 "Push: one
-- coach-directed import.complete, sent on the first claim only" is COACH-directed and expected
-- once per settled run — this file checks that nothing CLIENT-directed exists for this run.
-- S12a ships with FEATURE_PERSON_LINK absent, so there should be no invite/claim/notification
-- route reachable at all; this is the read that proves it stayed that way.
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id, :intent_id (see 01_run_identity.sql)

-- 7a. Any row in a person-link / invite table for people this run's provenance created. At this
-- slice's base there is no landed invite/claim table (S8-D3/D4a/D4b/D5 are not built per
-- S12_PILOT_READINESS.md §2b) — this query is written against the Person state machine only, so
-- it still means something once those tables land: a Person state beyond InvitePending for a
-- person this run created, with no explicit owner-approved S12b action on record, is the
-- signal to treat as a stop-immediately client-directed action.
SELECT
  pn.id AS person_id,
  pn.state,
  pn.created_at,
  pn.updated_at
FROM "ImportNativeProvenance" prov
JOIN "ScoutImport" si
  ON si.coach_id = prov.coach_id AND si.import_intent_id = prov.import_intent_id
JOIN "Person" pn
  ON pn.id = prov.native_id AND pn.coach_id = prov.coach_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
  AND prov.native_kind = 'person'
  AND pn.state <> 'InvitePending';

-- 7b. Coach-directed push/analytics events for this run, shown for completeness so the reader
-- can see the ONE expected coach-directed push (import.complete, first claim only) and confirm
-- nothing else fired. This reads whatever analytics/event log table this environment actually
-- writes to (S12_PILOT_READINESS.md §3.4 names the event constants in src/analytics/events.ts:
-- SCOUT_RUN_STARTED, SCOUT_RUN_FENCED, SCOUT_RUN_SETTLED, SCOUT_INGEST_COMPLETED,
-- SCOUT_IMPORT_STATUS_READ, SCOUT_IMPORT_STATUS_INVALID, SCOUT_RECONSTRUCT_COMPLETED,
-- SCOUT_RECONSTRUCT_ROSTER_READ, SCOUT_RECONSTRUCT_ENTITIES_READ). This pack does not assume a
-- fixed analytics table name/schema (none is pinned in the Prisma schema at this base); resolve
-- the actual sink for the target environment before running this half, and keep it SELECT-only.
--
-- Template (fill in <analytics_table> for the environment being reported on):
--
-- SELECT event_name, coach_id, intent_id, occurred_at, properties
-- FROM <analytics_table>
-- WHERE coach_id = :'coach_id'
--   AND intent_id = :'intent_id'
--   AND event_name LIKE 'scout.%'
-- ORDER BY occurred_at;
