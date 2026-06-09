# R2 Audit — PR #374 Bank-Payout Post-Fix Verification

Repo: `BradleyGleavePortfolio/growth-project-backend`  
Branch under review: `feature/bank-payout-ach` at `c49d0a66656b384d302f34023bf49f6fc7aaf416`  
Scope: Verified only the five R1 → fixer-cycle items listed in `/home/user/workspace/PR374_R2_AUDIT_BRIEF.md`; did not re-litigate R1 brief-drift items.

## Verdict

CLEAN — all five requested fix items are present and the requested no-regression sanity test set is green.

## Verification details

### V1 — Gate 6 gross-conservation invariant

Status: PASS

Evidence:
- `test/payouts-v2.spec.ts:353-402` contains the Gate 6 `it.each` gross-conservation block asserting `coach_net_cents + platform_fee_cents + stripeFee === gross`.
- The adversarial inputs include the required cases: `$1,000 ACH`, `$25 micro-purchase`, `$9,999.99 large ACH`, `$1.00 minimum`, `$50 card`, and `$200 future ACH` at `test/payouts-v2.spec.ts:359-365`.
- The rounding-edge test uses `reconcileInternal` and asserts the platform absorbs a positive penny delta while coach-visible net + fee + Stripe fee still equals gross at `test/payouts-v2.spec.ts:382-400`.
- `./node_modules/.bin/jest test/payouts-v2.spec.ts --runInBand` passed: 51/51 tests.

### V2 — Gate 7 webhook HTTP-level reject

Status: PASS

Evidence:
- `src/payouts-v2/payouts-v2-webhook.controller.ts:39-102` defines `PayoutsV2WebhookController` at `POST /v1/webhooks/payouts-v2/stripe-connect` and verifies the Stripe signature before delegating to `PayoutRoutingService`.
- `test/payouts-v2.spec.ts:772-865` mounts a real Nest app and uses `app.listen(0)` plus Node `http` via the repo-local `httpRequest` helper.
- Missing signature returns 400 with no routing call at `test/payouts-v2.spec.ts:811-823`.
- Invalid signature returns 400 with no routing call at `test/payouts-v2.spec.ts:825-837`.
- The aggregate reject guard keeps routing at zero calls at `test/payouts-v2.spec.ts:839-843`.
- Valid signature returns 200 and invokes routing exactly once at `test/payouts-v2.spec.ts:845-864`.

### V3 — Gate 9 controller 503 test

Status: PASS

Evidence:
- `test/payouts-v2.spec.ts:875-947` mounts `PayoutMethodController` in a real Nest app with pass-through guards and service spies.
- With `FEATURE_BANK_PAYOUTS_V2=false`, `GET /me/payout-methods` returns 503 and `{ error: 'BANK_PAYOUTS_V2_DISABLED' }` without calling `listForCoach` at `test/payouts-v2.spec.ts:905-915`.
- With the flag off, `POST /me/payout-methods/financial-connections/session` returns 503 and the same error without calling `createFinancialConnectionsSession` at `test/payouts-v2.spec.ts:918-930`.
- With the flag off, `POST /me/payout-methods/:id/default` returns 503 and the same error without calling `setDefault` at `test/payouts-v2.spec.ts:933-945`.

### V4 — Gate 5 fee formula documentation

Status: PASS

Evidence:
- `src/payouts-v2/platform-fee.service.ts:55-89` contains the required `FEE FORMULA — EXACT DERIVATION` block.
- The block shows the required worked example: `cardCost = round(0.029 × 100000) + 30 = 2930`, `stripe_actual_cost = 500`, `savings = 2430`, `platform_fee = 3215 = $32.15`, and `coach_net = 96285 = $962.85` at `src/payouts-v2/platform-fee.service.ts:70-76`.
- The block explicitly notes the R1 auditor's `$36.10` used different inputs: `cardCost = $33.00` and uncapped `stripe_actual_cost = $0.80`, not this service's capped ACH input and `cardCost=2930`, at `src/payouts-v2/platform-fee.service.ts:83-88`.
- The worked-example test references this derivation and asserts `3215 / 96285` at `test/payouts-v2.spec.ts:317-329`.

### V5 — Gate 8 S3 DI deferred note

Status: PASS

Evidence:
- `src/payouts-v2/payouts-v2.module.ts:32-40` states Phase A does not use AWS S3 and defers `S3Client` constructor-injection scaffolding to Phase B for 1099-K storage.
- `package.json:27` retains `"@aws-sdk/client-s3": "^3.1065.0"`.

## Test results

- `./node_modules/.bin/jest test/payouts-v2.spec.ts --runInBand` — PASS, 51 passed / 51 total.
- `./node_modules/.bin/jest test/payouts-v2.spec.ts test/checkout-webhook-handler test/checkout-webhook-fee-split test/dunning test/entitlement test/entitlements --runInBand` — PASS, 252 passed / 252 total.

## Notes

- No source files were changed for this audit.
- The local worktree did not have a complete `node_modules` initially; after an `npm ci` attempt hit disk-space exhaustion, I reused an existing workspace dependency tree and regenerated Prisma client types against this worktree's schema so the requested tests could execute.
