# R1 Audit Report — PR #376 MWB-1 Master Workout Builder Data Model

Auditor: GPT-5.5 R1  
Branch under review: `feature/mwb-1-data-model` @ `73fca48f8df0232d7d43ef237585946ab915e65f`  
Base: `main` @ `9322eeb`  
Audit branch: `audit/r1-pr-376`

## Verdict

**DIRTY** — verification found hard gate failures in scope/feature-flag posture despite green TypeScript, Prisma diff, RLS, MWB-adjacent, and dunning test lanes.

## Blocking findings

1. **Gate 2 scope boundary fails: PR edits forbidden `src/ai/**` files.**
   - Changed files include:
     - `src/ai/coach/coach-ai.service.ts`
     - `src/ai/gateway/materialisers/assign-workout.materialiser.ts`
   - The audit brief explicitly says: `NO edits to src/community/**, src/dunning/**, src/entitlement/**, src/payouts-v2/**, src/contracts/**, src/ai/**`.
   - This is a hard scope failure independent of test results.

2. **Gate 8 entitlement-gating posture is not satisfied for the new `WorkoutProgramController`.**
   - New write surface: `POST /workout-programs/:programId/fork`, `POST /workout-programs/:programId/clone`, `POST /workout-programs/:programId/assignments`.
   - The controller has `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles('coach', 'owner')`, but it does not mount `ClientEntitlementGuard`, `SubscriptionGuard`, or another entitlement/paywall guard.
   - The PR body says controller/service exposure is behind entitlement guards, but the code path only shows auth + roles at the new controller class.
   - The existing `test/entitlement-guards-mounted.spec.ts` passes because it does not include `WorkoutProgramController`; passing that suite does not verify the new MWB program endpoints are entitlement-gated.

## Gate-by-gate results

| Gate | Result | Notes |
|---|---:|---|
| 1 — Commit hygiene | PASS | Single commit: `feat(workout): MWB-1 master workout builder data model + RLS + sub-coach scope`; author `Dynasia G <dynasia@trygrowthproject.com>`; title-only. |
| 2 — Scope boundaries | FAIL | `src/ai/coach/coach-ai.service.ts` and `src/ai/gateway/materialisers/assign-workout.materialiser.ts` are changed even though `src/ai/**` is explicitly forbidden. `prisma/migrations/migration_lock.toml` is also new and not listed in the allowed paths. |
| 3 — TypeScript clean | PASS | `./node_modules/.bin/tsc --noEmit` returned 0. |
| 4 — Test lanes pass | PASS | RLS MWB-1 passed 61/61 after resetting the already-mutated local RLS test schema and reapplying `GRANT USAGE`; MWB-adjacent lanes passed; dunning lane passed 127/127. |
| 5 — Migration shape | PASS | Prisma v6.19.3 `migrate diff` from `origin/main:prisma/schema.prisma` emits only additive `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT` statements. Actual migration contains `DROP POLICY IF EXISTS` lines for policy replacement on the new RLS tables; no table/column/data-destructive operation was found in the Prisma diff. |
| 6 — RLS posture on 4 new tables | PASS | RLS spec verified `ENABLE` + `FORCE`, canonical policy sets, service role bypass, anon zero access, owner access, tenant/sub-coach read behavior, and helper hardening. |
| 7 — Sub-coach scope correctness | PASS | `assignable-asset-resolver-workout`, `coach.service.sub-coach-scope`, and `sub-coach-scope.service` lanes passed; MWB RLS spec covers assigned vs non-assigned client snapshot reads. |
| 8 — Feature flag / exposure posture | FAIL | No dedicated launch feature flag; more importantly, the new `WorkoutProgramController` is auth+role gated but not entitlement gated, contrary to the gate language and PR body. |
| 9 — Forbidden tokens | PASS | Added-line grep for `sonnet`, `claude-3`, `TODO(audit)`, `FIXME`, `XXX` returned no matches. |
| 10 — openapi-spec SKIP-BECAUSE | PASS | PR body documents the known `openapi-spec.spec.ts` skip as an environment DB-seed limitation involving missing `WearableMetricDef`; changed files do not touch wearables/openapi/auth/app.module. |

## Verification commands run

- `npm ci` to install verification dependencies; Prisma Client generated at v6.19.3.
- `./node_modules/.bin/tsc --noEmit` → PASS.
- `./node_modules/.bin/prisma --version` → Prisma 6.19.3.
- `git show origin/main:prisma/schema.prisma > /tmp/base.prisma`.
- `./node_modules/.bin/prisma migrate diff --from-schema-datamodel /tmp/base.prisma --to-schema-datamodel prisma/schema.prisma --script` → additive-only Prisma diff.
- `RLS_FN_TEST_DATABASE_URL=postgresql://rls_tester:rls_tester_pw@localhost:5432/rls_fn_test psql ... GRANT USAGE ON SCHEMA app TO anon, app_authenticated, service_role;` → GRANT applied.
- First RLS run failed because the local `rls_fn_test` schema already had MWB-1 columns from prior state (`column "cloned_from_plan_id" ... already exists`). I reset only the local throwaway RLS test objects/columns and reran.
- `RLS_FN_TEST_DATABASE_URL=... ./node_modules/.bin/jest test/rls-mwb1-workout-builder-policies.spec.ts --runInBand` → PASS, 61/61 after clean reset.
- `./node_modules/.bin/jest test/workout-builder.service.spec.ts test/ai/coach-ai.controller.spec.ts --runInBand` → PASS, 50/50.
- `./node_modules/.bin/jest test/ai-execution-stream2.spec.ts --runInBand` → PASS, 41/41.
- `./node_modules/.bin/jest test/module-graph.spec.ts test/workout-builder.controller-rbac.spec.ts test/sprint-b-workout-builder-guard.spec.ts test/assignable-asset-resolver-workout.spec.ts test/coach.service.sub-coach-scope.spec.ts test/sub-coach-scope.service.spec.ts --runInBand` → PASS, 39/39.
- `./node_modules/.bin/jest test/entitlement-guards-mounted.spec.ts --runInBand` → PASS, 17/17; note this suite does not include `WorkoutProgramController`.
- `./node_modules/.bin/jest test/dunning-v2-cadence.spec.ts test/dunning-v2-copy.spec.ts test/dunning-v2-feature-flag.spec.ts test/dunning-v2-lockout-guard.spec.ts test/dunning-v2-service.spec.ts test/dunning.service.spec.ts --runInBand` → PASS, 127/127.

## Recommendation

Do not merge as-is. At minimum, either remove/relocate the `src/ai/**` changes from this PR or get the scope exception explicitly approved, and mount an appropriate entitlement/subscription guard on the new program endpoints or document why these coach-facing MWB program writes are intentionally free and update the gate/tests accordingly.

DIRTY
