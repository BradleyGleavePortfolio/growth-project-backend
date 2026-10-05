AUDIT Claude Opus 5.5 — growth-project-backend#680 @ 216489ff5fa707147b50ef0e387aba5b3079e4b1 — VERDICT: APPROVE

A/B/C = 0/0/6

Lens: AUD-OPUS-R34-119 (agent 119). Tier T4: recurring money path (entitlement, webhook order and redelivery, row locks, dunning entry, trial consumption). The PR body says T4, and this lens agrees. The head was re-read right before posting. This lens did not read the other lens's verdict at this head.

**Scope.** Piece R3 (#678 → #679 → #680 → #696 → #701). Base `agent115/recur-split-2-subscription-checkout` @ 8bbf4a41 (#679 round 6). The diff is +2,672/−94 = 2,766 lines over 11 files, in the 1,500–3,000 band and under the cap. Product code is `src/checkout/checkout-webhook-handler.service.ts`, `src/connect/stripe-connect-api.service.ts` (`retrieveInvoice`) and the contract comment in `src/notifications/coach-first-payment.service.ts`.

**Evidence reuse.** This lens's last APPROVE (8e05ad0e, issuecomment-5977283278) was withdrawn by LENS NOTE 5977325672, so no Opus approval covers fix round 5 (6ec2f435, e648be54, 2cc6211b) or fix round 6 (d4a3a837, 216489ff).
- Both rounds were audited in full. This lens read `git diff 8e05ad0e 216489ff` on the handler (291 lines) line by line. The base move f48fa8f0 → 8bbf4a41 does not touch the handler file.
- Re-read in full at this head: `applySubscriptionUpdated`, `applyInvoicePaid`, `applyInvoicePaymentFailed`, `applyPaymentIntentFailed`, `applySubscriptionDeleted`/`endSubscriptionPurchase`, `prefetchForOuterTx`/`prefetchFailedInvoice`/`prefetchSubscriptionAuthority`, `attachNativeTrialCard`, `lockPurchase`, `recordAttemptDecline` and `activateUnderPackageLock`.
- Also read: R1/R2's `trial-card.ts` (`attachTrialCard` liftTrialEnd, `ownTrialSetupSecret` metadata), `subscription-plan.ts:287` `ownTrialCardOn`, R2's expire/cancel paths, and BillingService's prefetch → tx → handle order.
- Unchanged pieces from the 2b10687c/8e05ad0e reads (the metadata bind, C-680-4/5/6 closures) rest on that evidence.

**Prior findings (both lenses, latest heads)**
- Sol B-680-1 narrowed (5977195657): CLOSED. invoice.paid now applies the revision fence to every non-ended row (L1754-1771). When the state matches, the money settles. Anything else throws `WebhookRedeliverError`, and the catch rethrows under the outer tx (L1790).
- Sol B-680-2 narrowed: CLOSED.
  - The decline captures the write version and status before its Stripe reads (L717-737), and the locked re-check redelivers on any newer write except the move into past_due (L1905-1914).
  - First-attempt `last_error` is written under the package lock and the purchase row lock, only while the attempt never granted access (L2034-2044).
  - B-680-2 residual (dead Sol probe): passes at this head.
- Sol B-680-3 / Opus C-680-10: CLOSED. Under an outer tx, a missing invoice.paid prefetch redelivers for every purchase (L1732-1737).
- B-680-5 (dead Sol round-5), cases 1 and 2 plus deletion: CLOSED.
  - `trialOwnCardOn` = default card AND no create-time end (L37-42). It gates the never-started trial grant (L62) and deletion consumption (L1475).
  - `attachNativeTrialCard` attaches whenever the own card is not on (L817), and only before any grant (L809).
- B-680-6 (dead Sol real-PG): CLOSED. `lockPurchase` takes FOR NO KEY UPDATE (L2014-2027). DunningState/PaymentReminder carry FKs to ClientPurchase/User only, never CoachPackage, so no other own-connection FK waits on the package lock.
- B-679-10 handoff (attempt-owned SetupIntent by metadata): CLOSED.
  - Lookup is on (purchase id, subscription id, recurring) first, then the secret prefix (L771-791).
  - The customer check is kept, and the attach always lifts the end through `attachTrialCard`.
- Opus C-680-8: the builder declined it with a sound reason (a per-column apply lets an older read overwrite a newer write), so it is withdrawn. C-680-9: CLOSED (contract comment).

**Probes (CI lane, PR head + probe specs only):** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229300646 (73 tests: 67 pass, 6 fail, every failure explained).
- Dead Sol `aud-sol-r34r5-117-authority` (unchanged): 11/12. The one failure is B-680-5 case 2 on exact call shape only: the attach is made once, plus R1's `liftTrialEnd: true`. This lens's behavioural version passes: Stripe-set default with the end on → own SetupIntent attaches and lifts the end.
- Dead Sol `aud-sol-r34r5-117-postgres-lock` (real PG, unchanged): `SOL_LOCK_PROOF` shows windows 1, no 55P03, failureWasCaught false. Its only failing assertion is the metrics line, because its db double lacks `paymentReminder.create` (warningCount 1). The builder's shim (real FK reminder rows) passes 2/2.
- Opus R34-117 probe 12/12. Builder regressions `b-recur6b-118-authority`, `b-recur5b-117-authority`: pass.
- New `aud-opus-r34-119-pg-lock` (real PostgreSQL, 4/4), all with the handler's exact statements:
  - a second NO KEY UPDATE waits;
  - a plain UPDATE (R2's CAS writes) waits;
  - a DunningState FK insert from another connection does not wait;
  - package-then-purchase order serializes two workers without deadlock.
- New `aud-opus-r34-119-probe` (11 green controls, 4 expected-red Cs below). Green controls:
  - decline read → paired past_due update → dunning once, no redelivery;
  - a lifecycle-neutral write after the read redelivers once, then dunning once (no livelock);
  - an own-card trial's first post-trial decline enters dunning;
  - a subscription_create decline never does;
  - own-metadata attach lifts the end, grants and stamps once, and a redelivery does not write Stripe again;
  - other-flow SetupIntents and non-recurring rows are untouched.

**Findings (all C)**
- **C-680-7 (carried)** — L785-790 `stripe_client_secret startsWith` is unindexed. The metadata lookup now runs first. Fix rule: an additive migration (> 20270316000000) adding an indexed SetupIntent id column, looked up by equality. Default: post-stack follow-up.
- **C-680-11 (outside this diff, main-era L1161)** — L1915-1925 writes `status: 'past_due'` over a row Stripe already moved to `unpaid` (entitlement false). Probe: row unpaid, live unpaid, a retry decline → status `past_due`. Entitlement stays false. The row then misreports the plan, and `recordFailure` reopens a window. Fix rule: write the live `authority.subscriptionStatus` when it is past_due/unpaid, and never downgrade `unpaid` to `past_due`.
- **C-680-12 (outside this diff, main-era L793; composition with R-DISPUTE-PAUSE)** — `purchaseHasEnded` (L90-97) fences only canceled/expired/incomplete_expired, so `applySubscriptionUpdated` re-grants a row whose access ended for a money reason. Probes (red):
  - status `chargeback_lost`, entitlement false, then `customer.subscription.updated(active, cancel_at_period_end)` → entitlement true;
  - status `disputed`, entitlement false, then `customer.subscription.updated(active, pause_collection)` → entitlement true. Stripe sends exactly that update when billing is paused, so R-DISPUTE-PAUSE ("no automatic restore") breaks unless its build fences these writers.

  Fix rule: one predicate (ended or money-revoked: refunded, chargeback_lost, dispute-paused) used by every grant writer (subscription update, invoice.paid, trial attach). It is built with R-DISPUTE-PAUSE in the dunning stack. Whichever of recurring/dunning lands second carries it, with these probes as regressions.
- **C-680-13 (defence in depth)** — L809 does not check `purchaseHasEnded(row)`. Probe: an `expired` attempt with Stripe still `trialing` gets the card attached and the end lifted. R2 expires an attempt only after Stripe shows it ended (`cancelConfirmed`), so this is not reachable today. Fix rule: return `{ ok: true }` without attaching when the row has ended.
- **C-680-14** — L37-42 `trialOwnCardOn` duplicates R2's `ownTrialCardOn` (`src/checkout/subscription-plan.ts:287`). Fix rule: one exported helper with a structural parameter type, used by both.
- **C-680-15** — L1894-1896 `invoice_superseded` acknowledges a decline of an invoice that is still open whenever a newer invoice exists. Probe PIN: no dunning. A weekly plan whose old invoice keeps failing after the next invoice is issued never enters dunning for it. Fix rule: treat the decline as superseded only when the declined invoice is no longer collectible (paid/void/uncollectible) or the newer invoice is paid; otherwise fall through to the version-fenced write.

**Integration obligations (operator):**
- Trials #673 (head 5fdb5f5c) adds `subscriptionGrantsEntitlement` (any default card grants a trial) and a TrialUsage ledger in the same handler. The second to land must keep `trialOwnCardOn`, because a customer or Stripe-set default is never this attempt's consent. It must also keep one ledger (`trial_started_at` vs TrialUsage).
- `isNeverEntitledPaymentAttempt` must be unified with the dunning helper.
- C-661-3 credential clearing.
- C-680-12 above.

**Operator defaults judged:**
- Narrower past_due exemption: ACCEPT. The paired-update control is green, and the residual edge redelivers.
- Deletion consumes only granted/own-card trials: ACCEPT. A client who never got access keeps the one trial.
- Real-PG proof as a CI-lane probe: ACCEPT. Two independent real-PG probes are green on the lock part.
- Day-10 lockout plan view: belongs to R1 with the lockout stack, not this piece.

**CI at this head:** all 10 emitted checks pass, and deploy-readiness-gate is skipped. The run is https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224655542 (build-and-test, rls-live, mwb-3, community-live, rls-floor). Schema parity, npm audit and size-label are green. CodeQL, danger, banned casts and SBOM do not run on a stacked base. Banned casts were checked locally (`check-r75 --mode=range` 8bbf4a41…216489ff): OK, net −1 `as any`, net −1 `as unknown as`. Failing-before for this round is lane run 37224558256 (7 fail = the 7 cases marked failed-before).

Zero A and zero B: APPROVE. All six Cs are optional. C-680-11 and C-680-12 lie outside this diff, and C-680-12 must ride with the R-DISPUTE-PAUSE build.
