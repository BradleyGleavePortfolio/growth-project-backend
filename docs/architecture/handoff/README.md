# Handoff briefs

Short, operator-facing pre-work briefs for items on the
[expansion roadmap](../expansion-roadmap.md). Each brief answers
**WHY / WHEN / WHERE / WHO / WHAT / HOW** for one expansion-roadmap
row, and links out to the underlying RFC or ADR for engineers.

Briefs are deliberately short: they exist so that a future operator
can pick up the context behind an in-flight draft PR without reading
the full RFC end-to-end. The RFC remains the source of truth for
data model, API surface, and open questions.

## Conventions

- File names: `NN-<slug>.md`, where `NN` matches the row number in
  [`../expansion-roadmap.md`](../expansion-roadmap.md). Numbers are
  append-only — a retired item keeps its number; the file is left
  in place with `Status: Abandoned` and a link to the PR that
  closed it out.
- Each brief opens with a callout pointing at the underlying RFC or
  ADR and the draft PR (if any). The brief is the operator companion
  to those docs, not a replacement.
- Each brief covers, in this order:
  - **WHY** — the user/business problem.
  - **WHEN** — the trigger and gating conditions.
  - **WHERE** — the modules, tables, env vars, routes the work
    will touch.
  - **WHO** — stakeholders, decision-makers, on-the-hook role.
  - **WHAT** — what already exists and what is still to produce.
  - **HOW** — rollout plan and the smallest first non-doc PR.

## Index

| # | Brief | Underlying doc | Stage |
|---|-------|----------------|-------|
| 01 | [AI Program Builder](./01-ai-program-builder.md) | [`docs/rfcs/ai-program-builder.md`](../../rfcs/ai-program-builder.md) (PR #117, draft) | In discovery |
| 02 | [Team Mode foundation](./02-team-mode.md) | [`docs/architecture/adr-0001-team-mode-foundation.md`](../adr-0001-team-mode-foundation.md) (PR #118, draft) | In discovery |

When a new RFC or ADR lands for a previously parking-lot row in
[`../expansion-roadmap.md`](../expansion-roadmap.md), append a
matching brief here in the same PR.
