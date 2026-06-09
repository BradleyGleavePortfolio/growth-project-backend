# R2 Audit Report — PR #376 MWB-1 Post-Fix

Auditor: GPT-5.5 R2  
Repo: `BradleyGleavePortfolio/growth-project-backend`  
PR: #376 — `feature/mwb-1-data-model`  
Head audited: `b29cac2680bd3a944ef51514edca7a3c6d08d328`  
Audit branch: `audit/r2-pr-376`

## Verdict

**CLEAN** — 0 findings.

Ready for merge — orchestrator may proceed.

## R1 re-verification

### 1. REAL FIX — WorkoutProgramController entitlement guard

**PASS.** `WorkoutProgramController` now mounts the coach subscription/paywall guard at class level:

```ts
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@Roles('coach', 'owner')
@RequiresTier('pro')
@Controller('workout-programs')
export class WorkoutProgramController
```

Covered write handlers on this controller:

- `fork()` — `POST /workout-programs/:programId/fork`
- `clone()` — `POST /workout-programs/:programId/clone`
- `assignProgram()` — `POST /workout-programs/:programId/assignments`

`WorkoutProgramController` has no read handlers; the class is a write-only surface, so the class-level `SubscriptionGuard` + `@RequiresTier('pro')` covers the complete controller surface.

The tier string is correct (`'pro'`, lowercase) and matches the `RequiredTier` union consumed by `SubscriptionGuard`.

`SubscriptionGuard` is provided by the global `SecurityGuardsModule`; `WorkoutBuilderModule` does not duplicate-register it.

Parity spot-check passed against the reference coach paid-surface pattern: `CoachMediaController` and coach-AI controllers also layer `SubscriptionGuard` with `@RequiresTier('pro')` over JWT/coach-role guards.

### 2. PRESERVATION — legitimate `src/ai/*` edits remain

**PASS.** The R1 “src/ai drift” item is confirmed as brief drift, not a defect, and the MWB-1 product-code edits remain in place.

- `src/ai/coach/coach-ai.service.ts` still widens the AI client gate from head-coach-only to `WorkoutBuilderService.assertCanAccessClient(...)`, preserving the opacity convention by converting failures to `404 Client not found`. This preserves MWB-1 §7.2 sub-coach scope parity.
- `src/ai/gateway/materialisers/assign-workout.materialiser.ts` still creates `ClientWorkoutAssignmentSnapshot` inside the same `prisma.$transaction` as `clientWorkoutAssignment.create(...)`. This preserves MWB-1 §3.3 snapshot freeze for the AI assignment path.
- The live PR body includes a `Cross-module integration (src/ai/*)` section that explicitly cites §3.3 and §7.2 and explains why both AI-path edits are intentional product-code integration.

## R2 checklist results

| Area | Result | Notes |
|---|---:|---|
| Entitlement guard mounted on WorkoutProgramController | PASS | Class-level `JwtAuthGuard`, `RolesGuard`, `SubscriptionGuard`, `@Roles('coach','owner')`, and `@RequiresTier('pro')`. |
| All WorkoutProgramController writes covered | PASS | `fork`, `clone`, and `assignProgram`; no read handlers exist on the controller. |
| Guard not weakened to auth-only | PASS | `SubscriptionGuard` executes tier/status checks; OWNER bypass remains guard-level behavior. |
| Guard provider wiring | PASS | Provided by global `SecurityGuardsModule`; no manual duplicate provider in `WorkoutBuilderModule`. |
| Entitlement regression tests | PASS | `test/workout-program-controller-entitlement.spec.ts` statically pins guards/tier metadata and behavior-tests free-tier denial, inactive subscription denial, pro allow, and owner allow. Note: inactive subscription uses the existing `SubscriptionGuard` response contract (`error: 'SUBSCRIPTION_INACTIVE'`), while tier upgrades use `code: 'TIER_UPGRADE_REQUIRED'`. |
| PR body update | PASS | Live PR body includes Entitlement gating and Cross-module integration sections. |
| Rebase integrity | PASS | Head sits on `origin/main` `b966088f71338fcff0aa767c480488cfa86b939a`; commit graph is linear: original MWB-1 commit, guard fix, entitlement test commit. |
| Prisma client version | PASS | `package.json` and lockfile pin Prisma / `@prisma/client` 6.19.3. |
| Migration order | PASS | PR diff relative to `origin/main` adds only `20261215000000_mwb_1_data_model` plus `migration_lock.toml`; no R2 migration edits were made after R1. Existing repo convention already contains same-prefix migration directories, so the MWB-1 directory remains unique by full name and deterministic lexicographic order. |
| §3.3 snapshot invariant | PASS | `assignPlan`, `assignProgramToClient`, and AI assign materializer create assignment + snapshot in the same transaction. Existing tests pin assignment snapshot write and fan-out snapshot creation. |
| RLS posture | PASS by diff/structure | R2 fix commits touched only `src/workout-builder/workout-builder.controller.ts` and `test/workout-program-controller-entitlement.spec.ts`; no RLS migration/spec changes were introduced post-R1. |
| Module graph | PASS by inspection | `AppModule` imports `WorkoutBuilderModule`; global `SecurityGuardsModule` is loaded before feature modules; no new duplicate guard provider or circular import was added by R2. |

## Verification evidence

Commands / checks performed:

- `git status --short --branch` — clean audit branch at `b29cac2680bd3a944ef51514edca7a3c6d08d328`.
- `git log --oneline --decorate --graph --max-count=20 --all` — verified linear rebase on `origin/main` `b966088f`.
- `git show --stat --patch 21ebfbed -- src/workout-builder/workout-builder.controller.ts` — verified real guard fix.
- `git show --stat --patch b29cac2680bd3a944ef51514edca7a3c6d08d328 -- test/workout-program-controller-entitlement.spec.ts` — verified new entitlement test coverage.
- `gh pr view 376 --repo BradleyGleavePortfolio/growth-project-backend --json body,headRefOid,baseRefOid` — verified live PR body and head/base SHAs.
- Source inspection of:
  - `src/workout-builder/workout-builder.controller.ts`
  - `src/billing/subscription.guard.ts`
  - `src/common/security/security-guards.module.ts`
  - `src/workout-builder/workout-builder.module.ts`
  - `src/app.module.ts`
  - `src/ai/coach/coach-ai.service.ts`
  - `src/ai/gateway/materialisers/assign-workout.materialiser.ts`
  - `src/workout-builder/workout-builder.service.ts`
  - `test/workout-program-controller-entitlement.spec.ts`
  - `test/workout-builder.service.spec.ts`
- `gh pr checks 376 --repo BradleyGleavePortfolio/growth-project-backend` — current GitHub `build-and-test` check is red, but failures observed in the log are non-MWB/environmental or pre-existing full-suite issues: missing local Postgres for RLS helper specs, `PayoutsV2WebhookController.handle` role-decoration failure outside this PR’s diff, and full-suite OOM. CI type-check/build reached subsequent stages, and MWB-adjacent CI log entries show `test/workout-builder.service.spec.ts` and `test/ai-execution-stream2.spec.ts` passing before the unrelated failures/OOM.

Local note: this audit worktree has no `node_modules`; per the disk-cautious rule I did not run `npm ci`. Initial direct `npx` attempts from the workspace root were discarded as environment/tooling misses, not PR failures.

## Findings

None.

## Final recommendation

Mergeable from the MWB-1 R2 audit perspective. The required R1 functional fix is present, and the legitimate MWB-1 §3.3 / §7.2 `src/ai/*` integration edits were preserved.

Ready for merge — orchestrator may proceed.
