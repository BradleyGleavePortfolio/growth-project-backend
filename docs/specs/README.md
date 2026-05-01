# Specs — backend-owned expansion pre-work

This folder holds engineer-facing specifications for the
backend-owned items on the [expansion roadmap](../architecture/expansion-roadmap.md)
and its appended waves. Each spec is the long-form companion
to a one-page operator handoff brief in
[`../architecture/handoff/`](../architecture/handoff/).

## Why a "specs" folder, separate from `rfcs/`?

`docs/rfcs/` is reserved for cross-cutting RFCs that propose
new *subsystems* (e.g. the AI Program Builder, PR #117).
`docs/specs/` holds narrower specifications for individual
features that fit inside the existing module shape — a
checklist, an alerting rule, a single feature endpoint family,
a tiering primitive. The split keeps the RFC folder focused on
architectural change and the specs folder focused on shippable
feature contracts.

## Status of every spec in this folder

Every file in this folder is **pre-work**. None of them
carries a runtime change. Each file describes the data model,
API surface, rollout plan, RBAC posture, observability hooks,
and acceptance criteria for a feature that will be implemented
in a later, separate PR series. The spec is the contract; the
runtime work follows once the spec is reviewed.

A spec that has gone to runtime gets a status banner at the
top that says "in flight" with a link to the live module
README. A spec that has been retired stays in this folder with
a "retired" banner, the reason, and a pointer to the
replacement (if any) — specs are append-only history.

## What every spec must cover

Each spec in this folder is structured around the same
sixteen sections so a reviewer can compare two specs side by
side. The required sections are:

1. **Status** — banner indicating pre-work / in flight / retired,
   plus links to the matching handoff brief.
2. **WHY** — the problem the feature solves, in user/business
   terms.
3. **WHEN** — gating conditions for starting the work.
4. **WHERE** — modules, tables, and routes the feature will
   touch.
5. **WHO** — sign-off, on-the-hook engineer, downstream
   consumers.
6. **WHAT** — the existing surface, the new surface, and the
   non-goals.
7. **HOW** — rollout plan, smallest first PR, feature flag.
8. **Data model sketch** — additive Prisma model proposals,
   FKs, indexes, and enums; no migration committed by the
   spec PR.
9. **API sketch** — route shape, request/response shape,
   throttling, error envelope.
10. **Rollout / feature flags** — env var name, default,
    kill-switch behavior, fan-out order across mobile +
    console + BFF.
11. **RBAC and privacy** — role gate, tenancy axis, GDPR
    scrub coverage, audit log entry.
12. **Tests** — unit, integration, smoke, and (where
    applicable) eval; what stays in CI, what is manual.
13. **Risks** — the failure modes the spec is paying down by
    being written before runtime.
14. **Dependencies** — other roadmap items, external
    services, and the gating decision items they imply.
15. **Acceptance criteria** — the checklist a future PR
    series must satisfy before the spec is considered
    "shipped."
16. **Operator handoff** — the runbook entry the operator
    gets when the feature ships, and the dashboards / alerts
    / kill-switches they will need.

## Index

The roadmap is the source of truth; this index is a derived
view.

### Rows #21 — #29 (addendum, PR #121)

| Row | Item | Spec | Brief |
|---|---|---|---|
| 21 | Outcome check-ins | [`outcome-check-ins.md`](./outcome-check-ins.md) | [`#21`](../architecture/handoff/21-outcome-check-ins.md) |
| 22 | At-risk client detector | [`at-risk-detector.md`](./at-risk-detector.md) | [`#22`](../architecture/handoff/22-at-risk-detector.md) |
| 23 | AI weekly recap | [`weekly-recap.md`](./weekly-recap.md) | [`#23`](../architecture/handoff/23-weekly-recap.md) |
| 24 | Coach AI voice / tone | [`coach-ai-voice.md`](./coach-ai-voice.md) | [`#24`](../architecture/handoff/24-coach-ai-voice.md) |
| 25 | Ready-to-scale checklist | [`ready-to-scale-checklist.md`](./ready-to-scale-checklist.md) | [`#25`](../architecture/handoff/25-ready-to-scale-checklist.md) |
| 26 | Intake questionnaire | [`intake-questionnaire.md`](./intake-questionnaire.md) | [`#26`](../architecture/handoff/26-intake-questionnaire.md) |
| 27 | Public coach profile | [`public-coach-profile.md`](./public-coach-profile.md) | [`#27`](../architecture/handoff/27-public-coach-profile.md) |
| 28 | Program templates | [`program-templates.md`](./program-templates.md) | [`#28`](../architecture/handoff/28-program-templates.md) |
| 29 | Revenue dashboard | [`revenue-dashboard.md`](./revenue-dashboard.md) | [`#29`](../architecture/handoff/29-revenue-dashboard.md) |

### Rows #30 — #37 (wave, this PR)

| Row | Item | Spec | Brief |
|---|---|---|---|
| 30 | Coach-created challenges (fitness + finance) | [`coach-challenges.md`](./coach-challenges.md) | [`#30`](../architecture/handoff/30-coach-challenges.md) |
| 31 | Public/private leaderboards | [`leaderboards.md`](./leaderboards.md) | [`#31`](../architecture/handoff/31-leaderboards.md) |
| 32 | Profile pictures / avatar media | [`avatar-media.md`](./avatar-media.md) | [`#32`](../architecture/handoff/32-avatar-media.md) |
| 33 | Coach content boards | [`content-boards.md`](./content-boards.md) | [`#33`](../architecture/handoff/33-content-boards.md) |
| 34 | Coach-created regimens | [`regimens.md`](./regimens.md) | [`#34`](../architecture/handoff/34-regimens.md) |
| 35 | Per-client regimen assignment | [`regimen-assignment.md`](./regimen-assignment.md) | [`#35`](../architecture/handoff/35-regimen-assignment.md) |
| 36 | Messaging + progress visibility | [`messaging-progress.md`](./messaging-progress.md) | [`#36`](../architecture/handoff/36-messaging-progress.md) |
| 37 | L2 / L3 tiering and white-glove | [`tiering-l2-l3.md`](./tiering-l2-l3.md) | [`#37`](../architecture/handoff/37-tiering-l2-l3.md) |

## Cross-references

- [`../architecture/expansion-roadmap.md`](../architecture/expansion-roadmap.md)
  — the canonical numbered index (PR #119).
- [`../architecture/expansion-roadmap-addendum.md`](../architecture/expansion-roadmap-addendum.md)
  — rows #21 — #29 (PR #121).
- [`../architecture/expansion-wave-coach-experience.md`](../architecture/expansion-wave-coach-experience.md)
  — rows #30 — #37 (this PR).
- [`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
  — answers "do we have this already?" for the coach-experience
  wave by mapping each row to the closest existing artefact.
- [`../architecture/handoff/README.md`](../architecture/handoff/README.md)
  — the operator-facing companion to this folder.
- Draft PR #117 (AI Program Builder RFC) and PR #118 (Team
  Mode ADR) — the subsystem-level RFCs these specs build on.
- PR #119 (expansion roadmap + first two handoff briefs) and
  PR #121 (specs #21 — #29) — the parent doc series this
  folder extends.

## Coexistence note

This folder will receive specs from two currently-open draft
PRs (#121 and the present wave PR). Until both merge,
individual spec files may be missing — links in this index
point to files that will exist on `main` once the
corresponding PR lands. The index entries above are listed in
numeric order so the file order on `main` after both merges
is predictable.
