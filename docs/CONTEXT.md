# Operator Context Index

**Last refreshed:** 2026-05-26

This document indexes the durable context for any agent or operator picking up work on this repo. **Read `PROJECT_STATE.md` first** — it is the canonical master.

---

## Critical entry points

| If you need... | Read |
|---|---|
| Where the project is right now (PRs, rules, sequence) | [`PROJECT_STATE.md`](./PROJECT_STATE.md) |
| The UX/UI standard (calm, premium, mindful, habit-rewarding) | [`design-system/00-stillwater-standard.md`](./design-system/00-stillwater-standard.md) |
| What hygiene gaps exist (17 third-party findings, ranked, sequenced into 6 PRs) | [`audits/codebase_hygiene_findings.md`](./audits/codebase_hygiene_findings.md) |
| Comprehensive UX audit of 203 surfaces | [`audits/ux_review_report.md`](./audits/ux_review_report.md) |
| Latest pre-merge audit of any shipped PR | [`audits/pr<NNN>_audit_v2.md`](./audits/) |

---

## Section: Master State

- [`PROJECT_STATE.md`](./PROJECT_STATE.md) — Single source of truth. Rules (R1, R52, R56, R61), open PRs, backlog tiers, decisions log, quick-start protocol.

## Section: Stillwater Standard (UX direction)

The user's vision for the app: **one notch above what a decacorn would ship — calm, premium, mindful, habit-rewarding. Design becomes the moat.**

- [`design-system/README.md`](./design-system/README.md) — index of all design docs
- [`design-system/00-stillwater-standard.md`](./design-system/00-stillwater-standard.md) — manifesto, 7 principles, voice, anti-patterns
- [`design-system/01-tactile-primitives.md`](./design-system/01-tactile-primitives.md) — `useHaptic`, `useSpring`, `CompletionMoment` contracts
- [`design-system/02-screen-grammar.md`](./design-system/02-screen-grammar.md) — One Decision Rule, Path Spec, Cognitive Budget
- [`design-system/03-redesign-specs/`](./design-system/03-redesign-specs/) — 5 screen redesign specs (client home, settings, AI meal plan draft, branded checkout, notification preferences)
- [`design-system/04-rollout-plan.md`](./design-system/04-rollout-plan.md) — Tier 1/2/3 sequencing + effort sizing

## Section: Design intelligence (source training docs from operator)

- [`design-intelligence/mobile-app-design-intelligence.md`](./design-intelligence/mobile-app-design-intelligence.md) — 134KB exhaustive mobile design reference
- [`design-intelligence/website-landing-page-design-intelligence.md`](./design-intelligence/website-landing-page-design-intelligence.md) — 81KB landing page design reference

## Section: Hygiene findings (codebase) — 17 ranked + 28 verbatim, 6-PR sequence

- [`audits/codebase_hygiene_findings.md`](./audits/codebase_hygiene_findings.md) — all 17 ranked findings + Batch 3 mapping, grouped into PRs A→F (with PR-G/PR-H for new Batch 3 items)
- [`audits/issue_register_28_findings_2026-05-26.md`](./audits/issue_register_28_findings_2026-05-26.md) — **Batch 3:** 28-issue full architectural register (verbatim from third-party inspection, file:line precision, big-picture solutions)
- [`audits/issue_register_28_findings_2026-05-26.docx`](./audits/issue_register_28_findings_2026-05-26.docx) — original docx for fidelity

The 6-PR hygiene sweep sequence:
- **PR-A**: AI cost + security hardening (LLM spend cap, GatewayInvokeDto, throttle, role injection) — actively bleeding P&L edge
- **PR-B**: Stripe/Billing hardening
- **PR-C**: Security parity (RBAC, throttles)
- **PR-D**: Admin controller cleanup (pagination, DTOs, Swagger)
- **PR-E**: payment-ops Swagger pass
- **PR-F**: CI lint rules to prevent regression

## Section: UX audit (203 surfaces)

- [`audits/ux_review_report.md`](./audits/ux_review_report.md) — full report (heatmap, worst-10, strongest-10, top-20 fixes)
- [`audits/ux_review_rubric.md`](./audits/ux_review_rubric.md) — 3-ideal scoring rubric (premium / rewarding / cognitively simple)
- [`audits/ux_design_reference_notes.md`](./audits/ux_design_reference_notes.md) — auxiliary notes from design intelligence

Worst surfaces: settings/messaging. Strongest: client/Home, apply flow.

## Section: PR audits — shipped this train

| PR | Audit chain | Final audit |
|---|---|---|
| #279 Checkout hardening integration | v1 → v2 CLEAN | (historical, in conversation) |
| #280 CNAME Phase 4 | v1 DIRTY 0/0/2/12 → refix → v2 CLEAN 0/0/0/13 | [`audits/pr280_audit_v2.md`](./audits/pr280_audit_v2.md) |
| #281 Dunning v1 | v1 DIRTY 0/1/4/5 → refix → v2 CLEAN 0/0/0/5 | [`audits/pr281_audit_v2.md`](./audits/pr281_audit_v2.md) |
| #282 Nudge v1 | v1 DIRTY 0/2/4/5 → refix → v2 CLEAN 0/0/0/7 | [`audits/pr282_audit_v2.md`](./audits/pr282_audit_v2.md) |

Plans + result writeups also persisted under [`audits/`](./audits/).

---

## How to extend this folder

When new context is generated (audits, design specs, plans):
1. Drop it under the appropriate `docs/` subdirectory.
2. Add a row to the relevant section above.
3. Update `PROJECT_STATE.md` artifacts index.
4. Commit as a `docs/...` PR.

This folder is the durable memory of the project. Treat it like the wiki.
