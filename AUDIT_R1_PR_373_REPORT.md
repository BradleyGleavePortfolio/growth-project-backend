# R1 Audit PR #373 — B3 Smart Dunning v2

Verdict: CLEAN

Audited repo/worktree: `/home/user/workspace/tgp/backend-b3-v2-audit` at `b922b57ca7913fc353d726569c03f25e55b70764`.
PR branch audited: `feature/b3-smart-dunning-v2`.
Author check: all four PR commits are authored by `Dynasia G <dynasia@trygrowthproject.com>` with title-only messages and empty bodies.

## Summary

- Changed files: 22; shortstat: `22 files changed, 2708 insertions(+)`.
- Added tests in this PR: 5 files, 1006 inserted test lines by `git diff --numstat` (`143 + 227 + 27 + 160 + 449`). Builder claimed 101 tests; the suite reports below are authoritative.
- TypeScript: PASS after `npm ci`; `npx tsc --noEmit` exited 0.
- Full non-RLS/non-OpenAPI Jest lane: PASS; `332 passed, 6 skipped, 338 total suites`; `4307 passed, 77 skipped, 5 todo, 4389 total tests`.
- v1 dunning regression lane: PASS; `test/dunning.service.spec.ts` = 26/26.
- Entitlement pin lane: PASS; `test/entitlement-guards-mounted.spec.ts` = 17/17.
- R70 fail-fast lane: SKIP-BECAUSE `scripts/r70-fail-fast.sh` is absent.

## Gate-by-gate findings

### 1. Schema additivity — CLEAN

Evidence:
- Existing table `DunningState` gained `locked_out_at DateTime?` and `reversal_count Int @default(0)` at `prisma/schema.prisma:3557-3565`; the first is nullable and the second is defaulted.
- New model `PaymentRecoveryToken` is additive-only at `prisma/schema.prisma:3570-3590`; no existing model relation was mutated.
- Migration only adds two columns and creates one table/index set: `ALTER TABLE ... ADD COLUMN "locked_out_at" TIMESTAMP(3)` at `prisma/migrations/20261214000000_dunning_v2_lockout_recovery/migration.sql:16`, `ALTER TABLE ... ADD COLUMN "reversal_count" INTEGER NOT NULL DEFAULT 0` at line 19, and `CREATE TABLE "PaymentRecoveryToken"` at lines 22-33.
- Destructive statement scan found no operative `DROP`, `DROP COLUMN`, `DROP TABLE`, `RENAME`, `ALTER COLUMN`, `TRUNCATE`, or `DELETE FROM`; the only hit was a comment saying "no DROP" at migration line 4.

### 2. Feature flag default OFF — CLEAN

Evidence:
- `FEATURE_DUNNING_V2_ENV` is defined at `src/checkout/dunning-v2/dunning-v2.feature.ts:24-25`.
- `isDunningV2Enabled()` returns `(env[FEATURE_DUNNING_V2_ENV] ?? '').toLowerCase() === 'true'` at `src/checkout/dunning-v2/dunning-v2.feature.ts:32-35`, so absent, empty, and non-true values are OFF.
- Tests verify absent env OFF at `test/dunning-v2-feature-flag.spec.ts:6-8`, falsey/non-true strings OFF at lines 10-19, and case-insensitive true ON at lines 21-26.
- v2 service methods hard no-op before state access: `applyImmediateClear` at `src/checkout/dunning-v2/dunning-v2.service.ts:72-77`, `handleLateReversal` at lines 141-147, `runLockoutSweep` at lines 212-214, and `detectAndHandleLateReversal` at lines 260-267.
- Lockout guard no-ops before reading state when OFF at `src/checkout/dunning-v2/dunning-lockout.guard.ts:64-67`; scheduler skips when OFF at `src/checkout/dunning-v2/dunning-lockout.scheduler.ts:31-37`.

### 3. v1 dunning untouched — CLEAN

