# Wave 1.5 BIG — Planning Branch

This branch holds the design artifacts for Wave 1.5 BIG (the expanded version of Wave 1.5 after Bradley's overrides on 2026-06-16).

**Scope:** server-side feature-flag infrastructure, search γ CTA attachment, content↔package mapping, gym-owner role + RLS privacy, slicing dimensions (tier/cohort/program_enrollment/coach_assignment/tag/activity), LRU+Redis pub/sub cache, bidirectional drift telemetry.

## Files

- `SERVER_SIDE_FEATURE_FLAGS_SPEC.md` — mobile γ contract extracted read-only (Planner output)
- `DECISIONS.md` — 7 locked product decisions + bonus + overrides from session 2026-06-15→16
- `design-reference/` — Quiet Luxury Doctrine training material (authoritative for CTA UX)
- `evidence/` — Mobile code citations supporting the spec
- `plan_a_evidence/` — Planner A working files (in progress)

## Planning subagents

- PLANNER A — Content↔package mapping + luxury CTA UX (relaunching with luxury doc)
- PLANNER B — Gym-owner role + RLS privacy boundaries (in flight)
- PLANNER C — Slicing+evaluator architecture + LRU/Redis + drift telemetry (in flight)

Plans land here as `PLAN_A_*.md`, `PLAN_B_*.md`, `PLAN_C_*.md` before any builder spins.

**No code lands until all three plans are approved by Bradley.**

R74 identity: `Bradley Gleave <bradley@bradleytgpcoaching.com>`
