# Expansion wave — coach experience (rows #30–#37)

> ## Reconciliation Note (2026-05-10)
>
> The original spec body of this PR called every row "in discovery —
> spec drafted; runtime work not started." That is no longer true.
> Two rows have shipped runtime since this PR was opened, two more
> have shipped a partial slice via Sprint A and Sprint B, and the
> remaining four are still pre-runtime. The index table below has
> been re-stamped to reflect actual state on `main` as of
> 2026-05-10. Per-row spec files have been annotated with a
> "Status update (2026-05-10)" block where shipped runtime
> intersects the spec.
>
> Summary of intersections:
>
> - **Row #31 leaderboards** — `src/leaderboard/` (PR #161, merged
>   2026-05-08, migration `20260506060000_add_leaderboard`) ships a
>   roster-scoped peer leaderboard with a combined-score metric.
>   The spec's challenge-scoped snapshot variant with moderation
>   and public widget is NOT shipped — different surface, same row
>   number. Spec stays open for the challenge variant.
> - **Row #35 regimen assignment** — Sprint B (PR #188) ships
>   `ClientWorkoutAssignment` and `DailyMealPlanAssignment`
>   (single-day granularity) via migrations
>   `20260508000000_add_workout_builder` and
>   `20260509000000_add_sprint_b_macros_meals_insights`. The
>   spec's multi-week regimen assignment (workouts + meals +
>   lessons + challenges in one durable assignment row) is NOT
>   shipped.
> - **Row #36 messaging + progress** — voice notes shipped via
>   migration `20260506040000_add_voice_notes_and_coach_onboarding`
>   on top of the pre-existing `src/messaging/` text surface. The
>   spec's three primitives (progress envelope endpoint,
>   `subject_kind`/`subject_id` deep-link convention,
>   `ProgressVisibilityPreference` table) are NOT shipped.
> - **Rows #30, #32, #33, #34, #37** — no runtime intersection.
>   Specs unchanged.
>
> Adjacent shipped work, not row-mapped but worth noting for spec
> authors who reference "what already exists":
>
> - **Notification Center** (`src/notifications/`, migration
>   `20260507000000_add_notification_center`) — digest scheduler
>   plus per-event emitters. Row #36's progress-envelope work
>   should reuse this emitter pattern rather than build a parallel
>   one.
> - **Coach Onboarding Wizard** (`CoachOnboardingProgress` table,
>   shipped alongside voice notes in
>   `20260506040000_add_voice_notes_and_coach_onboarding`).
> - **First Win** (`src/first-win/`, migration
>   `20260506050000_add_first_win`) — adjacent to row #30
>   challenges in framing, distinct in surface.

**Status:** Living index extension — appends rows #30–#37 to the
expansion roadmap introduced by PR #119
([`expansion-roadmap.md`](./expansion-roadmap.md)) and extended by
PR #121
([`expansion-roadmap-addendum.md`](./expansion-roadmap-addendum.md)).
This file exists as a separate "wave" addendum so the three PRs
(#119, #121, and this one) remain trivially mergeable in any
order.

**Last updated:** 2026-05-10 (reconciliation pass; runtime state
re-stamped against `main`). Original spec authored 2026-05-01.
**Owner:** Backend platform.
**Audience:** Future operators and engineers who need to understand
the next wave of coach-experience expansion items, in what order,
and why an in-progress draft PR exists today.

This document, like its parents, is **not** a commitment to ship
every item. It is a commitment to make the order, the
dependencies, and the parking-lot status of each item legible — so
a draft PR opened today against item #30 is not orphaned context
six months from now.

## Why a separate "wave" file

PR #119 introduces the roadmap-and-handoff layer; PR #121 appends
rows #21–#29; this PR appends rows #30–#37 (a coach-experience
wave focused on community, content distribution, programs,
messaging-derived progress, and tiering/entitlements). To keep
all three PRs trivially mergeable in either order, the new rows
are listed in this file and the new handoff briefs under
[`./handoff/`](./handoff/) point back to a stable file (this one)
that exists on `main` once this PR merges. When PRs #119 and
#121 merge (or before, if their merge conflicts with this PR are
resolved), the rows below are folded into the main roadmap's
index table, the addendum is retired, and this wave file becomes
a banner pointer.