Evidence:
- `src/checkout/dunning.service.ts` is not in the PR diff; changed dunning paths are all new `src/checkout/dunning-v2/*` files plus additive wiring.
- `CheckoutWebhookHandlerService` still calls v1 `this.dunning.recordResolution(updated.id)` before any v2 recovery shim at `src/checkout/checkout-webhook-handler.service.ts:1023-1031`; the v2 `applyImmediateClear` call is additive after that at lines 1032-1041.
- Refund/dispute routing still delegates to v1 refund/dispute handler after the v2 fire-and-forget probe at `src/checkout/checkout-webhook-handler.service.ts:188-196`.
- v1 dunning regression suite passed 26/26 in `test/dunning.service.spec.ts`.

### 4. Cadence math + state machine — CLEAN

Evidence:
- Cadence constant is exactly `[0, 1, 3, 7]` at `src/checkout/dunning-v2/dunning-v2.cadence.ts:25-26`.
- Day-10 lockout is expressed as Day-7 final index `3` plus grace `3` days: `DUNNING_V2_LOCKOUT_GRACE_DAYS = 3` at line 29 and `DUNNING_V2_FINAL_STEP_INDEX = 3` at line 32.
- Late-reversal compressed cadence enters at step 2 with `+4` coach gap and `+3` lockout gap at `src/checkout/dunning-v2/dunning-v2.cadence.ts:35-42`.
- Tests assert the exact cadence, length, Day-10 math, final step, and compressed reversal constants at `test/dunning-v2-cadence.spec.ts:19-45`.
- `deriveState()` maps no-row to INACTIVE, active/no-lock to ACTIVE, active/locked to LOCKED, resolved/recovered to RECOVERED, and other resolved/abandoned rows to INACTIVE at `src/checkout/dunning-v2/dunning-v2.service.ts:48-61`.
- Tests cover no-row, ACTIVE, LOCKED, RECOVERED, resolved without recovery, abandoned, and full forward path including LOCKED→RECOVERED at `test/dunning-v2-cadence.spec.ts:67-142`.
- Late-reversal ACTIVE→RECOVERED→ACTIVE compressed re-entry is implemented at `src/checkout/dunning-v2/dunning-v2.service.ts:160-190` and tested at `test/dunning-v2-service.spec.ts:235-256`.

### 5. Lockout guard — CLEAN

Evidence:
- Guard blocks only when flag is ON, path is not allowed, user exists, and a lockout row is found: `src/checkout/dunning-v2/dunning-lockout.guard.ts:64-93`.
- The thrown response is `ForbiddenException` with stable code `LOCKED_DUNNING` at `src/checkout/dunning-v2/dunning-lockout.guard.ts:93-97`; code constant is defined at `src/checkout/dunning-v2/dunning-v2.cadence.ts:47-48`.
- Lockout lookup requires `locked_out_at != null`, `status: 'active'`, same client user, and `entitlement_active: false` at `src/checkout/dunning-v2/dunning-lockout.guard.ts:100-118`.
- Allow-list includes billing/update surfaces, auth, health checks, and Roman chat prefixes at `src/checkout/dunning-v2/dunning-lockout.guard.ts:39-56`, with prefix logic at lines 131-149.
- Tests assert billing/auth/health/Roman routes are allowed and content routes block at `test/dunning-v2-lockout-guard.spec.ts:20-51`.
- Guard integration tests assert flag-OFF no-op/no state read at `test/dunning-v2-lockout-guard.spec.ts:77-85`, 403 on locked non-billing route at lines 92-102, `ForbiddenException` type at lines 105-110, billing allowed at lines 113-120, Roman chat allowed at lines 122-128, unlocked users allowed at lines 130-136, unauthenticated allowed at lines 138-144, and fail-open lookup errors at lines 146-158.

### 6. Roman copy stems — CLEAN

