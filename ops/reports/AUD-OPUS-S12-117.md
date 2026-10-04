# AUD-OPUS-S12-117 — Claude Opus 5.5 lens, mobile coach setup split W1 (#345) and W2 (#346)

Agent 117. A full independent audit of both pieces at their exact heads. Opus never approved #329, so no earlier evidence was reused. No local jest or tsc was run; all probes went through the CI lane.

## Verdicts

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #345 (W1, base main) | `a4e4958820053b5aaa0f2d4a8c14f140816541b2` | REQUEST CHANGES | 0/2/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5977036236 |
| #346 (W2, base W1) | `4522eb8e550119a5cb770b93b9525290b4ffb03f` | REQUEST CHANGES | 0/2/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5977036337 |

Both heads were re-read immediately before and after posting; they were unchanged.

## CI

- #345 required checks green 4/4: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152922078/job/111290312174), [Analyze js-ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152922139/job/111290312064), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152922139/job/111290311953), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/111290408636).
- #346: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152924654/job/111290319845) green. CodeQL/Analyze only run on main-based PRs.
- Probe lanes (the expected outcome is FAIL at head; each failure is a counterexample):
  - #345 helper probe: [run 37180178650](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180178650): 3 failed / 1 passed (control passes).
  - #346 form probe: [run 37180389838](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180389838): 5 failed / 2 passed (paid and free controls pass).
  - [Run 37180193869](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180193869) is superseded. It was a harness error only (RNTL `render` is async here).
- Probe specs are kept at `/home/user/workspace/ops/aud-117/AUD-OPUS-S12-117/probes/`, with job logs in the same folder. The remote audit branches were deleted at job end.

## Split fidelity and structure

