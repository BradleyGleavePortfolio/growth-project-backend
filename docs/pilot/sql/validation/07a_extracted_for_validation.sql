-- Validation-only extract of 07_client_directed_sends.sql query 7a (the SELECT-only,
-- table-name-fixed part). NOT part of the shipped pack's public surface — kept only so
-- docs/pilot/sql/validation/VALIDATION_RUN.sh can execute 7a with a plain `-f` and record real output.
-- The pack file itself (07_client_directed_sends.sql) is the source of truth; keep this in sync
-- with its 7a block if that block ever changes.
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
