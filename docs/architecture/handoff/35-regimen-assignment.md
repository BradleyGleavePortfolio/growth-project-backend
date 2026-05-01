# Handoff brief 35 — Per-client regimen assignment

> Operator-facing pre-work brief for expansion-roadmap item **#35**.
> Companion to the engineer-facing spec at
> [`../../specs/regimen-assignment.md`](../../specs/regimen-assignment.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 35](../expansion-wave-coach-experience.md).

---

## WHY

A regimen (#34) is a recipe; an assignment is the bake. The
assignment row pins a *version* to a client over time, supports
pause/resume, survives re-assignment (lineage), and answers
"what is this client doing this week" in O(1). Without it,
the platform cannot honor pause/resume or show the coach's
history with a client. See spec §2.

## WHEN

Gated on:

1. Spec #34 review (regimen schema final).
2. Spec #28 review (clone transaction final).
3. Founder sign-off on pause-resume policy (subtract paused
   seconds from elapsed; default).
4. Backend lead sign-off on consent gate (assignment requires
   active `ClientCoachConsent`).

## WHERE

- **New module:** `src/regimen-assignments/` (spec §4).
- **New tables:** `RegimenAssignment`,
  `RegimenAssignmentEvent`.
- **Active-uniqueness:** Postgres partial unique index
  (`WHERE state = 'active'`) — one active assignment per
  client.
- **Writes during clone:** `WorkoutRoutine`,
  `RoutineExercise`, `MealPlan`, `Lesson`, `CoachGuideline`,
  `ContentBoardSubscription` (#33).
- **Routes:** `/api/coach/clients/:client_id/regimen-assignments`,
  `/api/coach/regimen-assignments/:id/pause|resume|end|migrate`,
  `/api/me/regimen-assignment`,
  `/api/me/regimen-assignment/this-week`. See spec §4.

## WHO

- **Owner / decision-maker:** founder for pause-resume policy
  and re-assignment behavior; backend lead for
  clone-transaction contract and cursor algorithm; product
  for the per-client regimen UI.
- **On the hook for runtime work:** backend platform.
- **Audience:** coaches (assign + manage), clients (read
  their own week), spec #36 (consume the cursor for
  progress), the AI Program Builder PR #117 §22 (Outcome
  Graph hooks).

## WHAT

**Already exists:**

- Spec at [`../../specs/regimen-assignment.md`](../../specs/regimen-assignment.md).
- The merged `ClientCoachConsent` row.
- `WorkoutRoutine.client_id` and `MealPlan.client_id` FKs.
- The clone-transaction shape from PR #121 spec #28.

**Still to be produced:**

- Migration adding the two tables and the partial unique
  index.
- The cursor service (pure function; testable; no DB).
- The state machine: `active` ↔ `paused`,
  `→ ended | migrated_out | archived`.
- The transactional clone-on-assign path.
- The auto-subscribe wire-up to spec #33.

## HOW

PR-1 lands the migration plus the read endpoints plus the
*non-cloning* assign path (writes the row but defers the
client-visible clone to a follow-up). Six-phase rollout per
spec §7. Acceptance in spec §15.

`REGIMEN_ASSIGNMENT_ENABLED=off` until Phase 3; flips on
for L2 + L3.
