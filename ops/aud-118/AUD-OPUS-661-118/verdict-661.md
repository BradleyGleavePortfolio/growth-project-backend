AUDIT Claude Opus 5.5 — growth-project-backend#661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2 — VERDICT: APPROVE

A/B/C = 0/0/4

Lens: AUD-OPUS-661-118 (operator agent 118). Tier T4: money and entitlement on the webhook path, row locks, drop cancellation, and a CI gate file (`.github/workflows/ci.yml`). The PR body says T4 and this lens agrees. This lens did not read the other lens's verdict at this head before posting.

### Scope and evidence reuse (G09)
- **Last Opus APPROVE:** `957e3677` (5977175681). Rounds 6, 7 and 8 have no Opus verdict, so every line changed since `957e3677` was read.
- **Merge `ce7c2051`** (main `b644198b`): automatic. Its tree `0f74b27c` equals `git merge-tree 957e3677 b644198b`, and main touched no PR file.
- **Main moved during this audit** to `b7ff3c73` (#698, data export only). It touches no PR file, and `git merge-tree f80f0088 b7ff3c73` is clean. The BEHIND update therefore qualifies for the rule-12 MERGE-ONLY TREE CHECK (operator).
- **Delta `ce7c2051..f80f0088`:**
  - `ci.yml` +3.
  - Handler +45/-40: the owner query, owner-first order, multi-owner recovery and `FOR NO KEY UPDATE`.
  - `purchase-fanout.service.ts` +14/-4: the B-661-9 takeover.
  - Five test doubles: they gain `findMany` and the OR branches, and the two SQL-text assertions now target `FOR NO KEY UPDATE`. No assertion is weakened.
  - The new `test/checkout-settlement.live.spec.ts`.
  - The removal of `test/checkout-hosted-activation-once.spec.ts`. It is byte-identical (SHA-256 `fc2e00c2…`) to the copy #702 adds.
- **Reused:** every other PR file is byte-identical to `957e3677`, so this lens's audit there still applies: admin select, `checkout.service.ts`, dunning, payment-ops controller, log redaction, and their specs.
- **Piece boundary:** without the moved spec, #661 compiles and is green alone. The B-661-5 and C-661-7 hosted cases run on #702, which lands with this PR (rule 11).

### Round 6-8 delta: findings
- **Owner query** (`checkout-webhook-handler.service.ts:1302-1318`):
  - These conditions are all inside one `findMany` before `take: 10`: PI, `payment_failed`, `fanout: { isNot: null }` (semi-join on the unique `PurchaseFanout.purchase_id`), `billing_type notIn ['recurring']` (non-null column, default `one_time`, so `NOT IN` drops no one-time row), and `stripe_subscription_id: null`. Every returned row is therefore an owner.
  - It runs after the PaymentIntent row lock (`:1199`) and before the activation lookup (`:1214`). Row order no longer decides.
  - Recovery (`:1325-1348`) loops over the owners with the same id + PI + `payment_failed` compare-and-set. In the tx path the PI lock makes P2025 impossible. In the no-tx path a lost CAS throws 503, and the redelivery recovers the rest.
  - Nothing runs twice: no fanout, no first-payment notice, no split.
- **Binding "hosted Checkout activates only via `checkout.session.completed`":** kept.
  - Recovery re-entitles a purchase whose activation record already exists. It is not an activation.
  - A late completion of such a purchase is `already_progressed` (`:793`).
- **B-661-9 takeover** (`purchase-fanout.service.ts:597-608`):
  - Every reason except `payment_failed` also matches `canceled:payment_failed` drops, in one statement.
  - Under READ COMMITTED, EvalPlanQual re-checks the OR on the newest row version, so both commit orders against `restoreAfterPaymentRecovered` (`:629-650`) converge on "canceled".
  - All six callers of `cancelPendingForPurchase` were traced. `drops_canceled` now also counts the relabeled drops. The only consumer is the `decide` response, and the count is truthful there (those drops are now unassigned for good).
  - Account deletion moves every purchase to `canceled` (`account-deletion.manifest.ts:383-414`), so recovery (status `payment_failed` only) cannot reach it.
- **`FOR NO KEY UPDATE`** (`:699`, `:717`): it still conflicts with every UPDATE, DELETE and row lock, and it still returns the newest committed xmin. It no longer blocks an FK check (`FOR KEY SHARE`). The xmin guarantee is unchanged.
- **`ci.yml:549-566`:** additive only. The live spec is one more entry in the `mwb-3-live-tests` list, under the same gate and the same per-file reset + bootstrap convention as its neighbours. No gate is weakened. In build-and-test it is `describe.skip`.
- **Logs:** ids, counts and reasons only. **Copy:** none added.

### Independent probes (real PostgreSQL 16.15 on the runner, real handler / `PurchaseFanoutService` / Prisma, full schema)
- **`test/aud-opus-661-118.live.spec.ts`:**

| Probe | Case | Head (`20d2eb4f`, this PR's src + #702) | Control `c7ee15f0` | Control `957e3677` |
|---|---|---|---|---|
| O1 | The owner is the oldest row. 30 never-activated rows and 5 activated non-owners on the PI (recurring, with subscription, refunded, chargeback_lost, canceled) are all newer, and unordered reads are answered newest first. The owner gets `payment_recovered`, paid, its drop pending. The 35 others do not change. The redelivery changes nothing. | pass | **fail** (`checkout_session_activates`) | pass |
| O2 | The same on the no-transaction path (PrismaService) | pass | **fail** | pass |
| D1 x5 | refund / dispute / subscription_canceled / partial_refund_decision / grant_revoked. Pending, due and `canceled:payment_failed` drops take the reason. Other-reason, fired and failed drops are untouched. The restore returns 0. | pass | pass | **fail** (failure-canceled drop not taken over) |
| D2 | A `payment_failed` cancel never takes over another reason. The restore returns only the drops that failure canceled. | pass | pass | pass |
| L1 | While the PI lock is held, a ScheduledDrop insert that references the purchase completes and an UPDATE waits | pass | pass | **fail** (`blocked`) |

- **Runs:**
  - Head: [run 37218675555](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218675555), tsc green, 5 suites / 53 tests.
  - Controls: [run 37218911726](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218911726) (2 failed / 7 passed) and [run 37218923485](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218923485) (6 failed / 3 passed).
- **Dead Sol lens probe** (AUD-SOL-661R6-117 `661-native-verified`, 9 and 10 adoptions through real native reservations): replayed unchanged in run 37218675555. Both cases pass at this tree, so the ten-row boundary is closed.
- **Builder evidence verified:**
  - Round 7 failing-before [run 37186266591](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37186266591): only the 10 and 12 cases fail.
  - After [run 37186426457](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37186426457): 190/190.

### Prior findings
- **C-661-11, closed:** `FOR NO KEY UPDATE` in both queries. Verified by L1 against the `957e3677` control.
- **C-661-12, closed:** the real-PostgreSQL settlement spec runs in `mwb-3-live-tests`. At this head that is 8 suites / 71 tests, the spec PASS and nothing skipped. It carries P1-P7 of this lens's round-5 probe.
- **Sol B-661-3 (owner selection and list boundary) and B-661-9:** checked independently above. The fixes hold.

### C findings
- **C-661-13 (new, docs):** the PR bodies are stale after FIX ROUND 8.
  - The #661 status line still says round 7 and 3,121 lines. Its round-4 acceptance evidence still lists `test/checkout-hosted-activation-once.spec.ts` as part of this PR.
  - The #702 body says "One file" and "235 changed lines".
  - Rule: refresh both bodies (sizes 2,843 and 513, the moved spec under #702) before merge.
- **C-661-14 (new, outside this delta, composition):**
  - `src/checkout/checkout.service.ts:89` puts `trialing` (and `past_due`) in `PAID_STATUSES`. A replay then answers 409 `PAYMENT_ALREADY_COMPLETE` with "This payment is already complete", even for a free trial that charged nothing.
  - Today's one-time PaymentSheet route never reaches it. It becomes reachable once native trials or recurring (#672, #678-#680) reserve rows through `classifyPaymentReplay`.
  - Rule: whichever of these merges second maps `trialing` to a trial-specific code and copy with no payment claim, and maps `past_due` to a payment-update code. Add one replay test per status.
- **C-661-10 (carried, pre-existing):**
  - One PaymentIntent can be stamped on two rows.
  - `ClientPurchase.stripe_payment_intent_id` has no index. The lock, the owner query and the `findFirst` each scan once per PI event.
  - Rule (follow-up migration): add the index, and release or refuse a second stamp on completion.
- **C-661-2 (carried, operator):** historic credential backfill, in a deploy window after merge.

### CI
- 11/11 required checks are SUCCESS at `f80f0088` ([CI run 37218016267](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218016267); CodeQL, danger, banned casts, build-sbom, Schema parity and npm audit are green in their own runs).
- build-and-test: 728 suites passed, 0 failed. Re-read immediately before posting.
- Size: +2,716/-127 = 2,843 changed lines. That is under 3,000 and inside the 1,500-3,000 band, so the operator posts the SIZE ASSESSMENT.

APPROVE: no A or B findings at this head. Rounds 6-7 close Sol B-661-3 (owner selection and the ten-row boundary), Sol B-661-9 and this lens's C-661-11 and C-661-12. Each closure is confirmed independently on real PostgreSQL against `c7ee15f0` and `957e3677` controls. Round 8 is a byte-identical test move, and the integrated tree with #702 is `4339454c`.
