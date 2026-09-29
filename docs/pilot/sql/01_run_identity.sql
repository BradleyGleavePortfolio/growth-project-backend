-- S12-B4 read-only observation pack — 01_run_identity.sql
-- Purpose: §3.4 "ScoutImport (mode, phase, epoch, accepted_start_at, deadline_at,
-- last_observed_at, stored claim, terminal_status, reason_code)". One row, or zero if the run
-- has not been created yet (report that as "no run yet", never as any terminal_status).
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id  -- the pilot coach's User.id (uuid), from 00_find_coach.sql
--         :intent_id -- the run's intent id (server mode: the ImportIntent.id text; legacy mode:
--                        the extension-minted imp-…/ext-… string)

SELECT
  si.coach_id,
  si.intent_id,
  si.mode,                    -- 'legacy' | 'server' — a legacy run's terminal is the extension's
                               -- claim, never a server verdict (S12_PILOT_READINESS.md §0.1)
  si.state,
  si.terminal_status,         -- NULL until settled; report as "not yet terminal", never as a code
  si.reason_code,             -- NULL unless terminal_status is set; from the closed catalogue in
                               -- src/scout/lifecycle/reason-codes.ts (RUN_REASON_CODES)
  si.phase,                   -- discovering | transferring | reconciling | NULL (legacy)
  si.execution_epoch,
  si.started_at,
  si.accepted_start_at,       -- NULL on legacy rows
  si.deadline_at,             -- NULL on legacy rows; compare to now() only to describe state,
                               -- never to fence anything from this read-only pack
  si.last_observed_at,
  si.fenced_at,
  si.fence_reason,            -- cancelled | timed_out | revoked | NULL
  si.completed_at,
  si.import_intent_id,
  -- The extension's OWN claim, kept next to (never merged into) the server verdict, per
  -- §3.4: "The extension's claim is reported separately, as the extension's statement, beside
  -- the server verdict."
  comp.terminal_status AS extension_claimed_terminal_status,
  comp.final_counts    AS extension_claimed_final_counts,
  comp.completed_at    AS extension_claimed_completed_at
FROM "ScoutImport" si
LEFT JOIN "ScoutImportCompletion" comp
  ON comp.coach_id = si.coach_id AND comp.intent_id = si.intent_id
WHERE si.coach_id = :'coach_id'
  AND si.intent_id = :'intent_id';
