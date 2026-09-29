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
-- S12B4-SOL-A1 closure: this pilot pack answers "what happened", never "who" — source_id and
-- target_id are real source-system identifiers (and, for target_kind='person', a native row
-- pointer), so they are hashed here rather than printed. If a specific identity ever needs
-- tracing, that is a separate, explicitly-scoped operator query outside this pack, not a
-- default column in a report meant for aggregate pilot observation.
SELECT
  l.entity_type,
  l.source_platform,
  encode(sha256(l.source_id::bytea), 'hex') AS source_id_digest,
  l.status,             -- reconstructed | skipped | failed
  l.target_kind,         -- person | scout_entity | workout_program | workout_plan | NULL
  (l.target_id IS NOT NULL) AS has_target_id,
  l.reason,
  l.created_at
FROM "ScoutReconstructionLedger" l
WHERE l.coach_id = :'coach_id'
  AND l.intent_id = :'intent_id'
ORDER BY l.entity_type, l.source_platform, source_id_digest;

-- 4b. Native provenance for this run's intent (incl. S8-D1: native_kind = 'person' rows are the
-- typed person handoff — outcome created|already_present|unresolved, never an UPDATE of an
-- existing Person: S8-D1 review-locked "one Person per accepted source identity"). Same
-- S12B4-SOL-A1 redaction as 4a: source_id is hashed, native_id is reduced to presence-only.
SELECT
  p.source_namespace,
  p.entity_type,
  encode(sha256(p.source_id::bytea), 'hex') AS source_id_digest,
  p.native_kind,          -- person | workout_program | workout_plan
  (p.native_id IS NOT NULL) AS has_native_id, -- false only when outcome = 'unresolved'
  p.outcome,               -- created | already_present | unresolved
  p.reason,                 -- set only when outcome = 'unresolved' (unresolved:<code>[:<qualifier>])
  p.created_at
FROM "ImportNativeProvenance" p
JOIN "ScoutImport" si
  ON si.coach_id = p.coach_id AND si.import_intent_id = p.import_intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
ORDER BY p.native_kind, p.entity_type, source_id_digest;

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
-- S12B4-SOL-A1 closure: the pilot report needs a COUNT and a state distribution, never the
-- client's name or the raw source person id — pn.display_name and pn.source_person_id are
-- real client PII and are dropped from this pack; person_id (our own internal UUID, not a
-- source identifier) is kept only because 4e's duplicate check needs a stable join key an
-- operator could cross-reference without it being a source-system value.
SELECT
  pn.id AS person_id,
  pn.source_platform,
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

-- 4d-count. The single number the §5 report template actually needs ("Roster: <n>") — prefer
-- this over counting 4d's rows by hand, and prefer it over 4d entirely when only the count is
-- needed for the report (4d remains available for an operator who needs the per-row state
-- distribution without any name/source-id column).
SELECT count(*) AS roster_count
FROM "ImportNativeProvenance" prov
JOIN "ScoutImport" si
  ON si.coach_id = prov.coach_id AND si.import_intent_id = prov.import_intent_id
JOIN "Person" pn
  ON pn.id = prov.native_id AND pn.coach_id = prov.coach_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
  AND prov.native_kind = 'person'
  AND prov.outcome IN ('created', 'already_present');

-- 4e. Duplicate-native-identity check for this run's intent — a stop-immediately trigger if this
-- returns any row (§3.5: "a duplicate native identity after a replay"). Should always be empty;
-- the identity key is unique in the schema, so a hit here would mean the constraint was bypassed.
SELECT
  p.coach_id, p.source_namespace, p.entity_type,
  encode(sha256(p.source_id::bytea), 'hex') AS source_id_digest,
  count(*) AS n
FROM "ImportNativeProvenance" p
JOIN "ScoutImport" si
  ON si.coach_id = p.coach_id AND si.import_intent_id = p.import_intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id'
GROUP BY p.coach_id, p.source_namespace, p.entity_type, source_id_digest
HAVING count(*) > 1;
