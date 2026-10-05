# AUD-SOL-P34-120 — agent 120 — GPT-6.1 Sol

## Mandate / current state

P3 verdict published: **REQUEST CHANGES 0/4/1** at `b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381`. [Exact Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359).

P4 verdict published: **REQUEST CHANGES 0/4/0** at `4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94`. [Exact Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).

First full T4 review of mobile Programs P3 #357 at `b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381` and P4 #358 at `4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94`; both heads claimed, initial metadata and comments preserved under `ops/aud-120/AUD-SOL-P34-120/`. [P3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357) / [P4](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358).

Read common 120/119/116/118 instructions, LAW, standing orders, merge dependency guide, relevant operator 115 handoff and prior Sol report. P3 is 2,421 changed lines; P4 is 1,323, both grandfathered below 3,000. [P3 size/readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5975773616) / [P4 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5975773622).

## Review completion

- Read complete P3/P4 diff and relevant helpers/server contracts; full review and evidence disposition published independently. [P3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359) / [P4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).
- Original #328 B1–B6 closures, C2 backend-first gate and C8 history-origin classification disposed by scope below, without copying the other current lens. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).
- All execution in GitHub CI lanes, exact candidate heads re-read immediately before publication, no candidate source edits, merges, deployment or heavy local execution.

## Findings / probes

Complete P3/P4 source diff read (all 14 changed files) and relevant Programs helpers, API response/request shapes, auth cache clearing, API interceptor, telemetry processors and backend idempotency/removal contracts. No candidate source changed.

P3/P4 Programs runtime/tests are byte-identical to original #328's last Sol-approved `fb76721fa21476cf36595fcd861a6b5a07630516` for the compared Programs paths. Prior B1 assignment keys, B2 immutable retry payload, B3 error recovery and B4 single conflict reload closures still apply to their original counterexamples; first full piece review challenges additional boundaries rather than relabeling them as open original findings. B5/B6 and C8 belong to #356's builder code, outside this job. [Prior Sol dispositions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5964883401).

Historical initial lanes, exact P3/P4 heads plus test-only commits (later corrected lanes are final evidence):
- P3 [run 37341628581](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628581): repeated conflict rebase, unknown day-picker intent change, duplicate cache identity, retired-screen create continuation; candidate screen/API/error controls.
- P4 [run 37341628728](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628728): continuation after unmount, 51-client refusal completeness, telemetry name metadata, all-runs removal warning; candidate fix-round controls.

Initial P3 lane: repeated conflict and day-picker changed-intent expectations genuinely fail; duplicate probe's `gcTime: 0` erased the unobserved cache entry, and awaiting a held async press prevented lifecycle resolution (test-seam failures, not proof). Initial P4 lane: post-unmount chunk continuation, unsanitized name metadata and misleading per-run removal warning genuinely fail; completeness stopped on a multiple-match text query, not the intended assertion. Candidate controls passed: P3 32, P4 7. [Initial P3 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628581) / [initial P4 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628728).

Corrected P4 lane proves all four findings: four behavioral failures, seven candidate controls passing. P3 v2 proves conflict, day-picker key/body reuse and wrong duplicate cache identity, but its lifecycle probe still hit a control-callback test seam; third ownership-only lane hit RNTL 14's removed unsafe query helper, not the candidate defect. [Corrected P4 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294) / [P3 v2 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342001881) / [ownership harness failure](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342331911).

Read the installed RNTL 14 implementation before final ownership probing: retain the unresolved `fireEvent.press` return promise (act itself settles independently), unmount/clear cache, then resolve the operation and await the press. Final P3 lane reaches all four actual behavioral assertions and has **4 failed / 32 candidate controls passed**, not a harness error. [Final P3 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342607062).

