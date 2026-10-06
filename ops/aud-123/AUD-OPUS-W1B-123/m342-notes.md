# AUD-OPUS-W1B-123 — m#342 @ 5acdf5ca204689dfca604339be9fd1b347f3b5d8 (merge resolution only)

Started 18:32 PDT. Scope: `git show --remerge-diff 5acdf5ca`.

Checks done
- Parents: 4c79b67c (train top, tree d7afdb57) + 7083b7a1 (on origin/main). Merge base cc4ceeed.
- Files changed on both sides vs merge base: app.config.js, config/expected-env.json, ClientPackagesScreen.tsx, PackageDetailSurface.tsx.
  - app.config.js auto-merge: main's NEVER_DECLARED_PERMISSIONS + branch's withWalletPlugin both present; H-vs-P1 diff == main's change exactly.
  - PackageDetailSurface.tsx auto-merge: H-vs-P1 diff == main's weekly label exactly.
  - expected-env.json: union, both keys, valid JSON object syntax (closing brace placed).
  - ClientPackagesScreen.tsx: header doc union (stale hosted-Checkout para dropped, correct: branch removed hosted Checkout); render keeps
    SmartDunningBanner then YourPlansPanel; navigateToBrandedCheckout removed (no callers; handleBuy uses usePackagePurchase);
    handleUpdateCard -> navigation.navigate('UpdateCard', {autostart:true}) kept (dunning pay path).
- planTerms.ts (semantic): PlanInterval already has "week"; purchasableFromPublicPackage weekly -> "week" (was falling to "month").
  asInterval also maps "week"/"weekly". Intent terms check (adoptIntentTerms) compares interval so a mismatch shows review, never silent charge.
- `git diff --name-only 7083b7a1 5acdf5ca` == the branch's 32-file set exactly => every main-only file (dunning lockout provider/screen/store,
  api lockedDunning, packagesApi, CoachPackageEditScreen, FirstPackageForm, CoachPackagesListScreen) byte-identical to main.
- `git diff --name-only 4c79b67c 5acdf5ca` = main's files + planTerms.ts only => no stray non-main change.
- Required checks at head: Typecheck/lint/test, CodeQL, Analyze x2 all SUCCESS.

Findings: A0 B0.
- C-342-1 (edge, deferred to 10k clients): main's packagesApi billingCycleToInterval maps any unknown billing_cycle to monthly; the
  backend public payload type has no weekly today, and the intent terms check shows real terms before payment. Main code, not this merge.
- Note: size 7,591+550 = 8,141 (collapsed dual-APPROVED train landed as one, rule 11); operator call, not a code finding.

Verdict: APPROVE.
