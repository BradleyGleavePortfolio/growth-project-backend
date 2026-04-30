# Handoff brief — At-risk client detector (B4)

**Roadmap row:** #22.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/at-risk-detector.md`](../../specs/at-risk-detector.md).
**Cross-references:** PR #119 (parent roadmap), brief
[`21-outcome-check-ins.md`](./21-outcome-check-ins.md) (upstream
data), brief [`23-weekly-recap.md`](./23-weekly-recap.md)
(downstream).

## WHY

A coach loses clients silently when there is no proactive
detection. The strategy memo names "at-risk clients" as a primary
metric of the mini admin board. This item ships a **rules-based**
detector (no LLM) that surfaces flagged clients in the coach
console — explicitly three rules in v1, threshold-tuned with the
design-partner cohort.

## WHEN

- Outcome check-ins (#21) are in flight (rule #2 reads them).
- Three default thresholds are signed off.
- PostHog event taxonomy extended with at-risk transitions.

## WHERE

- New module: `src/at-risk/`.
- New table: `AtRiskFlag`.
- New routes: `/api/coach/clients/at-risk`,
  `/api/coach/clients/:id/at-risk`,
  `/api/coach/clients/:id/at-risk/dismiss`.
- Reads: `CheckIn`, `OutcomeCheckIn` (#21), `CoachMessage`,
  `MealPlan`, `WorkoutRoutine`.

## WHO

- **Sign-off:** founder for thresholds; backend lead for the
  table.
- **On the hook:** backend platform.
- **Downstream:** coach console widget, weekly recap (#23),
  OWNER metrics.

## WHAT

- **Already exists:** all input tables; PostHog taxonomy.
- **Net-new:** one table, one module, one cron job, one feature
  flag (`AT_RISK_DETECTOR_ENABLED`), three rule classes
  implementing a shared `AtRiskClassifier` interface.
- **Non-goals:** no LLM; no client-facing surface; no auto-
  dismiss other than the rule no longer firing.

## HOW

PR-1 migration + module shell + pure-function rule unit tests.
PR-2 wires module + cron + Redis lock. PR-3 ships routes + dismiss.
PR-4 OWNER metrics. PR-5 design-partner allow-list.

## Risks (top three)

1. **Threshold panic** in the first month — defaults will be
   wrong; tuning is a one-line constants edit.
2. **Cron overlap** on multi-instance Fly — Redis SETNX lock,
   Sentry breadcrumb on lock failure.
3. **False-positive trust erosion** — v1 widget is collapsible
   and we do **not** page or email on a flag.

## Cross-references

- Spec: [`../../specs/at-risk-detector.md`](../../specs/at-risk-detector.md)
- Upstream: brief #21 (data), PR #117 (forward-compat LLM hook).
- Downstream: brief #23 (recap mentions open flags), brief #29
  (revenue dashboard surfaces at-risk count).
