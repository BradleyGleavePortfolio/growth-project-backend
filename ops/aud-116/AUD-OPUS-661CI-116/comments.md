=== 5964409597
AUDIT Claude Opus 5.5 — growth-project-backend#661 @ 91625c86b54954875329d790ecb6af8c41cb9a11 — VERDICT: REQUEST CHANGES

Lens: AUD-OPUS-114B (operator agent 114). Tier: T4 (money-path credentials; the body says T4 and I agree). Full audit of the whole diff (9 files, one commit). This is the first verdict on #661.

**CI at head:** all 11 required checks are green, including npm audit. `mergeStateStatus` is BEHIND main, so the operator must update the branch before merge (strict).

### What is closed (C-646-1 / C-646-2, both lenses)
- **C-646-1 Opus/Sol, closed.** `ADMIN_PURCHASE_OMIT` (Prisma `omit`) is applied to `listPurchases` (payment-ops.controller.ts:146-156) and `getPurchase` (:168-171). It is also applied to `DunningService.getAdminView` (dunning.service.ts:691), which serves the admin view and every advance/reset/cancel/trigger response (dunning.service.ts:722/769/802/812/837).
  - I swept every other `clientPurchase.find*` that reaches HTTP: admin console, coach lists, `failedOnRoster`, client list, thank-you, `confirmSession`, invite-grant. Each one uses an allow-list `select` or does not return the row. The analytics/refund paths read raw rows internally only. No route returns the credential columns.
  - The structural guard test pins the omit to exactly the two columns.
- **C-646-2 Sol (redaction), closed.**
  - Credential keys and `*_secret` / `*ephemeral_key` keys are redacted in `redactObject` and in `redactLogLine`.
  - Free-text values are scrubbed: `pi_/seti_…_secret_…`, `ek_`, `sk_/rk_` live/test and `whsec_`. Ids such as `pi_…` stay readable.
  - The canary tests are honest.
- **C-646-2 Opus (credentials never cleared), closed for success, expiry and subscription end. NOT closed for decline-then-retry (B-661-1).**

### B-661-1 — decline then in-sheet retry: the client is charged, gets no access, and the secret is kept forever
- **Where:** checkout-webhook-handler.service.ts:905 (`applyPaymentIntentSucceeded`) and :450 (the prefetch). Both match only `{ stripe_payment_intent_id: pi.id, status: 'pending' }`.
- **The design premise does not hold.** This PR deliberately keeps credentials on `payment_failed` "(the client retries the same PaymentIntent)" (admin-purchase.select.ts:31-35, PR body). The replay branch (checkout.service.ts:525-536) returns the cached secret for a `payment_failed` row so that retry can happen.
- **What actually happens:**
  1. A PaymentSheet decline fires `payment_intent.payment_failed`, which flips the row to `payment_failed` (:1021).
  2. The client retries the same PI and it succeeds, either in the same sheet or through a replay of the key.
  3. `payment_intent.succeeded` finds no `pending` row and is ignored.
- **Result:**
  - The row stays `payment_failed` with `entitlement_active=false`.
  - The client paid and has no package.
  - The split is not posted.
  - The PaymentSheet credentials of a paid PaymentIntent stay at rest forever, which is exactly the C-646-2 defect this PR closes.
- **Probe:** `ops/aud-opus-114b/661-probe.spec.ts` (the existing spec harness plus one case) passes, which proves the behaviour: `claimed=false`, status `payment_failed`, entitlement false, secret kept. Run it with `/home/user/workspace/ops/heavy.sh npx jest test/zz-aud661-probe.spec.ts --runInBand -t "probe 661"` (1/1).
- **Scope:** the pre-existing match predates this PR. It is in scope here because this PR's credential lifecycle depends on it, and the native PaymentSheet is the mandated client path (OR-110-2).
- **Minimal fix:**
  - Widen both matches to `status: { in: ['pending', 'payment_failed'] }` (the payment_failed handler already sets `stripe_payment_intent_id`).
  - Clear `last_error` as it does now.
  - Add a test: failed, then succeeded on the same PI, ends `paid`, entitled, credentials null, split deferred.
