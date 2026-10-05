# AUD-SOL-P34-120 — agent 120 — GPT-6.1 Sol

## Mandate / current state

P4 verdict published: **REQUEST CHANGES 0/4/0** at `4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94`. [Exact Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5998829473).

First full T4 review of mobile Programs P3 #357 at `b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381` and P4 #358 at `4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94`; both heads claimed, initial metadata and comments preserved under `ops/aud-120/AUD-SOL-P34-120/`. [P3](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357) / [P4](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358).

Read common 120/119/116/118 instructions, LAW, standing orders, merge dependency guide, relevant operator 115 handoff and prior Sol report. P3 is 2,421 changed lines; P4 is 1,323, both grandfathered below 3,000. [P3 size/readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5975773616) / [P4 readiness](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5975773622).

## Review plan

- Read complete P3/P4 diff and relevant helpers/server contracts.
- First disposition prior #328 B1–B6 closures, C2 backend-first gate and C8 history-origin classification; do not copy another lens's verdict. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).
- Run any independent probes only using GitHub CI lanes.
- Re-read exact candidate heads immediately before posting verdicts; no candidate source edits, merges, deployment or heavy local execution.

## Findings / probes

Complete P3/P4 source diff read (all 14 changed files) and relevant Programs helpers, API response/request shapes, auth cache clearing, API interceptor, telemetry processors and backend idempotency/removal contracts. No candidate source changed.

P3/P4 Programs runtime/tests are byte-identical to original #328's last Sol-approved `fb76721fa21476cf36595fcd861a6b5a07630516` for the compared Programs paths. Prior B1 assignment keys, B2 immutable retry payload, B3 error recovery and B4 single conflict reload closures still apply to their original counterexamples; first full piece review challenges additional boundaries rather than relabeling them as open original findings. B5/B6 and C8 belong to #356's builder code, outside this job. [Prior Sol dispositions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5964883401).

Independent lanes dispatched on exact P3/P4 heads plus test-only commits; no result yet:
- P3 [run 37341628581](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628581): repeated conflict rebase, unknown day-picker intent change, duplicate cache identity, retired-screen create continuation; candidate screen/API/error controls.
- P4 [run 37341628728](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628728): continuation after unmount, 51-client refusal completeness, telemetry name metadata, all-runs removal warning; candidate fix-round controls.

Initial P3 lane: repeated conflict and day-picker changed-intent expectations genuinely fail; duplicate probe's `gcTime: 0` erased the unobserved cache entry, and awaiting a held async press prevented lifecycle resolution (test-seam failures, not proof). Initial P4 lane: post-unmount chunk continuation, unsanitized name metadata and misleading per-run removal warning genuinely fail; completeness stopped on a multiple-match text query, not the intended assertion. Candidate controls passed: P3 32, P4 7. [Initial P3 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628581) / [initial P4 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341628728).

Corrected P4 lane proves all four findings: four behavioral failures, seven candidate controls passing. P3 v2 proves conflict, day-picker key/body reuse and wrong duplicate cache identity, but its lifecycle probe still hit a control-callback test seam; third ownership-only lane hit RNTL 14's removed unsafe query helper, not the candidate defect. [Corrected P4 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342003294) / [P3 v2 execution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342001881) / [ownership harness failure](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342331911).

Read the installed RNTL 14 implementation before correcting ownership probing: retain the unresolved `fireEvent.press` return promise (act itself settles independently), unmount/clear cache, then resolve the operation and await the press. Final P3 lane is [37342607062](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342607062), pending result.

Pending verdict finding ledger:
- B-357-1, `ProgramFormScreen.tsx:153-173`: unresolved dirty-field conflict is discarded on a later unrelated server revision; preserve pending conflicts until explicit resolution or value convergence.
- B-357-2, `ProgramDayPickerScreen.tsx:79-109,155-162`: Saved A lost response keeps a key but accepts Saved B with that same key/body mismatch; freeze an immutable pending intent through authoritative outcome resolution.
- B-357-3, `ProgramEditorScreen.tsx:81-96,179-183`: Duplicate writes the copy under the original program's detail key; cache by returned identity, never a mismatched route id (corrected probe pending).
- B-357-4, `ProgramFormScreen.tsx:211-226` (also other P3 manual writes): old-session completion can write global cache/navigate after retirement; fence mount and account generation across each awaited side effect (corrected probe pending).
- B-358-1, `ProgramAssignScreen.tsx:156-212`: next batch request starts after unmount; capture/fence operation owner, abort/retire after unmount/account change, preserve already-issued unknown intents.
- B-358-2, `ProgramAssignScreen.tsx:182-202,348-353`: global refusal breaks after marking only current 50, omitting the selected remainder from outcomes/recovery; explicitly account for every selected client (corrected probe pending).
- B-358-3, `ProgramHistoryScreen.tsx:79-82`, `ProgramPackagesScreen.tsx:90`: dynamic client/package names passed as telemetry action; split local UI text from bounded diagnostic operation codes and retain only opaque ids/status/reference.
- B-358-4, `ProgramHistoryScreen.tsx:53-75`: one-copy workout counts are used for an all-client-runs removal; show truthful all-runs scope and started/finished preservation, use authoritative preflight totals or omit unprovable exact counts.

Each ledger item remains subject to corrected execution inspection; exact candidate locations: [P3 form](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramFormScreen.tsx), [P3 picker](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramDayPickerScreen.tsx), [P3 editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramEditorScreen.tsx), [P4 assignment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramAssignScreen.tsx), [P4 history](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94/src/screens/coach/programs/ProgramHistoryScreen.tsx).

## CI / evidence limits

Exact candidate combined Typecheck/lint/test context was SUCCESS for both; no main-only contexts were present on these stacked pieces, so green combined CI is not full merge/release eligibility. [P3 check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154711217/job/111295632771) / [P4 check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37154713307/job/111295639368).

`gh run watch` and `gh run view --log-failed` unexpectedly used an unauthenticated jobs request and hit rate limit; used authenticated REST run metadata and log ZIP downloads instead. No repeated watch attempt. Logs and both original probe files remain in evidence folder; corrected versions will also be preserved.

## Follow-ups (C)

Potential C-357-1: `ProgramAssetPicker.tsx:27-42` consumes only the first library page, ignoring `next_cursor`; provide search/paginated load-more for older assets, and never claim the entire library is empty when only a filtered first page is empty. [Exact picker](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramAssetPicker.tsx#L27-L42).

C-328-8 remains outside this diff in #356: head-count equality is not restore-origin proof; reset history or require durable origin. C-328-2 backend-first contract is an operator release acceptance gate, not a new UI defect. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).

## HANDOFF

P4 done at exact head, REQUEST CHANGES 0/4/0 (comment above). P3 first three findings proved, ownership acceptance proof pending lane 37342607062; no P3 verdict yet. Worktrees remain on own probe branches. Next: inspect final P3 lane, re-read P3 head and publish verdict, preserve probes and remove only own worktrees/throwaway branches.
