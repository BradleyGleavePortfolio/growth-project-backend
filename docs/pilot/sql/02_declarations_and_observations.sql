-- S12-B4 read-only observation pack — 02_declarations_and_observations.sql
-- Purpose: §3.4 "ScoutRunDeclaration and observation rows". Both tables are insert-only
-- (database trigger refuses UPDATE/DELETE/TRUNCATE); a row here is a permanent fact about what
-- was declared/observed, not a live status. Zero rows in either query means "not declared" /
-- "not observed" — report as "not known", never as "no" or 0 coverage.
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id, :intent_id (see 01_run_identity.sql)

-- 2a. Declarations: one row per (source_platform, account_scope_id_digest) the coach declared
-- for this run. account_scope_id_digest is already a sha256 digest in the database — this query
-- never needs, and must never be given, the raw source account id.
SELECT
  d.source_platform,
  d.account_scope_id_digest,
  encode(d.challenge, 'hex') AS challenge_hex,
  d.declared_at
FROM "ScoutRunDeclaration" d
WHERE d.coach_id = :'coach_id'
  AND d.intent_id = :'intent_id'
ORDER BY d.declared_at;

-- 2b. Observations: one row per (execution_epoch, source_platform, account_scope_id_digest,
-- family) uploaded for this run. `evidence` is the validated ObservationEvidenceV1 payload;
-- shown here in full because this pack is meant for a human deciding whether the pilot's
-- own claims are internally consistent, not for a wider audience — do not forward this
-- specific query's output outside the pilot review without checking it does not carry anything
-- beyond what §3.4 already permits to be examined by the builder/reviewer.
SELECT
  o.id,
  o.execution_epoch,
  o.source_platform,
  o.account_scope_id_digest,
  o.family,
  o.basis_kind,
  o.evidence_digest,
  o.evidence,
  o.received_at
FROM "ScoutRunObservation" o
WHERE o.coach_id = :'coach_id'
  AND o.intent_id = :'intent_id'
ORDER BY o.execution_epoch, o.family, o.received_at;
