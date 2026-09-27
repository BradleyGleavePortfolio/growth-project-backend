-- S12-B4 read-only observation pack — 04_provenance_and_roster.sql
-- Purpose: §3.4 "the completion ledger and ImportNativeProvenance", incl. S8-D1 person
-- provenance (native_kind = 'person', written by src/scout/reconstruct/native/person-writer.ts).
-- Zero rows anywhere here means "nothing reconstructed natively yet" — report as "not known
-- yet"/"none reconstructed", not as a failure.
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id, :intent_id (see 01_run_identity.sql). ImportNativeProvenance is keyed by
-- import_intent_id (the ImportIntent uuid), which is NULL on rows written before S7-L or by a
-- legacy run; this pack resolves it via ScoutImport.import_intent_id for the given intent_id.

-- 4a. Reconstruction ledger: per-identity accounting for this run (staged = reconstructed +
-- skipped + failed; S8-DOC's invariant, not enforced by this read, only checkable from it).
SELECT
  l.entity_type,
  l.source_platform,
  l.source_id,
  l.status,             -- reconstructed | skipped | failed
  l.target_kind,         -- person | scout_entity | workout_program | workout_plan | NULL
  l.target_id,
  l.reason,
  l.created_at
FROM "ScoutReconstructionLedger" l
WHERE l.coach_id = :'coach_id'
  AND l.intent_id = :'intent_id'
ORDER BY l.entity_type, l.source_platform, l.source_id;

-- 4b. Native provenance for this run's intent (incl. S8-D1: native_kind = 'person' rows are the
-- typed person handoff — outcome created|already_present|unresolved, never an UPDATE of an
-- existing Person: S8-D1 review-locked "one Person per accepted source identity").
SELECT
  p.source_namespace,
  p.entity_type,
  p.source_id,
  p.native_kind,          -- person | workout_program | workout_plan
  p.native_id,             -- NULL only when outcome = 'unresolved'
  p.outcome,               -- created | already_present | unresolved
  p.reason,                 -- set only when outcome = 'unresolved' (unresolved:<code>[:<qualifier>])
  p.created_at
FROM "ImportNativeProvenance" p
JOIN "ScoutImport" si
  ON si.coach_id = p.coach_id AND si.import_intent_id = p.import_intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
ORDER BY p.native_kind, p.entity_type, p.source_id;

-- 4c. Provenance outcome histogram, by native_kind — the fastest way to answer "how many
-- people/programs/plans did this run actually create vs. already have vs. leave unresolved".
SELECT
  p.native_kind,
  p.outcome,
  count(*) AS n
FROM "ImportNativeProvenance" p
JOIN "ScoutImport" si
  ON si.coach_id = p.coach_id AND si.import_intent_id = p.import_intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
GROUP BY p.native_kind, p.outcome
ORDER BY p.native_kind, p.outcome;

-- 4d. Roster this run produced (Person rows created via native_kind='person' provenance for
-- this run's intent) — "imported, not yet joined" is a state label the mobile UI applies (S8-D2 /
-- UX-D2); at the database this is simply an InvitePending Person with provenance pointing at
-- this intent. A coach with zero rows here after a settled run is reported as "roster: none
-- reconstructed", never as "roster: not known" (the run DID settle; the read is conclusive).
SELECT
  pn.id AS person_id,
  pn.source_platform,
  pn.source_person_id,
  pn.display_name,
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
  AND prov.outcome IN ('created', 'already_present')
ORDER BY pn.created_at;

-- 4e. Duplicate-native-identity check for this run's intent — a stop-immediately trigger if this
-- returns any row (§3.5: "a duplicate native identity after a replay"). Should always be empty;
-- the identity key is unique in the schema, so a hit here would mean the constraint was bypassed.
SELECT
  p.coach_id, p.source_namespace, p.entity_type, p.source_id, count(*) AS n
FROM "ImportNativeProvenance" p
JOIN "ScoutImport" si
  ON si.coach_id = p.coach_id AND si.import_intent_id = p.import_intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
GROUP BY p.coach_id, p.source_namespace, p.entity_type, p.source_id
HAVING count(*) > 1;
