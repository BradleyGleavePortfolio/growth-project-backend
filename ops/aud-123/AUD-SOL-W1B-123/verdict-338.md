AUDIT GPT-6.1 Sol — growth-project-mobile#338 @ 2d0288ca654ae18f7a071817441b73f1ccd75270 — VERDICT: REQUEST CHANGES

Independent **MR2 merge-delta audit**, agent 123; **A/B/C: 0/1/0**. ([Reviewed merge](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

### B-338-MR2-1 — main's durable-create comparison drops a changed trial on an ordinary retry

**Normal-user story:** a coach gets a retryable create error, changes the free-trial choice from None to 7 days, and taps Create package again; the editor saves the earlier no-trial package and silently discards the selected 7-day trial. ([Merged create path](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

`src/lib/coachSetup/packageCreateIntent.ts:347–387,391–402` replays an earlier input and applies the current input with `deps.update` only when `sameCreateInput` differs; that comparison includes price/billing but **not trialDays**. The merge now passes the trial into main's durable create at `CoachPackageEditScreen.tsx:239,366–391`, but a None→7 change compares equal: no update occurs, `latest` contains the replayed zero-trial row, and the screen navigates with that old row at `:402–405`, hydrating the trial back to empty at `:192–194`. This needs no race, crash, date boundary or old app build—just one ordinary retry followed by a form edit. ([Exact helper and editor at this head](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

Read-only lightweight execution of the exact equality return expression produced **actual true / expected false** for otherwise identical inputs with trialDays 0→7; unchanged terms and a changed-price control behaved correctly. This is an equality probe plus a source-traced create flow, not a mounted-screen, network or native-device exercise. ([Predicate executed](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

**Fix:** include normalized trial days in the durable-create input comparison and add a sequential regression: first create gets a retryable error, the coach selects 7 days, the same-key create is retried, the existing package is updated to trial_days 7, and the resulting editor row/preview retains 7 days. Preserve the single-package/idempotency behavior; no wider hardening is requested. ([Affected comparison gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

### Other delta seams

The resolution otherwise retains main's free-or-$19.99 rule, billing-only-when-changed update, pricing-applied check, save failures and publish gate; typed trial changes are now correctly counted as unsaved, and the trial value reaches preview/create/PATCH. Reviewed all five adjusted test pins plus the unchanged publish tests; the preview/PATCH assertions now exercise the restored trial field, and price/error/DTO pins remain consistent with the new capability. ([Merge resolution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/2d0288ca654ae18f7a071817441b73f1ccd75270))

Rechecked refreshed backend #671 at `2a6dfd987af9081471d928f0c179b39b7f37df0d`: create/update `trial_days`, 0–30 rule and all three package trial refusal codes match; its DTO/rules are unchanged from the initial `4315136a` contract read. **Keep the existing operator gate: merge mobile #338 only after the backend trials train is deployed; that gate is not this finding.** ([Refreshed backend contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2a6dfd987af9081471d928f0c179b39b7f37df0d), [assigned deploy gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/338#issuecomment-6007681845))

Exact-head required contexts are green; existing PR CI logs show **tsc plus 572 suites / 8,058 tests passed**, and the final targeted lane passed **4 suites / 63 tests** with this head as its sole parent. Those existing controls do not test the changed-trial retry above. ([PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400783437), [targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400639114), [lane provenance](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/6ea49a8ccc9e4832c16a154bbf118785d4255aed))

Cs: none.
