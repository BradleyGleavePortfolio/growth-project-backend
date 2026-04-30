# Handoff brief — Program templates (B6)

**Roadmap row:** #28.
**Status:** In discovery — spec drafted; runtime work not started.
**Spec:** [`../../specs/program-templates.md`](../../specs/program-templates.md).
**Cross-references:** PR #117 (AI Program Builder — these
templates are training-data and the UX pattern), PR #119 (parent
roadmap), brief
[`26-intake-questionnaire.md`](./26-intake-questionnaire.md)
(intake feeds first-week plan generation, which uses templates).

## WHY

Today every coach assembles `WorkoutRoutine`, `MealPlan`, and
`Lesson` content from scratch per client; there is no template
notion in the schema. The strategy memo's B6 calls for "6 hand-
built starter programs across 2 niches, 1-click clone-to-
workspace, edit-in-place" and explicitly notes that B6 is
*training data and a UX pattern* for the AI Program Builder.

This item adds the program-template family: a coach-private (or
platform-curated) library of reusable programs that clone in a
single transaction into a client's workspace as live rows.

## WHEN

- AI Program Builder RFC (PR #117) §3 is reviewed against this
  spec to confirm the template family and the Builder's
  `ProgramDraft` family are additive and non-overlapping.
- The first six hand-built programs have copy approved by the
  founder.
- Clone-transaction shape is reviewed by the backend lead.

## WHERE

- New module: `src/program-templates/`.
- New tables: `ProgramTemplate`, `ProgramTemplateSection`,
  `ProgramTemplateClone`.
- New routes under `/api/coach/program-templates/*` and
  `POST /api/admin/program-templates` (OWNER curation).
- Reads / writes: `WorkoutRoutine`, `RoutineExercise`, `MealPlan`,
  `Lesson`, `CoachGuideline` during clone.

## WHO

- **Sign-off:** founder for the six starter programs and curation
  policy; backend lead for the clone transaction.
- **On the hook:** backend platform.
- **Downstream:** AI Program Builder (PR #117), intake-driven
  first-week plan (#26).

## WHAT

- **Already exists:** all materialization-target tables
  (`WorkoutRoutine`, `MealPlan`, `Lesson`, `CoachGuideline`).
- **Net-new:** three tables, one module, one feature flag
  (`PROGRAM_TEMPLATES_ENABLED`) and a sub-flag for the platform-
  curated set, six seeded starter programs loaded by a guarded
  OWNER backfill script.
- **Non-goals:** no marketplace; no parameterized templates (the
  "smart" template is PR #117); no cross-niche transformation.

## HOW

PR-1 migration + module shell + seed loader. PR-2 read routes +
clone endpoint (single-transaction insert). PR-3 OWNER curation
surface. PR-4 design-partner allow-list. PR-5 platform-wide.

## Risks (top three)

1. **Cross-niche payload mismatches** — validators allow with a
   warning surfaced in the console.
2. **Drift from `WorkoutRoutine`/`MealPlan` schema** — per-kind
   validators import live insert DTOs and assert compatibility
   at boot.
3. **Curated content rot** — OWNER has an "archive + supersede"
   path; `superseded_by` may be added later.

## Cross-references

- Spec: [`../../specs/program-templates.md`](../../specs/program-templates.md).
- Upstream: PR #117 (shared validators).
- Upstream input: brief #26.
