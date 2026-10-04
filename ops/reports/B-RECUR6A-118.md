# B-RECUR6A-118 — recurring R1/R2 fix round 6 (#678, #679)

Status: DONE — FIX ROUND 6 posted on both PRs, READY FOR AUDIT at green heads

## Heads
- #678 agent115/recur-split-1-terms-foundation @ 77bce4505b12586a0fe1080246d97217f0834f1c (was b04ea692). +2,389/−22 = 2,411 changed lines vs fees F6 (1,500–3,000 band: stated).
- #679 agent115/recur-split-2-subscription-checkout @ 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca (was 6760ee6a). +2,932/−0 = 2,932 vs #678 (was 2,945).

## Findings closed
| Finding | Fix | Where |
|---|---|---|
| Opus B-678-2 (generic card update lifted the trial end) | `setSubscriptionDefaultPaymentMethod` sends `cancel_at_period_end=false` only with `liftTrialEnd: true`; `attachTrialCard` passes it (same key). Same signature as D1 #687 plus the optional flag. | R1 stripe-connect-api.service.ts, trial-card.ts |
| Sol B-679-7 (send fence vs deletion) | `sendFenced` (R1 function, R2 caller): claim + create + bind in one tx that holds the client's User row FOR KEY SHARE (finalization takes FOR UPDATE SKIP LOCKED: it skips while a send runs, or runs first and the send sees deleted/closed and sends nothing). Read-back under the row lock. Deletion side: `AccountDeletionBillingService.collectUnboundAttemptSubscriptionIds` (pinned unbound native attempts → Stripe list by customer + created_gte, metadata.tgp_purchase_id; touched <2 min, has_more, or unreadable → throw, deletion retries). `resolveStaleUnbound` expiry is a CAS on marker + updated_at. | R1 subscription-attempt.ts, account-deletion.*; R2 service |
| Sol B-679-8 (rejected bind exclusion) | `holdUnresolved`: unpaid-cleanup unconfirmed or paid → the same client's pending/expired row is reopened (pending, bound to the sub); admission reuses / reports / ends it, never a second. Deleted-account rows never reopened (id recorded only). | R1 subscription-attempt.ts; R2 service |
| Sol B-679-10 / Opus B-679-10 (pending SetupIntent null) | Attempt-owned SetupIntent (`createSetupIntent`, key `tgp-trial-setup-<purchase>`, usage off_session, on_behalf_of coach, metadata) via `ownTrialSetupSecret`/`ownTrialSheet` when Stripe returns no pending SI; `ownTrialCardOn` (default + end lifted) in classifyWithoutSheet/subscriptionUnpaid; tryReuse: no SI at all → a default card is not the attempt's own. | R1 + R2 |

## Size moves (#679 → #678, behavior-identical)
subscription-errors.ts / subscription-plan.ts R2 hunks; `isRecurringPackage` + public `runContractGate`/`ensureCustomer`; wire-format describe → test/b-recur-subscription-wire.spec.ts; `resultFromRow` → `intentResult`; `findAttemptSubscription` → subscription-attempt.ts.

## Evidence
- Failing-before lanes (first versions): R1 run 37219128773 (7/8 fail), R2 run 37219434244 (10/11 fail). Final-spec reruns: R1 37220505580, R2 37220493176.
- Probe replay lanes: #678 run 37220414906, #679 run 37220452812.
- Local: 22 suites / 236 tests pass on #679 tree; 18 suites / 144 on #678 tree; targeted tsc (249 src files) clean; eslint clean; prettier clean on touched lines.

## Probe replay (local, confirmed in lanes)
Old #679 head 6760ee6a: 11 fail / 162 pass. New head: 9 fail / 164 pass.
- Now pass: Sol B-679-7 acceptance; Sol null-pending-SI acceptance x2; Opus B-678-2 acceptance; Opus B-679-10 acceptance.
- Fail by design (evidence of old behavior): Opus B-678-2 evidence; Opus B-679-10 evidence x2.
- Fail, unchanged from round 5 (superseded): Sol r12-116/r12-117 "minimal bodies" (trial-card attach carries the lift since round 5; Sol r12r5-r1 expects it); Opus r12-117 P2 evidence (trial create carries cancel_at_period_end since round 5); Sol round-4 "invoice paid after the unpaid read" (payment inside DELETE after a successful void: impossible on Stripe, stated in round 5).
- Sol B-679-8 acceptance: live ['sub_1'] and creates 1 pass; `nextSubscription` is 'sub_1' (the next key resumes the same still-payable subscription) instead of undefined.
- C-679-3 acceptance: fails, C deferred (FREEZE).

