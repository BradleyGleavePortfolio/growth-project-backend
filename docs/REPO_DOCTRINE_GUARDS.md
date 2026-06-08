# Repository Doctrine Guards — Canonical Index

This file lists every test in the repo that enforces doctrine (banned
tokens, locked defaults, naming conventions, route shapes, role
hierarchies). Treat these as **non-negotiable invariants**: a failure
here is never a "flaky test" — it's a real doctrine breach, and the
right response is to fix the offending code, never to weaken the guard.

Every guard test below is part of CI's `build-and-test` job and is
expected to be green on every PR.

## Why this file exists

Community v1-1 (PR #365) sat red for 5 days because the builder did not
know `test/doctrine-cleanup.spec.ts` banned the `Reaction` token from
`prisma/schema.prisma`. Future builders MUST consult this index before
introducing any new Prisma model, enum, table, or column name; before
shipping any new banned-phrase pattern; and before relaxing or
modifying any existing guard.

If you find yourself wanting to weaken a guard so your code can land:
**STOP**. Land an ADR under `docs/decisions/NNNN-*.md` first, get it
reviewed, and only then change the guard. Path A (rename your code)
is almost always correct.

## Fail-fast pre-push lane (R70)

These three guards complete in <30 seconds combined. Run them BEFORE
the full suite:

```bash
npx jest \
  test/doctrine-cleanup.spec.ts \
  test/invariants/locked_defaults.spec.ts \
  test/diagnostic-prompt-doctrine.spec.ts \
  --runInBand
```

## Guard test index

### Core doctrine

| Test                                         | What it enforces                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/doctrine-cleanup.spec.ts`              | No Prisma model named `*Badge*`, `*Streak*`, `*Reaction*`; no column named `streak_*` or `badge_*`. Case-sensitive on the capital-letter tokens. Established by PR #90 (2026-04-29).        |
| `test/diagnostic-prompt-doctrine.spec.ts`    | LLM prompt templates do not leak gamification language (streaks, badges, points, levels) into user-facing diagnostic copy.                                                                  |
| `test/invariants/locked_defaults.spec.ts`    | Default values for entitlement tiers, feature flags, and seed records cannot be silently changed; freeze-frame snapshot.                                                                    |

### Module/route hygiene

| Test                                              | What it enforces                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `test/admin-controller-hygiene.spec.ts`           | All admin controllers are mounted under `/v1/admin/*`, gated by `AdminGuard`, and never accept anonymous traffic.               |
| `test/entitlement-guards-mounted.spec.ts`         | Every premium-tier route has the entitlement guard in its `@UseGuards()` chain — drift detector.                                |
| `test/sprint-b-workout-builder-guard.spec.ts`     | Workout-builder routes respect the per-user weekly quota and the feature flag.                                                  |

### Auth / role hierarchy

| Test                                              | What it enforces                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `test/auth-guard-deletion-lockout.spec.ts`        | Soft-deleted accounts cannot authenticate; race-condition-safe.                                                                 |
| `test/recent-auth.guard.spec.ts`                  | Sensitive routes require a re-authentication within the recency window.                                                         |
| `test/roles.guard.spec.ts`                        | `owner > coach > student` hierarchy is enforced; coach can act on `@Roles('student')` per documented policy.                    |
| `test/coach-brief-enabled.guard.spec.ts`          | Coach-brief endpoints respect the per-coach feature flag.                                                                       |
| `test/subscription.guard.spec.ts`                 | Subscription-gated routes reject unentitled users with structured errors (R9).                                                  |
| `test/billing/subscription-guard.tier.spec.ts`    | Tier-specific gating (per-feature) matches the entitlement matrix.                                                              |

### Domain rules

| Test                                              | What it enforces                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `test/cross-pillar-practice.guard.spec.ts`        | A practice cannot be assigned across incompatible pillars (e.g. nutrition practice on a sleep coach plan).                      |
| `test/real-meal-plans-guards.spec.ts`             | Meal-plan generators only emit foods present in the canonical food DB — no hallucinated ingredients.                            |
| `test/pr14-interval-guard.spec.ts`                | Habit/practice interval validation per PR #14 spec.                                                                             |
| `test/ai-guardrails.service.spec.ts`              | AI gateway refuses prompts matching banned-phrase patterns; logs and returns structured deny.                                   |
| `test/ssrf-guard.spec.ts`                         | Outbound HTTP allowlist for connector OAuth flows.                                                                              |

### Community v1-1 (added 2026-06-08, PR #365)

| Test                                                              | What it enforces                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/community/schema/community-schema.spec.ts`                  | All 11 community models present in generated Prisma client; v1-1 migration DDL includes partitioned messages table and all FKs.                                                 |
| `test/community/rls/community-rls.spec.ts`                        | RLS policies on all community tables enforce workspace tenancy; `app.current_user_id()::uuid` convention.                                                                       |
| `test/community/rls/community-v1-emoji-roundtrip.spec.ts`         | `response_kind` column on `community_responses` preserves UTF-8 byte-perfect for 👍 (4B), 🔥 (4B), family ZWJ 👨‍👩‍👧‍👦 (25B), ❤️ with VS16 (6B). Live-Postgres-gated via `liveDbUrl()`. |

## Adding new guards

When introducing a new doctrine, banned token, or invariant:

1. Write the guard test under `test/` (or a domain subdirectory).
2. Add a row to this file.
3. Land an ADR in `docs/decisions/NNNN-*.md` explaining the
   doctrine (R68 — Doctrine-Decision-Of-Record).
4. If the guard runs in <10s, add it to the R70 fail-fast lane in
   `AGENT_RULES.md`.

## Modifying or relaxing guards

Forbidden without a merged ADR. The whole point of doctrine is that
nobody — including future you — can silently soften it. If a guard
is wrong, an ADR explains why, and the guard change rides on the
same PR as the rationale.

## Related runtime invariants (not guarded by tests)

Some doctrine cannot be tested at unit/integration level; it lives
in code review and process. The current list:

- **R0:** decacorn quality / no silent failures / no quick patches /
  no stub data (`AGENT_RULES.md` items 1, 7, 10).
- **R8:** checkout never visibly leaves the app.
- **R13:** OAuth consent screen stays in production mode.

These are review-time invariants — every reviewer is expected to
check them on every PR.
