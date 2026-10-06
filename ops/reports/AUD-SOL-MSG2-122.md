# AUD-SOL-MSG2-122 — messaging mobile delta audit

## Result

AUDIT GPT-6.1 Sol — growth-project-mobile#377 @ fae228c8f1609c24f9a581c74393b072eea23c12 — VERDICT: APPROVE

AUD-SOL-MSG2-122, agent 122. A/B/C = 0/0/0.

Started Monday 2026-10-05 16:58:10 PDT; scope is prior B-377-1 and the eight-line fix delta, under RUTHLESS SCOPE.

Finished at 17:00:32 PDT after immediately reverifying the full head and posting the sole Sol verdict for it. [Posted audit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005972535)

## Review

- B-377-1 is closed: `src/screens/client/MessagesScreen.tsx:792-793` now returns early for UUID-backed pending rows, retaining them unless the normalized server list contains the same `client_message_id`; equal body text and the existing age reaper cannot discard them. [Keyed reconciliation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fae228c8f1609c24f9a581c74393b072eea23c12/src%2Fscreens%2Fclient%2FMessagesScreen.tsx)
- Traced the ordinary `load()` caller at lines 157-173, failed-send creation at lines 363-371, normalization at lines 770-783, and the Send again handler at lines 730-731; the retained pending row still carries its original send key. [Client screen](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fae228c8f1609c24f9a581c74393b072eea23c12/src%2Fscreens%2Fclient%2FMessagesScreen.tsx)
- The new regression at `src/screens/client/__tests__/MessagesScreenCache.test.ts:74-78` keeps a keyed failed “Done” against a different-key “Done” and removes it when its own key appears. [Regression test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fae228c8f1609c24f9a581c74393b072eea23c12/src%2Fscreens%2Fclient%2F__tests__%2FMessagesScreenCache.test.ts)
- Verified one fix commit with exactly two production lines and six test lines added; no other changes or item-list regressions were identified, and unkeyed legacy reconciliation is unchanged. [Exact fix delta](https://github.com/BradleyGleavePortfolio/growth-project-mobile/compare/316f0a130012509f498b36993ec304f0dc151b3a...fae228c8f1609c24f9a581c74393b072eea23c12)
- The full PR is +1,420/-80 = 1,500 lines against unchanged #371 base `d4244f2cab5a3d89124a5f56221ef389527d525b`; any additional change needs size rechecking. [PR under review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377)

## Evidence reuse and CI

- Reused the prior Sol screen probe from the original B-377-1 finding, without changing it; `cmp` of its original saved patch and the fix-lane patch returned 0. [Prior Sol finding and failing probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)
- Independently compared lane head `7bf314b40348fa04f80d643e847b82dc5886c6ce` with audited head `fae228c8f1609c24f9a581c74393b072eea23c12`: production `src` files are byte-identical; remaining differences are test-only probes and CI plumbing. [Fix lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390700458)
- Read the completed lane logs: typecheck success, 10 suites / 77 tests passed, including the unchanged Sol ordinary-refresh screen probe and the new cache regression. [Lane job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390700458/job/112034817144)
- Verified the PR check at the exact audited head is successful: typecheck, lint, 480 suites / 6,735 tests / 5 snapshots passed. [PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390955305/job/112035638125)
- No new probes or CI runs needed; no local npm, jest, tsc, lint, builds, pushes, or merges performed.
- Independent Sol review: no current-round Opus lens report, notes, or verdict read.

## Saved evidence

- `ops/aud-122/AUD-SOL-MSG2-122/exact-fix-delta.patch`
- `ops/aud-122/AUD-SOL-MSG2-122/fix-lane-37390700458.log`
- `ops/aud-122/AUD-SOL-MSG2-122/pr-ci-37390955305.log`
- `ops/aud-122/AUD-SOL-MSG2-122/verdict-377.md`
- `ops/aud-122/AUD-SOL-MSG2-122/posted-verdict-377.json`

## HANDOFF

- Complete: posted APPROVE at exact head `fae228c8f1609c24f9a581c74393b072eea23c12`, after head verification immediately before posting. [Sol audit comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005972535)
- No open A/B findings; Cs: none added.
- No worktrees, branches, CI runs, or locks created; claim `ops/lanes122/claims/mobile-377-fae228c8-sol` records ownership.
- Operator next action: use this exact-head approval in the existing #371/#377 stack process; no merge or deployment was performed by this lens.