## Follow-ups (C)
- C-679-3: src/checkout/subscription-checkout.service.ts:1464 replaySecretState and :1498 canceledSetupState @ 8bbf4a41 (same-key trial replay returns the stored SetupIntent secret when both the subscription and the SetupIntent are 404). Fix rule: on a missing SetupIntent read the bound subscription; expire the attempt only on proven absence of both (resource_missing), keep it otherwise.
- Admin deletion while a send holds the user row (src/account-deletion/account-deletion.service.ts:455 lockUser 'skip' @ 77bce450): finalization's SKIP LOCKED answers "A deletion for this account is already running" for up to the send (≤30 s). Fix rule: a distinct retryable message for a held row.
- Pooled DB connection held during the Stripe create (src/checkout/subscription-attempt.ts:17 SEND_FENCE_TX_TIMEOUT_MS = 30_000 @ 77bce450; ≤10 s per Stripe request). Fix rule: monitor pool; if pressure, move to a short lock + durable intent row.

## Log
- 10:07 start; rules, threads, probes read (copies in ops/aud-118/B-RECUR6A-118/probes/).
- 10:22 pushed #678 77bce450 and #679 76aa84b8; then #679 8bbf4a41 (findAttemptSubscription move committed).
- 10:33 required checks green: #678 12 pass / 1 skipping, #679 10 pass / 1 skipping (no reruns). Lanes confirmed: before R1 37220505580 (7/8 fail), before R2 37220493176 (10/11 fail), probes #678 37220414906 (39/2), probes #679 37220452812 (164/9).
- 10:35 FIX ROUND 6 posted: #678 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5982632966 ; #679 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5982633162 . PR bodies updated (tier header, deletion yes, Fix round 6 rows).
- 10:36 notify/recur.txt written; ci/B-RECUR6A-118-* branches deleted; worktrees removed (incl. pre-fix worktrees 678old/679old); no lock held.

## Operator decisions
1. Sol B-679-8 probe expects the next key to get no subscription (`nextSubscription: undefined`); this round has the next key resume the same, still-payable subscription (creates 1, live [sub_1]). Recommended default: accept (exclusion holds, more function). Alternative: answer PAYMENT_RETRY for held rows until Stripe resolves, at the cost of a stuck client.
2. Account finalization now makes Stripe list calls inside its transaction for unbound checkout attempts (rare; 120 s tx timeout). Recommended default: accept.

## HANDOFF
- #678 @ 77bce4505b12586a0fe1080246d97217f0834f1c and #679 @ 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca: FIX ROUND 6, READY FOR AUDIT, required checks green. Next: fresh Opus + Sol audits at these exact heads.
- For B-RECUR6B (#680): rebase-free merge of #679 into #680 is clean (merge-tree). `setSubscriptionDefaultPaymentMethod` now lifts the trial end only with `liftTrialEnd: true`; test/b-recur-fix-round-1-trial-card.spec.ts:172 uses an exact toHaveBeenCalledWith on it and will need `liftTrialEnd: true`. `classifyWithoutSheet` / `subscriptionUnpaid` treat a trialing default as the attempt's card only when the end is lifted (`ownTrialCardOn`). The own trial SetupIntent (metadata `tgp_purchase_id`, `tgp_subscription_id`, `tgp_checkout: native_subscription_trial`) is not tied to the subscription by Stripe; the #680 `setup_intent.succeeded` handler should attach it via `attachTrialCard` when it sees that metadata.
- For dunning D1 #687 / D3 #689: R1's `setSubscriptionDefaultPaymentMethod` is D1's signature plus optional `liftTrialEnd`; on conflict keep R1's version.
- C follow-ups listed above (C-679-3; admin "already running" while a send holds the user row; pool hold during create).
