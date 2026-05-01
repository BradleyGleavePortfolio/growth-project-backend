# Handoff brief 30 — Coach-created challenges

> Operator-facing pre-work brief for expansion-roadmap item **#30**.
> Companion to the engineer-facing spec at
> [`../../specs/coach-challenges.md`](../../specs/coach-challenges.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 30](../expansion-wave-coach-experience.md).

---

## WHY

A coach has no first-class way to run a metric-driven, time-
bounded competition or commitment within their roster.
Challenges fix this with a **vertical-agnostic** primitive: a
fitness coach instantiates the same shape with a `steps`
metric that a finance coach instantiates with a `finance_savings`
metric. They share state machine, submission API, and
leaderboard projection. See spec §2 for the full pain framing
and §6 for the cross-vertical strategic value.

## WHEN

Not yet. The work is gated on:

1. **Spec review.** Spec §3 enumerates four trigger
   conditions (field-types vocab from #21, validator pattern
   from PR #117 §3, leaderboard spec #31, tier spec #37).
2. **A `CHALLENGES_ENABLED` feature flag** gating every
   route. The flag must default to **off** until §7 Phase 6
   completes.
3. **Tier-gating decisions.** Spec #37 owns the per-tier
   challenge quota and the public-visibility tier minimum.
   Both must be set before Phase 3 of this spec ships.
4. **Public-surface readiness.** Spec #31 (leaderboards) is a
   precondition for `visibility=public` challenges.

The work starts at **Phase 1** of the rollout plan in §7 of
the spec, after the gating decisions close.

## WHERE

The spec proposes one new module and additive schema:

- **New module:** `src/challenges/` (per §4 of the spec).
  Module-isolated; nothing in `src/coach/`, `src/messaging/`,
  or the workout/meal modules imports from it.
- **New tables (additive only):** `CoachChallenge`,
  `CoachChallengeMetric`, `CoachChallengeParticipation`,
  `CoachChallengeSubmission`, `CoachChallengeAuditEvent`.
- **Existing tables read on submit:** `WorkoutSession`,
  `HabitLog`, `WeightLog`, `User`, `ClientCoachConsent`. The
  module **only reads** these.
- **Routes (proposed):** under `/api/coach/challenges/*`,
  `/api/me/challenges/*`, `/api/challenges/:id/submissions`,
  and `/api/admin/challenges/*` for moderation. See §4 of
  the spec for the full list.
- **Observability:** PostHog events under the existing
  taxonomy in `src/analytics/events.ts`; OWNER metrics counter
  shape from [`../../metrics.md`](../../metrics.md); Sentry
  posture per [`../../audit-and-gdpr.md`](../../audit-and-gdpr.md).

## WHO

- **Owner / decision-maker:** founder for the metric-kind
  catalog and the finance adapter shape; backend lead for the
  state machine and the submission idempotency contract;
  product for invitation UX.
- **On the hook for runtime work:** backend platform.
- **Stakeholders that must sign off before Phase 1:**
  - Founder — metric catalog, finance adapter, public-tier
    minimum.
  - Backend lead — schema, state machine, idempotency.
  - Product — invitation flow.
- **Audience for the *output*:** coaches (creating challenges),
  participants (joining + submitting), OWNER admin
  (moderation).

## WHAT

**Already exists today:**

- The spec at [`../../specs/coach-challenges.md`](../../specs/coach-challenges.md)
  — long-form, structured around the 16 standard sections,
  covering problem framing, schema, API surface, rollout,
  tests, risks, dependencies, acceptance criteria, operator
  handoff.
- Draft PR opening this wave (this PR) carries the spec.
- Reuse plumbing: PR #93 (Redis throttler), PR #94 (OpenAPI
  spec), PR #95 (Sentry sourcemaps), the audit module,
  `SubscriptionGuard`, `RolesGuard`.

**Still to be produced:**

- Closure on every gating decision in spec §3.
- Migration adding the five new tables.
- The `metric-adapters/` family (one file per kind).
- The OWNER moderation surface (freeze, takedown).
- Leaderboard wire-up (delegated to spec #31).
- Tier wire-up (delegated to spec #37).

## HOW

The smallest first PR (PR-1) lands the migration plus a
read-only `GET /coach/challenges` endpoint plus a stubbed
`metric-adapters/` directory with one adapter (`steps`)
implemented and the rest stubbed. PR-1 is no-op behind
`CHALLENGES_ENABLED=off` — every route returns 404 until the
flag is set to `coach_only` or `on`.

Subsequent PRs follow the seven-phase plan in spec §7. The
flag flip from `off` to `on` happens only after the OWNER
moderation surface (Phase 5) and the leaderboard wire-up
(Phase 6) are live, and only for L2 / L3 tiers (Phase 7).

The acceptance criteria for "the spec has shipped" are
itemized in spec §15. When all seven items pass on staging
and the runbook entry in §16 is added to
[`../../deploy-runbook.md`](../../deploy-runbook.md), the
roadmap row's stage flips to **in flight**, and this brief
is updated to point at the live module README at
`src/challenges/README.md`.