Evidence in implementation:
- `A small matter` appears in Day-0 push at `src/checkout/dunning-v2/dunning-v2.copy.ts:51-56`.
- `not yet on speaking terms` appears in Day-1 dry push at `src/checkout/dunning-v2/dunning-v2.copy.ts:59-64`.
- `going to lose access` appears in Day-3 blocker headline at `src/checkout/dunning-v2/dunning-v2.copy.ts:88-100`.
- `last chance before lockout` appears in Day-7 blocker headline at `src/checkout/dunning-v2/dunning-v2.copy.ts:118-130`.
- `locked out in 3 days` appears in coach in-app straight copy at `src/checkout/dunning-v2/dunning-v2.copy.ts:134-139`.
- `household ledger` appears in Day-10 lockout screen at `src/checkout/dunning-v2/dunning-v2.copy.ts:154-162`.
- `Links, like milk` appears in expired-link dry copy at `src/checkout/dunning-v2/dunning-v2.copy.ts:171-177`.
- `last payment update failed` appears in late-reversal push/blocker at `src/checkout/dunning-v2/dunning-v2.copy.ts:179-200`.
- `ROMAN_STEMS` enumerates all eight stems at `src/checkout/dunning-v2/dunning-v2.copy.ts:217-226`; tests assert rendered stems across surfaces at `test/dunning-v2-copy.spec.ts:61-173`.

