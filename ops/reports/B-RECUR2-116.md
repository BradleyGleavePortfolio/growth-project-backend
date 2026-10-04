# B-RECUR2-116 (builder, agent 116) — recurring fix round 4: backend #678 + #679 (content), #680 restack merge-only

Start heads (gh api, 03:40 UTC 10-04): #678 b89c199d (base agent115/fee-split-6-recovery-specs, now 1895147d), #679 958806d1, #680 2b10687c.
Open findings at start: Sol #679 B-679-1..7 (REQUEST CHANGES 0/7/0, comment 5976210528); Opus #679 C-679-1, C-679-2 (APPROVE 0/0/2, comment 5976163092);
#678 dual APPROVE 0/0/0. Operator 20:44 PDT: #680 content is owned by B-R3-116 (Sol 0/4/0 on #680); my #680 work is merge-only under the recur lock.

## Log
- 03:50 UTC #678 local ebbd170e: moved inert R2 code (subscription-plan.ts, subscription-errors.ts, subscription-terms.ts, error-label.ts, terms spec) + Stripe voidInvoice / cancelSetupIntent / listSubscriptionsForCustomer createdGte + fakes. #678 size 1,573.
- 03:53 UTC #679 local: merge of #678 (add/add conflict in subscription-terms.ts: R1 copy kept) + refactor (service imports the moved code). #679 size 2,280; b-recur suites 35/35 local.
- 03:56 UTC #679 test-only commit 8f1b5464 (test/b-recur2-116-fix-round-4.spec.ts, 18 cases: Sol R12 probe cases for B-679-1..7 + C-679-1 x3 + C-679-2 + 1 release case). Failing-before CI lane run 37175437392 (ci/B-RECUR2-116-679-before @ e21dc964): 18 failed / 18, each on its assertion (not a compile error).
- 04:00 UTC #679 fix commit f83dbdd2. Local jest: fix-round-4 18/18, b-recur-subscription-checkout + terms + lockout route table 89/89; eslint clean.
- 04:02 UTC pushed #678 ebbd170e951b1a34dfa082c37d9eaac94912f644 (fast-forward), #679 f83dbdd2ae4ff1592ae557febc43b97ff59d9ac9 (fast-forward). Sizes: #678 1,573 (+1555/-18) vs its base; #679 2,938 (+2921/-17) vs #678.
- 04:03-04:04 UTC recur lock held (mkdir/rmdir, about 1 min): #680 merge-only restack 929f39684951027aca14d9a3ab0127061e9aa808 = merge of #679 f83dbdd2 into 2b10687c, no conflict; `git diff <#679 head> <#680 head>` byte-identical to `git diff 958806d1 2b10687c` (R3 content unchanged). Lock released 04:04:32 UTC for B-R3-116.
- Known before push (local, merge of #679 into #680): 4 #680 tests encode the age-based admission that B-679-1 removes and will be red on #680 until B-R3-116 (owner of #680 content) updates them -- see "Operator decisions" below.

## Operator decisions (needed)
1. Four #680 tests (owned now by B-R3-116) assume old trial attempts are ignored after 23 hours. B-679-1 removes that age-based admission, so these tests fail on the restacked #680 (found by a local merge of #679 into #680; not edited, per the merge-only rule):
   - test/b-recur-fix-round-1.spec.ts:360 "trialing without a card ... with a card -> left alone": expects PKG2 to get a 7-day trial while a 30 h old PKG trial with a saved card is still pending. Under the one-trial-per-client-per-coach rule, that saved-card trial holds the trial, so PKG2 now gets no trial.
   - test/b-recur-fix-round-1.spec.ts:379 "a Stripe error while retiring never blocks the new attempt": expects sub_2. The open trial is now reused, so the result is sub_1 and no second subscription is created.
   - test/b-recur-116-fix-round-3.spec.ts:375 "a failed stale-trial cleanup logs no message": same issue; expects sub_2, now gets sub_1. The log assertions still hold.
   - test/b-recur-fix-round-1-trial-card.spec.ts:266 "stale-trial cleanup keeps a trial whose SetupIntent cannot be read": the later readable check now confirms no card was saved. It cancels the SetupIntent and then cancels sub_1.
   Recommended default: B-R3-116 updates these 4 expectations in its #680 round. #680 restack FIX ROUND is not posted until #680's checks are green.
2. #678 is now 1,573 lines (it was 747) after the size-ruling move. That is still under 3,000. It needs fresh dual audits at ebbd170e. Recommended default: accept.
3. B-679-1 design choice: when an old unbound trial attempt is found on Stripe, it is bound and reused for the same plan. That keeps Sol probe lines 191-221 literally green. For another plan, it is retired after a confirmed cancel. Recommended default: accept.

## PAUSE STATE (owner order 21:04 PDT, paused 04:08 UTC)
- PR heads (all pushed, fast-forward or merge commits only):
  - #678 ebbd170e951b1a34dfa082c37d9eaac94912f644
  - #679 f83dbdd2ae4ff1592ae557febc43b97ff59d9ac9 (test commit 8f1b5464 + fix commit f83dbdd2)
  - #680 929f39684951027aca14d9a3ab0127061e9aa808 (merge-only restack; R3 content identical)
- Done:
  - Size move into #678.
  - All fixes in #679: B-679-1..7, C-679-1, C-679-2.
  - Failing-before run 37175437392: 18/18 failed.
  - Local after-fix suites green.
  - #680 restack pushed.
  - recur lock released at 04:04:32 UTC; the lock is not held now.
- Not done:
  - Waiting for PR checks at the three heads. At 04:07 UTC: #678 pass=2 pending=9; #679 pending=9; #680 pass=2 pending=7. #680 build-and-test is expected red (decision 1).
  - FIX ROUND 4 comments are not written; no draft file exists.
  - PR body updates (tier header, Fix rounds rows, sizes).
  - Deleting ci/B-RECUR2-116-679-before.
  - Removing worktrees.
- Worktrees (clean, no WIP commit needed): /home/user/workspace/wt/B-RECUR2-116-678, /home/user/workspace/wt/B-RECUR2-116-679, /home/user/workspace/wt/B-RECUR2-116-680.
- CI still running: PR checks on the three heads above. The CI-lane run 37175437392 has completed.
- Resume steps:
  1. `prstate.sh backend 678/679/680` until the checks finish; rerun known flakes once.
  2. Post FIX ROUND 4 on #678 and #679 (READY FOR AUDIT only if their 7 checks are green).
  3. Post FIX ROUND 4 (restack, merge-only) on #680 without READY FOR AUDIT. Name the 4 stale tests and B-R3-116 as their owner.
  4. Update the 3 PR bodies.
  5. Delete the ci/ branch and remove the worktrees.
  6. Write the ## HANDOFF section.