The numbering is **append-only** and matches the rule in PR
#119's roadmap doc: rows #01–#20 are reserved by PR #119; rows
#21–#29 are reserved by PR #121; rows #30–#37 are reserved here.
Future expansion items continue from #38.

## Index — rows #30 through #37

| # | Item | Stage (as of 2026-05-10) | Brief | Underlying spec |
|---|------|--------------------------|-------|-----------------|
| 30 | Coach-created challenges (fitness + finance) | In discovery — spec drafted; runtime work not started | [`./handoff/30-coach-challenges.md`](./handoff/30-coach-challenges.md) | [`../specs/coach-challenges.md`](../specs/coach-challenges.md) |
| 31 | Public/private leaderboards | **Adjacent runtime shipped (different scope)** — `src/leaderboard/` (PR #161) ships a roster-scoped peer leaderboard. Spec's challenge-scoped variant with moderation/public widget remains pre-runtime. | [`./handoff/31-leaderboards.md`](./handoff/31-leaderboards.md) | [`../specs/leaderboards.md`](../specs/leaderboards.md) |
| 32 | Profile pictures / avatar media | In discovery — spec drafted; runtime work not started (one nullable `User.avatar_url` field exists with no upload pipeline) | [`./handoff/32-avatar-media.md`](./handoff/32-avatar-media.md) | [`../specs/avatar-media.md`](../specs/avatar-media.md) |
| 33 | Coach content boards (PDFs / newsletters / videos / links) | In discovery — spec drafted; runtime work not started | [`./handoff/33-content-boards.md`](./handoff/33-content-boards.md) | [`../specs/content-boards.md`](../specs/content-boards.md) |
| 34 | Coach-created regimens / programs (multi-week orchestration) | In discovery — spec drafted; runtime work not started. Sprint B's single-day `WorkoutPlan` is the closest existing artefact and is NOT a multi-week regimen. | [`./handoff/34-regimens.md`](./handoff/34-regimens.md) | [`../specs/regimens.md`](../specs/regimens.md) |
| 35 | Per-client regimen assignment | **Partial runtime shipped (workout + meal slice)** — Sprint B (PR #188) ships `ClientWorkoutAssignment` and `DailyMealPlanAssignment` at single-day granularity. Spec's multi-week regimen assignment (incl. lessons, challenges) remains pre-runtime. | [`./handoff/35-regimen-assignment.md`](./handoff/35-regimen-assignment.md) | [`../specs/regimen-assignment.md`](../specs/regimen-assignment.md) |
| 36 | Coach ↔ client messaging + progress visibility | **Adjacent runtime shipped (voice notes only)** — voice attachment columns added to `CoachMessage` via migration `20260506040000`. Spec's three primitives (progress envelope, deep-link convention, `ProgressVisibilityPreference`) remain pre-runtime. | [`./handoff/36-messaging-progress.md`](./handoff/36-messaging-progress.md) | [`../specs/messaging-progress.md`](../specs/messaging-progress.md) |
| 37 | L2 / L3 tiering, entitlements, and white-glove | In discovery — spec drafted; runtime work not started | [`./handoff/37-tiering-l2-l3.md`](./handoff/37-tiering-l2-l3.md) | [`../specs/tiering-l2-l3.md`](../specs/tiering-l2-l3.md) |

## Dependencies between these rows

These eight rows are not independent. The dependency graph below
is the order a runtime rollout that aimed at all eight would
naturally follow.

```
#32 avatar media ─────────────┐
                              ├──> #31 leaderboards (display avatars on entries)
#34 regimens ────────────────┐│
                             │└──> #36 messaging+progress (progress signals
                             │      include adherence to assigned regimen)
#34 regimens ─> #35 assignment ─> #36 messaging+progress
#33 content boards ──────────────> #36 messaging+progress
                                   (messaging deep-links to a content item)
#30 challenges ─> #31 leaderboards (challenge has its own leaderboard)
#37 tiering ─────> gates everything; #30/#31/#33/#34 quotas are
                   read from the entitlement read model
```

External dependencies on the existing draft PRs:

- **PR #117 (AI Program Builder RFC):** `#34 regimens` shares the
  publish-target shape. The runtime PRs for `#34` reuse the
  per-kind validators and the transactional publish path the
  Program Builder is the source of truth for. `#33 content
  boards` reuses Supabase Storage prefix conventions and the mime
  allow-list shape from the Builder's `CoachAsset` family. The
  full mapping is in
  [`./gap-map-coach-experience.md`](./gap-map-coach-experience.md).
- **PR #118 (Team Mode foundation ADR):** every row that adds a
  coach-scoped table includes the forward-compat
  `acted_by_member_user_id` column hook (where applicable) so the
  Team Mode wiring PR series doesn't have to retrofit.
- **PR #119 (roadmap + handoff briefs #01–#02):** this wave
  extends the same shape.
- **PR #120 (platform-readiness lanes #01–#11):** every row in
  this wave maps onto one or more lane briefs. The lane crosswalk
  is in
  [`./gap-map-coach-experience.md`](./gap-map-coach-experience.md)
  §"Platform-readiness coverage."
- **PR #121 (specs #21–#29):** `#28 program templates` is a
  precursor to `#34 regimens` (a regimen is a multi-week
  orchestration *over* templates). `#26 intake questionnaire` is
  a precursor to `#35 assignment` (the intake's outcome can
  auto-suggest an initial regimen). `#22 at-risk detector` and
  `#29 revenue dashboard` overlap with `#36 messaging+progress`
  (progress signals feed both). The mapping is in
  [`./gap-map-coach-experience.md`](./gap-map-coach-experience.md).

## Stage definitions

Same as the main roadmap. Reproduced here so this wave file is
self-contained:

- **Parking lot** — the option is named and ordered, but no RFC,
  ADR, or spec exists yet.
- **In discovery** — an RFC, ADR, or spec exists in the repo.
  There may be a draft PR. Open questions exist that must close
  before runtime work starts.
- **In flight** — at least one non-doc PR has merged toward the
  item. The runtime is partially or fully present. The brief, if
  any, points to the live module README rather than a standalone
  spec.
- **Shipped** — the item is in production and operated as part
  of the day-to-day platform.

## Conventions

These rows follow the same rules as PR #119's roadmap:

- **Stable numbers.** Rows #30–#37 are append-only. If an item
  is dropped, the row is marked `Abandoned — see <PR>` and the
  number is retired, not reused. Filenames in
  [`./handoff/`](./handoff/) and
  [`../specs/`](../specs/) keep the same numeric prefix across
  history.
- **Operator-facing brief, engineer-facing spec.** Every row has
  a short brief in `./handoff/NN-<slug>.md` that answers
  WHY/WHEN/WHERE/WHO/WHAT/HOW and a long spec in
  `../specs/<slug>.md` that contains the data model, API surface,
  rollout plan, RBAC posture, and acceptance criteria. The brief
  never duplicates the spec body — it summarizes and links.
- **No runtime, no migration, no module wiring.** This PR is a
  *spec wave*: every file is documentation. The runtime PRs
  follow in narrow, gated series, one row at a time.

## How to fold this in

When PR #119 and PR #121 merge, the rows above are folded into
the main `expansion-roadmap.md` index table in a single edit.
This file is then retired with a banner that reads:

> Folded into [`expansion-roadmap.md`](./expansion-roadmap.md)
> on `<date>`. See git history for the original wave layout.

The handoff briefs under [`./handoff/`](./handoff/) and the specs
under [`../specs/`](../specs/) are unchanged by the fold-in.

## See also

- [`./expansion-roadmap.md`](./expansion-roadmap.md) — the parent
  roadmap (PR #119).
- [`./expansion-roadmap-addendum.md`](./expansion-roadmap-addendum.md)
  — rows #21–#29 (PR #121).
- [`./platform-readiness/README.md`](./platform-readiness/README.md)
  — cross-cutting lanes (PR #120). Every row in this wave maps
  onto one or more lanes; the crosswalk is in
  [`./gap-map-coach-experience.md`](./gap-map-coach-experience.md).
- [`./gap-map-coach-experience.md`](./gap-map-coach-experience.md)
  — answers "do we have this already?" by mapping each row to the
  closest existing draft PR / merged module.
