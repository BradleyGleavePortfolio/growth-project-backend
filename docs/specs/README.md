# Specs — backend-owned expansion pre-work

This folder holds engineer-facing specifications for the
backend-owned items on the [expansion roadmap](../architecture/expansion-roadmap.md).
Each spec is the long-form companion to a one-page operator
handoff brief in [`../architecture/handoff/`](../architecture/handoff/).

## Why a "specs" folder, separate from `rfcs/`?

`docs/rfcs/` is reserved for cross-cutting RFCs that propose new
*subsystems* (e.g. the AI Program Builder). `docs/specs/` holds
narrower specifications for individual features that fit inside
the existing module shape — the 12-step ready-to-scale checklist,
the at-risk rules engine, the weekly recap endpoint, the outcome
check-in templates, etc. The split keeps the RFC folder focused on
architectural change and the specs folder focused on shippable
feature contracts.

## Status of every spec in this folder

Every file in this folder is **pre-work**. None of them carry a
runtime change. Each file describes the data model, API surface,
rollout plan, RBAC posture, observability hooks, and acceptance
criteria for a feature that will be implemented in a later,
separate PR series. The spec is the contract; the runtime work
follows once the spec is reviewed.

A spec that has gone to runtime gets a status banner at the top
that says "in flight" with a link to the live module README. A
spec that has been retired stays in this folder with a "retired"
banner, the reason, and a pointer to the replacement (if any) —
specs are append-only history.

## Index

| Roadmap # | Item | Spec | Handoff brief |
|---|---|---|---|
| 21 | Outcome check-ins (B7) | [`outcome-check-ins.md`](./outcome-check-ins.md) | [`../architecture/handoff/21-outcome-check-ins.md`](../architecture/handoff/21-outcome-check-ins.md) |
| 22 | At-risk client detector (B4) | [`at-risk-detector.md`](./at-risk-detector.md) | [`../architecture/handoff/22-at-risk-detector.md`](../architecture/handoff/22-at-risk-detector.md) |
| 23 | AI weekly recap (B2) | [`weekly-recap.md`](./weekly-recap.md) | [`../architecture/handoff/23-weekly-recap.md`](../architecture/handoff/23-weekly-recap.md) |
| 24 | Coach AI voice / tone setting | [`coach-ai-voice.md`](./coach-ai-voice.md) | [`../architecture/handoff/24-coach-ai-voice.md`](../architecture/handoff/24-coach-ai-voice.md) |
| 25 | Ready-to-scale checklist (B1) | [`ready-to-scale-checklist.md`](./ready-to-scale-checklist.md) | [`../architecture/handoff/25-ready-to-scale-checklist.md`](../architecture/handoff/25-ready-to-scale-checklist.md) |
| 26 | Intake questionnaire templates (B3) | [`intake-questionnaire.md`](./intake-questionnaire.md) | [`../architecture/handoff/26-intake-questionnaire.md`](../architecture/handoff/26-intake-questionnaire.md) |
| 27 | Public coach profile (B5) | [`public-coach-profile.md`](./public-coach-profile.md) | [`../architecture/handoff/27-public-coach-profile.md`](../architecture/handoff/27-public-coach-profile.md) |
| 28 | Program templates (B6) | [`program-templates.md`](./program-templates.md) | [`../architecture/handoff/28-program-templates.md`](../architecture/handoff/28-program-templates.md) |
| 29 | Revenue dashboard (B8) | [`revenue-dashboard.md`](./revenue-dashboard.md) | [`../architecture/handoff/29-revenue-dashboard.md`](../architecture/handoff/29-revenue-dashboard.md) |

## What every spec must cover

Each spec in this folder is structured around the same headings so
a reviewer can compare two specs side by side. The required
sections are:

1. **Status** — banner indicating pre-work / in flight / retired,
   plus links to the matching handoff brief and any cross-referenced
   draft PR.
2. **WHY** — the problem the feature solves, in user/business terms.
3. **WHEN** — gating conditions for starting the work.
4. **WHERE** — modules, tables, and routes the feature will touch.
5. **WHO** — sign-off, on-the-hook engineer, downstream consumers.
6. **WHAT** — the existing surface, the new surface, and the
   non-goals.
7. **HOW** — rollout plan, smallest first PR, feature flag.
8. **Data model sketch** — additive Prisma model proposals, FKs,
   indexes, and enums; no migration committed by this PR.
9. **API sketch** — route shape, request/response shape, throttling,
   error envelope.
10. **Rollout / feature flags** — env var name, default, kill-switch
    behavior, fan-out order across mobile + console + BFF.
11. **RBAC and privacy** — role gate, tenancy axis, GDPR scrub
    coverage, audit log entry.
12. **Tests** — unit, integration, smoke, and (where applicable)
    eval; what stays in CI, what is manual.
13. **Risks** — the failure modes the spec is paying down by being
    written before runtime.
14. **Dependencies** — other roadmap items, external services, and
    the gating decision items they imply.
15. **Acceptance criteria** — the checklist a future PR series must
    satisfy before the spec is considered "shipped."
16. **Operator handoff** — the runbook entry the operator gets when
    the feature ships, and the dashboards / alerts / kill-switches
    they will need.

## Cross-references

- [`../architecture/expansion-roadmap.md`](../architecture/expansion-roadmap.md)
  — the canonical numbered index that ties these specs to their
  position on the expansion track.
- [`../architecture/handoff/README.md`](../architecture/handoff/README.md)
  — the operator-facing companion to this folder.
- Draft PR #117 (AI Program Builder RFC) and PR #118 (Team Mode
  ADR) — the subsystem-level RFCs these specs build on.
- PR #119 (expansion roadmap + first two handoff briefs) — the
  parent doc series this folder extends.
