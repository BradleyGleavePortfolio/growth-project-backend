-- S12-B4 read-only observation pack — 05_tenant_isolation.sql
-- Purpose: §3.5 success criterion "zero rows or reads for any other coach" / stop-immediately
-- trigger "any cross-tenant row or read". This file is deliberately the ONLY one in this pack
-- that is allowed to look beyond a single :coach_id, and only to prove that nothing else was
-- touched — never to browse another coach's data.
-- SELECT only, never run against production by a builder.
--
-- Params: :coach_id (the pilot coach), :window_start, :window_end (UTC timestamps bounding the
--         pilot run, so this check is scoped in time as well as by table)

-- 5a. Any Scout/importer row for a DIFFERENT coach created inside the pilot window. Every S8/S10
-- write is keyed by coach_id (S12_PILOT_READINESS.md §3.1); a non-empty result here for any
-- table is a stop-immediately finding, not something to summarize away.
--
-- S12B4-SOL-B1 closure — read this query for exactly what it is, nothing more:
--   * It is a TIME-WINDOW ACTIVITY SIGNAL, not a causal audit. A non-empty row proves another
--     coach's own ordinary activity happened to fall inside [:window_start, :window_end]; it
--     does NOT by itself prove that activity was caused by, or read during, the pilot run. The
--     positive control in VALIDATION.md demonstrates exactly this: a second coach's unrelated,
--     legitimate run inside a wide window flags here even though the pilot run never touched it.
--     Treat any hit as "investigate", not as a proven cross-tenant leak, and narrow the window
--     to the pilot run's own accepted_start_at..completed_at (or as tight as the evidence
--     allows) before drawing a conclusion from a hit.
--   * Zero rows here is NOT proof of "zero cross-tenant reads". This table only sees WRITES
--     (created_at/started_at/etc. on rows owned by another coach); it has no way to observe a
--     READ of another coach's data that left no row of its own to find. "Zero rows" means "no
--     other coach's write landed in this window", never "reads were verified isolated" — the
--     pilot report template (§5) must say exactly that and never claim a security "PASS" from
--     this query alone.
SELECT 'ScoutImport' AS tbl, coach_id, intent_id::text AS key, started_at AS at
FROM "ScoutImport"
WHERE coach_id <> :'coach_id' AND started_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ScoutIngestEntity', coach_id, intent_id, created_at
FROM "ScoutIngestEntity"
WHERE coach_id <> :'coach_id' AND created_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ScoutReconstructionLedger', coach_id, intent_id, created_at
FROM "ScoutReconstructionLedger"
WHERE coach_id <> :'coach_id' AND created_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ImportNativeProvenance', coach_id, coalesce(import_intent_id::text, ''), created_at
FROM "ImportNativeProvenance"
WHERE coach_id <> :'coach_id' AND created_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ScoutRunDeclaration', coach_id, intent_id, declared_at
FROM "ScoutRunDeclaration"
WHERE coach_id <> :'coach_id' AND declared_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ScoutRunObservation', coach_id, intent_id, received_at
FROM "ScoutRunObservation"
WHERE coach_id <> :'coach_id' AND received_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'ScoutRunSettledBasis', coach_id, intent_id, settled_at
FROM "ScoutRunSettledBasis"
WHERE coach_id <> :'coach_id' AND settled_at BETWEEN :'window_start' AND :'window_end'
UNION ALL
SELECT 'Person', coach_id, id, created_at
FROM "Person"
WHERE coach_id <> :'coach_id' AND created_at BETWEEN :'window_start' AND :'window_end'
ORDER BY tbl, at;

-- 5b. One workspace per coach per platform (§3.1 additional pilot limit): the pilot coach must
-- not have declared more than one distinct (source_platform, account_scope_id_digest) across
-- ALL of their runs, not just this one. More than one row is not itself a stop-immediately
-- trigger but must be called out in the report as a pilot-limit deviation.
SELECT
  source_platform,
  account_scope_id_digest,
  count(DISTINCT intent_id) AS runs_declared_against_this_scope,
  min(declared_at) AS first_declared_at,
  max(declared_at) AS last_declared_at
FROM "ScoutRunDeclaration"
WHERE coach_id = :'coach_id'
GROUP BY source_platform, account_scope_id_digest
ORDER BY first_declared_at;

-- 5c. Is the pilot coach also a client of another coach (S8D OQ-4, an additional pilot limit)?
-- Non-NULL coach_id on their own User row means yes — call it out in the report.
SELECT id, coach_id AS reports_to_coach_id
FROM "User"
WHERE id = :'coach_id';