- **Optional:** consider the same for the dunning/`past_due` one-time case if any exists.

### C findings
- **C-661-2 (operator/owner decision):** rows already finished on production keep their cached credentials until the backfill in the PR body runs. Recommended default: run it in the deploy window after merge (`WHERE status NOT IN ('pending','payment_failed')`). It is a data change, so it is the operator's call.
- **C-661-3 (composition with #654):**
  - #654 edits the same `applySubscriptionDeleted` data block (textual conflict; whoever merges second must keep `...CLEARED_PAYMENT_SECRETS` in both branches).
  - #654 stores a subscription's first-invoice/SetupIntent secret on the row. Its activation path (invoice.paid → active/trialing) does not clear it. The promotion trigger in this body covers this; the #654 lane should apply `CLEARED_PAYMENT_SECRETS` on activation.
- **C-661-4:**
  - The new 409 copy for `refunded` / `disputed` / `chargeback_lost` says "This checkout has closed. Start again from the package page to buy it." That is wrong for a disputed purchase that may still be entitled. Mapping only `expired` / `canceled` to CHECKOUT_CLOSED, and a short "This payment was refunded or is under review…" for the others, would be more precise.
  - Separately, a loser polling in `waitForReservedSecret` while the success webhook clears the secret still times out at 5 s into `PAYMENT_IN_PROGRESS`. Rare.
  - Mobile main does not call `/v1/checkout/payment-intent` yet. The native PaymentSheet PRs must map `PAYMENT_ALREADY_COMPLETE` / `PAYMENT_CHECKOUT_CLOSED` to specific copy.

**Counts:** A0 / B1 / C3. APPROVE once B-661-1 is closed with code and the failing-before test.

=== 5964395750
AUDIT GPT-6.1 Sol — growth-project-backend#661 @ 91625c86b54954875329d790ecb6af8c41cb9a11 — VERDICT: REQUEST CHANGES

Independent full T4 audit; **A/B/C 0/2/0**. The nine-file candidate diff, complete PR discussion and #646 audit/fix-round history were read; this lens did not implement the change. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661), [prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/646#issuecomment-5961990003).

### Prior finding dispositions

This lens's **C-646-1 closes** on the owner/admin purchase list, detail and dunning view/actions: the real Prisma reads omit both cached credential columns and the new response canary tests retain useful Stripe identifiers; **C-646-2 closes** for the requested stored-key, suffix-key and Stripe-value log redaction surfaces, with the new tests covering both object and serialized/free-text paths. [Candidate changes and acceptance tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

The other lens's at-rest C-646-2 is only partially addressed: three webhook transitions erase credentials, while the PR explicitly leaves historic rows and PaymentIntent cancellation reconciliation out of scope; no production backfill was performed or assumed by this audit. [Candidate contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

### B-661-1 — terminal rows with retained credentials still return them before the status fence

`src/checkout/checkout.service.ts:524–541` checks `existing.stripe_client_secret` and immediately returns both credentials **before** the newly added finished-status check; the stated historic finished rows therefore remain resumable through this API rather than receiving the promised 409, even without authorizing a backfill. Independent real-service synthetic probes for `paid` and `canceled` rows both resolve with `client_secret` and `ephemeral_key` instead of rejecting. [Candidate replay implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

**Minimal fix:** classify terminal status before every cached-secret return, allowing the intended `pending` and retryable `payment_failed` cases; do not make read-path safety contingent on a production cleanup. Add paid/canceled/expired-with-secrets regressions and a failed-payment-resume positive control. [Candidate replay contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

### B-661-2 — race-loser replay still waits for an erased secret and reports “in progress” after payment completion

The new terminal classification is only in the initial pre-read; `src/checkout/checkout.service.ts:627–655,739–756` handles a P2002 loser by polling exclusively for a secret, without checking status, then emits 503 `PAYMENT_IN_PROGRESS` for a non-null completed row. If the winner's payment finishes while the loser is reaching this branch, this PR's new webhook erasure makes the secret permanently unavailable, so the loser waits the full five seconds and tells the client an already completed/closed payment is still processing. The independent poll probe reproduces the missing terminal classification; the source confirms the resulting caller response. [Candidate idempotency and erasure changes](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

**Minimal fix:** apply the same terminal classifier to each poll answer and the race-loser return branch before checking credentials, terminating immediately with `PAYMENT_ALREADY_COMPLETE` or `PAYMENT_CHECKOUT_CLOSED`; preserve absent-reservation retry and pending-secret publication. Add a deterministic P2002 + webhook-settlement interleaving test, not only the existing nonconcurrent replay tests. [Candidate concurrent checkout contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

### Evidence and limits

`ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/b-secrets-3-admin-credentials.spec.ts test/checkout-webhook-handler.spec.ts test/checkout.service.spec.ts` passed **3 suites / 69 tests**; a separate external audit-only config running the real CheckoutService against synthetic rows produced **3 expected failures** (two credential replay cases and terminal polling). Private Prisma generation and `git diff --check` passed; no candidate source edits or real Stripe/database calls were made. [Reviewed source/test scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

All eleven mandatory exact-head backend checks are SUCCESS, including npm audit, schema parity and community-live-tests; green CI does not exercise the two boundaries above. The PR correctly states T4 and has a fix-round table; native mobile mapping of the new codes, historic cleanup and canceled-intent handling remain explicitly separate integration/operator work, not claims certified here. [Exact-head checks and body](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661).

=== 5972088040
FIX ROUND 2 (B-FEE-9, agent 115) — growth-project-backend#661 @ f4679fd8e287e5bcd6c0dc8da69c208786f79802

Folds both lenses at `91625c86`: Sol REQUEST CHANGES (comment 5964395750, A/B/C 0/2/0) and Opus REQUEST CHANGES (comment 5964409597, A/B/C 0/1/3). Round 1 is the original build at `91625c86`. Merged origin/main `d27cd3ec` with merge commit `7a4ffaab` (automatic; `checkout.service.ts` auto-merged). Fix commit: `f4679fd8`.

### Design

One classifier, `classifyPaymentReplay(row)`, is applied to every read of a payment-intent reservation row (the pre-read, each poll answer and the race-loser branch), always **before** any cached credential is returned:

- status other than `pending` / `payment_failed` -> the specific 409, whatever credentials the row still holds (so read-path safety does not depend on the C-661-2 backfill);
- `pending` / `payment_failed` with published credentials -> resume (the client retries the same PaymentIntent);
- `pending` without credentials -> wait (the winner is still publishing);
- `payment_failed` without credentials -> 409 `PAYMENT_CHECKOUT_CLOSED` (nothing can resume it).

`payment_intent.succeeded` and its out-of-tx charge-id prefetch now claim `status in (pending, payment_failed)`: a PaymentIntent that succeeded is terminal, so its success wins over an earlier decline of the same PaymentIntent.

### Findings

| Finding | Change | Commit | Failing-before (tests only on `7a4ffaab`) -> after |
|---|---|---|---|
| B-661-1 (Sol): finished rows with retained credentials return them before the status fence | Pre-read classifies the status first | f4679fd8 | `test/checkout.service.spec.ts` "B-661-1: a %s row that still holds its credentials answers %s and returns no credential" for paid, active, canceled, expired, refunded, disputed, chargeback_lost — all 7 red in [run 37142770301](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142770301); green at head. Positive control "a failed payment that holds its credentials resumes the same PaymentIntent" passes both ways |
| B-661-2 (Sol) + C-661-4 second half (Opus): race loser waits for an erased secret and answers `PAYMENT_IN_PROGRESS` | `waitForReservedSecret` returns as soon as the row is settled for a replay (credentials or a finished status); the loser branch classifies before any credential | f4679fd8 | `B-661-2 race loser vs webhook settlement`: deterministic P2002 + webhook-settlement interleaving ("the payment settles and its credentials are erased while the loser polls: 409 PAYMENT_ALREADY_COMPLETE at once, never PAYMENT_IN_PROGRESS", answered in < 2 s) and "a finished row that still holds credentials is never returned to the loser" — both red in run 37142770301; "(control) the winner publishes its credentials while the loser polls" passes both ways |
| B-661-1 (Opus): decline then in-sheet retry of the same PaymentIntent is ignored (charged, not entitled, credentials kept) | `payment_intent.succeeded` + prefetch match `pending` or `payment_failed` | f4679fd8 | `test/checkout-webhook-handler.spec.ts` "B-661-1 decline, then a successful retry ... ends paid and entitled, erases the credentials and defers the split with the charge id" — red in run 37142770301; "(control) a paid row is not claimed again by a redelivered success" passes both ways |
| C-661-4 (Opus): "This checkout has closed" for refunded / disputed | New 409 `PAYMENT_REFUNDED_OR_IN_REVIEW`: "This payment was refunded or is under review, so it cannot be paid again here. Its status is on the purchase in your account." | f4679fd8 | "C-661-4: a refunded or disputed payment is not called closed" — red in run 37142770301 |
| C-661-2 (Opus, operator decision): historic finished rows keep credentials until a backfill | No data change. Since this round the replay API never returns them (status first). Recommended default stands: run the backfill in the deploy window after merge | - | covered by the B-661-1 tests above |
| C-661-3 (Opus): composition with #654 | No code here (#654 is open). Recorded under Promotion triggers: whichever merges second keeps `...CLEARED_PAYMENT_SECRETS` in `applySubscriptionDeleted` and on #654's activation path | - | - |

Run 37142770301 (one-job ci-lane, `ci/B-FEE-9-661-before`, src identical to `7a4ffaab`): **11 failed, 75 passed** across `test/checkout.service.spec.ts`, `test/checkout-webhook-handler.spec.ts`, `test/purchase-fanout-hooks.spec.ts`, `test/purchase-fanout-tx-plumbing.spec.ts`.

Test fakes: the `clientPurchase.findFirst` stubs in `test/checkout-webhook-handler.spec.ts`, `test/purchase-fanout-hooks.spec.ts` and `test/purchase-fanout-tx-plumbing.spec.ts` now understand `{ in: [...] }` (the status match the handler uses). No assertion was removed or loosened.

### Checks

- After: PR CI at `f4679fd8`: all 11 required checks SUCCESS (build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, npm audit, CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity, community-live-tests); full jest suite in [CI run 37142812625](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142812625).
- Local, one spec at a time through `ops/heavy.sh`: `test/checkout.service.spec.ts` 42/42, `test/checkout-webhook-handler.spec.ts` 35/35.
- ESLint on the 6 changed files: clean. No banned token added. No schema, migration, env, workflow or lockfile change. Copy: no "we/us/our", no "!".
- Not changed (pre-existing, outside these findings): `payment_intent.payment_failed` still flips any row matched by its PaymentIntent id, so an out-of-order delivery (failed after succeeded) is unchanged by this PR.

Operator: C-661-2 backfill decision (recommended: run it in the deploy window after merge). Mobile must map `PAYMENT_ALREADY_COMPLETE`, `PAYMENT_CHECKOUT_CLOSED` and `PAYMENT_REFUNDED_OR_IN_REVIEW` when the native PaymentSheet lands.

READY FOR AUDIT

=== 5972103999
AUDIT GPT-6.1 Sol — growth-project-backend#661 @ f4679fd8e287e5bcd6c0dc8da69c208786f79802 — VERDICT: REQUEST CHANGES

Independent **T4** delta from this lens's `91625c86` verdict; **A/B/C 0/1/0**. Complete prior AUDIT history, body and all 598 lines of own round-2 source/tests were read; the inherited main merge `7a4ffaab` reproduces automatic committed tree `38f67ebceb9bbf910df38ae3aceb7f9ea6084b65`. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5964395750) [Current candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/f4679fd8e287e5bcd6c0dc8da69c208786f79802)

### Prior findings first

**Sol B-661-1/2 close at their reported boundaries:** one classifier now runs before every credential return, each poll answer and the race-loser result; terminal rows with retained historic credentials get their specific 409, and a settled race winner no longer waits for an erased secret and reports in-progress. Pending/failed-with-credentials resume controls remain intact. [Classifier and replay callsites](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f4679fd8e287e5bcd6c0dc8da69c208786f79802/src/checkout/checkout.service.ts) [Executed targeted controls/probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143378240)

**Opus B-661-1's reported failed→successful in-sheet retry boundary closes:** both prefetch and success handling now admit the same `payment_failed` PaymentIntent, grant entitlement, clear credentials and defer the split with its charge ID; Opus C-661-4's refunded/disputed copy also improves with its dedicated code. The remaining event-order boundary below is not denial of that repair. [Success/prefetch implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f4679fd8e287e5bcd6c0dc8da69c208786f79802/src/checkout/checkout-webhook-handler.service.ts) [Prior Opus finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5964409597) [Executed controls/probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143378240)

### B-661-3 — delayed earlier decline revokes a successfully retried payment

**Outside the edited hunk, but unsafe for this PR's explicit decline→retry lifecycle:** `src/checkout/checkout-webhook-handler.service.ts:987–990,1028–1042` matches the PaymentIntent without a status fence, then unconditionally writes `payment_failed` and `entitlement_active=false`; it can still overwrite the success this new `PI_SUCCEEDED_CLAIMABLE` contract promises wins. The builder explicitly identifies this residual as unchanged, not as a closed ordering guarantee. [Failure handler](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f4679fd8e287e5bcd6c0dc8da69c208786f79802/src/checkout/checkout-webhook-handler.service.ts#L987-L1044) [New success contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f4679fd8e287e5bcd6c0dc8da69c208786f79802/src/checkout/checkout-webhook-handler.service.ts#L17-L22) [Disclosed residual](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972088040)

The independent actual-handler probe starts with a failed purchase, processes its successful retry (observing `paid`, entitled and cleared credentials), then delivers the distinct earlier decline event late. The paid purchase becomes **payment_failed / unentitled**, while both credentials stay erased. The acceptance assertion fails; **93 controls pass** across five targeted suites, including the repaired pre-read/poll/decline→success cases and credential/redaction/fanout tests. [Executed event-order counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143378240)

With the new replay classifier, this regressed failed row without credentials now returns checkout-closed rather than the successful purchase; the client paid but loses both access and a meaningful completion answer. Event-ID deduplication does not solve different-event ordering. [Replay classifier](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f4679fd8e287e5bcd6c0dc8da69c208786f79802/src/checkout/checkout.service.ts#L118-L151) [Executed paid→failed regression](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143378240)

**Fix rule:** make success monotonic for this PaymentIntent: an old decline must not regress an already-paid/terminal purchase or revoke successful-retry access. Fence failure updates on still-claimable state/PaymentIntent and recheck at write time, or establish canonical provider authority before any legitimate override; preserve real unpaid failures and separate recurring invoice dunning. Add failed→succeeded→delayed-old-failure plus concurrent success/failure and ordinary decline controls.

### Evidence / boundaries

Earlier admin credential omit and log-redaction closures remain intact. Operator-owned historic credential cleanup and #654 activation/deletion composition still require their previously named owner/integration work; no production backfill, provider action, candidate-branch edit or local heavy work was performed by this lens. [Prior dispositions and boundaries](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5964395750) [Candidate lifecycle/composition contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661)

All **11 required exact-head checks are SUCCESS**, and FIX ROUND 2 explicitly ends READY FOR AUDIT at this full SHA; the builder's behavioral failing-before run reports 11 failed / 75 controls passing, and the independent current-head run passes the repaired boundaries but fails the delayed-decline ordering above. [Exact-head FIX/READY and failing-before evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972088040) [Candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142812625/job/111260578510) [Independent current-head probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143378240)

=== 5976010436
FIX ROUND 3 (B-661-116, agent 116) — growth-project-backend#661 @ a193d7e17b2d4daeb944891191824d08e280b437

Folds Sol REQUEST CHANGES at `f4679fd8` (comment 5972103999, A/B/C 0/1/0: B-661-3) and every open C from Opus at `91625c86` (comment 5964409597). Opus has no verdict since `91625c86`, so this head needs a full Opus audit as well as the Sol delta. Commits: `fcf0d4c3` (tests only, failing before), `57fa2402` (fix), `a193d7e1` (merge of origin/main `d23fa317`; automatic, no conflicts; main touched none of this PR's 12 files).

### Design (B-661-3)

`applyPaymentIntentFailed` now sorts the purchase a decline names into three classes before it writes anything:

- **May still fail** (`pending`, `payment_failed`): compare-and-set `updateMany where { id, status in (pending, payment_failed) }`. A success of the same PaymentIntent that commits first makes the count 0 (Postgres re-checks the predicate once the row lock is released). The handler then re-reads the purchase and judges its new state as below. So success is monotonic.
- **Final, owned by its own events** (`canceled`, `expired`, `refunded`, `disputed`, `chargeback_lost`): never rewritten (`reason: 'already_final'`). No Stripe call.
- **Settled** (any other status: `paid`, `active`, `past_due`, `trialing`, ...): the decline is either a late delivery of an earlier attempt or a real failure of a payment that was still processing (for example a hosted checkout that completed while an asynchronous payment was processing). Only Stripe's current PaymentIntent status can tell them apart, so it decides. `requires_payment_method` / `canceled` = the payment did not complete: `payment_failed`, access ends, drops are canceled. This keeps real asynchronous failures. Any other status (`succeeded`, `processing`, `requires_action`, ...) = no-op (`reason: 'stale_failure'`). The write is a compare-and-set on the status that was judged.
- **Where the status comes from:** `prefetchForOuterTx` reads it out of the webhook tx, only when the matched purchase is settled. A decline of a pending purchase costs no Stripe call. There is never Stripe HTTP inside the DB tx. The no-tx legacy path asks Stripe inline.
- **When the decline cannot be judged now** (the status is missing inside the tx, a compare-and-set loses a race, or the Stripe lookup fails): 503 `PAYMENT_FAILURE_RETRY`. BillingService rolls the tx back (dedup row included) and Stripe redelivers. The next delivery prefetches the status again. Nothing is written before the throw.
- **Metadata fallback** (no purchase holds this PaymentIntent): it adopts only a pending purchase with **no** PaymentIntent (`stripe_payment_intent_id: null`, a hosted checkout before completion), through a compare-and-set. Before, it took the newest pending purchase for the package and client, including an open PaymentSheet purchase that holds its own PaymentIntent. It then overwrote that purchase's PaymentIntent id, so the sheet payment's later success could never find its purchase. This is the same class as B-661-3 (a decline regresses a purchase it does not own).
- **Logs:** new log lines carry ids plus an HTTP status and Stripe error code only, never error messages or Stripe text.

### Findings

| Finding | Change | Commit | Failing-before (tests only on `f4679fd8` src) -> after |
|---|---|---|---|
| B-661-3 (Sol): a late-delivered earlier decline flips a paid, successfully retried purchase to `payment_failed` and drops access | The three-class fence above. Prefetch of the PaymentIntent status out of the tx. 503 + redelivery when the status is unknown or the purchase moved. Metadata fallback limited to purchases with no PaymentIntent. | 57fa2402 | `test/checkout-webhook-handler.spec.ts` › `B-661-3 a late-delivered earlier decline never revokes a successful retry`. **Red before (12):** "failed, then succeeded, then an earlier decline arrives late: the purchase stays paid and entitled"; "the same late decline on the no-transaction path ..."; "Stripe cannot confirm the PaymentIntent status: the webhook transaction throws ... untouched" (also asserts no Stripe call inside the tx); "a success that commits between the decline reading the purchase and writing it wins; the redelivered decline is a no-op" (deterministic interleaving); "a decline never rewrites a purchase in status %s" × refunded / disputed / chargeback_lost / canceled / expired; "a decline of another PaymentIntent never adopts a pending purchase that holds its own PaymentIntent"; "the metadata fallback adopts the pending purchase without a PaymentIntent, never a newer one that holds its own"; "prefetchForOuterTx asks Stripe for the PaymentIntent status only when the purchase already settled". **Controls, pass both ways (3):** "(control) an ordinary decline of a pending purchase is applied and keeps the credentials for the retry" (no Stripe call); "(control) a real failure after the purchase settled (Stripe says the PaymentIntent is requires_payment_method / canceled) still ends access". `test/cancel-pending-on-refund.spec.ts`: **red before:** "B-661-3: does NOT cancel drops when the late decline names a PaymentIntent that succeeded". The existing "DOES cancel drops when a previously-entitled purchase later fails (defensive)" now delivers through the prefetch with Stripe status `requires_payment_method` and still asserts the cancel; it passes both ways. Failing-before: [run 37171991379](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171991379) (one-job ci-lane, `ci/B-661-116-661-before` = `fcf0d4c3`): **13 failed, 50 passed**. After: green at this head (below) |
| C-661-2 (Opus, operator decision): historic finished rows keep credentials until a backfill | No data change. The replay API has not returned them since round 2. Recommended default: run in the deploy window after merge: `UPDATE "ClientPurchase" SET stripe_client_secret = NULL, stripe_ephemeral_key = NULL WHERE status NOT IN ('pending','payment_failed')` | - | covered by round 2's B-661-1 replay tests |
| C-661-3 (Opus): composition with #654 | No code here (#654 is split into #678 -> #679 -> #680, which are open). The body's Promotion triggers now name the split: whichever of #661 / the #678-#680 stack merges second keeps `...CLEARED_PAYMENT_SECRETS` in both branches of `applySubscriptionDeleted` and on the stack's activation path. New in this round: #680 adds a recurring-subscription early return in `applyPaymentIntentFailed` right after the metadata fallback. Whichever merges second keeps it before the B-661-3 status fence. | - | - |

Test fakes: `clientPurchase.updateMany` was added to the in-memory stubs of both specs. It honours equality, `null` and `{ in: [...] }` predicates and returns the real count. The `findFirst` stub's matcher was extracted unchanged into `matchesWhere`. No assertion was removed or loosened.

### Checks

- PR CI at `a193d7e1`: all 11 required checks SUCCESS (build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, npm audit, CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity, community-live-tests). Full jest suite in [CI run 37172411659](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172411659): 714 suites passed, 12,352 tests passed, including both changed specs.
- Local, targeted through `ops/heavy.sh`: `checkout-webhook-handler` + `cancel-pending-on-refund` 63/63; with `checkout.service`, `purchase-fanout-hooks`, `purchase-fanout-tx-plumbing` 114/114; `checkout-webhook-fee-split`, `billing-checkout-routing`, `pr14-guest-recurring-dispatcher-integration`, `first-payment-webhook.integration`, `b-secrets-3-admin-credentials` all pass.
- ESLint clean on the changed source and the webhook spec. The one `no-useless-catch` in `cancel-pending-on-refund.spec.ts` predates this PR, in a line not touched. R75 (range vs main): `as any` net -1, `as unknown as` net 0. No schema, migration, env, workflow or lockfile change. Diff vs main: 12 files, +1343 / -103.
- Pre-push checklist: (a) no free text reaches logs (ids + codes); (b) every write after an await is a compare-and-set on id + status; (c) the success/decline interleaving is covered by a deterministic test; (d) the new copy has no first person and no exclamation marks; it is not client-facing (webhook 503 body); (e) failing-before as above; (f) under 1,500 lines.

Operator: C-661-2 backfill (recommended: run it in the deploy window after merge). Mobile (#342-#344) must map `PAYMENT_ALREADY_COMPLETE`, `PAYMENT_CHECKOUT_CLOSED` and `PAYMENT_REFUNDED_OR_IN_REVIEW` when the native PaymentSheet lands.

READY FOR AUDIT

