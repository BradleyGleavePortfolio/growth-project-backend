# 01 — Feature flags & entitlements

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Today the backend has two parallel "is this caller allowed to do
this" systems and they don't talk to each other:

1. **Env-var flags** (`COACH_CODE_GATE_ENABLED`,
   `BILLING_ENFORCEMENT`, the *described-but-not-yet-added*
   `TEAM_MODE_ENABLED` and `BUILDER_ENABLED`). These are operator
   global switches. They live in `src/common/env-validation.ts`
   and are consumed ad-hoc by the modules that care.
2. **Entitlement bundles** (`fitness_only`, `finance_only`,
   `performance_os`) plus per-product status, documented in
   [`docs/entitlements.md`](../../entitlements.md). These are
   per-customer and per-product. They drive what the coach can do.

Without a single read model `can(actor, action, target) → boolean`
that composes both, every new feature reinvents the gate. Worse,
some features end up with **no gate at all** because the engineer
shipping the PR couldn't tell whether their feature was a flag
question, a bundle question, or both.

**Cross-feature impact (why this is the first lane):**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | Adds a third dimension (per-team-role permissions) on top of flags + entitlements. Without a unified resolver the matrix in `src/common/team-mode/permissions.ts` (PR #118) is a third silo. |
| AI Program Builder | Needs `BUILDER_ENABLED` + a per-coach entitlement + per-coach cost ceiling + a kill switch in case of provider outage. Four gates, one decision point. |
| Check-ins v2 | Schema-version flag during the migration window so old clients keep reading the legacy shape. |
| Public profiles | Per-coach opt-in (entitlement) + global kill switch (flag). |
| Templates marketplace | Bundle-gated visibility + creator-side feature flag while the surface is in beta. |
| Revenue dashboards | OWNER-only flag while shape is iterating; later, per-coach entitlement once exposed to coaches. |

## WHEN

Settle this lane **before** shipping any runtime PR for the five
features above. Concretely: before PR #117 or PR #118 leave draft.
After this brief is accepted, the runtime PRs land in this order:

1. The unified resolver (a pure-TS `can(...)` in
   `src/common/access/`, no I/O). Default behavior matches
   today's behavior — this is a refactor, not a feature.
2. Migrate two existing call sites to the resolver (one per
   sub-system: pick `COACH_CODE_GATE_ENABLED` and the
   `SubscriptionGuard`). Prove the shape.
3. Add the two new flags (`TEAM_MODE_ENABLED`, `BUILDER_ENABLED`)
   *only after* the resolver is in place, so they enter the world
   already routed through the unified path.
4. Document the kill-switch posture (env-var flip propagates on
   the next request; no Fly redeploy needed because the resolver
   reads from `process.env` per-call in dev/test and via a cached
   getter in prod with a 60s TTL).

## WHERE

- `src/common/access/` — new module. Pure TypeScript, no Nest
  decorators, no Prisma. Mirrors the shape of
  `src/common/team-mode/` introduced in PR #118.
- `src/common/env-validation.ts` — the env-var flag tier and the
  placeholder rejector live here. The resolver reads validated
  values from a small typed accessor, never `process.env`
  directly.
- `src/billing/SubscriptionGuard` — first call site to migrate.
  Today it does its own enforcement-mode parsing; under the
  resolver the guard just asks `can(actor, 'coach.write', coach)`.
- `src/auth/` — second call site. `signup-with-code` consults
  `COACH_CODE_GATE_ENABLED` directly today; under the resolver it
  asks `can(anon, 'auth.signup_with_code', null)`.
- Entitlement bundle resolution: `docs/entitlements.md` already
  documents the additive Phase-2 override-table shape. The
  resolver reads the current bundle status; the override table is
  a future plug-in.

## WHO

- **Owner:** backend lead.
- **Reviewers:** founder (for entitlement-bundle questions),
  whoever is shipping Team Mode wiring (so the team-mode permission
  matrix lands on top of, not parallel to, this resolver).
- **On the hook in production:** OWNER (kill switch is an env-var
  flip; OWNER is the operator who flips it).

## WHAT

### What already exists

- Env-var flag tier in `src/common/env-validation.ts`
  (hard / prod / optional / legacy).
- `BILLING_ENFORCEMENT` runtime modes documented in the root
  README and in `src/billing/README.md`.
- Entitlement bundle taxonomy in `docs/entitlements.md` with the
  per-product status enum (`trialing` / `active` / `past_due` /
  `canceled` / `suspended` / `inactive` / `unknown`).
- Team-mode permission matrix scaffolding in
  `src/common/team-mode/permissions.ts` (PR #118 — draft).
- `SubscriptionGuard` in `src/billing/`.

### What is missing

- A single typed `can(actor, action, target) → Decision` function
  that composes the four gates: env flag, entitlement bundle,
  per-product status, and (when Team Mode lands) team-role
  permission.
- A registry of `action` strings — the same vocabulary used by
  Team Mode (`'coach.write'`, `'client.read'`, `'billing.manage'`,
  …) — extended with platform actions (`'auth.signup_with_code'`,
  `'ai.draft_program'`, `'admin.export_clients_csv'`, …).
- A test that fails when an action is added to the matrix without
  a row in any of the resolver's four sub-tables (drift detection,
  same shape PR #118 already proposed for Team Mode).
- A short doc in `docs/access-model.md` (operator-facing) that
  lists every flag, every action, and the matrix between them.

### Flag taxonomy (proposed)

Three categories. Every new flag must declare its category in the
env-var matrix:

1. **Kill switch.** Default `enabled`; flip to `disabled` to
   suppress the feature in case of incident. Examples: AI
   Program Builder, public profiles.
2. **Rollout gate.** Default `disabled`; flip to `enabled`
   during rollout. Examples: `TEAM_MODE_ENABLED`,
   `BUILDER_ENABLED`. Once GA, the flag is removed in a follow-up
   PR (do not leave dead flags).
3. **Enforcement mode.** Tri-state (`off` / `observe` /
   `enforce`). Used when the runtime needs an observation window
   before turning enforcement on. `BILLING_ENFORCEMENT` is the
   prototype.

## HOW

### Resolver shape

```ts
// src/common/access/types.ts
export type Actor =
  | { kind: 'anon' }
  | { kind: 'user'; userId: string; role: Role; coachId?: string; teamMembership?: TeamMembership }
  | { kind: 'service'; service: 'stripe' | 'finance-federation' | 'cron' };

export type Decision =
  | { allowed: true; reason: 'flag_on' | 'entitlement' | 'role' | 'ownership' }
  | { allowed: false; reason: 'flag_off' | 'no_entitlement' | 'wrong_role' | 'cross_tenant' | 'past_due' | 'unknown' };
```

```ts
// src/common/access/can.ts
export function can(actor: Actor, action: Action, target: Target | null): Decision { /* … */ }
```

The resolver is a **pure function**. It takes a snapshot of the
relevant state (caller, target, current entitlement, current flag
values) and returns a decision. It never queries Prisma. The
caller (a guard, a controller, a service) is responsible for
loading the inputs.

### Kill-switch contract

- An env-var flag flip is honored on the next request. No Fly
  redeploy. In production the resolver reads flag values via a
  typed accessor that caches for 60s; the cache is invalidated
  on `SIGHUP` (not used today; explicit warm-cache flush helper
  is provided for tests).
- An entitlement-bundle change (e.g., a coach moves from
  `fitness_only` to `performance_os`) is honored on the next
  request — entitlements are read per-call from the
  `CoachSubscription` mirror.
- The unified resolver logs every `Decision { allowed: false }`
  with the reason at `debug` level. In production the log is
  rate-limited to avoid log volume on hot paths.

### Operator handoff

- OWNER toggles a flag via `fly secrets set FLAG=value` (see
  `docs/deploy-runbook.md` §8 for the operator workflow).
- Per-coach entitlement override is a future Phase-2 table
  documented in `docs/entitlements.md`. Until that table exists,
  per-coach overrides are not supported — bundle assignment is
  the only knob.

## Risks

- **Resolver becomes a god module.** Mitigation: every action is
  a string, the registry lives next to the resolver, and the
  drift test catches additions made elsewhere.
- **Cache TTL hides a flag flip.** Mitigation: 60s TTL, documented;
  test environment uses a 0s TTL (read-through).
- **Migration of existing call sites breaks behavior.** Mitigation:
  start with two call sites, one per sub-system, and keep the
  legacy code paths until the resolver has run for one full
  release cycle without a regression report.
- **Team Mode lands a parallel matrix.** Mitigation: Team-Mode
  matrix in `src/common/team-mode/permissions.ts` is composed
  *into* the resolver, not consulted in parallel. PR #118 is
  drafted exactly so this composition is mechanical.

## Dependencies

- None on the existing `src/common/team-mode/` scaffolding (PR
  #118 stays draft). The resolver can be merged independently.
- Reads from `src/billing/CoachSubscription` mirror — already
  exists.
- Reads from `src/common/env-validation` — already exists.

## Acceptance criteria

A runtime PR satisfies this brief when:

1. ✅ A `src/common/access/can.ts` exists, pure-TS, no Nest, no
   Prisma.
2. ✅ The action vocabulary is one file with one
   exported union, used by both `src/common/access/` and (later)
   `src/common/team-mode/`.
3. ✅ At least two existing gates are migrated to the resolver
   (one flag, one entitlement). Behavior unchanged — assert via
   tests that mirror the pre-migration semantics.
4. ✅ `docs/access-model.md` exists, listing every flag, every
   action, and the matrix between them.
5. ✅ A drift test fails when an action is added to the registry
   without a row in the resolver matrix.
6. ✅ Env-var matrix in the root README adds a "Category" column
   (kill switch / rollout gate / enforcement mode) to every flag.
7. ✅ `BILLING_ENFORCEMENT` keeps its three-mode contract; the
   tri-state semantics are preserved through the migration.

## Test strategy

- **Unit:** the resolver is pure; cover every `Decision.reason`
  branch with table-driven tests.
- **Integration:** the migrated `SubscriptionGuard` and the
  migrated `signup-with-code` keep their existing test suites
  green. No new integration tests beyond the regression coverage.
- **Drift:** the registry-vs-matrix test runs in CI on every PR.
- **Manual:** operator flips `BILLING_ENFORCEMENT` between
  `observe` and `enforce` in staging; a coach in `past_due` gets
  the right answer in both modes.

## Rollout & kill-switch

- Phase 1 (PR-1, behind no flag — pure refactor): land the
  resolver and migrate two call sites. Behavior unchanged.
- Phase 2 (PR-2): migrate the remaining call sites in batches of
  ≤3 per PR. Each PR is independently revertable.
- Phase 3 (PR-3): introduce `TEAM_MODE_ENABLED` and
  `BUILDER_ENABLED` as new flags through the unified resolver.
- Kill switch: `BUILDER_ENABLED=false`, `TEAM_MODE_ENABLED=false`,
  or `BILLING_ENFORCEMENT=observe` immediately suppresses the
  associated feature.
