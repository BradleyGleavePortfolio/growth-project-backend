# B-SHEET5-119 — mobile P3 #344 fix round (B-344-7, B-344-2 residual, B-344-3 residual)

Started 14:17 PDT 10-04 (lock lanes119/locks/sheet taken 14:17, released 14:33). Finished 14:33 PDT 10-04.
Start head #344 7e17d142d45cfcf6d922b6e78f79881be2428041 (2,866). #342 e3226f3b / #343 691e0cf0 untouched (frozen).

## Result
| PR | head | round | size | required CI | comment |
|---|---|---|---|---|---|
| mobile #344 S3 | bc4387ac9f1a35d8ad6746d8ece3cda75fe89ab4 | FIX ROUND 5, READY FOR AUDIT | +2,711/-247 = 2,958 (grandfathered, under 3,000; 42 left) | Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37236117451 green (Analyze: final-main gate) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984615650 |

Commits: 1836f7d (tests), bc4387a (fix). PR body tier header + Fix round row 5 updated. notify/sheet.txt written 14:33.

## Findings closed
- Opus B-344-7: planActions.ts outcome(o, trial): trial (scheduled end <= trial end) "Your free trial ends on <date>, and nothing is
  charged."; otherwise "Your plan will not renew. Access continues until <date>, and nothing more is charged." Converted trial gets paid wording.
- Sol B-344-2 residual (+ Opus C-344-13): stale card (list failed/unavailable) -> "Refresh your plans first" dialog, no destructive
  button, nothing sent; confirmed active/trialing consent adds "If a payment is overdue, ending it ends access now instead and cancels the unpaid charge."
- Sol B-344-3 residual: receipts {result, trial, gen}; each newer successful read drops a contradicted receipt; kept through failures.

## CI lanes (logs ops/aud-119/B-SHEET5-119/run*.log)
- Before https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235851899: 9 failed/124 (5 new, Opus P1, Sol 2 B probes, consent pin).
- After https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235878848: 451/457. Red: Opus P6 (evidence pin of old
  wording, by design), Opus SH3-118 exact consent pin (superseded by B-344-2 overdue clause), Opus Q5 INFO (C-343-8), Opus C-342-1 isCombo
  (held), 2 Sol Sh118 openPlanAction pins (superseded by B-342-1, as at 7e17d142).
- Probe placement script: ops/aud-119/B-SHEET5-119-place.sh.

## Follow-ups (C) (none folded)
- C-SH5-1 src/components/purchase/YourPlansPanel.tsx stale banner (~line 347) and stale dialog (~line 254): only Try again / Refresh plans; no Email support when cards are shown over a failed read. Fix: add the support action to the stale banner when the failed read had a status.
- Opus C-344-12 YourPlansPanel.tsx confirming line for dispute-paused / Day-10 locked plans (backend planView `locked` state; land gate for D2c #705).
- Opus C-344-14 / Sol C-344-12 planActions.ts:98-99 noAnswer "could not reach the server" for timeouts; fix "No answer came back from the server".
- Sol C-344-13 planActions.ts:186-195 SUBSCRIPTION_SETUP_UNAVAILABLE specific guidance.
- Sol C-344-1 ClientPackagesScreen.tsx:257-272 native card-update composition. Opus C-344-5/6/8/9/10/11 unchanged.

## Operator decisions (recommended default)
1. Stale-card End my plan is gated behind a refresh rather than a conditional dialog. Default: keep (true for every server state).
2. Overdue clause on every active/trialing consent (covers webhook-order race). Default: keep.
3. Land #342-#344 as one with final-main Analyze, recurring backend deploy, D4 #690 and native card-update composition. Default: yes.

## HANDOFF
- #344 @ bc4387ac: FIX ROUND 5 + READY FOR AUDIT posted at a green head. Next: Opus 5.5 + Sol audits at that exact head.
- Lock released; ci/B-SHEET5-119-* branches deleted; worktree and local branch removed. Nothing running. 42 lines of size headroom left.
