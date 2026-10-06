# AUD-SOL-W1A-123 — AV3 add-on evidence

Started 2026-10-05 18:38:18 PDT, deadline 18:58:18 PDT. Independent delta review only; no Opus round comments or notes read.

## Scope

Reviewed mobile #381 head `5c13f14428c9d541996287f5869a92c72834e4c4` from the own prior Sol verdict at `feab0c3b74479d2c3b644e91f301a76d92222c0e`; prior B-381-1 is the guaranteed client booking dead end when a coach saves minimum notice of 14 days or more. ([PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [prior Sol review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6006810212))

The operator selected the fix of refusing 14+ days and stopping inputs below that range, rather than adding client forward-range navigation.

## Fix and regression checks

`NOTICE_UNDER_MINUTES` uses the same `OPEN_SLOTS_RANGE_DAYS = 14` that the client open-slots hook uses; validation rejects notice >= 20160 minutes, and both numeric editing and unit changes clamp below that boundary with the specified sentence. ([Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fscreens%2Fcoach%2FCoachBookingOptionsScreen.tsx), [calendar hook](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fhooks%2FuseCalendar.ts))

The accepted whole-unit maxima are 13 days, 335 hours, and 20159 minutes; the two-day save remains 2880 minutes, and the notice-shorter-than-window validation remains intact. ([Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fscreens%2Fcoach%2FCoachBookingOptionsScreen.tsx), [regression tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fscreens%2Fcoach%2F__tests__%2FcoachBookingOptions.test.tsx))

Reviewed fix commit `eab75ececc60380b216e39111d744635cb1b0e06`; its only files are the booking editor and its regression test. ([PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

Verified merge `413974bde2b22f380989272204b56dd3c04f7203` parents are the fix and main `7083b7a1f91744fdc8101f7255417f778562e639`; `git show --remerge-diff` has no resolution changes, and editor/hook/entry/regression-test blobs are identical before and after it. ([PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

Read final Settings lines 466–481 and 553–560: both Money and Booking options entries remain; navigator lines 421–422 and 541–548 retain booking options and Money routes. ([Settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fscreens%2Fcoach%2FSettingsScreen.tsx), [navigator](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fnavigation%2FCoachNavigator.tsx))

Final commit changes one test file only, adding six lines to mock the query-dependent BookingOptionsEntry in the unrelated Settings money-row harness; existing assertions are not weakened. ([Harness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/5c13f14428c9d541996287f5869a92c72834e4c4/src%2Fnavigation%2F__tests__%2FcoachSettingsMoneyRow.test.tsx))

C-381-1 carries unchanged and remains non-blocking: client notice/window refusal wording is less specific than the backend's sentences; no fix or further analysis requested. ([Prior Sol C](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6006810212))

## CI / size

Size is +712/-1 = 713 changed lines over ten files, under 1500. ([PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

All three required checks are green; the authenticated jobs API confirms lint, typecheck, and test success at exact head `5c13f14428c9d541996287f5869a92c72834e4c4`. ([Head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37399726301/job/112063975157))

No local tests/builds, new lane, worktrees, commits, pushes, merges, deployments, or production access.

## Posted and verified

Completed 18:40:31 PDT. Revalidated the exact head immediately before posting and fetched only the own new comment ID to verify the required first line.

APPROVE, A/B/C 0/0/1, with B-381-1 resolved, no new findings, and one unchanged carried C. ([Posted Sol AV3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6007572796))
