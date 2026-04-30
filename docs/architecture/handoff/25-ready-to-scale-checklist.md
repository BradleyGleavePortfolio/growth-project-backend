# Handoff brief — Ready-to-scale checklist (B1)

**Roadmap row:** #25.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/ready-to-scale-checklist.md`](../../specs/ready-to-scale-checklist.md).
**Cross-references:** PR #119 (parent roadmap), brief
[`24-coach-ai-voice.md`](./24-coach-ai-voice.md) (step 12), brief
[`27-public-coach-profile.md`](./27-public-coach-profile.md)
(first feature gated by the checklist).

## WHY

The strategy memo's B1 calls for a 12-step "ready to scale"
checklist that gates optional features (e.g. the public coach
profile #27). Today the existing `CoachProfile` carries pieces
that imply readiness, but there is no canonical readiness object
the console and gated features can read. This item adds that
object — and the gating helper (`isReadyFor("public_profile")`)
that downstream features call.

## WHEN

- The 12 steps are signed off by the founder.
- Each step's source of truth is identified (most are computed,
  not stored).
- The `isReadyFor(coachId, feature)` helper interface is agreed
  before downstream features wire their gates.

## WHERE

- New module: `src/coach-readiness/`.
- New table: `CoachReadinessStepOverride` (only carries
  dismissals — defaults are computed).
- New routes: `GET /api/coach/readiness`,
  `POST /api/coach/readiness/:stepId/dismiss`,
  `POST /api/coach/readiness/:stepId/undismiss`.
- Reads: `CoachProfile`, `CoachSubscription`,
  `CoachAIVoiceSetting` (#24), `OutcomeCheckInTemplate` (#21),
  `MealPlan` / `WorkoutRoutine` / `CoachMessage` count.

## WHO

- **Sign-off:** founder for the 12-step list and gating
  decisions; backend lead for the table.
- **On the hook:** backend platform.
- **Downstream:** coach console; gated features (#27 first).

## WHAT

- **Already exists:** all input tables; help center / setup
  checklist (`docs/help/`).
- **Net-new:** one (sparse) table, one module with 12 step
  classes, one feature flag
  (`READY_TO_SCALE_CHECKLIST_ENABLED`), one PostHog event family.
- **Non-goals:** not a separate onboarding UX; no email
  reminders; not configurable per-coach.

## HOW

PR-1 migration + 12 step classes + unit tests. PR-2 wires routes
+ dismiss flow. PR-3 wires the first gate (#27). PR-4 turns flag
on.

## Risks (top three)

1. **Step drift** — adding a step without updating gates. CI
   test asserts the step constants array length and uniqueness.
2. **Stale cache** — bio edit doesn't immediately flip the step
   for 30s. Profile-service hook invalidates the in-memory cache.
3. **Misleading completion** — 12/12 doesn't mean a real
   business. OWNER metrics doc carries the necessary-not-
   sufficient note.

## Cross-references

- Spec: [`../../specs/ready-to-scale-checklist.md`](../../specs/ready-to-scale-checklist.md).
- Step inputs: briefs #21, #24.
- First gated feature: brief #27.
