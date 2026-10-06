AUDIT Claude Opus 5.5 — growth-project-mobile#342 @ 5acdf5ca204689dfca604339be9fd1b347f3b5d8 — VERDICT: APPROVE

Lens AUD-OPUS-W1B-123 (agent 123). Scope: merge resolution only (`git show --remerge-diff 5acdf5ca`), per the job entry.

**A 0 / B 0 / C 1**

What I checked
- Parents: `4c79b67c` (audited train top #344 -> #343 -> #342) and `7083b7a1` (on main). There are no other commits.
- `git diff --name-only 7083b7a1 5acdf5ca` is exactly the branch's 32-file set. So every file that only main touched is byte-identical to main, including the dunning lockout files (`DunningLockoutProvider`, `DunningLockoutScreen`, `dunningLockoutStore`, `api.lockedDunning`) and the coach package save/publish path (`packagesApi.ts`, `CoachPackageEditScreen`, `CoachPackagesListScreen`, setup `FirstPackageForm`). A client locked for non-payment still gets main's lockout handling, and a coach's package save/publish is unchanged.
- `git diff --name-only 4c79b67c 5acdf5ca` shows only main's files plus `src/lib/planTerms.ts`. Nothing else arrived.
- Hunks:
  1. `config/expected-env.json`: a union of main's `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS` and the branch's `EXPO_PUBLIC_GOOGLE_PAY_ENABLED`, with the braces correct.
  2. `ClientPackagesScreen.tsx` header doc: keeps main's UpdateCard note and the PaymentSheet note. Dropping the stale hosted-Checkout paragraph is correct.
  3. `ClientPackagesScreen.tsx` render: `SmartDunningBanner` then `YourPlansPanel`, with both behaviours kept. `handleUpdateCard -> navigate('UpdateCard', { autostart: true })` is intact.
  4. `navigateToBrandedCheckout` had no callers left, so removing it is correct. Buy goes through `usePackagePurchase` (PaymentSheet).
  5. `planTerms.ts` `purchasableFromPublicPackage`: weekly now maps to `"week"`, which is a valid `PlanInterval`. Before, it fell through to `"month"`. A weekly package now shows and confirms as weekly. The intent terms check (`adopted.interval !== pkg.interval`) still shows the real terms before any charge.
- Clean auto-merges also checked: `app.config.js` keeps main's `NEVER_DECLARED_PERMISSIONS` plus the branch's wallet plugin, and `PackageDetailSurface.tsx` keeps main's weekly label. Each H-vs-P1 diff equals main's change exactly.
- Story: a client taps a recurring package, the PaymentSheet opens, she pays, and she gets access at the price and interval the coach set (weekly stays weekly). Holds.
- Required checks at this head: Typecheck/lint/test, CodeQL, and Analyze (actions, javascript-typescript) are all SUCCESS.

Cs
- C-342-1 (edge, deferred to 10k clients): main's `packagesApi.billingCycleToInterval` maps any unknown `billing_cycle` to monthly. The public payload type has no weekly today, and the intent terms check catches any mismatch before payment. This is main code, not this merge.

Note for the operator: the PR is 7,591 + 550 = 8,141 changed lines vs main. That is the dual-APPROVED train landed as one (rule 11), not a code finding.
