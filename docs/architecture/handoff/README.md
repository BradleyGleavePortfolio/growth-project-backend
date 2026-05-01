# Handoff briefs

Per-row operator-facing briefs. Each is a 60-second read in the
WHY / WHEN / WHERE / WHO / WHAT / HOW shape, plus risks (top 3),
acceptance criteria (one line), operator handoff (kill-switch,
dashboards, runbook, first-30-days signal), and cross-references
to the engineer-facing spec + the related draft PRs.

The brief lives separately from the spec so:

- The long-form spec (`docs/specs/<row>.md`) stays
  engineer-facing.
- The brief stays operator-facing (founder, OWNER on call,
  the engineer who picks the work up six months later).
- A reviewer triaging the wave can read all briefs in 10
  minutes without opening any spec.

## Engagement & retention wave (rows #40–#44)

- [`40-community-spaces.md`](./40-community-spaces.md)
- [`41-events-live-calls.md`](./41-events-live-calls.md)
- [`42-replays-content-library.md`](./42-replays-content-library.md)
- [`43-rewards-and-bounties.md`](./43-rewards-and-bounties.md)
- [`44-ai-business-copilot.md`](./44-ai-business-copilot.md)

## Brief shape

Every brief in this folder follows the same eight-section shape:

1. **WHY** — problem in user/business terms, in two
   paragraphs.
2. **WHEN** — gating conditions for the first runtime PR
   (each a one-line check, never a process gate).
3. **WHERE** — modules, tables, env-var family, what is
   *not* touched (especially `new-website`).
4. **WHO** — founder / backend / mobile / console / OWNER
   responsibilities; hard boundaries.
5. **WHAT** — already-exists, net-new, non-goals.
6. **HOW** — 7–8-PR rollout plan; smallest first PR; feature
   flag.
7. **Risks (top 3)** + **Acceptance criteria (one-line)** +
   **Operator handoff** (kill-switch, dashboards, runbook,
   first-30-days signal).
8. **Cross-references** — engineer spec, adjacent specs,
   related draft PRs.

## Conventions

- Append-only row numbers (mirrors the spec convention).
- A brief is *retired* not *deleted*: when a row ships and
  the runbook subsumes the brief, the file stays as a
  historical record with a "shipped: see <runbook>" header.
- Briefs cross-reference the engineer spec by relative path,
  not by URL.
