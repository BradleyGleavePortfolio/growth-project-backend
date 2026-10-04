# B-RECUR-116 (builder, agent 116) — recurring stack fix round 3: backend #679 + #680 (#678 restack only if needed)

Start heads (verified via gh api): #678 b89c199d91a868e625b1c1bd861d540ac4c2a8ce (base agent115/fee-split-6-recovery-specs 7be7d396),
#679 517def8ca6c5ab6102ace5133dda684157e6a06d, #680 7e55cfcb6d573d2a0095ef9f459f37c389cb7117. No AUDIT/FIX ROUND comments on the
pieces; findings come from #654 @ 02c48de7: Opus APPROVE 0/0/3 (C-654-8, C-654-9, C-654-10) and the unposted Sol draft 0/3/0
(B-654-5 narrowed, B-654-8, B-654-9) per AUD-SOL-MONEY-115 / AUD-SOL-MONEY-2-115.

## Open findings at start
| ID | Lens | Where (piece) | Summary |
|---|---|---|---|
| B-654-5 narrowed = C-654-8 | Sol B / Opus C | #679 subscription-checkout.service.ts mintSubscription (via replayAttempt/claimUnbound, tryReuse) | uncertain create resent blindly; after Stripe's 24 h key retention a second subscription is created |
| B-654-8 | Sol B | #679 retireAttempt, tryReuse stale path, finishBound 'unavailable' | failed/unavailable cancel still expires a payable attempt (and a new key then mints a second subscription) |
| B-654-9 = C-654-10 | Sol B / Opus C | #679 errorLabel (+ message-logging catch lines in #679 and three new lines in #680 handler) | arbitrary Error.name / identifier-shaped code reach logs |
| C-654-9 | Opus C | mobile #334 | closed by #334 round 3 (mode:'none'); nothing in this job |

## Log
- 02:55 UTC failing-before run (test-only commit 323b27c7 on #680 head): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172350469 red 19 failed / 1 passed
- 02:58 UTC (19:58 PDT) local: 8 b-recur suites 153/153 at 2b10687c (heavy.sh jest --runInBand).
- 02:59 UTC pushed #679 958806d15af64863786337699020428cd89ffaf3 (fix) and #680 2b10687c63cf02e0181339b684634ff9cfbeb803
  (test 323b27c7 + merge of #679 4117c2bf + handler labels / fix-round-2 expectation 2b10687c). Stack lock `recur` taken and released.
- 03:08 UTC (20:08 PDT) required checks green at both heads (7 running required + size-label/test-deploy-readiness; deploy-readiness-gate
  skipped as usual). #679 build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172708421/job/111348789748 ;
  #680 build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172709393/job/111348792701 (no OOM flake).
- 03:09 UTC posted FIX ROUND 3 + READY FOR AUDIT:
  #679 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976053666
  #680 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976054570
  #678 (no change, READY at b89c199d) https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976055756
  PR bodies of #678/#679/#680: tier header (T4) prepended, Fix rounds table appended, sizes updated.
- 03:11 UTC cleanup: ci/B-RECUR-116-680-before deleted (run URL stays valid); worktrees removed; local branches deleted.

## Round 3 table (what changed)
| Finding | Change | Commit | Test |
|---|---|---|---|
| B-654-5 narrowed / C-654-8 | mintSubscription: a retry of a pinned attempt looks the subscription up by metadata.tgp_purchase_id first: found -> bind; unreadable -> PAYMENT_RETRY (retry marker kept); none and >= 23 h old -> SUBSCRIPTION_ATTEMPT_EXPIRED timed_out; none inside the window -> identical pinned resend | #679 958806d1 | test/b-recur-116-fix-round-3.spec.ts (in #680), 6 cases, all failed before |
| B-654-8 | cancelConfirmed() (cancel answered, or read-back shows canceled/incomplete_expired); retireAttempt, tryReuse stale path, finishBound no-sheet end the attempt only after it, else PAYMENT_RETRY and no new attempt; tryReuse past_due/unpaid -> ALREADY_ACTIVE; sheetSecret null for ended subs; retireAttempt unreadable keeps retry marker | #679 958806d1 | 5 failed-before cases + 1 control |
| B-654-9 / C-654-10 | src/checkout/error-label.ts closed allow-lists (stripe:<type>:<status>:<code>, http:<status>, P####, fixed network codes, fixed class names, else `error`); 6 service catch lines + 3 new handler lines (#680 2b10687c) log the label, never err.message | #679 958806d1, #680 2b10687c | 7 failed-before canary cases + label controls |
| C-654-8 expectation | b-recur-3-fix-round-2.spec.ts "create times out after Stripe made it": one create (binds found sub) instead of an identical second create | #680 2b10687c | same spec |
Sizes: #679 2,952 changed lines (was 2,863); #680 2,914 (was 2,480); #678 747 unchanged.

## Notes for the operator / next lenses
- Every retry of an uncertain create now makes one extra Stripe list call (status=all, limit=100; has_more without a hit = unreadable -> retry, never a guess). A customer with more than 100 subscriptions would get PAYMENT_RETRY on such a retry (unrealistic; pagination would be a later C).
- Pre-existing, outside these findings (not changed): a cancel racing a payment that lands between the Stripe read and the DELETE could cancel a just-paid subscription (ms window, existed before this round). Possible C for a lens; a fix would need Stripe's invoice state after cancel.
- checkout-webhook-handler.service.ts still has many main-era log lines with err.message (outside this diff); only the three this piece adds were changed.
- #654 stays open at 02c48de7 as the superseded original; its tree no longer equals #680.

## HANDOFF
State at 03:11 UTC 2026-10-04 (20:11 PDT 10-03). All work pushed; no local-only changes; worktrees and ci branch removed.

| PR | Exact head | Checks | Round / comment | Next step |
|---|---|---|---|---|
| backend #678 (base agent115/fee-split-6-recovery-specs) | b89c199d91a868e625b1c1bd861d540ac4c2a8ce (unchanged) | 7 running required green (+2 migration checks) | FIX ROUND 3 no-change + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976055756 | AUD pair R12: full piece audit (no lens has audited the pieces) |
| backend #679 | 958806d15af64863786337699020428cd89ffaf3 | 7 running required green | FIX ROUND 3 + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976053666 | AUD pair R12: Sol re-verify B-654-5 narrowed / B-654-8 / B-654-9; Opus re-verify C-654-8 / C-654-10; deep audit of 517def8c..958806d1 |
| backend #680 | 2b10687c63cf02e0181339b684634ff9cfbeb803 | 7 running required green | FIX ROUND 3 + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976054570 | AUD pair R3: delta 7e55cfcb..2b10687c (merge of #679 + 3 handler lines + tests) |

Failing-before evidence: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172350469 (19 failed / 1 passed at 323b27c7 = #680 7e55cfcb + new spec).
Operator decisions: none blocking. The stack still needs the main retarget after fees F1-F6 land (CodeQL, danger, Banned cast tokens, build-sbom then run; added lines carry no banned token). Owner adds the Stripe `setup_intent.succeeded` webhook event before deploy. Mobile #342-#344 pair with #680 (no mobile contract change this round: same codes, `reason` values unchanged).
