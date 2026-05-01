# Handoff brief 34 — Coach-created regimens / programs

> Operator-facing pre-work brief for expansion-roadmap item **#34**.
> Companion to the engineer-facing spec at
> [`../../specs/regimens.md`](../../specs/regimens.md).
> Read this brief first, then the spec.

**Status:** In discovery — spec drafted, no runtime code merged.
**Last updated:** 2026-05-01.
**Roadmap row:** [`expansion-wave-coach-experience.md` row 34](../expansion-wave-coach-experience.md).

---

## WHY

A real coaching engagement is multi-week. PR #121 spec #28
introduces the *single template* primitive; this spec
introduces the *multi-week orchestration* (a regimen is a
sequence of templates with progression, deload, and reading
material). Without it, a coach must clone twelve templates by
hand for a 12-week program. See spec §2.

## WHEN

Gated on:

1. Spec #28 review (PR #121) — the `ProgramTemplate` schema
   must be final.
2. PR #117 RFC §12 review — the transactional publish path
   is reused at *assignment* (#35); this spec defines what
   gets cloned.
3. Founder sign-off on per-tier regimen ceiling (#37).
4. Backend lead sign-off on the regimen-version policy
   (new-row default).

## WHERE

- **New module:** `src/regimens/` (spec §4).
- **New tables:** `Regimen`, `RegimenVersion`, `RegimenWeek`,
  `RegimenBlock`.
- **Reads:** `ProgramTemplate` (#28), `WorkoutRoutine`,
  `MealPlan`, `Lesson`, `CoachGuideline`, `ContentBoard`
  (#33).
- **No writes** to client-visible tables — this module
  defines the *recipe*; the *bake* is spec #35
  (assignment).
- **Routes:** `/api/coach/regimens/...`,
  `/api/coach/regimens/:id/versions/:v/publish`,
  `/api/coach/regimens/:id/versions/:v/preview`,
  `/api/admin/regimens/...`. See spec §4.

## WHO

- **Owner / decision-maker:** founder for version policy and
  per-tier ceiling; backend lead for validator contract and
  template→workout/meal/lesson lineage; product for the
  regimen-builder UX.
- **On the hook for runtime work:** backend platform.
- **Audience:** coaches (build regimens), spec #35 (consume
  for assignment), spec #36 (consume for progress projection),
  OWNER (curate platform regimens).

## WHAT

**Already exists:**

- Spec at [`../../specs/regimens.md`](../../specs/regimens.md).
- `ProgramTemplate` (PR #121 spec #28).
- The clone-into-`WorkoutRoutine`/`MealPlan`/`Lesson`
  transactional path (PR #117 §12 + spec #28 §"Clone").

**Still to be produced:**

- Migration adding the four tables.
- The regimen-version policy implementation (new-row on
  PATCH, immutable on publish).
- The preview service (resolves a version to its publish
  shape *without* writing).
- The duplicate service.
- OWNER curated-regimen surface.

## HOW

PR-1 lands the migration plus `GET /coach/regimens` read-only
against an empty table. Six-phase rollout per spec §7.
Acceptance criteria in spec §15.

`REGIMENS_ENABLED=off` until Phase 4; flips to `on` for L2 +
L3 only.
