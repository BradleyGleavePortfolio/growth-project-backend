# B-SHEET7B-122 — payment sheet m#342 main refresh (agent 122 last job, builder Opus)

Start 18:06 PDT 10-05 (time box 30 min, to 18:36). Lock ops/lanes122/locks/sheet-m taken over 18:07.
START comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-6007179460

## State
- m#342 branch agent115/sheet-split-1-payment-core, old head 4c79b67cbd211146abd76bd03349a4dd6e6de7c6 (audited top of #344 -> #343 -> #342).
- origin/main moved since B-SHEET7-122: now 7083b7a1f91744fdc8101f7255417f778562e639 (adds notifications m#341 over fb904a75).
- B-SHEET7-122's unpushed merge db7fe536 (vs fb904a75) failed its lane (run 37396377567): tsc error
  src/screens/client/PackageCheckoutScreen.tsx(156,70) — main widened PackageBillingInterval with 'weekly';
  planTerms.purchasableFromPublicPackage still typed the 4 old values.
- Redone as ONE fresh merge: worktree /home/user/workspace/wt/B-SHEET7-122-1 (reused), merge commit
  5acdf5ca204689dfca604339be9fd1b347f3b5d8 (parents 4c79b67 + 7083b7a1). Not pushed to the PR branch until the lane is green.

## Conflict resolutions (one merge commit)
1. config/expected-env.json: union. Main's EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS + branch's EXPO_PUBLIC_GOOGLE_PAY_ENABLED, alphabetical.
2. src/screens/client/ClientPackagesScreen.tsx header doc: main's native UpdateCard note (OR-110-2, 1A) + branch's PlanTermsBlock /
   PaymentSheet purchase note; main's stale "Stripe Checkout in branded webview" paragraph dropped (branch removed hosted Checkout).
3. ClientPackagesScreen.tsx render: both. Main's `<SmartDunningBanner surface="ClientPackagesScreen" />` then branch's
   `<YourPlansPanel reloadKey={plansTick} />`. Main's handleUpdateCard -> navigation.navigate('UpdateCard', { autostart: true }) kept;
   branch's handleBuy -> usePackagePurchase kept.
4. Semantic: navigateToBrandedCheckout had zero callers after the merge; removed (dead code, no behaviour change).
5. Semantic (new vs B-SHEET7-122): src/lib/planTerms.ts purchasableFromPublicPackage accepts 'weekly' and maps it to cadence 'week'
   (otherwise it would fall to 'month'). Today adaptPublicPackage never emits 'weekly', so no runtime change; fixes the tsc break.
- Auto-merged clean: app.config.js, PackageDetailSurface.tsx (main 'weekly' label). Lockout lives in main's DunningLockoutProvider /
  navigator, untouched by #342. Main's package save/publish (packagesApi.ts, CoachPackageEditScreen, setup FirstPackageForm) untouched by #342.
- Check: tree(5acdf5ca) - tree(db7fe536) == diff fb904a75..7083b7a1 exactly, plus the planTerms hunk.
- Size: PR diff vs main 7,591 + 550 = 8,141 (was 8,139). Grandfathered dual-APPROVE split stack landed as one (A5 rule 11).

## CI
- Lane run 37397761635 (ci/B-SHEET7B-122-1, pushed 18:09): tsc + 41 suites / 754 tests green
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37397761635
- Pushed 5acdf5ca to agent115/sheet-split-1-payment-core 18:12 (fast-forward from 4c79b67; main still 7083b7a1).
- PR CI "Typecheck, lint, test" green https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37397953042 ; CodeQL green. MERGEABLE.
- MAIN REFRESH comment (READY FOR AUDIT) 18:16: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-6007311469

## HANDOFF
- Done. m#342 head 5acdf5ca204689dfca604339be9fd1b347f3b5d8, READY FOR AUDIT (Opus + Sol, delta = `git show --remerge-diff 5acdf5ca`, hunks 1-5).
- Cleaned: ci/B-SHEET7B-122-1 and ci/B-SHEET7-122-1 deleted, worktree wt/B-SHEET7-122-1 removed, lock sheet-m released. Agent 123 may push.
- Auditor focus: hunk 5 (planTerms weekly -> 'week') is the only line not in B-SHEET7-122's earlier resolution; it is type-driven, no runtime change today.
