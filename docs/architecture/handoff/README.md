# Handoff briefs

> **Purpose.** Operator-facing pre-work briefs for items on the
> [expansion roadmap](../expansion-roadmap.md) and its
> appended waves. A brief is the first thing a new operator
> reads; the long-form RFC / ADR / spec is the engineer-facing
> companion.

## Why a brief and a spec

A handoff brief answers six questions in one page:

- **WHY** — the user/business problem the item solves.
- **WHEN** — the trigger and gating conditions.
- **WHERE** — modules, tables, routes the item will touch.
- **WHO** — sign-off, on-the-hook engineer, downstream
  consumers.
- **WHAT** — what already exists, what still needs to be
  produced.
- **HOW** — rollout plan, the smallest first PR, the flag.

The spec / RFC / ADR contains the data model, API surface,
open questions, alternatives, and acceptance criteria. The
brief never duplicates that body; it summarizes and links.

## Filename convention

`NN-<slug>.md`, where `NN` matches the row number on the
[expansion roadmap](../expansion-roadmap.md), the
[addendum](../expansion-roadmap-addendum.md), or the
[wave file](../expansion-wave-coach-experience.md).

Numbers are append-only. If a row is dropped, the file
remains with a `Retired — see <PR>` banner; the number is
not reused.

## Index

The roadmap is the source of truth for which briefs exist
and what stage they are in. This index is a derived view —
edit the roadmap, then update this index.

### Rows #01 — #20 (parent roadmap, PR #119)

The parent roadmap reserves rows #01 — #20. The first two
rows have briefs:

- [`01-ai-program-builder.md`](./01-ai-program-builder.md)
- [`02-team-mode.md`](./02-team-mode.md)

(Other rows in #01 — #20 are parking lot or in-flight; they
do not have briefs in this folder.)

### Rows #21 — #29 (addendum, PR #121)

- [`21-outcome-check-ins.md`](./21-outcome-check-ins.md)
- [`22-at-risk-detector.md`](./22-at-risk-detector.md)
- [`23-weekly-recap.md`](./23-weekly-recap.md)
- [`24-coach-ai-voice.md`](./24-coach-ai-voice.md)
- [`25-ready-to-scale-checklist.md`](./25-ready-to-scale-checklist.md)
- [`26-intake-questionnaire.md`](./26-intake-questionnaire.md)
- [`27-public-coach-profile.md`](./27-public-coach-profile.md)
- [`28-program-templates.md`](./28-program-templates.md)
- [`29-revenue-dashboard.md`](./29-revenue-dashboard.md)

### Rows #30 — #37 (wave, this PR)

- [`30-coach-challenges.md`](./30-coach-challenges.md)
- [`31-leaderboards.md`](./31-leaderboards.md)
- [`32-avatar-media.md`](./32-avatar-media.md)
- [`33-content-boards.md`](./33-content-boards.md)
- [`34-regimens.md`](./34-regimens.md)
- [`35-regimen-assignment.md`](./35-regimen-assignment.md)
- [`36-messaging-progress.md`](./36-messaging-progress.md)
- [`37-tiering-l2-l3.md`](./37-tiering-l2-l3.md)

## Cross-references

- Parent roadmap: [`../expansion-roadmap.md`](../expansion-roadmap.md)
- Addendum: [`../expansion-roadmap-addendum.md`](../expansion-roadmap-addendum.md)
- Wave: [`../expansion-wave-coach-experience.md`](../expansion-wave-coach-experience.md)
- Specs: [`../../specs/README.md`](../../specs/README.md)
- Platform readiness: [`../platform-readiness/README.md`](../platform-readiness/README.md)

## Coexistence note

This folder will receive briefs from three currently-open
draft PRs (#119, #121, and the present wave PR). Until all
three merge, individual brief files may be missing — links
in this index point to files that will exist on `main` once
the corresponding PR lands. The index entries are listed
here in numeric order so the file order on `main` after all
three merges is predictable.
