-- S12-B4 read-only observation pack — 03_settled_basis.sql
-- Purpose: §3.4 "the settled basis (families[] with known and observed_unique)". This is the
-- single row S9/S10 wrote when the run settled; it is the authoritative per-family coverage
-- report (src/scout/reconciliation/reconcile.ts `ReconciliationReportV1.families`). Zero rows
-- means the run has not settled — report every family as "unknown (not yet settled)", never as
-- 0 or "complete".
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id, :intent_id (see 01_run_identity.sql)

-- 3a. The raw settled-basis row (report_version, full JSON report, observation digest list).
SELECT
  sb.coach_id,
  sb.intent_id,
  sb.execution_epoch,
  sb.report_version,
  sb.report,
  sb.observation_digests,
  sb.settled_at
FROM "ScoutRunSettledBasis" sb
WHERE sb.coach_id = :'coach_id'
  AND sb.intent_id = :'intent_id';

-- 3b. The same report, unpacked one row per family, for the pilot-report table in
-- docs/pilot/PILOT_RUNBOOK.md §5. `known: false` OR `observed_unique IS NULL` must be rendered
-- as "unknown (<qualifiers/reasons>)" by the report author — this query only surfaces the raw
-- fields; it does not itself decide the word "unknown" (D-S11-7(4): unknown never silently
-- becomes zero — that discipline lives in how the reader of this output writes the report, not
-- in a CASE expression that could quietly coerce NULL to 0).
SELECT
  sb.coach_id,
  sb.intent_id,
  fam.value ->> 'family'                                   AS family,
  (fam.value ->> 'mapped')::boolean                         AS mapped,
  (fam.value -> 'tokens')                                   AS tokens,
  (fam.value ->> 'staged_unique')::int                       AS staged_unique,
  (fam.value ->> 'native_present_verified')::int             AS native_present_verified,
  (fam.value ->> 'rejected')::int                            AS rejected,
  (fam.value ->> 'unresolved')::int                          AS unresolved,
  (fam.value ->> 'failed')::int                              AS failed,
  (fam.value ->> 'ledger_without_staged')::int               AS ledger_without_staged,
  fam.value -> 'unresolved_children'                         AS unresolved_children,
  fam.value ->> 'relationship_closure'                       AS relationship_closure,
  (fam.value ->> 'relationship_unverified')::int             AS relationship_unverified,
  fam.value -> 'reasons'                                     AS reasons,
  fam.value -> 'child_reasons'                               AS child_reasons,
  fam.value -> 'qualifiers'                                  AS qualifiers,        -- e.g. roster_bridge_pending
  fam.value ->> 'completeness_basis'                         AS completeness_basis, -- 'none' = unknown
  (fam.value ->> 'observed_unique')::int                      AS observed_unique,    -- NULL = unknown
  ((fam.value ->> 'completeness_basis') = 'none'
    OR (fam.value ->> 'observed_unique') IS NULL)             AS coverage_is_unknown
FROM "ScoutRunSettledBasis" sb
CROSS JOIN LATERAL jsonb_array_elements(sb.report -> 'families') AS fam(value)
WHERE sb.coach_id = :'coach_id'
  AND sb.intent_id = :'intent_id'
ORDER BY family;

-- 3c. Run-level verdict conditions held (S9-C `conditions[]` on the report) and the
-- required_families list, so the reader can see WHY a partial is partial (the closed catalogue
-- in src/scout/lifecycle/reason-codes.ts, D-S9-2 condition order: unresolved_family,
-- unresolved_identities, relationship_unverified, coverage_basis_unknown).
SELECT
  sb.coach_id,
  sb.intent_id,
  sb.report ->> 'basis'              AS basis,             -- 'recomputed' at this base
  sb.report -> 'conditions'          AS conditions_held,
  sb.report -> 'required_families'   AS required_families, -- null = undeterminable, not "none"
  (sb.report ->> 'ledger_without_staged')::int AS ledger_without_staged
FROM "ScoutRunSettledBasis" sb
WHERE sb.coach_id = :'coach_id'
  AND sb.intent_id = :'intent_id';
