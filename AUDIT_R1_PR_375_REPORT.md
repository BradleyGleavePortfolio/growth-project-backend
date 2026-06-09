# R1 Audit Report — PR #375 B5 Digital Contracts + HelloSign Embedded

Auditor: GPT-5.5 R1 auditor  
Repo/worktree: `BradleyGleavePortfolio/growth-project-backend` / `backend-b5-audit`  
Head reviewed: `3f35447e54ecd56d66ae5209c8bd0b85a02c06e2`  
Base: `9322eeb`  
Audit branch: `audit/r1-pr-375`

## Verdict

**DIRTY** — several gates fail, including operator-critical launch posture items (`.env.example` hard-off default missing), exact scope boundaries, contract-template source/disclaimer requirements, migration safety grep, RLS readiness, and HelloSign verification/spec mismatches.

## Gate 1 — Commit hygiene

**Status: PASS**

Command run:

```bash
git log --format='%H%n%an <%ae>%n%B%n---' 9322eeb..HEAD
```

Findings:
- 8 commits present.
- Every commit author is `Dynasia G <dynasia@trygrowthproject.com>`.
- Commit messages are title-only; no bodies, emoji, `Co-Authored-By`, `Generated with`, or bot trailers found.

## Gate 2 — Scope boundaries

**Status: FAIL**

Command run:

```bash
git diff --name-only 9322eeb..HEAD
```

Changed files outside the allowed scope list:

```text
scripts/gen-b5-seed-migration.ts
scripts/patch-lock-dropbox-sign.py
src/notifications/notification-kind.ts
test/checkout-buyer-drops.spec.ts
test/checkout.service.spec.ts
```

Additional notes:
- No edits were found under explicitly forbidden directories `src/community/**`, `src/dunning/**`, `src/entitlement/**`, `src/payouts-v2/**`, or `src/ai/**`.
- `src/checkout/**` changes are present and appear to be the checkout hook/module wiring, but the extra `src/notifications/**`, `scripts/**`, and non-contract checkout test changes violate the brief's allowlist.

## Gate 3 — TypeScript clean

**Status: PASS**

Commands run:

```bash
npm ci
./node_modules/.bin/tsc --noEmit
```

Result:
- `npm ci` completed and generated Prisma Client `v6.19.3`.
- `./node_modules/.bin/tsc --noEmit` exited 0.

## Gate 4 — Test lanes pass

**Status: FAIL / MIXED**

Required command results:

```bash
./node_modules/.bin/jest test/contracts --runInBand
```

Result: **PASS** — 4 suites, **31/31 tests passed**.

```bash
./node_modules/.bin/jest src/dunning --runInBand
./node_modules/.bin/jest src/entitlement --runInBand
./node_modules/.bin/jest src/checkout --runInBand
```

Result: **FAIL** — each exact required command exited 1 with `No tests found` because this repo's matching tests live under `test/...`, not those `src/...` paths.

Fallback verification commands run:

```bash
./node_modules/.bin/jest test/dunning --runInBand
./node_modules/.bin/jest test/entitlement test/entitlements --runInBand
./node_modules/.bin/jest test/checkout --runInBand
```

Fallback results:
- Dunning fallback: **PASS** — 6 suites, **127/127 tests passed**.
- Entitlement fallback: **PASS** — 2 suites, **39/39 tests passed**.
- Checkout fallback: **PASS** — 7 suites, **131/131 tests passed**.

Gate assessment:
- Contract and checkout pass counts satisfy the brief's expected contract/checkout counts when using actual repo test paths.
- The exact required dunning/entitlement/checkout lane commands fail, so this gate is not clean as written.

## Gate 5 — `FEATURE_CONTRACTS_ENABLED` hard-off invariant

**Status: FAIL**

Critical finding:
- `.env.example` does **not** contain `FEATURE_CONTRACTS_ENABLED=false`.
- `.env.example` also does **not** contain HelloSign-related keys.
- This directly fails the brief's hard requirement that `.env.example` set `FEATURE_CONTRACTS_ENABLED=false`.

