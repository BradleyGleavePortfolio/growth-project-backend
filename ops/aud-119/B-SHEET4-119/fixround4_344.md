FIX ROUND 4 (restack + tests, B-SHEET4-119, agent 119) — growth-project-mobile#344 @ 7e17d142d45cfcf6d922b6e78f79881be2428041

Restack of #343 FIX ROUND 3 (`691e0cf`, which carries #342 FIX ROUND 3 `e3226f3`) onto P3: merge commit `7009196` (clean, no conflict). Then one tests-only commit `7e17d14`, placed here because #343 has 65 lines left under its grandfathered ceiling (operator rule).

Size: +2,619 / -247 = 2,866 changed lines (tests included). Grandfathered PR, under its 3,000 ceiling.

## B-SHEET3-119 FIX ROUND 3 content survives unchanged
- `8f53887a` (FR3 head) is an ancestor of this head; commits 0ac7fea, aff733b, 8f53887 are unchanged (stable patch-ids 1c276e44, 6826213f, 9cc26c5e).
- `git diff 8f53887a 7e17d14 -- <every file FR3 touched>` is empty (YourPlansPanel.tsx, planActions.ts, ClientPackagesScreen.tsx, YourPlansPanel.recovery.test.tsx).
- `git diff 8f53887a 7e17d14` touches only: packagePayment.ts and its replyCodes test (from #342), usePackagePurchase.ts and PackageSelectionSheet.payment.test.tsx (from #343), and this round's test commit below.

## Tests commit 7e17d14
| Finding | Test |
|---|---|
| #343 B-343-1 (Sol) | new src/hooks/__tests__/usePackagePurchase.nativeFence.test.tsx: 8 rejected initStripe/initPaymentSheet x one-time/renewing x logout/login, 2 unmount, 2 same-account controls |
| #342 B-342-1 (Sol), hook flow | same file: unknown card step -> same-key retry -> PACKAGE_NOT_FOUND, one-time and renewing: same key, no no-charge claim, support + Open your plan, the unclear notice's reference, next tap still the same key |
| #342 B-342-1 consumers | PackageSelectionSheet.subscription.test.tsx:374 and PackageCheckoutScreen.buyer.test.tsx:181 pin the new sheet and share-link wording (exact, reference as [0-9a-f]{8}) |

Failing before: the new suite failed 10 / 14 on #343's pre-fix head (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232859355; the 4 B-342-1 hook cases already passed there because S1's fix was merged in; S1's own failing-before is https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232648574).
After, top tree (21 suites: every package suite, Sol and Opus S12-119 probes, B-SHEET3-119's YourPlansPanel Opus/Sol probe copies): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233045102 — 354 / 355; the one red test is Opus Q5 INFO (C-343-8, red by design).
Prior-round lens probes at this tree: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233619554 — 96 / 99; red: Opus C-342-1 isCombo (held C) and two Sol Sh118 openPlanAction copy pins superseded by Sol's B-342-1 rules.
Required check at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233295816 pass. Analyze contexts run only on main-based PRs: final-main gate.

READY FOR AUDIT (restack)
