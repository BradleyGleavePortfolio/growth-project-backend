# AUD-OPUS-R12-119 (Claude Opus 5.5 lens, agent 119) — recurring R1 #678 + R2 #679

Started Sun Oct  4 12:30:49 PDT 2026. Claims: backend-678-77bce450-opus, backend-679-8bbf4a41-opus.
Heads: #678 77bce4505b12586a0fe1080246d97217f0834f1c, #679 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca. Both CLEAN, draft, READY at head, required checks pass.


## Progress log
- 12:40 Read rules, job entry, B-RECUR6A-118 report, all AUDIT/FIX ROUND comments on #678/#679 (copies: ops/aud-119/AUD-OPUS-R12-119/c678.json, c679.json). Worktrees wt/AUD-OPUS-R12-119-1 (#678 head), -2 (#679 head), detached.
- Fees F6 branch moved to 8cb7b2d4 (F3 round 16 merge) after #678 merged 13c814f7; PRs still CLEAN. Operator restack later.
- Read in full: R1 own diff (13c814f7..77bce450; changed vs 0c2191c0: account-deletion billing/module/service, checkout.service, subscription-attempt.ts, -errors, -plan, trial-card, stripe-connect-api, tests/fakes) and R2 service 1-1561, controller, module, route table.
- Required checks at both heads green (12 pass/1 skip; 10 pass/1 skip). Builder failing-before lanes 37220505580, 37220493176 concluded failure (as expected).
- Candidate Cs so far: coach-deletion not fenced (send locks only the client row; collector reads only client rows); deletion collector throws forever on Stripe customer resource_missing; attemptSettled no-SI default answers settled/ALREADY_ACTIVE while the enforced end will cancel the trial.
- 12:44 Verified builder probe-replay runs independently via API: 37220452812 = 8bbf4a41 + prior lens probes only (164/9, failures exactly as FR6 lists); 37220414906 #678 (39/2). Remerge-diffs: R2 merges empty except 32e1a67d (subscription-errors.ts add/add, resolved to the R1 file byte-for-byte). Sizes via gh: #678 2389+22, #679 2932+0.
- 12:44 Probe pushed: audit/AUD-OPUS-R12-119/679-probes (4340b5cc = 8bbf4a41 + test/audit-opus-r12-119.spec.ts), CI lane run 37229380504.
- 12:48 Probe run 37229380504 completed as predicted: 3 acceptance cases fail (C-679-4, C-678-3, C-678-4); evidence + control pass. Heads re-read (unchanged), verdicts posted 12:48 PDT.
- 12:49 audit/AUD-OPUS-R12-119/679-probes deleted on origin; worktrees removed. Probe spec copy, verdict texts, comment JSON and run logs kept in ops/aud-119/AUD-OPUS-R12-119/.

## Verdicts
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend #678 (R1) | 77bce4505b12586a0fe1080246d97217f0834f1c | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983746979 |
| backend #679 (R2) | 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5983747222 |

Prior findings, closed at these heads: C-678-1, dead-lens B-678-2, Opus B-679-8, B-679-9, dead-lens B-679-10, Opus C-679-3 (new-key and bound reads). The Sol B-679-7/8/10 fixes meet their fix rules (judged independently). Sol C-679-3 (same-key trial replay residual) is still open as a follow-up.
CI: every required check is green at both heads. The builder's failing-before lanes (37220505580, 37220493176) concluded failure as claimed. The builder's probe replay 37220452812 was verified as 8bbf4a41 plus the prior probes only. My probe lane: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229380504

