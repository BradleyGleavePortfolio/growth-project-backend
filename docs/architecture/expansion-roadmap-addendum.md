# Expansion roadmap — addendum (rows #21–#29)

**Status:** Living index extension — appends rows for the backend-
owned pre-work items #21–#29 to the main
[`expansion-roadmap.md`](./expansion-roadmap.md) added by PR #119.
This file exists as a separate addendum because PR #119 is still
in draft as of this PR; merging the two pieces is mechanical (a
single edit to the table in `expansion-roadmap.md` once #119
lands) and is described in the "How to fold this in" section
below.

**Last updated:** 2026-04-30.
**Owner:** Backend platform.
**Audience:** Same as the main roadmap — future operators and
engineers who need to know what the platform is deliberately
growing into, in what order, and why an in-progress draft PR
exists today.

## Why a separate addendum file

PR #119 introduces the roadmap-and-handoff layer; this PR
introduces nine more backend-owned items that fit into the same
roadmap shape. To keep the two PRs trivially mergeable in either
order, the new rows are listed here and the new handoff briefs
under [`./handoff/`](./handoff/) point back to a stable file
(this one) that exists on `main` once this PR merges. When PR
#119 merges (or before, if its merge conflicts with this PR are
resolved), the rows below are folded into the main roadmap's
index table and this addendum is retired with a banner pointing
at the merged file.

The numbering is **append-only** and matches the rule in PR
#119's roadmap doc: rows #01–#20 are reserved by PR #119; rows
#21–#29 are reserved here. Future expansion items continue from
#30.

## Index — rows #21 through #29

| # | Item | Stage | Brief | Underlying spec |
|---|------|-------|-------|-----------------|
| 21 | Outcome check-ins (B7) | In discovery — spec drafted; runtime work not started | [`./handoff/21-outcome-check-ins.md`](./handoff/21-outcome-check-ins.md) | [`../specs/outcome-check-ins.md`](../specs/outcome-check-ins.md) |
| 22 | At-risk client detector (B4) | In discovery — spec drafted; runtime work not started | [`./handoff/22-at-risk-detector.md`](./handoff/22-at-risk-detector.md) | [`../specs/at-risk-detector.md`](../specs/at-risk-detector.md) |
| 23 | AI weekly recap (B2) | In discovery — spec drafted; runtime work not started | [`./handoff/23-weekly-recap.md`](./handoff/23-weekly-recap.md) | [`../specs/weekly-recap.md`](../specs/weekly-recap.md) |
| 24 | Coach AI voice / tone setting | In discovery — spec drafted; runtime work not started | [`./handoff/24-coach-ai-voice.md`](./handoff/24-coach-ai-voice.md) | [`../specs/coach-ai-voice.md`](../specs/coach-ai-voice.md) |
| 25 | Ready-to-scale checklist (B1) | In discovery — spec drafted; runtime work not started | [`./handoff/25-ready-to-scale-checklist.md`](./handoff/25-ready-to-scale-checklist.md) | [`../specs/ready-to-scale-checklist.md`](../specs/ready-to-scale-checklist.md) |
| 26 | Intake questionnaire templates + invite/onboarding wiring (B3) | In discovery — spec drafted; runtime work not started | [`./handoff/26-intake-questionnaire.md`](./handoff/26-intake-questionnaire.md) | [`../specs/intake-questionnaire.md`](../specs/intake-questionnaire.md) |
| 27 | Public coach profile (B5) | In discovery — spec drafted; runtime work not started | [`./handoff/27-public-coach-profile.md`](./handoff/27-public-coach-profile.md) | [`../specs/public-coach-profile.md`](../specs/public-coach-profile.md) |
| 28 | Program-template models (B6) | In discovery — spec drafted; runtime work not started | [`./handoff/28-program-templates.md`](./handoff/28-program-templates.md) | [`../specs/program-templates.md`](../specs/program-templates.md) |
| 29 | Coach revenue dashboard (B8) | In discovery — spec drafted; runtime work not started | [`./handoff/29-revenue-dashboard.md`](./handoff/29-revenue-dashboard.md) | [`../specs/revenue-dashboard.md`](../specs/revenue-dashboard.md) |

## Dependencies between these rows

The nine rows are not independent. The dependency graph below is
the order a runtime rollout that aimed at all nine would naturally
follow; it is the same order the founder's "Next 20 steps" list
in `coach_os_strategy_memo.md` and `tgp_coach_os_expansion_blueprint.md`
implies.

```
#24 coach AI voice ─────────┐
                            ├──> #23 AI weekly recap
#21 outcome check-ins ──────┤
                            ├──> #22 at-risk detector
#28 program templates ──────┘

#21 outcome check-ins ──────> #28 program templates  (shared field-types vocabulary)
#26 intake questionnaire ───> #28 program templates  (auto-generated first-week plan reads templates)
#25 ready-to-scale checklist ──> #27 public coach profile  (publication gate)
#26 intake questionnaire ───> #27 public coach profile  (CTA target)
#22 at-risk detector ───────> #29 revenue dashboard  (at-risk count surfaces in overview)
```

External dependencies on the existing draft PRs:

- **PR #117 (AI Program Builder RFC):** consumed by #21, #23,
  #24, #28; the runtime PRs for those four read provider
  plumbing, eval CI, and per-kind validators that PR #117 is the
  source of truth for.
- **PR #118 (Team Mode foundation ADR):** every row that adds a
  table includes the forward-compat `acted_by_member_user_id`
  column hook (where applicable) so the Team Mode wiring PR
  series doesn't have to retrofit.
- **PR #119 (roadmap + handoff briefs #01–#02):** this addendum
  extends.

## Stage definitions

Same as the main roadmap. Reproduced here so this addendum is
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

All nine rows in the table above are **in discovery**. Each
spec's "Acceptance criteria" section is the contract the runtime
PR series must satisfy to move the row to "in flight."

## How to fold this in

When the parent roadmap (PR #119) merges, this addendum is
folded in by:

1. Append rows 21–29 from the table above to the index table in
   `expansion-roadmap.md`.
2. Replace the contents of this file with a single banner
   pointing to the merged file.
3. No change to the briefs or specs is needed; their links use
   relative paths that resolve identically before and after the
   fold.

The fold is a single PR; CI is the same green it is now (docs-
only). Doing it in either order works:

- If PR #119 merges first, this PR rebases onto main and the
  fold can land in this PR.
- If this PR merges first, PR #119 carries the fold.

## When to update this file

Same conventions as the main roadmap:

- Append a new row (and create the matching handoff brief +
  spec) when a new backend-owned expansion item is named.
- Move a row from "in discovery" to "in flight" when the first
  non-doc PR for that item merges.
- Removing or reordering items requires the same review bar as
  accepting a spec or RFC.

## Cross-references

- [`./expansion-roadmap.md`](./expansion-roadmap.md) — main
  roadmap (rows #01–#20 from PR #119).
- [`./handoff/README.md`](./handoff/README.md) — handoff brief
  index + conventions.
- [`../specs/README.md`](../specs/README.md) — engineer-facing
  spec index for #21–#29.
- PR #117 — AI Program Builder RFC.
- PR #118 — Team Mode foundation ADR.
- PR #119 — expansion roadmap + first two handoff briefs.
