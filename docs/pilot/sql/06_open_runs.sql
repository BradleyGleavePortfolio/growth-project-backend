-- S12-B4 read-only observation pack — 06_open_runs.sql
-- Purpose: surface runs that are open with no fence and no terminal, most importantly the C4
-- case (S12-B1 review B, "C4": removing a coach from the allowlist leaves an open run open
-- until they are re-listed and read status, which then lazily fences it timed_out — see
-- docs/pilot/PILOT_RUNBOOK.md §3 "C4"). This query does not fence anything; it only reports.
-- SELECT only, parameterised, never run against production by a builder.
--
-- Params: :coach_id (optional narrowing — omit the predicate to check across the whole pilot
--         allowlist, which by design should be at most one coach during S12a)

SELECT
  si.coach_id,
  si.intent_id,
  si.mode,
  si.state,
  si.phase,
  si.accepted_start_at,
  si.deadline_at,
  si.fenced_at,
  si.fence_reason,
  si.terminal_status,
  now() > si.deadline_at AS past_deadline_but_unfenced,
  now() - si.deadline_at AS overdue_by
FROM "ScoutImport" si
WHERE si.coach_id = :'coach_id'
  AND si.terminal_status IS NULL
  AND si.fenced_at IS NULL
ORDER BY si.deadline_at NULLS LAST, si.started_at;

-- Read this result as: any row with past_deadline_but_unfenced = true is exactly the C4
-- situation — a run whose deadline has already passed but which nobody has re-listed the coach
-- to read (the lazy fence only fires on the next status read). Report each such row as "open,
-- unresolved, not cancelled" — never silently as timed_out (it has not actually been fenced yet)
-- and never omitted from the pilot report just because the coach is currently off the allowlist.
