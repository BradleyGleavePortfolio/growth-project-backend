# B-DUNR3-122 — dunning train: main merge, restack, D3-D5 onto D2d, B-689-5 (agent 122)

Started 15:12 PDT 2026-10-05. Lock: ops/lanes122/locks/dunning (taken 15:12).
GitHub auth was 401 from 15:13 to about 15:41. During that time the work ran locally from an anonymous public clone (wt/B-DUNR3-122-repo). Everything was pushed after auth returned.

## Status
- [x] 1 #687 merge origin/main (5cde6253): coach-alert.emitter.ts resolved (sendPush only)
- [x] 2 restack #688 (merge-only), #704 (1 import hunk), #705 (merge-only), #724 (1 hunk)
- [x] 3 #689 <- #724, base -> agent121/dunning-split-2d-restart-fixes; #690 (9 files / 25 hunks), #691
- [x] 4 B-689-5 fix in #689; failing-before test in #691
- [x] 6 lane ci/B-DUNR3-122-1: run 37385825581 cancelled (stale head), 37386012832 failed tsc (D5 spec), 37386724702 at b0b47959 SUCCESS (tsc + 67 suites / 1,118 tests)
- [x] 7 comments posted + notify/dunning.txt

## Heads (old -> new)
- #687 d86b31a6 -> c140575c8b857023ce69ae28a1dcf6e8ab925335 (merge of main 5cde6253)
- #688 2662d01a -> 610c52542c0a1865bd9c448d78291d9d663f67fb (merge-only, tree 8965d815)
- #704 764af2e1 -> 524c4025e36fe4b3c925f7cc0072fd6951f01605 (import-block union)
- #705 2a03d7dd -> 346b77570eb4d40a344d4bd0007c70039c34981a (merge-only, tree 82e60a80)
- #724 e77a8d36 -> 410fb1b3b82b0ab49c8387a8d01e6e3ca6060a6c (lost-dispute block)
- #689 bb992fed -> 0fbd18cae72f4fdea7c4876034a0d3d1d3dac1cd (merge 4f875a39, fix ebb522fa, tsc fix 0fbd18ca)
- #690 06307883 -> c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae (merge 620c9e8b, fix f97c46e2, merge b3ae2f29, privacy-guard counts c15f157c)
- #691 e0afe678 -> 17cfa5662b7014a90d54a3d6747ae651c37e8793 (merge b2631440, specs+B-689-5 3641c007, merge d8c229a6, tsc b0b47959, merge 17cfa566)

Sizes: #687 2,648 vs main; #689 2,942 vs #724; #690 2,792 vs #689; #691 2,914 vs #690 (all at or under 3,000).

## Deviation
- One push per PR per round was exceeded: #689 x2, #690 x3, #691 x4. Each extra push fixed a CI failure: #689 tsc TS2339 x3 (main's untyped SetupIntent metadata / payment_method), the lane's tsc in the D5 money-truth spec (positional voidInvoice, trial_started_at), and #690's privacy guard (main's legacy exception-text counts: 12 -> 7, D4 sweep removed).

## Comments
Drafts in ops/aud-122/B-DUNR3-122/comments/c*.md (posted URLs in HANDOFF).

## HANDOFF
Stopped on operator WRAP UP (16:15); finished 16:18 PDT. No pushes after WRAP UP.

Final heads (all READY FOR AUDIT; comments posted 16:12):
- #687 c140575c8b857023ce69ae28a1dcf6e8ab925335, FIX ROUND 5: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-6005131529
- #688 610c52542c0a1865bd9c448d78291d9d663f67fb, RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-6005131822
- #704 524c4025e36fe4b3c925f7cc0072fd6951f01605, RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-6005132080
- #705 346b77570eb4d40a344d4bd0007c70039c34981a, RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-6005132366
- #724 410fb1b3b82b0ab49c8387a8d01e6e3ca6060a6c, RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/724#issuecomment-6005132695
- #689 0fbd18cae72f4fdea7c4876034a0d3d1d3dac1cd, FIX ROUND 3: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-6005133093
- #690 c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae, RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-6005133549
- #691 17cfa5662b7014a90d54a3d6747ae651c37e8793, FIX ROUND: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-6005133942

CI:
- Lane ci/B-DUNR3-122-1 run 37386724702 at #691 b0b47959: success (tsc --noEmit plus 67 suites / 1,118 tests). Lane branch deleted after the run.
- #687: all 17 checks green.
- #688, #704, #705, #724, #689: CI green. Some duplicate runs were cancelled by concurrency; the other run of each workflow at the same sha passed.
- #690, #691: CI (full suite) still in progress at 16:17. Dependency Audit, H4 deploy readiness and Schema parity are green.

Open items:
- #690 / #691 PR CI result is not yet known. B-DUNFIX-122 to check.
- Opus DUN1: RC B-690-8 on #690 (B-DUNFIX-122).
- Sol candidates B-689-S1 (inquiry cancel copy) and B-690-S1 (no coach restart route) were noted in notify/ and not touched (outside the item list).

Decisions (recommended defaults):
1. #690 lockout guard keeps D4 effectiveLock (one rule with the status endpoint): keep.
2. past_due last_error = decline code (D4 C-690-1) over main's Stripe message: keep code.
3. createSetupIntent onBehalfOf falls back to '' when no plan has a destination account: accept, flag for audit.
4. D5 / c680-18 specs rewritten to the D2c R-DISPUTE-PAUSE model and main's B-680-3 redelivery: accept.
5. D4's resolveDunningOnPaid skips v1 recordResolution on a paused plan: follow-up C.
6. Extra pushes beyond one per round (#689 x2, #690 x3, #691 x4), each a CI fix: accept.

Cleanup: lock ops/lanes122/locks/dunning released (deleted). Worktrees wt/B-DUNR3-122-{1,704,724,689,690,691} removed. Own clone wt/B-DUNR3-122-repo kept (main checkout, no worktrees). Main clone untouched.