## Follow-ups (C)
- C-678-3: src/account-deletion/account-deletion.billing.ts:112-121 @ 77bce450. Any error from the Stripe list (including a 404 resource_missing "No such customer") throws, so the deletion fails every night. The throws at :108 and :119 reach admin force-delete as an uncoded 500. Fix rule: treat 404 resource_missing as proven absence (no ids) and keep every other error fail-closed. Have adminForceDelete answer "still finishing" and "incomplete list" as a coded retryable 409/503 with the retry time. Probe: run 37229380504.
- C-678-4: src/checkout/subscription-attempt.ts:53 (locks only the client's row) and account-deletion.billing.ts:92 (`client_user_id` only) @ 77bce450. When a coach account is finalized while a client's create is in flight, no collector returns the new subscription. The manifest then cancels the row, and the subscription stays orphaned on Stripe. Money-safe today: the incomplete first invoice is never handed out and expires at 23 h, and trials carry the enforced end. Fix rule: the collector also selects attempts by `coach_user_id`. Optionally, sendFenced also takes FOR KEY SHARE on the coach row, after the client row. Probe: run 37229380504.
- C-679-4: src/checkout/subscription-checkout.service.ts:1045 @ 8bbf4a41. `attemptSettled` returns settled for a subscription default when there is no SetupIntent, so `retireAttempt` (:900) answers SUBSCRIPTION_ALREADY_ACTIVE for a trial that will cancel at trial end with no card. Fix rule: with no SetupIntent, return false, as `tryReuse` does (:1132-1134). Test: the probe sequence answers ATTEMPT_EXPIRED (terms_changed) and the subscription ends. Probe: run 37229380504.
- Carried from others (not this lens's IDs): Sol C-679-3 (:1464-1490 same-key replay with both resources missing). Builder Cs: admin "already running" while a send holds the user row (account-deletion.service.ts:455/:698 skip). The pooled DB connection held during the Stripe create (subscription-attempt.ts:17).

## Notes for other stacks (operator)
- R3 #680: the own trial SetupIntent is tied to its subscription only by metadata (`tgp_checkout=native_subscription_trial`, `tgp_subscription_id`, `tgp_purchase_id`). The `setup_intent.succeeded` handler must call `attachTrialCard` (with `liftTrialEnd`) only while the row is not yet granted, and never after a client cancel; a redelivery must not lift a client's cancel. Main's applySubscriptionUpdated (checkout-webhook-handler.service.ts:814-846) grants on any `trialing` update, so #680 must gate the trial grant on the lifted end (`default_payment_method && !cancel_at_period_end`). Without that, a trial is granted at create, because Stripe sends the create-time state with cancel_at_period_end=true.
- Dunning (D1 #687/D3 #689): keep R1's `setSubscriptionDefaultPaymentMethod` (D1 signature plus the optional `liftTrialEnd`). The dunning card update must never pass `liftTrialEnd`.
- Dunning R-DISPUTE-PAUSE (being built): R2 admission (`decide`, service :500-516) treats a row as live only while it is `entitlement_active` or has status active/past_due/unpaid. Whatever state the dispute pause writes (access ended, billing paused) must stay excluded from new admission. Otherwise the client could buy the same plan again and create a second subscription while the coach has not restarted access. Recommended: the pause keeps the row in a status admission answers with a coded "your coach restarts this plan" 409, never a new subscription.
- Fees: no finding. The fees base moved from 13c814f7 to 8cb7b2d4 (F3 round 16) after #678 merged it.

## Operator decisions (recommended defaults)
1. Sol B-679-8 probe deviation (the next key resumes the same payable subscription): ACCEPT. tryReuse re-reads Stripe and re-checks the terms and prices, so there is still one subscription.
2. Stripe reads inside the 120 s deletion transaction: ACCEPT. Rows are 0-1, each list is bounded by created[gte], and cancelAll already calls Stripe there. Ticket C-678-3.
3. The three Cs plus Sol C-679-3: one follow-up PR on main after the recurring stack lands (default). Do not add them in a round on #679: it sits at 2,932 of 3,000.

## HANDOFF
State at 12:49 PDT 10-04 (from date). Both verdicts posted at the exact heads; no audit/* or ci/* branch of this job remains; worktrees removed; claims ops/lanes119/claims/backend-678-77bce450-opus and backend-679-8bbf4a41-opus left in place (verdicts exist at those heads).
- #678 @ 77bce4505b12586a0fe1080246d97217f0834f1c: Opus APPROVE 0/0/2. Next: Sol verdict at this head; then operator merge-only restack onto the final fees top.
- #679 @ 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca: Opus APPROVE 0/0/1. Next: Sol verdict; same restack.

What a short delta check after the merge-only restack onto the final fees top must verify (fresh Opus lens):
1. #678: the own patch (final fees top..new R1 head) equals 13c814f7..77bce450 per file (compare the +/- lines per file, as in this report). Any difference must be inside a conflict hunk, and every conflict hunk must be read (`git show --remerge-diff <restack merge>`).
2. If the fees side touched src/connect/stripe-connect-api.service.ts or account-deletion/*, confirm three things. `createSubscription` still sends `cancel_at_period_end=true` and `missing_payment_method=cancel` with a trial. `setSubscriptionDefaultPaymentMethod` still lifts only with `liftTrialEnd`. `finalizeUserDeletion` still calls `collectUnboundAttemptSubscriptionIds` inside the locked transaction, before the tombstone.
3. #679: the own patch (new R1 head..new R2 head) equals 77bce450..8bbf4a41 per file. The remerge diff of each restack merge must be empty. The size must stay at or under 3,000 (now 2,932; 2,411 for #678).
4. `createSubscription` is still reached only through `sendFenced` (two call sites in subscription-checkout.service.ts).
5. Every required check is green at both new heads, with no relabelled flakes. CodeQL, danger, banned casts and build-sbom must pass once the stack is retargeted to main.
6. Optional rerun: the probe ops/aud-119/AUD-OPUS-R12-119/audit-opus-r12-119.spec.ts must still show exactly the 3 C acceptance failures and 2 passes. Any other result means behavior changed.
