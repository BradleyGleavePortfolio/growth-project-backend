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
-- family) uploaded for this run. S12B4-SOL-A1 closure: `evidence` is the validated
-- ObservationEvidenceV1 payload and is exactly the kind of value this pilot report must not
-- print (S3.4/S3.6 need counts and state, never the raw payload) — this query surfaces only
-- `evidence_digest` (already a sha256 digest in the database) and the declared/observed counts
-- pulled out of the payload as plain integers, never the payload itself. An operator who has an
-- explicit, separately-scoped need to inspect a specific evidence payload byte-for-byte does
-- that outside this pack, not by widening this default query.
SELECT
  o.id,
  o.execution_epoch,
  o.source_platform,
  o.account_scope_id_digest,
  o.family,
  o.basis_kind,
  o.evidence_digest,
  (o.evidence ->> 'declared_total')::int AS declared_total,
  (o.evidence ->> 'observed_unique')::int AS observed_unique,
  o.received_at
FROM "ScoutRunObservation" o
WHERE o.coach_id = :'coach_id'
  AND o.intent_id = :'intent_id'
ORDER BY o.execution_epoch, o.family, o.received_at;
