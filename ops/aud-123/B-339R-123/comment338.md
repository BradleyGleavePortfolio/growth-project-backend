MAIN REFRESH (B-339R-123, agent 123) — growth-project-mobile#338 @ 2d0288ca654ae18f7a071817441b73f1ccd75270

Previous head 48b5e6b5434fc5db207dcb14d97e5208a3d4b16f (dual APPROVE). Main 7083b7a1f91744fdc8101f7255417f778562e639 (m#345 / m#321 package editor). ONE merge commit, parents 48b5e6b5 + 7083b7a1. Kept main's editor, its save, publish and failure behaviour, and the rule that a package is free or costs $19.99 or more. Kept this PR's trial-days field and its wire field unchanged.

Backend contract check: b#671 @ 4315136a `src/packages/packages.dto.ts` has `CreatePackageDto.trial_days?: number` and `UpdatePackageDto.trial_days?: number | null`. Its error codes are PACKAGE_TRIAL_DAYS_OUT_OF_RANGE, PACKAGE_TRIAL_REQUIRES_RECURRING and PACKAGE_TRIAL_NOT_ON_FREE, and TRIAL_DAYS_MAX is 30. This PR sends `trial_days` and maps those three codes, so it already matches; nothing renamed.

`src/api/packagesApi.ts` (4 conflict hunks):
1. Header comment: main's UpdatePackageDto line (billing fields, null clears the cadence) plus this PR's trial_days note. "trial_days/features are TODO" became "features are TODO".
2. `trialDaysForBackend` helper (PR) placed before main's `toBackendCreate` (main sends currency; PR omits trial_days when there is no trial, C-338-3).
3. `BackendUpdateBody`: main's billing fields plus PR `trial_days?: number`. The TODO now lists only features. Main's B-345 doc comment is kept.
4. PR `trialDaysChange` and main's `PACKAGE_UPDATE_NOT_APPLIED` / `pricingAppliedMismatch` / `isLivePackage` are both kept. `toBackendUpdate` merged without a conflict: main's billing-when-changed block plus the PR's trial_days line.

`src/screens/coach/payments/CoachPackageEditScreen.tsx` (6 conflict hunks):
1. Imports: main's set plus `trialDaysChange`, `errorCode` and the `utils/packageTrial` import.
2. `validate`: main's price rule (`packagePriceIssue`), then the PR's `parseTrialDays` (0 to 30 days, renewing plans only). The payload now carries `trialDays`.
3. Edit save: main sends billing only when it changed (`rest` / `nextInterval`), plus `trialDays: trialDaysChange(original, v.payload)`. trial_days goes out only when the trial changed.
4. catch: main's IntentStorageError branch comes first, then the PR's coded trial refusal branch (title "Check the free trial", with the server message), then main's `describePackageSaveFailure` for edits and `describeError` for creates. Without this branch, a trial 400 on an edit would show main's generic "One of the details is not valid".
5. Buyer preview: shows the typed trial, because it now reaches the server. This replaces main's saved-trial-only preview, which assumed the trial never reached the server.
6. Form: the PR's trial block (None/3/7/14/30 chips, a 1 to 30 input and help text) on renewing plans, followed by main's resumed-create text. Main's "no trial input until m#338" comment is removed.

Integration lines (needed because main deleted the trial state):
- `trialText` state is added back and filled from the saved row and from a resumed create intent.
- `trialText` is added to the `validate` and preview memo deps.
- Main's `unsaved` publish gate (B-321-5 / B-347-4) also counts a typed trial that differs from the saved row, or an invalid one. Without this, a coach could type a 7-day trial, tap "Make ... live" and publish with no trial.

Tests (both sides pass):
- main `CoachPackageEditScreen.w3FixRound4` B-347-2: now pins no trial in the preview until one is set, then the typed 7.
- main `CoachPackageEditScreen.lockPreview` B-321-4: there is still no features input, and there are 4 inputs instead of 3. The typed trial reaches the PATCH as `trial_days: 7`.
- main `packagesBackendContract`: `trial_days` added to the DTO whitelist mirror (b#671 DTO).
- PR `packageTrial.test`: `toBackendUpdate` with a billingInterval now also sends main's billing fields.
- PR `CoachPackageEditScreen.trialDays`: the $0-on-monthly case now pins main's copy ("Free packages are one-time ..."), and the failure title is "Could not save the package".

Size vs main: 8 files, +599 -28 = 627 lines.

CI:
- Lane 1 (tsc + 20 package/setup specs): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400298581. tsc was green. 2 specs were red on main-vs-PR test pins, fixed above in the same merge commit.
- Lane 2 (the 2 fixed specs + trialDays + paymentsApi): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400639114 green
- PR CI at 2d0288ca: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400783437 green; CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400783473 green (MERGEABLE)

Merge order: backend main (76a59216) does not yet have `trial_days` on its package DTOs, and they reject unknown fields. Until the backend trials train (b#671 and the pieces above it) is deployed, a coach who picks a trial gets a 400 on save. A package with no trial still saves, because the field is left out (C-338-3). m#338 must merge only after that backend is live.

READY FOR AUDIT
