# Handoff briefs

This directory holds the **operator-facing** companion to the
expansion roadmap items. Each brief is short (one screen). It
points outward to the long-form RFC, ADR, or spec — never
duplicates it. The brief is the first thing a new operator
reads; it is not the last.

This README is the index + conventions doc. The roadmap that
sits above all the briefs is in
[`../expansion-roadmap.md`](../expansion-roadmap.md).

## Index

| Brief | Roadmap row | Subject | Underlying long-form doc |
|---|---|---|---|
| [`01-ai-program-builder.md`](./01-ai-program-builder.md) | #01 | AI Program Builder | [`docs/rfcs/ai-program-builder.md`](../../rfcs/ai-program-builder.md) (PR #117) |
| [`02-team-mode.md`](./02-team-mode.md) | #02 | Team Mode foundation | [`../adr-0001-team-mode-foundation.md`](../adr-0001-team-mode-foundation.md) (PR #118) |
| [`21-outcome-check-ins.md`](./21-outcome-check-ins.md) | #21 | Outcome check-ins (B7) | [`../../specs/outcome-check-ins.md`](../../specs/outcome-check-ins.md) |
| [`22-at-risk-detector.md`](./22-at-risk-detector.md) | #22 | At-risk client detector (B4) | [`../../specs/at-risk-detector.md`](../../specs/at-risk-detector.md) |
| [`23-weekly-recap.md`](./23-weekly-recap.md) | #23 | AI weekly recap (B2) | [`../../specs/weekly-recap.md`](../../specs/weekly-recap.md) |
| [`24-coach-ai-voice.md`](./24-coach-ai-voice.md) | #24 | Coach AI voice / tone | [`../../specs/coach-ai-voice.md`](../../specs/coach-ai-voice.md) |
| [`25-ready-to-scale-checklist.md`](./25-ready-to-scale-checklist.md) | #25 | Ready-to-scale checklist (B1) | [`../../specs/ready-to-scale-checklist.md`](../../specs/ready-to-scale-checklist.md) |
| [`26-intake-questionnaire.md`](./26-intake-questionnaire.md) | #26 | Intake questionnaire (B3) | [`../../specs/intake-questionnaire.md`](../../specs/intake-questionnaire.md) |
| [`27-public-coach-profile.md`](./27-public-coach-profile.md) | #27 | Public coach profile (B5) | [`../../specs/public-coach-profile.md`](../../specs/public-coach-profile.md) |
| [`28-program-templates.md`](./28-program-templates.md) | #28 | Program templates (B6) | [`../../specs/program-templates.md`](../../specs/program-templates.md) |
| [`29-revenue-dashboard.md`](./29-revenue-dashboard.md) | #29 | Coach revenue dashboard (B8) | [`../../specs/revenue-dashboard.md`](../../specs/revenue-dashboard.md) |

## File-naming rule

`NN-<slug>.md`, where `NN` matches the row number on
[`../expansion-roadmap.md`](../expansion-roadmap.md). Numbers are
**append-only** — see the roadmap doc for the rule. A retired
brief stays in this folder with a "retired" banner and a pointer
to the replacement (if any).

## Required sections

Every brief in this folder is structured around the same six
top-level questions, in this order, for fast operator scanning:

1. **WHY** — the problem the item solves, in user / business
   terms. One paragraph.
2. **WHEN** — the trigger and gating conditions for starting the
   work. Bulleted; usually 2–4 items.
3. **WHERE** — the modules, tables, and routes the item will
   touch. Skeleton list; the spec carries the full list.
4. **WHO** — sign-off, on-the-hook engineer, downstream
   consumers, hard boundaries.
5. **WHAT** — what already exists vs. what is still to produce
   vs. non-goals. Three sub-bullets.
6. **HOW** — rollout plan + smallest first PR + feature flag
   name. Five-line max.

After those six, every brief carries:

- **Risks (top three).**
- **Cross-references** to the roadmap row, the spec/RFC/ADR, and
  any other dependencies among #01–#29.

If a section is empty, write `_None._` rather than removing it —
the shape is the contract.

## When to update a brief

- **Stage transitions** (parking lot → in discovery → in flight
  → shipped) are reflected in the roadmap row and the brief's
  status banner.
- **WHEN section closes** as gating conditions are met. Tick the
  bullets in place; do not delete the line.
- **HOW section** is edited as the rollout cadence is adjusted.
- The brief is retired (with a banner) once the feature is
  shipped and the live module README replaces it.

## Cross-references

- [`../expansion-roadmap.md`](../expansion-roadmap.md) — canonical
  row index.
- [`../../specs/README.md`](../../specs/README.md) — engineer-facing
  spec index for #21–#29.
- PR #117, PR #118, PR #119 — the upstream draft PRs these briefs
  build on.
