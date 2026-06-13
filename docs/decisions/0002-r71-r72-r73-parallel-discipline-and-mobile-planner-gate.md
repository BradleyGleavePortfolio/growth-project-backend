# ADR 0002 — R71 / R72 / R73: Parallel Discipline and Mobile Planner Gate

**Status:** Accepted
**Date:** 2026-06-12
**Decision owner:** Dynasia G (operator)
**Codified into:** `AGENT_RULES.md` (R71, R72, R73)

## Context

Between June 8 and June 12, 2026, the TGP build cadence shifted from 1 PR
in flight at a time to a sustained 5-concurrent-lane wave (community
expansion v1-6 → v3-1 plus parallel Roman P1–P4 and MWB-4 mobile
autosave). The new tempo surfaced three failure modes the prior rule set
(R0–R70) did not cover:

1. **Silent file-surface collisions between parallel siblings.** Two
   builders writing to overlapping paths discovered the conflict only at
   merge time, forcing rebase loops and burning audit cycles.
2. **Audit-stop-on-first-finding.** Auditors that returned `DIRTY` on the
   first P1 they found, without sweeping the rest of the diff, caused
   each fixer round to surface a new tranche of P1s the prior auditor
   never even examined.
3. **Functionally-correct but emotionally-flat mobile screens.** The
   builder stack ships React Native screens that compile, pass tests,
   and clear R65 — but feel generic. `MOBILE_APP_DESIGN_INTELLIGENCE.md`
   (a 17,000-word internal design manual covering Norman three levels,
   Apple cognitive de-load, Hick's law, progressive disclosure, Strava
   activity-design, and a Screen Design Protocol) is the team's source
   of truth, but no rule required builders to read it.

## Decision

**R71** codifies parallel-PR file ownership: every concurrent brief
declares OWNS / MUST-NOT-TOUCH / shared-append-only file lists, with
`§7C file_surface_overlap_check` enforced by the parent agent
pre-dispatch. Concurrent-lane cap is 5 by default.

**R72** codifies audit exhaustiveness: every audit sweeps the entire
changed-file diff, applies the full 50-failures checklist (R65), and
produces a single P0-P3 ranked report. Stop-on-first is malformed.

**R73** codifies the Mobile Planner Gate: a Planner stage precedes
every substantive mobile-screen build. Planner is a fresh GPT-5.5
subagent that reads `MOBILE_APP_DESIGN_INTELLIGENCE.md` in full and
produces a screen-specific design brief covering emotional
architecture, cognitive load, default path, progressive disclosure,
domain-specific moves, anti-patterns, component-level decisions, and
a §6.2 Master Checklist walk-through. Builder receives this brief as
mandatory input. Auditor grades against it. Planner ≠ Builder ≠
Auditor ≠ Fixer (R31 extended to four roles).

## Consequences

**Positive:**
- File-collision rebase loops eliminated for in-flight waves.
- Audit cycles compress (one exhaustive audit per round instead of
  N peel-the-onion rounds).
- Mobile screens ship with explicit emotional-architecture and
  cognitive-load reasoning, not as an afterthought.
- Planner brief becomes durable design documentation per screen — every
  screen now has a written rationale for its UX decisions.

**Costs:**
- One extra GPT-5.5 subagent per mobile screen build (~5–10 minutes).
- Parent agent must run §7C overlap check before every concurrent
  dispatch.
- Briefs become longer (OWNS/MUST-NOT-TOUCH/shared-append sections).

**Net:** all three rules are forced by the velocity we're already
running at. The cost is the price of admission for 5-lane concurrency
plus decacorn-grade screen quality.

## Effective

2026-06-12 (this PR's merge SHA). R73 applies forward only — screens
already in flight at merge time (PR #237 MWB-4 autosave, PR #241 Roman
P3, PR #242 Roman P4) are not retroactively required to spawn
Planners; their fixer cycles continue under the prior rule set.

## See also

- `tgp-agent-context/quality-references/MOBILE_APP_DESIGN_INTELLIGENCE.md` — Planner source-of-truth
- `tgp-agent-context/quality-references/50_FAILURES_OF_AI_GENERATED_CODE.md` — R65 sweep
- `tgp-agent-context/COMMUNITY_PARALLELIZATION_PLAN.md` — origin of the 5-lane cap
- `tgp-agent-context/quality-references/PLANNER_BRIEF_TEMPLATE.md` — R73 template
- `docs/decisions/0001-community-v1-1-doctrine-collision-path-a.md` — prior ADR template
