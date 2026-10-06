MAIN REFRESH (B-WIZ6-122, agent 122) — growth-project-mobile#345 @ 90e113bbcf9d1df530bd692a407b1c214598523f

One merge commit, parents `f7a86065bfe7e128eb4437b4124b63c1c2bb254a` (the landed train top, tree 71c4f04e) + `3c315e40e83317a8ccf51431daa9ba98759df0bb` (mobile main, includes the m#321 S-FEE editor and m#379). No fix commit. Not a merge-only refresh (A5 rule 12 does not apply): two files had conflicts, so both lenses need a merge delta at this head.

CI lane (tsc + 28 package / wizard / money / S-FEE suites, 398 tests): green, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37393938209
PR CI at this head: "Typecheck, lint, test" running, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394221262 (result follows in a one-line comment).

## Conflicts and how each was resolved

### src/api/packagesApi.ts
1. `fromBackend` (status + interval): took main's `statusOf` (a row with `published_at: null` is a draft). Both sides already read `billing_interval ?? interval`.
2. `BackendUpdateBody`: kept the train's typing (`billing_interval_count?: number | null`).
3. `toBackendUpdate` signature: kept the train's B-345-1/2 doc comment. Both sides exported it.
4. `toBackendUpdate` body: ONE billing path. Main's lower-case currency (B-321-2). Billing goes out only when the caller passes `billingInterval` (B-321-3: the editor passes it only when the coach changed it; the wizard always passes it). One-time sends `billing_interval: null` and `billing_interval_count: null` (train B-345-1; the backend resets the count to 1). `pricingAppliedMismatch` / `PACKAGE_UPDATE_NOT_APPLIED` (B-345-2) still checks every billing PATCH.
5. Auto-merged duplicates: `coachPackagesApi` had two `publish` keys. Kept main's (Idempotency-Key, same `POST :id/publish` route the wizard uses) and removed the train's copy. Removed duplicate `interval` / `published_at` fields in `BackendPackageRow`.

### src/screens/coach/payments/CoachPackageEditScreen.tsx (19 hunks; the train had reformatted the file, so I started from the train's version and ported S-FEE into it)
- **Price rule:** S-FEE `packagePriceIssue` plus the inline `package-price-helper` replace the train's `freeKept` check. The free first package still saves at its $0 one-time price (B-347-1). A $0 recurring price is refused with the S-FEE copy.
- **Inputs:** no trial input (B-347-2) and no features input (B-321-4). The preview drops typed features and shows only a trial the saved package already has.
- **Save, edit mode:** billing goes out only when it changed (B-321-3). Failures go through `describePackageSaveFailure`, which gives a next action, Try again and a reference (B-321-1).
- **Save, create mode:** kept the train's durable create (`createPackageOnce`, the stored intent, the resumed banner, B-329-1) and its `describeError` create copy.
- **Publish (one path, `handlePublishToggle`):** a draft shows "Make <name> live" (B-347-3). The button is disabled while the form has unsaved edits, and the line under it reads "Save your changes before making this live." (`SAVE_BEFORE_PUBLISH`, B-347-4 and B-321-5). A live package shows "Unpublish package" (S-FEE r4). Publish and unpublish failures use the S-FEE copy with retry. The row the server returns decides whether the coach sees "Package is live" or "Still a draft".
- **From main:** the archived banner, the archive failure copy and the weekly billing note.

### Test assertions that follow the single path (all other tests on both sides unchanged)
- `CoachPackageEditScreen.lockPreview.test.tsx` (main): "Publish package" becomes "Make Strength Builder live". "Package published" becomes "Package is live". The draft state is checked by its text. The unsaved line is checked by testID `package-edit-publish-unsaved`.
- `CoachPackageEditScreen.w3FixRound4.test.tsx` (train): a name-only edit of the free package sends no `billing_type`, and the publish POST carries the Idempotency-Key header.
- `CoachPackageEditScreen.w3FixRound5.test.tsx` (train): a blocked "Make live" is now a disabled button, so the old "Save your changes first" alert is gone.
- `packagesBackendContract.test.ts` (main): the one-time body also carries `billing_interval_count: null`.

## Decisions (recommended defaults)
1. A paid one-time package can now be set to $0. S-FEE allows this (free means $0 one-time, and backend #629 accepts it), so the train's older rule that refused a new $0 on a paid package is superseded. Default: keep the S-FEE rule.
2. A blocked "Make live" is a disabled button with the reason shown under it (S-FEE B-321-5), not the train's alert on tap. Default: keep.

READY FOR AUDIT
