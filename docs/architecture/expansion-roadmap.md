# Expansion roadmap

**Status:** Living index — the canonical ordering of expansion-track
work that builds *on top of* the current solo-coach product. New
items are appended here as they are scoped; items move to "in
discovery" once an RFC/ADR exists, and to "in flight" once the first
non-doc PR has merged. Removing or reordering items requires the same
review bar as accepting an RFC.

**Last updated:** 2026-04-30.
**Owner:** Backend platform.
**Audience:** Future operators and engineers who need to understand
what the platform is *deliberately* growing into, in what order, and
why an in-progress draft PR exists today.

This document is **not** a commitment to ship every item. It is a
commitment to make the order, the dependencies, and the parking-lot
status of each item legible — so a draft PR opened today against item
#1 is not orphaned context six months from now.

## How to read this document

Each item below is one expansion option. For the items that have
moved into formal pre-work, this index links to a **handoff brief**
that answers six questions:

- **WHY** — the user/business problem the item solves.
- **WHEN** — the trigger and gating conditions for starting the work.
- **WHERE** — the modules, tables, and routes the item will touch.
- **WHO** — the stakeholders that must sign off, and the role on the
  hook for the work.
- **WHAT** — the artefacts that already exist (RFC, ADR, scaffolding)
  and the artefacts that still need to be produced.
- **HOW** — the rollout plan and the smallest first PR.

Handoff briefs live in [`./handoff/`](./handoff/) and are numbered to
match this index. They are the operator-facing companion to the
underlying RFC or ADR.

## Index

| # | Item | Stage | Brief | Underlying doc |
|---|------|-------|-------|----------------|
| 01 | AI Program Builder | In discovery — RFC drafted; runtime work not started | [01-ai-program-builder.md](./handoff/01-ai-program-builder.md) | [`docs/rfcs/ai-program-builder.md`](../rfcs/ai-program-builder.md) (PR #117, draft) |
| 02 | Team Mode foundation | In discovery — ADR drafted; permission scaffolding present, no runtime wiring | [02-team-mode.md](./handoff/02-team-mode.md) | [`docs/architecture/adr-0001-team-mode-foundation.md`](./adr-0001-team-mode-foundation.md) (PR #118, draft) |
| 03 | Outcome Graph | Parking lot — referenced in §22 of the AI Program Builder RFC and §11 of the Team Mode ADR; no standalone document yet | — | — |
| 04 | Per-client adaptation | Parking lot — depends on item #01 (Program Builder primitives) | — | — |
| 05 | Plateau detection | Parking lot — depends on items #01 and #03 | — | — |
| 06 | Coach analytics expansion | Parking lot — extends `metrics.md` and `admin-reports.md` | — | — |
| 07 | Mobile push fan-out | Parking lot — depends on the messaging surface | — | — |
| 08 | Calendar / availability | Parking lot — independent of items #01 and #02 | — | — |
| 09 | Group programs | Parking lot — depends on items #01 and #02 | — | — |
| 10 | Asset library v2 | Parking lot — supersedes the asset-ingestion subset of item #01 if pulled forward | — | — |
| 11 | Cross-product entitlements (fitness ↔ finance) | Partially in flight in production — see [`docs/entitlements.md`](../entitlements.md) | — | [`docs/entitlements.md`](../entitlements.md) |
| 12 | OWNER federation v2 (account-id join key) | In flight in production — see [`src/admin/federation/README.md`](../../src/admin/federation/README.md) | — | [`src/admin/federation/README.md`](../../src/admin/federation/README.md) |
| 13 | Coach console BFF expansion | In flight — see [`docs/coach-console-integration.md`](../coach-console-integration.md) | — | [`docs/coach-console-integration.md`](../coach-console-integration.md) |
| 14 | Help / self-serve content surface | Shipped — see [`docs/help/`](../help/README.md) | — | [`docs/help/README.md`](../help/README.md) |
| 15 | Onboarding email sequence | Shipped — see [`docs/emails/onboarding/`](../emails/onboarding/README.md) | — | [`docs/emails/onboarding/README.md`](../emails/onboarding/README.md) |
| 16 | OpenAPI spec + downstream client generation | Shipped — see [`docs/openapi.json`](../openapi.json) | — | — |
| 17 | Audit + GDPR posture hardening | Shipped — see [`docs/audit-and-gdpr.md`](../audit-and-gdpr.md) | — | [`docs/audit-and-gdpr.md`](../audit-and-gdpr.md) |
| 18 | Sentry sourcemaps + observability | Shipped — see commit history around PR #95 | — | — |
| 19 | Redis-backed throttling | Shipped — see commit history around PR #93 | — | — |
| 20 | Security hardening bundle | Shipped — see commit history around PR #92 | — | — |

Items 14–20 are listed as expansion options because they are the
*precondition* surface area for items 01–10: they are the platform
plumbing that the future expansion items rely on. They live here so
that a future operator reading this index can see why the in-flight
discovery items can rely on, for example, Redis throttling, Sentry
sourcemaps, or the audit log without re-architecting them.

## Stage definitions

- **Parking lot** — the option is named and ordered, but no RFC or
  ADR exists yet. There is no PR. There may be a forward-compatibility
  note inside another doc.
- **In discovery** — an RFC or ADR exists in the repo. There may be
  a draft PR. The handoff brief is the operator-facing summary of the
  RFC. Open questions exist that must close before runtime work
  starts.
- **In flight** — at least one non-doc PR has merged toward the item.
  The runtime is partially or fully present. The handoff brief, if
  any, points to the live module README rather than a standalone RFC.
- **Shipped** — the item is in production and operated as part of
  the day-to-day platform. Further work on it is a normal feature
  PR, not an expansion item.

## Conventions

- Each item has a **stable number**. Numbers are append-only; if an
  item is removed, its number is retired, not reused. This keeps the
  handoff filenames stable across history.
- Each in-discovery / in-flight item has a handoff brief at
  `./handoff/NN-<slug>.md`, where `NN` matches the index number.
- A handoff brief is **operator-facing**. It is short. It points
  outward — to RFCs, ADRs, READMEs, dashboards, runbooks. It is the
  first thing a new operator reads, not the last.
- An RFC or ADR is **engineer-facing**. It is long. It contains the
  data model, the API surface, the open questions, the alternatives
  considered. The handoff brief never duplicates that body — it
  summarizes the WHY/WHEN/WHERE/WHO/WHAT/HOW and links to it.

## When to update this document

- Append a new row (and create the matching handoff brief) when an
  RFC or ADR for a previously parking-lot item lands.
- Move a row from "in discovery" to "in flight" when the first
  non-doc PR for that item merges.
- Move a row to "shipped" when the rollout plan in its handoff brief
  is complete and the feature is operated as steady state.
- Never silently delete a row. If an item is dropped, mark it
  `Abandoned — see <PR>` and keep the row.
