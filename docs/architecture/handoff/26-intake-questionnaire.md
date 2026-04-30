# Handoff brief — Intake questionnaire templates + invite/onboarding wiring (B3)

**Roadmap row:** #26.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/intake-questionnaire.md`](../../specs/intake-questionnaire.md).
**Cross-references:** PR #119 (parent roadmap), brief
[`21-outcome-check-ins.md`](./21-outcome-check-ins.md) (shared
field-types vocabulary), brief
[`28-program-templates.md`](./28-program-templates.md) (consumer
of intake answers for first-week plan generation), the existing
invite-landing surface (`docs/invite-landing.md`).

## WHY

A client redeeming an invite goes from `InviteCode.redeemed_at`
to a generic mobile onboarding flow with no per-coach
customization. The platform never sees the intake answers
coaches collect manually today (Google Forms, Typeform). Without
those answers, AI Program Builder (PR #117) cannot draft a
first-week plan from the client's stated goals and the at-risk
detector (#22) cannot tune per-client thresholds.

This item makes the intake **part of the platform** — coach-owned
template, client fills in immediately after redeem, answers
visible to downstream features.

## WHEN

- Outcome check-ins (#21) are in flight (shared field-type
  vocabulary).
- Coach console design has space for an "Intake" tab.
- A backfill posture is decided for clients who redeemed before
  the feature shipped (default: no auto-backfill).

## WHERE

- New module: `src/intake/`.
- New tables: `IntakeTemplate`, `IntakeResponse`.
- New routes: `/api/coach/intake-templates/*`,
  `/api/coach/clients/:id/intake`,
  `/api/me/intake/active`,
  `/api/me/intake`.
- Hooks: `src/invite-codes/invite-codes.service.ts` on redeem;
  signup-with-code path; `docs/emails/onboarding/01-welcome.md`.

## WHO

- **Sign-off:** founder for default starter templates; backend
  lead for tables; design partners for field iteration.
- **On the hook:** backend platform.
- **Downstream:** AI Program Builder (PR #117), at-risk detector
  (#22), coach console.

## WHAT

- **Already exists:** `InviteCode`, `User.coach_id`, signup-with-
  code path, onboarding email sequence.
- **Net-new:** two tables, one module, one feature flag
  (`INTAKE_ENABLED`), shared field-type vocabulary with #21,
  seeded starter templates loaded by guarded backfill (not
  migration data).
- **Non-goals:** no full form builder; no conditional logic; no
  file uploads in v1; no offline persistence.

## HOW

PR-1 migration + module shell + seeded starters. PR-2 templates
routes. PR-3 client submission routes. PR-4 invite-redeem hook.
PR-5 onboarding email block. PR-6 turn flag on.

## Risks (top three)

1. **Field-vocabulary drift between #21 and #26** — both modules
   import from `src/common/structured-fields/`; CI asserts a
   single source of truth.
2. **Sensitive medical data** — coaches in fitness niches will
   collect injury history; help center calls out what coaches
   should not collect; no special "medical" field types in v1.
3. **Email-block timeout** — read has a 1s timeout; default copy
   used on timeout.

## Cross-references

- Spec: [`../../specs/intake-questionnaire.md`](../../specs/intake-questionnaire.md).
- Shared vocabulary: brief #21.
- Downstream: brief #28, PR #117.
