# 11 — Release QA & regression gates

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

The codebase has three release gates today:

1. **CI on every PR**: lint, typecheck, build, test, env
   validation simulated on a prod env (`.github/workflows/ci.yml`).
2. **Smoke on every deploy** (`scripts/smoke.ts`,
   `npm run smoke:staging` / `npm run smoke:prod`). A boot-and-shape
   signal — does the app boot, are guards mounted, does the
   public invite landing render. **Smoke green is not** the
   same as **end-to-end SaaS green** (this distinction is
   already documented in `docs/README.md` under
   "What 'backend live' means").
3. **Manual e2e sweep** in `docs/e2e-qa-runbook.md` — run
   *after* smoke green. Lists the credentialled prereqs the
   smoke script intentionally does not exercise.

The next wave will stress this:

- **Team Mode** changes the tenant-resolution path on every
  authenticated request. A regression that returns the wrong
  team is invisible to smoke and to most unit tests.
- **AI Program Builder** is asynchronous — a job that fails
  silently in the queue does not surface in smoke.
- **Check-ins v2** is a non-additive shape change; the
  Phase-A → Phase-C window is a regression risk per release.
- **Public profiles** are unauthenticated; XSS / injection is
  a new regression class.
- **Templates marketplace** adds a moderation surface; a
  regression in moderation is a P0.
- **Revenue dashboards** drift quietly when a Stripe-mirror
  schema changes; correctness drift can go a month before
  anyone notices.

Without a documented **regression suite ownership** and a
**pre-deploy checklist** that reflects today's posture (no
canary deploys; one Fly app per environment), every wave of
features increases the probability of a bad deploy.

**Cross-feature impact:** every feature has a regression
posture; this brief makes that posture explicit per feature.

## WHEN

Settle this brief **before** the first non-trivial Team Mode
runtime PR ships. That's the first time we'll have a wide
tenant-resolution change; we want the regression gates already
in place.

## WHERE

- `.github/workflows/ci.yml` — CI pipeline.
- `scripts/smoke.ts` — boot-and-shape smoke.
- `docs/e2e-qa-runbook.md` — manual e2e.
- `docs/staging-execution-tracker.md` — staging cut-over.
- `docs/deploy-runbook.md` — deploy runbook.
- `test/` — unit + integration tests.

## WHO

- **Owner:** backend lead.
- **Reviewers:** OWNER (operator) for the pre-deploy
  checklist.
- **On the hook in production:** OWNER monitors Sentry +
  metrics for the first 15 min after every deploy.

## WHAT

### What already exists

- CI on every PR (lint, typecheck, build, test, env
  validation).
