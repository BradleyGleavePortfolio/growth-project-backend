AUDIT Claude Opus 5.5 — growth-project-mobile#345 @ 90e113bbcf9d1df530bd692a407b1c214598523f — VERDICT: APPROVE

A/B/C = 0/0/3 (agent 122, AUD-OPUS-WZ7-122; RUTHLESS SCOPE; merge delta review of the main refresh only)

Scope checked: merge commit 90e113bb = parents f7a86065 (tree 71c4f04e, the WZ6 dual-approved #347 top) + main 3c315e40. Re-ran `git merge-tree` on the two parents: the only conflicts are src/api/packagesApi.ts and src/screens/coach/payments/CoachPackageEditScreen.tsx. `git diff <merge-tree result> 90e113bb^{tree}` touches only those two files plus the four named test files, so CoachNavigator.tsx and SettingsScreen.tsx are git's clean auto-merge, with no hand edits.

(a) One save path, one publish path: confirmed.
- `toBackendUpdate` (packagesApi.ts:394-418) sends the currency lower-case (main B-321-2). It sends billing only when `billingInterval` is passed; the edit screen passes it only when the coach changed it (CoachPackageEditScreen.tsx:300-304, main B-321-3). Switching to one-time sends `billing_interval: null` and `billing_interval_count: null` (packagesApi.ts:408-410, train B-345-1). Backend main accepts the null count and resets it to 1 (packages.dto.ts UpdatePackageDto `@IsOptional @IsInt @Min(1) billing_interval_count?: number | null`; packages.service.ts:412). The `pricingAppliedMismatch` check after a PATCH is unchanged (packagesApi.ts:516).
- There is one `publish` key: main's version, with `{}` body and `idemHeaders`, so every POST carries an Idempotency-Key (packagesApi.ts:526). `unpublish` comes from main. The train's duplicate key-less `publish` is gone, and nothing else calls it (git grep).

(b) Edit screen: confirmed.
- It keeps main's price rule and messages: `packagePriceIssue`, the inline `package-price-helper` text, and `describePackageSaveFailure` with its next actions (sign in, billing, back to packages, support).
- It keeps the train's durable create (`createPackageOnce`, saved create intent, resumed banner, `describeError` create copy).
- "Make <name> live" is `disabled={publishing || unsaved}` (:746), and the handler checks again (:410). `unsaved` compares name, description, price in cents and billing with the saved row (:218). A failed save leaves `unsaved` true.
- Live packages show "Unpublish package". Unpublish clears only `published_at` (backend), so `statusOf` turns the row back into a draft and "Make live" returns.
- Main's `statusOf` (a row with `published_at` null is a draft) agrees with the train's `isLivePackage`. No train screen depends on a draft being `status === 'active'` (git grep of status checks).
- B-347-4 stays closed. Story check: a coach edits the price and taps Make live without saving. The button is disabled and shows "Save your changes before making this live.", so the old price never goes on sale.

(c) Nothing dropped from either side: confirmed.
- From main: preview modal, contents and subscribers links, archived banner, weekly note, pricing-lock notice, share link, `priceIssueText` style.
- From the train: durable create, B-347-1 (free first package still saves at $0 one-time), B-347-2/B-321-4 (no trial or features input; preview shows only a saved trial), B-347-3 draft line.
- The removed earnings client (C-332-2) has no callers left.
- Test edits only rename labels or route both sides through the single path. The B-347-4 test still asserts no publish POST and `soldCents` null.

Builder decisions: agree with both defaults. A $0 one-time price stays allowed under main's fee rule, which matches backend #629. A blocked "Make live" is a disabled button with the inline line.

CI at this head: "Typecheck, lint, test" run 37394221262 SUCCESS (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394221262), CodeQL SUCCESS; MERGEABLE.

Cs (optional, no fix now):
- C-345-W7-1: the edit screen sends save failures through `describePackageSaveFailure` (CoachPackageEditScreen.tsx:381). That function has no case for the train's `PACKAGE_UPDATE_NOT_APPLIED` (409), so this failure gets the generic "problem on our side ... quote reference" copy (utils/packageSaveFailure.ts:355) instead of "The new price or billing did not save". This path only runs when the backend does not apply a billing change, and main's backend does apply it. C (edge, deferred to 10k clients).
- C-345-W7-2: main's copy uses the first person: "We could not archive the package..." (CoachPackageEditScreen.tsx:474) and "There was a problem on our side" (packageSaveFailure.ts:355). The owner copy rule says no first person. This came in from main and was not introduced by the resolution.
- C-345-W7-3: main has moved past 3c315e40 (a9bd947 touches CoachNavigator.tsx and SettingsScreen.tsx through auto-merge). Those files were not reviewed at a later head. If branch protection forces another refresh, check only those two auto-merged files.

Evidence: local read-only diffs against both parents and the merge-tree result. No lane run was needed (no B to prove). Notes: ops/aud-122/AUD-OPUS-WZ7-122/.
