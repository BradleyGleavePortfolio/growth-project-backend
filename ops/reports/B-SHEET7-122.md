# B-SHEET7-122 — payment sheet m#342 main refresh (agent 122, builder Opus)

Start 17:49 PDT 10-05. Lock: ops/lanes122/locks/sheet-m.

## State
- m#342 branch agent115/sheet-split-1-payment-core, old head 4c79b67cbd211146abd76bd03349a4dd6e6de7c6 (audited top of #344 -> #343 -> #342).
- origin/main fb904a7593d58894989c70e4722fff12236daa59. Merge base cc4ceeed.
- Worktree /home/user/workspace/wt/B-SHEET7-122-1, merge commit db7fe53638de85e02b288744f136a34d72a1aef8 (parents 4c79b67 + fb904a75).

## Conflict resolutions (one merge commit)
1. config/expected-env.json: union. Main's EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS plus branch's EXPO_PUBLIC_GOOGLE_PAY_ENABLED, alphabetical.
   `node scripts/check-expected-env.js` OK (63 names).
2. src/screens/client/ClientPackagesScreen.tsx hunk 1 (header doc): main's "Update button opens native UpdateCard (1A)" + branch's
   "PlanTermsBlock / native PaymentSheet purchase" text; main's stale "Stripe Checkout in branded webview" line dropped (branch removed it).
3. ClientPackagesScreen.tsx hunk 2 (render): both. Main's `<SmartDunningBanner surface="ClientPackagesScreen" />` then branch's
   `<YourPlansPanel reloadKey={plansTick} />`.
4. Semantic: `navigateToBrandedCheckout` helper had zero callers after the merge (branch moved buy to PaymentSheet; main moved Update
   card to `navigation.navigate('UpdateCard', { autostart: true })`). Removed (27 dead lines). No behaviour change.
- Auto-merged (clean unions, checked): app.config.js (main NEVER_DECLARED_PERMISSIONS + branch wallet config), PackageDetailSurface.tsx
  (main 'weekly' interval). packagesApi.ts not touched by #342: no conflict. Lockout lives in DunningLockoutProvider/navigator (main),
  untouched by #342; DunningBanner returns null without provider so #342 tests unaffected.
- Size: PR diff vs main 7,589 + 550 = 8,139 (was 8,115). Grandfathered clean split stack (dual APPROVE), landed as one per A5 rule 11.

## CI
- Lane run 37396377567 (ci/B-SHEET7-122-1): tsc + 19 targeted spec paths. Pushed 17:53.

## HANDOFF
- If lane green: push db7fe536 to origin agent115/sheet-split-1-payment-core (fast-forward from 4c79b67), post MAIN REFRESH comment
  on m#342, wait PR CI, update this report, delete ci/B-SHEET7-122-1, remove worktree, release lock sheet-m.
