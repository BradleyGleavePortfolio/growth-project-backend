# AUDIT R1 PR #374 — bank-payout / ACH Phase A backend

Verdict: **DIRTY**

Auditor: GPT-5.5 R1 (verify-only)
Worktree HEAD: `deb9d5292509f6d571d872c5803208a9ff5eb1e8`
Base: `9322eeb`
Branch under review: `feature/bank-payout-ach`

## Gate 1 — Commit hygiene

Status: **PASS**

Command run:

```bash
git log --format='%H%n%an <%ae>%n%B%n---END---' 9322eeb..HEAD
```

Findings:

- One commit in range: `deb9d5292509f6d571d872c5803208a9ff5eb1e8`.
- Author is exactly `Dynasia G <dynasia@trygrowthproject.com>`.
- Commit message is title-only: `feat(payouts): bank-account ACH payouts v2 module behind FEATURE_BANK_PAYOUTS_V2 (off)`.
- No body, emoji, `Co-Authored-By`, bot trailer, or `Generated with` trailer found.

## Gate 2 — Scope boundaries

Status: **FAIL**

Commands run:

```bash
git diff --stat 9322eeb..HEAD
git diff --name-only 9322eeb..HEAD
```

Changed files:

```text
.env.example
package-lock.json
package.json
prisma/migrations/20261215000000_payouts_v2_bank_payout_methods/migration.sql
prisma/schema.prisma
src/app.module.ts
src/checkout/checkout-webhook-handler.service.ts
src/checkout/checkout.module.ts
src/payouts-v2/dto/link-bank-account.dto.ts
src/payouts-v2/dto/set-default-payout-method.dto.ts
src/payouts-v2/payout-method.controller.ts
src/payouts-v2/payout-method.service.ts
src/payouts-v2/payout-routing.service.ts
src/payouts-v2/payouts-v2.feature.ts
src/payouts-v2/payouts-v2.module.ts
src/payouts-v2/platform-fee.service.ts
src/payouts-v2/stripe-connect.provider.ts
test/payouts-v2.spec.ts
```

Findings:

- `src/checkout/checkout-webhook-handler.service.ts` is the expected additive checkout webhook delegation tweak.
- `src/app.module.ts` and `src/checkout/checkout.module.ts` are outside the brief's allowed scope list.
- `test/payouts-v2.spec.ts` is a root `test/` file, not under `src/payouts-v2/**/*.spec.ts` or co-located under `src/payouts-v2/` as specified by the gate.
- Migration directory is `20261215000000_payouts_v2_bank_payout_methods`; the gate specified `<timestamp>_bank_payouts_v2`.
- No edits were found under `src/community/**`, `src/dunning/**`, `src/entitlement/**`, or `src/ai/**`.

## Gate 3 — TypeScript clean

Status: **PASS WITH ENVIRONMENT NOTE**

Commands attempted / run:

```bash
pnpm tsc --noEmit
./node_modules/.bin/tsc --noEmit
```

Findings:

- `pnpm` was not installed in the environment.
- The audit worktree initially had no usable local `node_modules/.bin/tsc`.
- `npm ci` could not complete because the sandbox ran out of disk space (`ENOSPC`). The incomplete install was preserved outside the repo, and a symlink to an already-complete sibling dependency install was used for validation.
- With usable dependencies, `./node_modules/.bin/tsc --noEmit` returned exit code 0.

## Gate 4 — Test lane pass

Status: **FAIL / COMMAND-PATTERN MISMATCH**

Commands attempted / run:

```bash
pnpm jest src/payouts-v2 --runInBand
./node_modules/.bin/jest test/payouts-v2.spec.ts --runInBand
./node_modules/.bin/jest src/dunning --runInBand
./node_modules/.bin/jest src/entitlement --runInBand
./node_modules/.bin/jest test/dunning*.spec.ts --runInBand
./node_modules/.bin/jest test/entitlement*.spec.ts test/entitlements*.spec.ts --runInBand
```

Findings:

- `pnpm` was not installed.
- The exact `src/payouts-v2` Jest pattern found no tests because the new test file is `test/payouts-v2.spec.ts`, not under `src/payouts-v2`.
- Running the actual payouts-v2 test file passed: **37/37** tests passed.
- The exact `src/dunning` Jest pattern found no tests. Running the actual dunning test files passed: **127/127** tests passed, not the brief's expected 26/26 count.
- The exact `src/entitlement` Jest pattern found no tests. Running the actual entitlement test files passed: **39/39** tests passed, not the brief's expected 17/17 count.

## Gate 5 — Fee §2.7 worked examples

Status: **FAIL**

Files reviewed:

- `src/payouts-v2/platform-fee.service.ts`
- `test/payouts-v2.spec.ts`

Findings:

- Source implements:
  - `base = round(amount_cents * 0.02)`
  - `cardCost = round(amount_cents * 0.029) + 30`
  - `savings = max(0, cardCost - stripe_fee_cents)`
  - `platform_fee_cents = base + round(0.5 * savings)`
  - `coach_net_cents = amount_cents - platform_fee_cents - stripe_fee_cents`
- The code and tests assert `$1000 ACH` as `stripe_fee_cents = 500`, `platform_fee_cents = 3215`, `coach_net_cents = 96285`.
- The brief's explicit check states `cardCost = $33.00` and actual ACH cost `$0.80`, which yields `platformFee = $20.00 + 0.5 × ($33.00 − $0.80) = $36.10`, not `$32.15`.
- If the source formula is evaluated with the brief's stated inputs (`gross = 100000`, `cardCost = 3300`, `actual = 80`), the platform fee is `3610` cents and coach net would be `96310` cents under the source's net formula.
- Therefore the code/test `$32.15 / $962.85` assertion disagrees with the brief's required worked-example math. Per the brief, this is **DIRTY**.

## Gate 6 — Penny-absorb invariant

Status: **FAIL**

Files reviewed:

- `src/payouts-v2/platform-fee.service.ts`
- `test/payouts-v2.spec.ts`

Findings:

- `reconcileInternal()` keeps coach-visible fee/net equal to `compute()` and records `platform_absorbed_delta_cents = internal.platform_fee_cents - visible.platform_fee_cents`.
- A test asserts the platform absorbs a 1-cent internal delta (`3215` visible vs `3216` internal).
- The required invariant test `coachPayout + platformFee === gross` is not present.
- Existing worked-example tests assert `coach_net_cents = amount - platform_fee_cents - stripe_fee_cents`, so for the `$1000 ACH` case `96285 + 3215 = 99500`, not `100000`.
- I did not find a test covering several adversarial inputs for `coachPayout + platformFee === gross` to the cent.

## Gate 7 — Webhook signature reject

Status: **FAIL**

Files reviewed:

- `test/payouts-v2.spec.ts`
- `src/checkout/checkout-webhook-handler.service.ts`
- `src/billing/stripe-signature.ts` via imports used by the test

Findings:

- There is a test named `unverified payload throws (would yield 401) and leaves state unchanged`.
- That test directly calls `verifyStripeSignature()` with a bad signature and checks a local fake array remains unchanged.
- The test does not send a request to a webhook handler/controller, does not assert an actual HTTP `401` or `400` response, and does not cover a missing `Stripe-Signature` header.
- I did not find a Stripe Connect webhook handler test that rejects a missing/invalid signature with 401/400 and proves no handler-side DB mutation occurs.

## Gate 8 — Constructor-injection DI

Status: **FAIL**

Files reviewed:

- `src/payouts-v2/payout-method.service.ts`
- `src/payouts-v2/stripe-connect.provider.ts`
- `src/payouts-v2/payouts-v2.module.ts`
- `test/payouts-v2.spec.ts`

Findings:

- Stripe Connect abstraction is injected into `PayoutMethodService` via constructor using the `STRIPE_CONNECT` token.
- Unit tests instantiate `PayoutMethodService(prisma, stripe)` with a mock and assert the mock methods are called.
- I did not find inline `new Stripe(...)` or module-scope Stripe SDK instantiation in the new payouts-v2 code.
- No AWS S3 client injection exists in the payouts-v2 implementation. There are no `S3Client` references in `src/payouts-v2` or `test/payouts-v2.spec.ts`.
- Because the gate explicitly requires constructor-injection DI for both Stripe and AWS S3 clients with injectable mocks, this gate fails on the missing S3 side.

## Gate 9 — Feature flag OFF by default

Status: **FAIL**

Files reviewed:

- `.env.example`
- `src/payouts-v2/payout-method.controller.ts`
- `src/payouts-v2/payout-method.service.ts`
- `src/payouts-v2/payout-routing.service.ts`
- `test/payouts-v2.spec.ts`

Findings:

- `.env.example` has `FEATURE_BANK_PAYOUTS_V2=false`.
- `.env.example` has `FEATURE_STRIPE_TREASURY_PAYOUTS=false`.
- `PayoutMethodController.assertEnabled()` throws `ServiceUnavailableException` when `FEATURE_BANK_PAYOUTS_V2` is off.
- Services no-op while the flag is off, and tests assert service-level no-op behavior.
- I did not find a controller-level test asserting the routes return 503 / `BANK_PAYOUTS_V2_DISABLED` when the flag is off. The gate explicitly requires controller/service short-circuit behavior and a test assertion.

## Gate 10 — Dependency + migration + forbidden tokens

Status: **PASS WITH NAMING NOTE**

Commands / checks run:

```bash
node -e "const p=require('./package.json'); console.log(p.dependencies['@aws-sdk/client-s3'], p.devDependencies && p.devDependencies['@aws-sdk/client-s3'])"
grep -iE 'DROP |RENAME |ALTER COLUMN .* TYPE|TRUNCATE|DELETE FROM' prisma/migrations/*bank_payouts_v2*/migration.sql
grep -iE 'DROP |RENAME |ALTER COLUMN .* TYPE|TRUNCATE|DELETE FROM' prisma/migrations/20261215000000_payouts_v2_bank_payout_methods/migration.sql
git diff 9322eeb..HEAD -- 'src/**' | grep -iE '^\+.*(sonnet|claude-3|TODO\(audit\)|FIXME|XXX)'
```

Findings:

- `package.json` dependencies contain `"@aws-sdk/client-s3": "^3.1065.0"`.
- `package.json` devDependencies do not contain `@aws-sdk/client-s3`.
- `package-lock.json` root dependency is `^3.1065.0`; locked package version is `3.1065.0`.
- The brief's glob `prisma/migrations/*bank_payouts_v2*/migration.sql` does not match this PR's migration directory name.
- Running the destructive-pattern grep against the actual migration file returned zero matches.
- Migration operations are additive: `CREATE TYPE`, `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE ... ADD CONSTRAINT`.
- New-lines-only forbidden token scan over `src/**` found zero matches for `sonnet`, `claude-3`, `TODO(audit)`, `FIXME`, or `XXX`.

## Final verdict

**DIRTY**

Functional/security/scope blockers found:

1. Scope gate fails (`src/app.module.ts`, `src/checkout/checkout.module.ts`, root `test/payouts-v2.spec.ts`, and migration directory naming outside strict brief allowances).
2. §2.7 `$1000 ACH` math in source/tests disagrees with the brief's explicit `cardCost = $33.00`, `actual ACH = $0.80` worked calculation; source asserts `$32.15 / $962.85` instead of the brief-derived `$36.10` platform fee.
3. Penny-absorb invariant test `coachPayout + platformFee === gross` is missing; existing math asserts net excludes Stripe fee, so the sum is not gross.
4. Webhook signature reject coverage does not assert an actual 401/400 handler response and does not cover missing signature header.
5. AWS S3 constructor-injection/mocking requirement is missing.
6. Feature-flag controller 503 behavior lacks a direct test.
7. Requested Jest path commands do not locate tests in this repository layout; actual test files pass but counts differ from the brief.