Server-side implementation checks:
- `src/contracts/contract-envelope.service.ts` has `assertContractsEnabled()` and `createEnvelope()` calls it before DB/provider work.
- `applyProviderEvent()` returns `{ applied: false, reason: 'disabled' }` before DB lookup/mutation when the flag is off.
- `src/contracts/webhooks/hellosign-webhook.controller.ts` verifies the webhook first, then returns the required ACK without applying state when the flag is off.
- `src/contracts/checkout-contract-gate.service.ts` returns `{ ok: true, reason: 'contracts_disabled' }` when the flag is off.

Test names found for the invariant:
- `createEnvelope THROWS ServiceUnavailable when the flag is OFF (no envelope ever sent)`
- `applyProviderEvent refuses to mutate state when the flag is OFF`
- `verified but flag OFF → 200-acks WITHOUT mutating state (invariant)`
- `is a pure no-op when FEATURE_CONTRACTS_ENABLED is OFF`

Assessment:
- The server-side OFF behavior is implemented and test-covered.
- The gate still fails because the operator-mandated `.env.example` hard-off default is absent.

## Gate 6 — HelloSign Embedded provider implementation

**Status: FAIL**

Passing checks:
- `@dropbox/sign` is in `dependencies` as `^1.8.0`, not `devDependencies`.
- Provider abstraction exists in `src/contracts/providers/signature-provider.interface.ts`.
- Implementations exist:
  - `HelloSignProvider` real implementation.
  - `DocuSignProvider` NotImplemented stub.
  - `NativeCanvasProvider` NotImplemented stub.
- Invalid-signature reject tests exist:
  - `REJECTS a tampered event_hash`
  - `REJECTS when the signed message is mutated after signing (event_type swap)`
  - `rejects an UNVERIFIED webhook with 401 and never advances state`

Failing/spec-mismatch checks:
- The brief requires HMAC SHA-256 verification over the payload with `api_key`; implementation computes HMAC over `${eventTime}${eventType}` from parsed fields, not the raw payload bytes.
- `ProviderWebhookRequest.rawBody` comments say verification is byte-exact where possible, but `HelloSignProvider.verifyWebhook()` does not use `rawBody` for the HMAC.
- The brief asks to confirm `createEmbeddedSignUrl` exists; the code uses a private `embedUrlForSignature()` wrapper around Dropbox `EmbeddedApi.embeddedSignUrl()`, but no method named `createEmbeddedSignUrl` exists.
- No embed URL logging was found in the inspected provider/service paths.

Assessment:
- The reject path is covered, and it may align with HelloSign's legacy `event_hash` scheme, but it does not match the audit brief's “over payload” requirement.

## Gate 7 — Two-layer gate (TGP↔Client waiver + Coach↔Client per-package)

**Status: PASS WITH NAMING/INTEGRATION NOTES**

Passing checks:
- Layer 1 platform waiver is evaluated first in `CheckoutContractGate.evaluate()`.
- Layer 2 is gated per package after Layer 1 clears.
- Checkout service runs the contract gate before Stripe calls in both hosted Checkout Session and PaymentIntent paths.
- Test names found:
  - `Layer 1 first: blocks on the platform waiver before ever looking at the coach contract`
  - `platform signed + no coach contract required → ok (no_contract_required)`
  - `platform signed but coach contract required + unsigned → blocks on coach layer`
  - `both layers signed → ok (all_signed) carrying the coach envelope id for purchase linkage`

Notes:
- The brief names the per-package opt-in as `CoachPackage.contract_required`; implementation uses `CoachPackage.requires_contract`.
- `createPaymentIntentForClient()` binds `contract_envelope_id` to the reserved purchase when the signed coach envelope exists.
- `createCheckoutForClient()` runs the gate but does not carry the signed coach envelope id into the hosted-checkout `ClientPurchase` create/upsert path. This is outside the explicit gate wording but is a purchase-linkage inconsistency worth fixing.

