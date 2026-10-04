# AUD-SOL-F23-118 — fees F2/F3 — independent T4 audit

Operator: agent 118. Lens: GPT-6.1 Sol. Scope: backend #682 and #683 only.

## Progress

- Read both common contracts and the assigned JOBS118 entry; claims acquired for #682 `70f879a2` and #683 `438d29e6`.
- Isolated detached worktrees created at the exact assigned heads. Comment histories saved in `ops/aud-118/AUD-SOL-F23-118/`.
- Size verified from both GitHub and local diffs: #682 2,999, #683 2,835. Both under the hard 3,000-line cap.
- Review in progress. No verdict posted yet. No local heavy execution.
- Same-model previous approval for #682 is `a2051568`; this candidate changes only two test files, with all source/fakes unchanged. R75 range checker passes at F2, the specifically assigned historical top `b002ec21583e4e7053deacbe064e2c35f0f2865d`, and the F3 own range. Current top `5937064f` has a separate #697-owned `as unknown as` +1, not introduced in this pair.
- Exact-source full CI logs verified: #682 exactly 4 failed old-fixture tests / 2 suites; #683 exactly 9 / 3. At F4 `bbf2eac6`, all those suites pass and full build reports 730 passing suites / 12,589 passing tests. Logs saved in the audit notes directory.
- Prior Sol B-683-1/B-683-5 code fixes and new 15-case suite reviewed; builder before is 11 failing / 4 controls passing, after the new suite and 13-case retained Sol probe pass. Separate historical optional/obsolete probe failures are not described as green.
- New independent candidate-boundary proof in flight: notice insert/history read fails, retry-flag write also fails, service may acknowledge without durable retry. Synthetic delegate failure only, with real services and SQL NULL semantics restored for the flagged selection query. [F3 independent run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223253985).
- F2 independent retained Sol real-parser/protocol rerun in flight. [F2 independent run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223292881).
- Initial F2 lane `37223249880` had two empty audit files due to a wrong historical filename; explicitly superseded/canceled, never used as acceptance evidence. The corrected branch contains the actual two original specs from `d2fdec0e`.

## HANDOFF

#682 `70f879a29f06815d15a48c3c42483667a474d507` and #683 `438d29e64f24e6f803a578dae56e0140a44d1c52` claimed by this Sol lens. Next: decide prior findings, inspect full piece boundaries and changed money paths, verify attributable CI/probe evidence, then re-read heads/checks and post one verdict per PR.
