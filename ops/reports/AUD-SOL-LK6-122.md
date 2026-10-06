# AUD-SOL-LK6-122 — lockout main-refresh resolution

Operator: agent 122
Lens: GPT-6.1 Sol
PR: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352
Head: fa2c14fb62bdc75e0c6f4c39742111527c8876ae
Verdict: APPROVE (merge resolution)
A/B/C: 0/0/0
Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6006774474
Completed: 2026-10-05 17:44 PDT (America/Los_Angeles date)

## Scope and evidence

Independent review limited to the two hand-resolved spots and automatic-union integrity, as assigned; the baseline is the previously audited train at `e39a84de6e3b8e96afb44b96f80e2eb09ea3cb26` refreshed onto main `300f898fdaf6e0000f3415d0b0b4f0fc3cfa7d0c`. ([Builder's refresh record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6006717924))

- Commit parents are exactly those two heads, and the only new commit not reachable from either parent is `fa2c14fb62bdc75e0c6f4c39742111527c8876ae`. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))
- Automatic-merge reconstruction, using a separate object directory outside the read-only mobile repository, reports only `src/services/api.ts` and `src/navigation/README.md` as conflicts; its tree differs from the actual head only in those two files. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))
- `src/services/api.ts:130-145` keeps lockout stamping before the first await and then retains main's `readTokenForRequest` and `assertBindingMatches` logic; the raw token read is correctly superseded rather than duplicated. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))
- `src/services/api.ts:393-400` still handles only `403 LOCKED_DUNNING`, reports to the lockout store, and preserves the provider subscription and overlay path; non-401 responses, including AI-cap `429`/`503` and workout `409`, pass through unchanged at lines 428-430. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))
- Blob equality against main confirms no changes in `src/lib/ai/aiDailyCap.ts`, `src/api/romanApi.ts`, `src/api/workoutBuilderApi.ts`, `src/api/workoutAutosaveApi.ts`, `src/api/messagingV2Api.ts`, and `src/api/messagesApi.ts`. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))
- `src/navigation/README.md:222-228` retains both appended sections; the old train diff and refreshed PR diff both total 40 files, +7,025/-50. ([Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352))

No A/B/C findings in the assigned delta. No other lens work was read. No local npm, Jest, TypeScript, lint, build, or probe was run. No branch, checkout, push, merge, production setting, or deployment was changed.

## CI

- Required Typecheck, lint, test: SUCCESS at the reviewed head. ([CI job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394649215/job/112047615026))
- Analyze (actions), Analyze (javascript-typescript), and CodeQL: SUCCESS at the reviewed head. ([Actions analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394649453/job/112047615986), [JavaScript/TypeScript analysis](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394649453/job/112047616263), [CodeQL check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/112047755777))

## Saved evidence

- `ops/aud-122/AUD-SOL-LK6-122/merge-tree.txt`: automatic-merge tree and exact two-file conflict list.
- `ops/aud-122/AUD-SOL-LK6-122/objects/`: isolated automatic-merge objects; main repository object directory was not used for writes.
- `ops/aud-122/AUD-SOL-LK6-122/verdict-comment.md`: complete independent verdict payload.
- `ops/aud-122/AUD-SOL-LK6-122/prepost-head-check.json`: immediately pre-publication head and all-green check rollup.
- `ops/aud-122/AUD-SOL-LK6-122/comment-url.txt`: published verdict URL.
- `ops/lanes122/claims/mobile-352-fa2c14fb-sol`: exact-head Sol audit claim.

## HANDOFF

Published APPROVE (merge resolution) at `fa2c14fb62bdc75e0c6f4c39742111527c8876ae` after an immediate exact-head and all-green check recheck; A/B/C = 0/0/0. ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6006774474))

Recommended operator default: use this Sol approval for the exact head, subject to the independently posted other-lens verdict and unchanged green checks; no Sol fix round or open B remains. ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-6006774474))

No worktree, CI lane, build, lock, or background process was created. Report and isolated merge evidence are saved; the claim remains an audit record. Nothing else needed from this lens.
