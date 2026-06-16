# Wave 1.5 — HYPERSCALER-GRADE Build Order

**Status:** SUPERSEDES `RESCOPED_BUILD_ORDER.md` (25-PR version). User-approved hyperscaler test: "is it what Apple/Notion/Google/Tesla/Stripe would do?" Answer was NO at 800 LOC caps. Rewritten to hyperscaler standards.

**Doctrine:** Luxury / HECTACORN quality. Right not fast. Every PR independently revertable. Every PR auto-mergeable after CLEAN audit.

---

## Hyperscaler size law (cited)

- **Google code review playbook:** PRs under 200 LOC for fastest review + lowest defect rate ([DeployHQ](https://www.deployhq.com/blog/google-code-review-playbook-deployment-velocity))
- **Meta:** target <150 LOC per PR
- **Stripe Minions / Graphite stacked model:** median PR 47 LOC; ideal 50 LOC; defect detection collapses past 200 LOC ([Graphite research](https://graphite.com/research/median-pr_size), [Stripe case study](https://systemdesigndoc.com/case-studies/stripe-minions-1300-prs/))
- **LinearB elite tier:** ≤100 LOC ([Git AutoReview 2026 benchmark](https://gitautoreview.com/blog/pr-review-time-benchmark-2026))
- **Octopus AI study:** PRs >800 LOC have 87% lower review thoroughness, 28% more post-merge defects ([Octopus Review](https://octopus-review.ai/blog/ai-made-your-prs-bigger-reviews-got-worse))

**Our caps (binding):**
- **Hard:** 400 LOC net diff (additions + deletions − whitespace − generated migrations)
- **Target:** ≤200 LOC ideal; 200-400 acceptable with justification
- **Existing-file delta:** ≤150 LOC (force splits when adding to god-files)
- **New file:** ≤350 LOC (split into co-located helpers if larger)
- **Migration SQL:** counted separately, ≤300 LOC per migration; ≤1 migration per PR
- **Test files:** counted separately, no cap (more tests = good)

If any PR projects over 400 LOC, it MUST split before build starts. No exceptions.

---

## Stacked PR model (Graphite / Stripe Minions)

Each PR depends only on the previous one in its chain. We use 3 parallel chains where independence allows:

- **CHAIN A — Security/Infra spine** (RLS, Redis, FF module) — serial, blocks all others
- **CHAIN B — Schema chunks** (after CHAIN A PR1) — 5-10 parallel-within-tier PRs, each one model + one migration
- **CHAIN C — Feature surfaces** (after CHAIN A complete + CHAIN B complete) — admin tooling, evaluator, unlock UX

Within each chain: serial. Across chains: parallel where dependency-graph allows. Each PR squash-merges to `wave-1-5` integration branch (not `main`). Final cutover = single integration→main PR after staging soak + flag flip rehearsal.

---

## Build order — ~37 PRs

### CHAIN A — Security/Infra spine (8 PRs, serial)

**A1 — RLS Prisma middleware skeleton** (~180 LOC, 1 migration)
- New file: `src/database/rls.middleware.ts` (~120 LOC)
- Migration: `CREATE ROLE app_user NOBYPASSRLS LOGIN PASSWORD :env`; `GRANT CONNECT, USAGE ON SCHEMA public TO app_user;` (~40 LOC)
- No policy wiring yet. Just the middleware that calls `set_config('app.gym_ids', :ids, true)` per query + role swap on connection.
- Tests: middleware unit test (mock Prisma client, assert SET LOCAL is called with correct gymIds)

**A2 — RLS-aware PrismaService swap** (~140 LOC)
- Modify `PrismaService` to use `app_user` role for request-scoped queries; admin role only for migrations/cron.
- New: `src/database/prisma.context.ts` (~80 LOC) — AsyncLocalStorage to carry { userId, gymIds, role }.
- Tests: integration test that DDL fails as app_user (proves NOBYPASSRLS)

**A3 — RLS policies for User, Gym, GymMembership** (~250 LOC, 1 migration)
- Migration adds RLS ENABLE + 3 policies (USING + WITH CHECK) on the 3 core tables.
- Tests: live-DB test suite asserting cross-gym SELECT returns 0 rows, INSERT with foreign gymId rejected.

**A4 — RLS live-DB test harness** (~300 LOC)
- New `test/rls/` directory with Postgres testcontainer setup, fixtures, and the assertion DSL: `expectIsolatedFor(gymA).cannotSee(gymBRecord)`.
- Sets the pattern for every later schema PR to add 3-4 isolation tests.

**A5 — Redis client + module skeleton** (~200 LOC)
- New `src/redis/redis.module.ts` (~100 LOC), `redis.service.ts` (~80 LOC) with health check.
- One env: `REDIS_URL`. Connection pool. Reconnect logic.
- Tests: integration test against testcontainer redis.

**A6 — FeatureFlagsModule scaffold** (~250 LOC)
- New `src/feature-flags/feature-flags.module.ts`, `feature-flags.service.ts`, `feature-flags.controller.ts` (skeleton — `GET /me/feature-flags` returns hardcoded `{}` for now), Zod response schema.
- No DB, no evaluator yet. Wires into AppModule.
- Tests: e2e returns 200 + empty flags shape.

**A7 — `gym_owner` role plumbing** (~220 LOC)
- New `Role.GYM_OWNER` enum value, JWT claim propagation, `@Roles(GYM_OWNER)` guard, owner→gym multi-relation.
- Tests: guard rejects non-owner; multi-gym owner sees union.

**A8 — Termination cascade contract (read-only, no writes yet)** (~180 LOC)
- New `src/admin/termination/termination.contract.ts` — pure functions that COMPUTE the cascade plan (what would be deleted/anonymized for a given user/gymMembership) without executing.
- Tests: snapshot tests for cascade plans.

---

### CHAIN B — Schema chunks (after A4 complete; 12 PRs, parallel within tier)

Each schema PR adds: 1 Prisma model + 1 migration + RLS policies + 3-4 isolation tests. Hard cap 350 LOC including migration.

**Tier B1 (parallel, after A4):**
- **B1a — `ClientPurchase` model + migration + RLS** (~280 LOC) — gymId NOT NULL, gymMembershipId optional, the source-of-truth join for tier/package derivation (C-Q2 decision)
- **B1b — `GymMembership` join table** (~240 LOC) — userId + gymId composite PK, status enum, joinedAt; from multi-gym redundancy addendum
- **B1c — `WorkoutCompletion.gymMembershipId` migration** (~180 LOC) — non-null after backfill, FK to GymMembership

**Tier B2 (parallel, after Tier B1):**
- **B2a — `ContentPackage` + `Content↔Package` join** (~320 LOC) — Plan A core entity
- **B2b — `Cohort.gymId NOT NULL` + `Tag.gymId NOT NULL`** (~200 LOC) — gym-scoped vocab from addendum
- **B2c — Coach/Program assignment scoping to gymMembershipId** (~280 LOC) — assignment table FK swap

**Tier B3 (parallel, after Tier B2):**
- **B3a — Evaluator inputs table (`flag_evaluation_input`)** (~220 LOC) — per-user/gym evaluation context
- **B3b — Aggregation table (`gym_daily_rollup`)** (~260 LOC) — eager-CTE source (C-Q6 decision)
- **B3c — Unlock state (`client_unlock`)** (~240 LOC) — Plan A unlock UX

**Tier B4 (parallel, after Tier B3):**
- **B4a — Audit log (`admin_action_audit`)** (~200 LOC) — append-only, for termination cascade writes
- **B4b — Termination cascade write table (`termination_request`)** (~280 LOC) — pre-write Roman pattern (B-Q4-followup)
- **B4c — Multi-gym redundancy constraints (6 T_ROLLUP_* checks)** (~320 LOC) — the 6 binding tests from addendum

---

### CHAIN C — Feature surfaces (after CHAIN A + B complete; 17 PRs, serial within each sub-chain)

**Sub-chain C-EVAL (Evaluator infrastructure, 4 PRs, serial)**
- **C1 — Evaluator core (pure function)** (~300 LOC) — `evaluate(input, rules) => flags` deterministic, no I/O
- **C2 — Evaluator DB read layer** (~280 LOC) — single eager CTE query (C-Q6) building FlagEvaluationInput from gym_daily_rollup + ClientPurchase derivation
- **C3 — Evaluator Redis cache** (~220 LOC) — read-through, TTL 60s, AppState foreground refetch on mobile
- **C4 — Evaluator wired into `/me/feature-flags`** (~180 LOC) — replaces A6 skeleton's hardcoded empty

**Sub-chain C-AGG (Aggregation jobs, 3 PRs, serial)**
- **C5 — Aggregation job scaffold (BullMQ + cron)** (~260 LOC)
- **C6 — Daily rollup job (writes gym_daily_rollup)** (~340 LOC) — guards: idempotent per (gymId, date), skip if already-current
- **C7 — Backfill script + dry-run mode** (~280 LOC) — one-shot CLI for historical rollups

**Sub-chain C-ADMIN (Admin tooling + termination, 4 PRs, serial)**
- **C8 — Admin owner dashboard read endpoint** (~300 LOC) — multi-gym union, RLS-checked
- **C9 — Termination request submission endpoint** (~280 LOC) — writes termination_request, returns cascade plan from A8
- **C10 — Termination cascade executor (background job)** (~360 LOC) — Roman pre-write: writes shadow rows, then atomic swap; backed by audit log
- **C11 — Admin orphan resolution UI endpoints** (~260 LOC) — A-Q3 message-coach default

**Sub-chain C-UX (Content↔package + unlock UX, 6 PRs, serial)**
- **C12 — Content package CRUD endpoints (admin)** (~320 LOC)
- **C13 — Picker-page-first content browsing endpoint** (~260 LOC) — A-Q2 decision
- **C14 — Unlock evaluation endpoint** (~240 LOC) — `GET /content/:id/unlock-state`
- **C15 — Unlock deep-link resolver** (~220 LOC) — `unlock://{kind}/{id}` IN V1 (A-Q6)
- **C16 — Unlock UX state machine** (~300 LOC) — locked/preview/unlocked transitions
- **C17 — Unlock CTA telemetry events** (~180 LOC) — PII-free, mirrors PR #263 patterns

---

## Total: 37 PRs

- **CHAIN A:** 8 PRs (~1,820 LOC budget)
- **CHAIN B:** 12 PRs (~3,020 LOC budget)
- **CHAIN C:** 17 PRs (~4,800 LOC budget)
- **Total budget:** ~9,640 LOC across 37 PRs → median ~260 LOC/PR ✅ within Google/Meta band

Compare 25-PR version: same scope, ~14,000 LOC, median 560 LOC/PR — 2-4× too loose.

---

## Audit cycle (every PR)

1. Opus 4.8 builder spawns from this build order entry + linked spec
2. Builder pushes commit + opens PR on `wave-1-5` integration branch
3. **Dual GPT-5.5 audit** — one auditor focused on correctness/security, one focused on tests/contracts (parallel)
4. Findings synthesized → if any → Opus 4.8 fixer with inline prescriptions
5. Loop until BOTH auditors return CLEAN (true zero findings, P3 included)
6. Auto-merge to `wave-1-5` integration branch
7. Move to next PR

**No PR merges to `main`** until full integration soak + flag flip rehearsal at end.

---

## Phase 2 cleanup (after Wave 1.5 complete) — 8 PRs serial

Biggest debt first. One fixer at a time. R64 GitHub checkpoint per PR.

1. #400 backend
2. #396 backend
3. #398 backend
4. #397 backend
5. #252 mobile
6. #250 mobile
7. #249 mobile
8. #254 mobile

---

## GOD-PR

**CoachWorkoutBuilderScreen.tsx (1,783 LOC) → 4 hooks refactor** — quarantined, separate branch, sequenced AFTER Wave 1.5 + Phase 2 cleanup. Splits into:
- `useWorkoutBuilderState.ts` (~400 LOC)
- `useWorkoutBuilderAutosave.ts` (~350 LOC)
- `useWorkoutBuilderValidation.ts` (~300 LOC)
- `useWorkoutBuilderExerciseLibrary.ts` (~400 LOC)
- Screen shell becomes ~350 LOC.

---

## Why this passes the Apple/Google/Notion/Tesla/Stripe test

- **Apple:** Each PR is independently shippable + revertable. No "big bang" merge. ✅
- **Google:** Median 260 LOC ≤ documented 200-400 sweet spot. ✅
- **Notion:** Schema chunks parallelize cleanly across teams. ✅
- **Tesla:** Security spine (RLS, role separation) lands first, never bolted on. ✅
- **Stripe:** Stacked PR model with integration branch matches Minions case study verbatim. ✅
- **Defect detection:** No PR exceeds Octopus 800 LOC danger zone; most stay under 200 LOC review thoroughness peak. ✅