## Gate 8 — 4 contract drafts present + sourced

**Status: FAIL**

Files present:
- `src/contracts/templates/seed/platform-waiver-v1.md`
- `src/contracts/templates/seed/standard-coaching-v1.md`
- `src/contracts/templates/seed/group-program-v1.md`
- `src/contracts/templates/seed/course-purchase-v1.md`

Frontmatter source URL counts found:
- `platform-waiver-v1.md`: **7** URLs (brief expected 8)
- `standard-coaching-v1.md`: **6** URLs
- `group-program-v1.md`: **6** URLs
- `course-purchase-v1.md`: **8** URLs

Disclaimer check:
- Template frontmatter disclaimer text: `Draft wording prepared by an automated agent WITHOUT licensed legal review. FEATURE_CONTRACTS_ENABLED MUST remain OFF in production until reviewed by counsel.`
- Seed migration header text: `Draft wording prepared by agent without licensed legal review. FEATURE_CONTRACTS_ENABLED MUST remain OFF in prod until reviewed by counsel.`
- The seed migration header is not verbatim relative to the template disclaimer wording.

Assessment:
- All four templates have at least 5 cited URLs, but the platform waiver misses the brief's expected count of 8 and the migration disclaimer is not verbatim.

## Gate 9 — Migration shape

**Status: FAIL**

Commands run:

```bash
git show origin/main:prisma/schema.prisma > /home/user/workspace/prisma_base_pr375.schema.prisma
./node_modules/.bin/prisma migrate diff --from-schema-datamodel /home/user/workspace/prisma_base_pr375.schema.prisma --to-schema-datamodel prisma/schema.prisma --script
```

Diff shape result:
- Only allowed shapes appeared in the generated diff: `CREATE TYPE`, `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT`.

Required destructive-pattern grep:

```bash
grep -iE 'DROP |RENAME |ALTER COLUMN .* TYPE|TRUNCATE|DELETE FROM' prisma/migrations/2026121500000*_b5*/migration.sql prisma/migrations/2026121500010*_seed_b5*/migration.sql
```

Result:

```text
prisma/migrations/20261215000000_b5_digital_contracts/migration.sql:-- ADDITIVE-ONLY migration. ZERO DROP / RENAME / ALTER COLUMN TYPE.
```

Assessment:
- No destructive SQL statements were found in executable migration SQL, but the exact required grep does not return zero because the migration comment contains the forbidden terms.
- Seed migration is idempotent via repeated `ON CONFLICT ("id") DO NOTHING` guards.

## Gate 10 — Forbidden tokens + sub-coach RLS readiness

**Status: FAIL**

Forbidden-token command run:

```bash
git diff 9322eeb..HEAD -- 'src/**' 'test/**' | grep -iE '^\+.*\b(sonnet|claude-3|TODO\(audit\)|FIXME|XXX)\b' || true
```

Result:
- No forbidden new-line tokens found.

RLS readiness result:
- No `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, or contract-table policy SQL found in the B5 migrations.
- No changed B5 source/migration Phase B follow-up note for contracts RLS was found.

Assessment:
- Forbidden-token scan passes.
- RLS readiness fails because the contract tables have neither enforced RLS policies nor a documented Phase B follow-up in the changed B5 area.

## Additional high-signal observations

1. `.env.example` is entirely missing the B5/HelloSign additions despite the brief explicitly allowing and requiring them.
2. `src/contracts/contracts.feature.ts` defaults contracts ON in `development` and `test` when unset; production/unknown defaults OFF. That is acceptable for local tests but increases the importance of checking in `.env.example` with `FEATURE_CONTRACTS_ENABLED=false`.
3. Hosted checkout and PaymentIntent paths diverge on `contract_envelope_id` purchase linkage: PaymentIntent writes it, hosted checkout does not.
4. The reportable failures are not cosmetic; at least Gate 2, Gate 5, Gate 6, Gate 8, Gate 9, and Gate 10 require code or migration/report changes before this PR can be clean.

Final verdict: **DIRTY**
