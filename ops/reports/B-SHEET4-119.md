# B-SHEET4-119 — mobile P1 #342 + P2 #343 (+ restack/tests P3 #344)

Started 13:31 PDT 10-04 (lock lanes119/locks/sheet taken 13:31, released 13:55). Finished 13:55 PDT 10-04.
Start heads: #342 0b1985f4, #343 19678ce7, #344 8f53887a.

## Result
| PR | head | round | size | required CI | comment |
|---|---|---|---|---|---|
| #342 S1 | e3226f3b50a1f609aea7805600ec124324cd12aa | FIX ROUND 3, READY FOR AUDIT | +2,190/-17 = 2,207 | Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747197, Analyze x2 https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747242, CodeQL: green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5984292430 |
| #343 S2 | 691e0cf02a48db3e2d62f7c502673d9f1ef62215 | FIX ROUND 3, READY FOR AUDIT | +2,675/-260 = 2,935 | Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232961197 green (Analyze: main-only, final-main gate) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984292582 |
| #344 S3 | 7e17d142d45cfcf6d922b6e78f79881be2428041 | FIX ROUND 4 (restack + tests), READY FOR AUDIT (restack) | +2,619/-247 = 2,866 | Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233295816 green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984292690 |

All grandfathered, each under 3,000. PR bodies updated (tier header + Fix round rows).

## Findings closed
- Sol B-342-1 (residual): packagePayment.ts PACKAGE_NOT_FOUND copy is now packageUnavailable(ref) / packageUnavailableShareLink(ref),
  no no-charge claim; support + openPlan; key kept; reload on the sheet only; reference = attempt key ref, else request id; no Sentry.
  #342 commits ab41a59 (test), e3226f3 (fix).
- Sol B-343-1 (residual): usePackagePurchase.ts runSheet init catch returns STALE when !live() before building/reporting; both callers
  re-check !live() after await runSheet. #343: 40b8573 (merge #342), 691e0cf (fix + payment.test copy pin).
- #344: 7009196 (merge #343), 7e17d14 (new usePackagePurchase.nativeFence.test.tsx 14 tests; subscription.test.tsx:374 and
  PackageCheckoutScreen.buyer.test.tsx:181 copy pins). FR3 (B-SHEET3-119) files byte-identical; 8f53887 ancestor; patch-ids
  1c276e44 / 6826213f / 9cc26c5e.

## CI lanes (logs ops/aud-119/B-SHEET4-119/run*.log)
- #342 before https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232648574 (6 failed/163); after https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232722067 (tsc + 165/165).
- #343 before https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232859355 (20 failed/73); after https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233062601 (97/98, Opus Q5 INFO only).
- #344 top tree https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233045102 (354/355, Opus Q5 INFO only). Prior-round lens probes https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233619554 (96/99: Opus C-342-1 isCombo held;
  2 Sol Sh118 openPlanAction old-copy pins superseded by B-342-1). Prior probe copies: ops/aud-119/B-SHEET4-119/prior-probes/.

## Follow-ups (C) (none folded; none sit on the B lines)
- Sol C-342-8 / Opus C-342-7 src/lib/packagePayment.ts:459-460 noAnswer "could not reach the server" also for timeouts; fix: "No answer came back from the server"; non-axios errors to unknown + Sentry.
- Sol C-343-8 / Opus C-343-7 src/lib/packagePayment.ts:492-493 (endedWhileConfirming) "the team will put it right"; fix: "so the team can check it".
- Opus C-343-9 src/lib/packagePayment.ts:490-491 checkoutEnded has no caller; fix: delete it or use only where checkout_state proves no payment.
- Sol C-343-5 src/hooks/usePackagePurchase.ts:1117-1150 inFlightRef held by an old-epoch await; fix: tag the guard by epoch, old finally never clears a newer guard.
- Sol C-343-6 PackageSelectionSheet.tsx:235-258,324-339 CTA live after PAYMENT_ALREADY_COMPLETE; fix: done/status state.
- Sol C-343-7 / Opus C-343-8 PackageSelectionSheet.tsx:247-252,317-322 + Day1WinScreen.tsx:190-194,229-233 + RootNavigator.tsx:908-912: wire onOpenPlan to Membership (Opus probe Q5 red by design until then).
- New C-SH4-1 the PACKAGE_NOT_FOUND notice offers "open your plan in Membership"; on sheet callers without onOpenPlan the action reads "Continue to the app" (same as C-343-7/8); fixed by the same wiring.
- Held/unchanged: C-342-1 (isCombo), C-342-2 (land as one), C-342-4, C-342-5, Sol C-342-7 (CoachPackageEditScreen /100), C-343-1, C-343-2.

## Operator decisions (recommended default)
1. One PACKAGE_NOT_FOUND wording for every case (fresh tap or replay), since the app cannot know about a pre-restart attempt. Default: keep.
2. Land #342-#344 as one with final-main Analyze, backend recurring deploy and native card-update composition (unchanged gates). Default: yes.

## HANDOFF
- #342 @ e3226f3b, #343 @ 691e0cf0: FIX ROUND 3 + READY FOR AUDIT posted at green heads. #344 @ 7e17d142: FIX ROUND 4 (restack + tests) + READY FOR AUDIT (restack). Next: Opus 5.5 + Sol audits at those exact heads (Sol closes its B-342-1 / B-343-1; both lenses delta on #344).
- Lock released; notify/sheet.txt written (13:55); ci/B-SHEET4-119-* branches deleted; worktrees and local branches removed. Nothing running.