Published finding ledger (all eight B acceptance counterexamples executed):
- **B-357-1**, `ProgramFormScreen.tsx:153-173`: unresolved dirty-field conflict disappears on a later unrelated server revision; preserve it until explicit resolution or value convergence. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359).
- **B-357-2**, `ProgramDayPickerScreen.tsx:79-109,155-162`: Saved A lost response retains its key but accepts Saved B's body with that key; freeze immutable pending target/payload/key until authoritative resolution. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359).
- **B-357-3**, `ProgramEditorScreen.tsx:81-96,179-183`: Duplicate caches copy identity under original key; cache by returned identity, never a mismatched route id, test failed refresh/retry. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359).
- **B-357-4**, `ProgramFormScreen.tsx:211-226` (also P3 manual writes): old-session create completion repopulates cleared global cache after unmount; fence mount/account/operation generation across awaited cache writes, invalidation and navigation. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359).
- **B-358-1**, `ProgramAssignScreen.tsx:156-212`: second batch starts after unmount; capture/fence operation ownership, retire/abort on unmount/account change, preserve issued unknown intent. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).
- **B-358-2**, `ProgramAssignScreen.tsx:182-202,348-353`: global refusal marks only current 50 and omits remainder from results/Retry; account for every selected client and recover not-attempted remainder. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).
- **B-358-3**, `ProgramHistoryScreen.tsx:79-82`, `ProgramPackagesScreen.tsx:90`: client/package names enter diagnostic action metadata; separate local UI copy from bounded diagnostic codes, retain only approved opaque ids/status/reference. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).
- **B-358-4**, `ProgramHistoryScreen.tsx:53-75`: per-copy counts misdescribe all-runs removal; disclose all-runs scope and started/finished preservation, use authoritative totals or omit unprovable exact counts. [Published rule/evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).

Detailed counterexamples, precise code references, minimal fix rules and retest instructions are in the two posted verdicts and saved `verdict357.md` / `verdict358.md`. [P3 full verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359) / [P4 full verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).

## CI / evidence limits

Exact candidate combined Typecheck/lint/test context was SUCCESS for both; no main-only contexts were present on these stacked pieces, so green combined CI is not full merge/release eligibility. [P3 check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154711217/job/111295632771) / [P4 check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154713307/job/111295639368).

Final proof bundle: P3 lane head `09ba031420a47cd66fca89334711801ac072ecb8` (candidate + tests/workflow) gives 4 failures / 32 passed; P4 lane head `68733d0dbd8cd5c19fcf61848dd3cb53b2d7ce2e` gives 4 failures / 7 passed. No native device/server integration certification claimed. [P3 final lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342607062) / [P4 final lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294).

`gh run watch` and `gh run view --log-failed` used an unauthenticated jobs request and hit rate limit; recovery used authenticated REST metadata/log ZIP downloads, without repeating watch. Initial harness failures remain preserved and are not defects or final proof.

Portable final probes: `ops/aud-120/AUD-SOL-P34-120/P3-probes-final.test.tsx` (place as `src/screens/coach/programs/__tests__/audSolP34P3Boundaries.test.tsx`) and `P4-probes-final.test.tsx` (place as `.../audSolP34P4Boundaries.test.tsx`); all prior versions, logs, metadata, outbound payloads and comment receipts preserved.

## Follow-ups (C)

**C-357-1 (source finding, optional):** `ProgramAssetPicker.tsx:27-42` consumes only the first library page, ignoring `next_cursor`; provide search/paginated load-more for older assets, and never claim the entire library is empty when only a filtered first page is empty. [Exact picker](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramAssetPicker.tsx#L27-L42).

C-328-8 remains outside this diff in #356: head-count equality is not restore-origin proof; reset history or require durable origin. C-328-2 backend-first contract is an operator release acceptance gate, not a new UI defect. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).

## HANDOFF

**Review complete; both verdicts posted.** P3 REQUEST CHANGES 0/4/1, P4 REQUEST CHANGES 0/4/0 at exact heads above, no CI run outstanding. [P3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359) / [P4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).

**Cleanup complete, 2026-10-05 09:44:38 PDT (from `date`):** removed only own two worktrees and six local/remote throwaway branches; all final/intermediate probe files, patch bundles, log ZIPs, extracted logs, metadata and comment receipts remain under `ops/aud-120/AUD-SOL-P34-120/`. Cleanup receipts: `remote-cleanup.log` / `local-cleanup.log`. No candidate branch changed.

Fresh final check read: both exact-head combined Typecheck/lint/test contexts remain SUCCESS; no required main-only Analyze context claimed present. [P3 candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154711217/job/111295632771) / [P4 candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154713307/job/111295639368).

**Operator decisions / recommended default:** assign one programs builder to close all eight Bs, replay both lenses' probes, stay below each grandfathered 3,000 ceiling, restack P4, then fresh dual exact-head verdicts; ticket C-357-1 separately under freeze. Landing remains blocked and main-targeted required CI/release acceptance remains separate. [P3 operator recommendation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5998892359) / [P4 operator recommendation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).