- Boot-and-shape smoke for staging and prod.
- Manual e2e runbook.
- Staging execution tracker.
- Sentry sourcemaps uploaded on every deploy (PR #95).
- Throttler with shared Redis state (PR #93).
- One-time backfill precedent
  (`backfill:coach-subscriptions`, PR #96).
- README-with-every-PR rule (root README §10).

### What is missing

1. **A regression suite per feature.** Each feature owns a
   per-feature integration test file. No feature ships without
   one. Today this is convention; this brief makes it a rule.
2. **A pre-deploy checklist.** Short, executable. The OWNER
   walks it before clicking deploy on prod. Lives in
   `docs/deploy-runbook.md`.
3. **A post-deploy watch window.** The OWNER stays on Sentry +
   metrics for the first 15 min after deploy. Documented as a
   formal expectation (today it's implicit). Lane #06 already
   covers the incident path; this brief covers the watch.
4. **Canary posture.** Today there is no canary — Fly does a
   rolling deploy across machines, but every machine runs the
   new image. Document that explicitly. The closest thing to a
   canary today is **staging green + 15-min watch on prod**.
5. **A regression tag in CI.** Tests carry a `@regression`
   marker (or live in `test/regression/`). The full suite runs
   on every PR (already true). The regression sub-suite has a
   per-PR run-time budget (~60s); if a regression test exceeds
   it, that's a flag.
6. **Schema-mirror correctness check.** The OWNER reports
   surface ships with a daily check that compares the Stripe
   mirror against Stripe's own state for a sample of 10
   coaches. Drift is alerted. Today this is manual; this
   brief reserves the shape (runtime PR is future).
7. **Mobile-shape regression.** Per lane #02, the Phase-C
   removal needs <1% mobile traffic on the old shape. That
   measurement is itself a regression gate.

### Pre-deploy checklist (proposed)

OWNER runs this before clicking deploy on prod:

1. Staging deploy is green for ≥30 min.
2. `npm run smoke:staging` is green.
3. CI is green on the merge commit.
4. The PR description's `## Test plan` is checked.
5. If the PR ships a migration: lock-time estimate is in the
   description; OWNER reviewed.
6. If the PR ships an API shape change: lane #02 phase is
   correct; OpenAPI diff job is green.
7. If the PR ships a flag flip: kill switch verified in
   staging; OWNER ready to flip back.
8. Sentry dashboard is open in another tab.
9. OWNER metrics endpoint is open in another tab.

### Post-deploy watch (proposed)

For 15 min after deploy:

- OWNER watches Sentry for new error classes.
- OWNER watches the rate-of-500s on key endpoints.
- OWNER watches `/api/admin/metrics` for unexpected jumps in
  `past_due` count, `signup_failure` count, `webhook_failure`
  count.
- If anything is off, OWNER flips the relevant kill switch
  (lane #01) before debugging.

### Regression suite ownership (proposed)

Each major surface has a named integration test file:

- `test/regression/auth.spec.ts`
- `test/regression/billing.spec.ts`
- `test/regression/messaging.spec.ts`
- `test/regression/admin.spec.ts`
- `test/regression/federation.spec.ts`
- (future) `test/regression/team-mode.spec.ts`
- (future) `test/regression/builder.spec.ts`
- (future) `test/regression/check-ins.spec.ts`
- (future) `test/regression/public-profiles.spec.ts`
- (future) `test/regression/templates.spec.ts`
- (future) `test/regression/revenue.spec.ts`

Each file is owned by the engineer who shipped the surface
(named in a comment at the top). Adding a new endpoint to a
surface adds a test to its regression file.

The regression sub-suite runs in <60s on CI today; new tests
must respect that budget (use fakes for HTTP, mock provider
calls, no real network).

## HOW

### Operator handoff

- `docs/deploy-runbook.md` is extended with the pre-deploy
  checklist and the post-deploy watch.
- The README-with-every-PR rule (root README §10) gets a
  one-liner pointing at this brief.
- Regression suite is opt-in for tests today (move them to
  `test/regression/` over time; new feature tests start
  there).

### Canary non-policy

We document, in `docs/deploy-runbook.md`:

> The platform does not run a canary deploy. Fly's rolling
> deploy is the closest analogue. The substitute for a canary
> is: staging deploy ≥30 min green + post-deploy 15-min watch
> on prod.

If a future feature needs a real canary (e.g., AI Program
Builder, where async jobs are hard to validate without
production traffic), this lane is updated first.

### Schema-mirror correctness check (future runtime)

Daily cron via `@nestjs/schedule`:

1. Sample 10 active coaches.
2. For each, fetch the Stripe subscription state directly.
3. Compare to the local `CoachSubscription` mirror.
4. Difference → audit + Sentry warning + OWNER metric
   counter.

This is reserved for a future runtime PR. The brief documents
the shape so that PR is mechanical.

## Risks

- **OWNER skips the pre-deploy checklist.** Mitigation:
  short, opinionated checklist; OWNER is the operator and the
  one who lives with the consequences.
- **Regression budget overrun.** Mitigation: 60s budget;
  per-file timing in CI flags slow tests.
- **No canary means a bad deploy hits 100%.** Mitigation:
  staging green + 15-min watch + flag-based kill switch
  (lane #01) is the current posture. Document explicitly so
  the operator knows what they're trading.
- **Mobile-shape regression caught too late.** Mitigation:
  lane #10 mobile-build telemetry feeds the lane #02
  Phase-C decision.
- **Stripe-mirror drift.** Mitigation: future daily check;
  one-time backfill script as the recovery path.

## Dependencies

- Lane #01 (resolver / kill switches) — every regression
  gate has a kill switch fallback.
- Lane #02 (API versioning) — the OpenAPI diff job is part of
  the pre-deploy checklist.
- Lane #06 (observability) — Sentry + OWNER metrics are the
  watch surface.
- Lane #07 (migration safety) — migrations carry a lock-time
  estimate, surfaced in the pre-deploy checklist.
- Lane #10 (analytics) — mobile-build telemetry, Stripe-mirror
  drift counter.

## Acceptance criteria

1. ✅ `docs/deploy-runbook.md` is extended with the
   pre-deploy checklist and the post-deploy watch window.
2. ✅ The canary non-policy is documented in
   `docs/deploy-runbook.md`.
3. ✅ The regression suite ownership rule is documented; new
   feature surfaces add a `test/regression/<surface>.spec.ts`
   file.
4. ✅ The schema-mirror correctness check shape is documented
   as a reserved future runtime change.
5. ✅ The README-with-every-PR rule cross-references this
   lane (one line).

## Test strategy

- **Unit:** none — this lane is procedural.
- **Integration:** existing CI is the test surface. New
  regression files run in CI; per-file timing budget enforced
  by Jest.
- **Manual:** OWNER walks the pre-deploy checklist on every
  prod deploy.

## Rollout & kill-switch

- Lane is procedural — no rollout.
- Pre-deploy checklist + post-deploy watch ship as a doc
  update; the only "kill switch" is the OWNER deciding not to
  follow them, which would be a process failure not a code
  failure.
- Future runtime work (schema-mirror correctness check) ships
  with its own flag (`MIRROR_DRIFT_CHECK_ENABLED`).
