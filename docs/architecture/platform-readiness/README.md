# Platform Readiness — consolidated pre-work index

> **Status:** Draft. Docs-only. Nothing in this folder imports anything;
> nothing here adds an env var, a migration, a module, or a runtime
> code path. Every brief in this folder is enterprise-grade pre-work
> the operator can hand to an engineer and have them ship a narrow,
> reversible runtime PR.

This folder is the **single consolidated artefact** for the eleven
"platform expansion readiness" lanes that need to be settled
**before** the next wave of features (Team Mode, AI Program Builder,
check-ins v2, public profiles, templates marketplace, revenue
dashboards) can be shipped safely. Each lane answers the same six
questions in the same order: **WHY**, **WHEN**, **WHERE**, **WHO**,
**WHAT**, **HOW**, plus an operator handoff section, risks,
dependencies, acceptance criteria, test strategy, and rollout +
kill-switch posture.

Read this index first. Then read the lane(s) relevant to whatever
feature you are about to scope.

## Why this folder exists

Five-plus simultaneous platform investments (Team Mode, AI Program
Builder, check-ins, public profiles, templates, revenue dashboards)
all share the same eleven cross-cutting concerns. Without a single
place to settle each concern once, every feature PR re-litigates
the same questions ("how do I gate this?", "do I need a new API
version?", "where does the audit go?"), which produces drift,
inconsistency, and a long tail of missed enforcement gaps that
bite at audit / compliance / pricing time.

The eleven lanes here are the **shared pre-work**. Each brief is
small enough to read in 5–10 minutes and gives the next engineer
exactly what they need to ship the narrow runtime PR safely.

## Reading order

1. This README (you are here) — scope and ground rules.
2. The lane brief most relevant to your work. Each is independent
   and can be read on its own.
3. The existing module README closest to where the change will land
   (see [`docs/README.md`](../../README.md) → "Module READMEs").
4. The matching runbook (`docs/deploy-runbook.md`,
   `docs/audit-and-gdpr.md`, `docs/entitlements.md`, etc.).

## The eleven lanes

| # | Lane | One-line scope | Brief |
|---|---|---|---|
| 01 | Feature flags & entitlements | Single read model for "can this caller use this feature right now"; flag taxonomy, default-off rule, kill-switch posture. | [`01-feature-flags-and-entitlements.md`](./01-feature-flags-and-entitlements.md) |
| 02 | API versioning & contract stewardship | When `/api/*` becomes `/api/v2/*`, deprecation cadence, OpenAPI as the contract, mobile-pinning policy. | [`02-api-versioning-and-contracts.md`](./02-api-versioning-and-contracts.md) |
| 03 | Security, RBAC, & tenant boundaries | Role hierarchy review, tenant-scoping invariant, cross-tenant test, secret-handling posture. | [`03-security-rbac-and-tenant-boundaries.md`](./03-security-rbac-and-tenant-boundaries.md) |
| 04 | Data lifecycle, privacy, export, delete | Retention matrix per table, GDPR export shape, hard-delete vs scrub, residency posture. | [`04-data-lifecycle-privacy-export-delete.md`](./04-data-lifecycle-privacy-export-delete.md) |
| 05 | Billing packaging & monetization | Bundle taxonomy, entitlement-to-Stripe mapping, grandfather rules, dunning posture. | [`05-billing-packaging-and-monetization.md`](./05-billing-packaging-and-monetization.md) |
| 06 | Observability & incident response | Log/metric/trace contract, severity taxonomy, oncall handoff, postmortem template. | [`06-observability-and-incidents.md`](./06-observability-and-incidents.md) |
| 07 | Migration, seed, & backfill safety | Forward-only rule reaffirmed, three-phase shape change, backfill idempotency, dry-run gate. | [`07-migration-seed-and-backfill-safety.md`](./07-migration-seed-and-backfill-safety.md) |
| 08 | AI governance & prompt ops | Prompt-as-code, eval baselines, provider abstraction, cost ceilings, content guardrails. | [`08-ai-governance-and-prompt-ops.md`](./08-ai-governance-and-prompt-ops.md) |
| 09 | Support & self-serve operations | OWNER admin surface, self-serve recipes, support runbooks, manual override audit. | [`09-support-and-self-serve-operations.md`](./09-support-and-self-serve-operations.md) |
| 10 | Analytics & telemetry | PostHog event taxonomy, server-side metric shape, OWNER reports, identity stitch. | [`10-analytics-and-telemetry.md`](./10-analytics-and-telemetry.md) |
| 11 | Release QA & regression gates | Smoke vs E2E split, regression suite ownership, pre-deploy checklist, canary posture. | [`11-release-qa-and-regression-gates.md`](./11-release-qa-and-regression-gates.md) |

## Ground rules for every lane

These apply to every brief in this folder. They are the operator's
non-negotiables — every runtime PR that descends from this folder
must satisfy them.

1. **Default-off.** Every new capability ships behind an env-var
   flag (or an entitlement bundle, or both). The flag default is
   the safest behavior — usually "no-op" or "observe-only".
2. **Reversible.** Every runtime PR has a documented kill switch.
   For env-var flags, that means flipping the var. For DB shapes,
   that means an additive migration with a backfill that can be
   re-run.
3. **Auditable.** Every state-changing OWNER, COACH, or admin
   action writes an `AuditLog` row before returning success.
4. **Tenant-scoped.** Every query that touches per-coach or
   per-client data scopes by `coach_id` (or, in Team Mode, by
   `team_id` resolved from `coach_id`). Cross-tenant reads are a
   bug class, not a feature.
5. **Read-model boundaries.** Mobile and console see a stable
   read-model envelope. The runtime can change underneath without
   the client noticing as long as the envelope is preserved.
6. **No schema change without a migration.** No `prisma db push`
   in any environment that holds real data. The
   `RELEASE_ALLOW_DB_PUSH` escape hatch is for greenfield bootstrap
   only.
7. **Docs land with the PR.** A runtime PR that does not update
   the matching brief, the relevant module README, the env-var
   matrix in the root README, and (where applicable) the runbook
   is incomplete.

## How each lane supports the in-flight features

The five features the operator is actively scoping all share these
eleven concerns. Each lane brief calls out, in its **WHY** or
**HOW** section, exactly how it carries each feature:

- **Team Mode** (multi-staff coaching businesses; ADR in PR
  [#118](https://github.com/operator/growth-project-backend/pull/118)
  — draft, do not merge): wants tenant boundary widened from
  "coach" to "team", per-staff attribution on every write, a
  permission matrix evaluated on every action, and a billing
  rollup at the team owner.
- **AI Program Builder** (coach-asset → program draft pipeline;
  RFC in PR [#117](https://github.com/operator/growth-project-backend/pull/117)
  — draft, do not merge): wants prompt-as-code, async job queues
  on the existing `REDIS_URL`, deterministic fallback, per-coach
  cost ceilings, and human-in-the-loop publication into the
  existing program tables.
- **Check-ins v2** (richer cadence, multimedia, structured fields):
  wants a versioned schema migration path, idempotent backfill of
  existing rows, and read-model preserved for the mobile client.
- **Public profiles** (coach-facing public pages): wants a public
  read-model, a privacy/consent boundary that excludes
  client-identifying data, and entitlement-gated visibility.
- **Templates marketplace** (coaches publishing reusable
  programs/lessons): wants ownership/attribution invariants,
  monetization plumbing that does not couple to per-coach Stripe,
  and a moderation surface.
- **Revenue dashboards** (OWNER + per-coach revenue views): wants
  reliable Stripe-mirror state, an analytics read-model that
  composes Stripe + product usage, and the OWNER reports surface
  extended without breaking existing CSV consumers.

The cross-feature impact table is reproduced once at the top of
each lane brief in the **WHY** section.

## Update conventions

- Briefs are append-only by intent. If a lane changes shape, edit
  the brief in place and bump its `## Last reviewed` line at the
  top.
- Acceptance criteria and risks are the two sections that change
  most often; keep them tight and concrete.
- When a runtime PR ships against a lane, link it from the brief's
  `## What already exists` section (do not delete the brief — it
  remains the standing operator reference).

## Relationship to other architecture docs

- This folder pairs with the **expansion roadmap** introduced in
  PR [#119](https://github.com/operator/growth-project-backend/pull/119)
  (draft, supplemental docs only). The roadmap indexes
  *features*; this folder indexes *cross-cutting concerns*.
- Per-feature long-form docs live under `docs/rfcs/` (see PR #117)
  or `docs/architecture/adr-*.md` (see PR #118). Briefs in this
  folder reference those instead of duplicating them.
- Operator runbooks (`docs/deploy-runbook.md`, etc.) remain the
  source of truth for *how to operate* a given lane in production.
  Briefs here are the source of truth for *why the lane is shaped
  the way it is* and for the acceptance bar a future runtime PR
  must clear.

## What this folder does NOT do

- ❌ No `prisma/schema.prisma` change.
- ❌ No new migration in `prisma/migrations/`.
- ❌ No `app.module.ts` wiring.
- ❌ No new env vars added to `src/common/env-validation.ts`.
- ❌ No mobile or coach-console contract change.
- ❌ No edits to PR #117, #118, or #119.

Every runtime change descends from these briefs as a separate,
narrow PR.