Cross-check against local PR #6 spec branch copy (`/home/user/workspace/tgp/agentctx-b3-option3-update`, commit `d194405bcf833a28d2c90c4e2231095edfcfe5a2`):
- `A small matter`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:493-494`.
- `not yet on speaking terms`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:498`.
- `going to lose access`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:532` and `536`.
- `last chance before lockout`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:556` and `560` (capitalized in source headline; implementation stores lowercase stem key and rendered headline uses the same words with capitalization).
- `locked out in 3 days`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:565`, `610`, and `614`.
- `household ledger`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:599-600`.
- `Links, like milk`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:607`.
- `last payment update failed`: `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md:610`, `613`, and `617`.

### 7. AI-budget integration — CLEAN

Evidence:
- PR #373 changes no `src/ai`, `src/ai-credits`, or `src/billing` files and changes no package manifests.
- Dunning v2 uses static Roman copy and notification/email services; it does not add a separate AI billing path.
- Existing AI gateway has `CoachAIBudgetService` injected at `src/ai/gateway/ai-gateway.service.ts:95-106`.
- Existing gateway pre-call budget gate calls `canCharge()` for metered capabilities at `src/ai/gateway/ai-gateway.service.ts:181-203`.
- Existing gateway post-call metering calls `recordUsage()` at `src/ai/gateway/ai-gateway.service.ts:285-299`.
- `client_chat` is in the existing metered capability set at `src/ai-credits/ai-credits.constants.ts:39-58`, so Roman chat allowance routes through existing metering rather than invented billing.

### 8. PostHog telemetry event names — CLEAN

Evidence:
- Locked event constants are exactly: `dunning.attempt.failed`, `dunning.notify.sent`, `dunning.blocker.shown`, `dunning.coach.notified`, `dunning.lockout.entered`, `dunning.recovered`, `dunning.reversal.detected`, and `dunning.lockout.exited` at `src/checkout/dunning-v2/dunning-v2.telemetry.ts:17-34`.
- Events emit through existing `AnalyticsService.capture()` at `src/checkout/dunning-v2/dunning-v2.telemetry.ts:48-64`.
- Dispatcher fires attempt/notify/blocker/coach events at `src/checkout/dunning-v2/dunning-v2.dispatcher.ts:86-89`, `125-126`, `145`, `184`, and `233-238`; service fires recovery/lockout/reversal events at `src/checkout/dunning-v2/dunning-v2.service.ts:122-127`, `192-198`, and `239-241`.

### 9. No new heavyweight deps — CLEAN

Evidence:
- `git diff --stat origin/main...HEAD -- package.json package-lock.json` returned no output.
- `git diff --name-only origin/main...HEAD -- package.json package-lock.json` returned no output.
- No package manifest changed.

### 10. TypeScript — CLEAN

Evidence:
- Initial `npx tsc --noEmit` failed only because dependencies were not installed in the detached worktree.
- After `npm ci` completed and Prisma client generated successfully, `npx tsc --noEmit` exited 0 with no output.

### 11. Full non-RLS/non-OpenAPI Jest lane — CLEAN

Evidence:
- Command run: `npx jest --testPathIgnorePatterns='rls|openapi' --no-coverage`.
- Result: `Test Suites: 6 skipped, 332 passed, 332 of 338 total`; `Tests: 77 skipped, 5 todo, 4307 passed, 4389 total`; exit 0.

### 12. R70 fail-fast lane — SKIP-BECAUSE

Evidence:
- `scripts/r70-fail-fast.sh` does not exist in this worktree; the gate is skipped for absence.

### 13. No new restricted runtime-model marker strings introduced by this PR — CLEAN

Evidence:
- Diff-only count for added lines containing the restricted marker: `0`.
- Diff-only count for removed lines containing the restricted marker: `0`.
- This ignores pre-existing provider/product-code references outside the PR diff, per instruction.

### 14. Entitlement-guard pin — CLEAN

Evidence:
- `npx jest test/entitlement-guards-mounted.spec.ts --no-coverage` passed 17/17.
- Test output lists all 17 paid-route guard assertions as passing, including `/insights/holistic`, `/scheduling/*`, `/messages/voice-upload`, `/ai/*`, `/ai/gateway/invoke`, `/workouts`, `/meal-plans/*`, `/fasting/*`, `/log/*`, `/check-ins/*`, `/community/*`, `/assignments/*`, `/me/meal-plan/today`, and `/me/macros/current`.

### 15. Author + commit format — CLEAN

Evidence:
- `git log --format='%H %an <%ae> %s %bEND_BODY' origin/main..HEAD` shows all four commits authored by `Dynasia G <dynasia@trygrowthproject.com>`.
- Commit subjects are title-only, with empty body before `END_BODY`:
  - `48a1f0be71eff1ab4b1c67a81bc3b99a2c3e7ee4 feat(billing): add dunning v2 schema deltas (locked_out_at, reversal_count, PaymentRecoveryToken)`
  - `56796f0abc5ca244426982c1f4ead58f74469853 feat(billing): add dunning v2 feature flag, Roman copy, cadence, classifier, telemetry, renderer`
  - `e3741b47defb8df600995835098b72e031de1633 feat(billing): add dunning v2 service, lockout guard, dispatcher, scheduler, module, and webhook wiring`
  - `b922b57ca7913fc353d726569c03f25e55b70764 test(billing): add dunning v2 cadence, lockout guard, copy stem, late-reversal, and feature flag tests`
- No emoji, bodies, or trailers were present.

### 16. Late-reversal idempotency — CLEAN

Evidence:
- Webhook arm fires the late-reversal probe only for `charge.dispute.created` and `charge.refunded` at `src/checkout/checkout-webhook-handler.service.ts:188-194` and then preserves the original refund/dispute handler result at lines 195-196.
- `handleLateReversal()` enforces the one-active-cycle guard before incrementing at `src/checkout/dunning-v2/dunning-v2.service.ts:160-163`.
- It only increments `reversal_count` inside the cycle-open update at `src/checkout/dunning-v2/dunning-v2.service.ts:175-190`.
- Test `one-active-cycle guard` asserts active state returns `cycle_already_active` and leaves `reversal_count` at 1 at `test/dunning-v2-service.spec.ts:258-278`.
- Test `idempotency: a dispute→refund pair only opens (and increments) once` asserts first open true, second open false, `reversal_count` remains 1, and telemetry fires once at `test/dunning-v2-service.spec.ts:280-299`.

## Validation commands run

```text
npm ci
npx tsc --noEmit
npx jest --testPathIgnorePatterns='rls|openapi' --no-coverage
npx jest test/entitlement-guards-mounted.spec.ts --no-coverage
npx jest test/dunning.service.spec.ts --no-coverage
```

## Final verdict

CLEAN. All required gates pass; R70 is skipped only because the script is absent.