- The #347 tree (`ea2c72d1`) equals `git merge-tree --write-tree fc7fe73f 367e6c48`, so the stack top is #329 refreshed onto main.
- W1 is inert (no screen imports it until W2).
- W2 is not inert. It puts the checklist on the Command Center Overview header and registers the `CoachSetup` route.
- `FirstPackageForm` is mounted only by the W3 wizard (#347).

## #329 findings: disposition in the split

| Finding | Status | Where |
|---|---|---|
| A-329-1 (Money page) | Belongs to #348-#351 (composition, land as one); not blocking W1/W2. The checklist never routes to Earnings. | `CoachHomeCards.tsx:38-48` |
| B-329-1 (create durability) | Closed for its scope (strict write-ahead; unreadable is not "none"; editor durable). Residuals: B-329-5, C-345-1. | `packageCreateIntent.ts:322-326`, `FirstPackageForm.tsx:186-190` |
| B-329-2 (CONNECT_NOT_CONFIGURED copy) | Closed | `errors.ts:113` |
| B-329-3 (flat step body) | Closed | `coachSetupApi.ts:239-278` |
| B-329-4 (active with due items) | Closed | `connectCopy.ts:122`, `connectCopyStates.test.ts` |
| B-329-5 (Sol @fc7fe73f, admission after owner/unmount) | **Open**; proven by probe; split into helper (#345) and caller (#346) parts | see below |
| C-329-1 (live package) | Closed | `packagesApi.ts:449-460` |
| C-329-2 (server client signal) | Closed | `setupStatus.ts:89-106` |
| C-329-3 (wizard step 5) | In #347 (W3) | n/a |
| C-329-4 (checklist errors/retry) | Closed | `CoachSetupChecklist.tsx:186-188` |
| C-329-5 (tier header) | Was closed on #329; the split bodies lack the structured header (C-345-3) | PR bodies |
| C-329-6 (server idempotent create) | Closed by backend #675 (merged) | backend |
| C-329-7 (paid filter excludes chargeback_lost) | Closed earlier at #641 | backend |
| C-329-8 (410 needs two taps) | Closed; tested | `packageCreateIntent.ts:313-319`, `packageCreateDurability.test.tsx:242-` |

## Findings

### B-345-1 (#345): a cadence change after the package was made never reaches the server
- **File:line.** `src/lib/coachSetup/packageCreateIntent.ts:331-334` calls `deps.update(packageId, input)`. `src/api/packagesApi.ts:439-447` (`toBackendUpdate`) sends only name/description/amount_cents/currency/is_active. The stale TODO at `:435-436` is wrong: backend main `UpdatePackageDto` accepts billing_type/billing_interval/billing_interval_count (`src/packages/packages.dto.ts:115-128`).
- **Counterexample.** Probe run 37180178650:
  - Monthly made, then one-time picked: the PATCH has no `billing_type`.
  - Monthly made, then free picked: the PATCH carries only `amount_cents: 0`.
  - One-time made, then monthly picked: no `recurring` / `month`.
  - Form level (run 37180389838, case 3): the package is published monthly while `onCreated` reports one-time.
  - Free (case 4): the PATCH lacks `billing_type`. Backend main returns `PACKAGE_FREE_MUST_BE_ONE_TIME` (`packages.service.ts:870-874`) on every retry.
- **Fix rule.** `toBackendUpdate` maps `billingInterval` / `intervalCount` exactly as the create body does, and the stale TODO is removed. Add exact-PATCH-body tests for monthly->one-time, one-time->monthly and paid->free, plus a form-level test in #346 that the server cadence equals the cadence `onCreated` reports.
- **Verify.** Both probe specs' cadence cases pass at the new heads, with a failing-before lane run.
- **Side effect.** This also fixes the main package editor, which drops interval edits the same way (`CoachPackageEditScreen.tsx:183-184` on main, outside this diff).

### B-329-5 (Sol, retained): create admitted after the owner or mount changed
- **#345 helper part.** `packageCreateIntent.ts:322-329` runs `await saveIntent` -> `onIntent` -> `send` with no liveness check. The same gap exists at `:309-311` and `:331-334`.
- **#346 caller part.** `FirstPackageForm.tsx:194-219`. Checks happen only at `:193`, `:207` and `:215`. Publish, inviteLink and bind (`:208-212`) run unfenced, and `clearIntent` (`:217`) is followed by `setResumed` / `onCreated` (`:218-219`) with no check.
- **Counterexample.** Run 37180389838, cases 5-6: hold the write-ahead, then unmount or switch account, then release. Expected 0 creates; received 1. Mitigations (the identity gate unmounts navigators; the token is attached at send time) bound the impact but do not close the finding. The FIX ROUND 5 claim "every await re-checks the account and mount" is false at these heads.
- **Fix rule.** Pass an `isLive()` (account plus mount) predicate into `createPackageOnce` and check it after every await before onIntent/send/update/remember. Re-check in the form after `:208`, `:211`, `:212` and `:217`. When stopping, keep the saved intent.
- **Verify.** Probe cases 5-6 pass. Add a case where unmounting between publish and bind sends no bind.

### B-346-1 (#346): first-person copy
- **File:line.** `CoachSetupChecklist.tsx:121` "We will mark the moment with you when it lands."; `CoachSetupScreen.tsx:44` "Stripe, our payments partner, ...". Both are still present at #351. The same phrase appears at `CoachWizardNavigator.tsx:343` (#347; route it to the #347 lenses and builder).
- **Fix rule.** Rewrite impersonally, and extend the `\b(we|We|us|our|Our)\b|!` guard to the checklist strings and the setup screen.
- **Verify.** Run `git grep -nE "\b(We|we|our|Our|us)\b"` over the setup UI at the new head; the guard test is green.

### C-345-1 (#345): the guarantee does not survive sign-out
- **File:line.** `packageCreateIntent.ts:2-3,16-18` makes the claim, and the resumed copy at `FirstPackageForm.tsx:244` repeats it. `clearAllStorage()` at sign-out (`authActions.ts:379`, `mmkv.ts:248-254`) deletes the intent.
- **Counterexample.** A create whose answer was lost, followed by sign-out, sign-in and Create, goes out under a new key and leaves an extra draft.
- **Fix rule.** Narrow the claim and the copy to the same account on this device, or keep the coach-scoped intent through sign-out only if that fits the R15 shared-device wipe rule.

### C-345-2 (#345): W1 code is tested only in W3
Tests for stepBlob/saveStep, CONNECT_NOT_CONFIGURED, loadSetupStatus and qrPath are only in #347 (`coachSetup.test.tsx`, `coachSetupRound2.test.tsx`). This is acceptable only because the stack lands as one.

### C-345-3 (#345): PR body lacks the structured tier header
T4 appears only in prose and in the READY comment.

### C-346-1 (#346): async state writes have no stale or mount guard; wrong Retry target
- **File:line.** `CoachSetupChecklist.tsx:140-158`, `GetPaidPanel.tsx:57-99,174-182`, `InviteShareCard.tsx:60-96`. Separately, `GetPaidPanel.tsx:150` makes Retry open Stripe after a failed "Check status again".
- **Fix rule.** Add a per-load generation plus a mounted ref, and make Retry repeat the action that failed.

### C-346-2 (#346): an archived remembered package traps the form
- **Counterexample.** Run 37180389838, case 7: publish answers 400 `PACKAGE_ARCHIVED` (`packages.service.ts:614-619`) on every tap, and `onCreated` is never called.
- **Fix rule (mirrors C-329-8).** On PACKAGE_ARCHIVED or 404 for the intent's own package, clear the intent and make a fresh create in the same tap.
- **Verify.** Probe case 7 passes.

### C-346-3 (#346): fixes this piece needs live in later pieces
- B-332-7: `CoachHomeCards.tsx:22-48` navigates without `initial: false`, which can leave Settings with no root (no sign out, no account deletion). Fixed in #349.
- C-332-1: active sub-coaches get 403 on `/coach/connect/status` (backend `coach-connect.controller.ts:32`), so the checklist shows a permanent error. Fixed in #348.
- A-329-1 is fixed by #348-#351.
- This is non-blocking only if #345-#351 land together.

## Operator decisions

1. **Landing unit.** Land #345-#351 as one unit, with no OTA or build cut between W2 and #349. Default: yes. If W1-W3 land alone, B-332-7 and C-332-1 go live and A-329-1 stays unresolved.
2. **B-329-5 grade.** Opus grades it B (fleet identity re-check rule, T4, cheap fix, overclaimed FIX ROUND). Default: keep it as B.
3. **B-345-1 ownership.** The fix goes in `packagesApi.ts` (#345), with the form-level test in #346. Default: one fix round across W1 and W2.

## Open items

- B-345-1, B-329-5 (both parts), B-346-1 need a fix round followed by fresh exact-head dual verdicts on #345 and #346. #347 is affected by restacking and by the `CoachWizardNavigator.tsx:343` copy.
- The C findings above are optional; C-346-2 and C-345-1 are cheap.

## HANDOFF

- **Job.** AUD-OPUS-S12-117 (Claude Opus 5.5 lens, agent 117). Status: complete.
- **#345** @ `a4e4958820053b5aaa0f2d4a8c14f140816541b2`: REQUEST CHANGES, A/B/C 0/2/3. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5977036236)
- **#346** @ `4522eb8e550119a5cb770b93b9525290b4ffb03f`: REQUEST CHANGES, A/B/C 0/2/3. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5977036337)
- **Candidate CI.** Green (#345 4/4; #346 Typecheck/lint/test).
- **Probe runs.** [37180178650](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180178650) (#345, 3F/1P) and [37180389838](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180389838) (#346, 5F/2P).
- **Blocking (B).**
  - B-345-1: `packagesApi.ts:439-447` and `packageCreateIntent.ts:331-334`.
  - B-329-5: `packageCreateIntent.ts:322-329` and `FirstPackageForm.tsx:194-219`.
  - B-346-1: `CoachSetupChecklist.tsx:121` and `CoachSetupScreen.tsx:44`.
- **Closure test.** The kept probe specs pass at the new heads, and each fix has a failing-before CI lane run.
- **Non-blocking (C).** C-345-1/2/3, C-346-1/2/3, as listed above.
- **Defaults.** Land #345-#351 as one unit; B-329-5 stays B; one W1+W2 fix round, then fresh dual verdicts.
- **Cleanup.** Worktrees `/home/user/workspace/wt/AUD-OPUS-S12-117-345` and `-346` removed; remote audit branches `audit/AUD-OPUS-S12-117/345-cadence` and `audit/AUD-OPUS-S12-117/346-form` deleted. No PR branch was pushed, nothing was merged, no deploy was dispatched, and no money was spent.
