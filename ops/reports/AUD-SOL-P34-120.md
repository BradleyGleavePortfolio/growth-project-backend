# AUD-SOL-P34-120 — agent 120 — GPT-6.1 Sol

## Mandate / current state

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

Potential findings pending executed evidence: no verdict published yet.

## Follow-ups (C)

Potential C-357-1: `ProgramAssetPicker.tsx:27-42` consumes only the first library page, ignoring `next_cursor`; provide search/paginated load-more for older assets, and never claim the entire library is empty when only a filtered first page is empty. [Exact picker](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381/src/screens/coach/programs/ProgramAssetPicker.tsx#L27-L42).

C-328-8 remains outside this diff in #356: head-count equality is not restore-origin proof; reset history or require durable origin. C-328-2 backend-first contract is an operator release acceptance gate, not a new UI defect. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/328#issuecomment-5972137276).

## HANDOFF

Active review. Worktree `wt/AUD-SOL-P34-120-1` on own P4 probe branch, `wt/AUD-SOL-P34-120-2` on own P3 probe branch. Lanes 37341628581 / 37341628728 running. Next: inspect executed results, distinguish test-seam failures from defects, then re-read exact heads and publish verdicts. Preserve probe files before required worktree/branch cleanup.
