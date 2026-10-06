AUDIT Claude Opus 5.5 — growth-project-mobile#338 @ 2d0288ca654ae18f7a071817441b73f1ccd75270 — VERDICT: APPROVE

Lens AUD-OPUS-W1B-123 (agent 123), delta MR2. Scope: the merge commit (`git show --remerge-diff 2d0288ca`) plus everything main changed in `packagesApi.ts` and `CoachPackageEditScreen.tsx`.

**A 0 / B 0 / C 0**

- **Parents.** `48b5e6b5` is the prior head, dual APPROVE. `7083b7a1` is main. No other commit.
- **Main's editor is kept.** `git diff 7083b7a1 2d0288ca -- CoachPackageEditScreen.tsx` removes only main's "no trial input" comments, the saved-trial-only preview and the old `unsaved` and `updated` expressions. Each is replaced by its trial-aware version. Also kept unchanged:
  - `packagePriceIssue` (free one-time or $19.99 and up)
  - the billing-only-when-changed `rest`/`nextInterval` PATCH
  - `createPackageOnce` with durable intents and the resumed-create text
  - `IntentStorageError` and `describePackageSaveFailure`
  - publish/unpublish
- **`packagesApi.ts`.**
  - The header doc, `BackendUpdateBody` and `toBackendUpdate` take the union of both sides: main's billing fields, plus `trial_days` (sent only when the editor passes `trialDays`).
  - `toBackendCreate` omits `trial_days` when there is no trial, so a no-trial create never depends on the new backend.
  - Main's `PACKAGE_UPDATE_NOT_APPLIED`, `pricingAppliedMismatch` and `isLivePackage` are intact.
  - The row adapter maps `trial_days` to `trialDays`, so after a save `original` carries the trial.
- **Matches b#671 at its current head `2a6dfd98`** (moved from the `4315136a` the builder cited; re-checked):
  - `CreatePackageDto.trial_days?: number` and `UpdatePackageDto.trial_days?: number | null`
  - `TRIAL_DAYS_MAX = 30`
  - codes `PACKAGE_TRIAL_DAYS_OUT_OF_RANGE`, `_REQUIRES_RECURRING` and `_NOT_ON_FREE`, each with `code` in the body
  - The mobile `TRIAL_ERROR_CODES`, `parseTrialDays` (0 to 30, renewing plans only) and `errorCode` read all line up. The coded trial refusal is caught before main's generic edit failure, so the coach sees the server's specific sentence.
- **"Make live" waits for a save.** `unsaved` now also counts `!trial.ok` or `trialDaysChange(original, typed) !== undefined`. A typed 7-day trial disables publish until it is saved. After the save, `setOriginal(res.data)` carries `trial_days`, so the gate clears.
- **Story holds.** A coach adds a 7-day trial, saves (the PATCH carries `trial_days: 7`) and makes it live. The buyer preview shows the typed 7, because that value now reaches the server.
- **None of the 5 test adjustments is weaker:**
  - `lockPreview` B-321-4 still proves every input reaches the PATCH, now with 4 inputs including `trial_days: 7`.
  - `w3FixRound4` B-347-2 still pins no trial in the preview at first, then adds the typed 7.
  - `packagesBackendContract` adds `trial_days` to the DTO mirror, matching b#671.
  - `packageTrial.test` is stricter on the first case. The second case pins `billing_type` and `trial_days: 0`.
  - `trialDays.test` pins main's real failure title and main's $0-recurring copy.
- Size vs main: 9 files, +608 −28. Required checks at this head: Typecheck/lint/test, CodeQL, and Analyze (actions, javascript-typescript) are all SUCCESS.

Operator gate (not a finding): merge only after the backend trials train is deployed. Until then, current backend DTOs reject `trial_days`, so a coach who picks a trial gets a 400 on save, while no-trial saves are unaffected.
