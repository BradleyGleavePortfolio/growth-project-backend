# AUD-SOL-661D-120 — GPT-6.1 Sol, agent 120

## Scope / current state

- Only backend #661 `bc399edd5911c9c1e83e4bb1051fde05bfeda64d` and #702 `9ddda117d89f72c8d4a7a5b58a2c7ba6173053a2`, T4 conflict-resolution/main-refresh delta; both heads claimed.
- Both required RESTACK notes are present. [#661 note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5998643247) [#702 note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702#issuecomment-5998643507)
- Prior own-model approvals are #661 `f80f0088c98cd078cffa5dd217a8fdc84ad631b2` and #702 `20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb`; reuse is limited to verified unchanged inputs, not automatic approval. [Prior #661 approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5982350850) [Prior #702 approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702#issuecomment-5982351152)
- Size gate: #661 2,849 changed lines, grandfathered under 3,000; #702 513 changed lines. [#661](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661) [#702](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702)

## Progress / plan

- Read common 120/119/118/116, LAW, standing orders and merge dependency guide; fetched remote state; isolated composed-tree worktree `/home/user/workspace/wt/AUD-SOL-661D-120-1`.
- Read prior Sol 116–118 handoffs and current comment timeline. Full attributable comment history is in `ops/aud-120/AUD-SOL-661D-120/history.txt`.
- Read `010f9b57` remerge conflict diff. Next: inspect every checkout/webhook line changed by recurring composition, prove unchanged restack/test inputs, replay prior Sol probes plus new conflict-hunk probe in CI lanes only, re-read exact heads/checks before verdict.
- Full prior AUDIT/FIX history and all 1,248 lines of recurring-handler delta read; checkout-service delta read; #702 two changed test blobs remain identical to the prior approved top and its restack has no conflict resolution. [Refresh](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/010f9b57884456f61bf91455d0073421d91c3500) [Restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/9ddda117d89f72c8d4a7a5b58a2c7ba6173053a2)
- Initial exact-head checks: #661 all 11 required success; #702 all 7 available main-required checks success, four main-only contexts absent as expected. [#661 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37244459604) [#702 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37244481892)
- Tests-only commit `3fc0689f` on exact #702: byte-identical round-5 PostgreSQL replay, final round-6 native-owner probe, agent-118 mixed-owner/concurrency/rollback probe, and new composed recurring-credential/reply/ownership acceptance tests. One GitHub lane runs typecheck plus 41 targeted suites including recurring rounds R1–R7 and both candidate settlement specs. [Running lane 37341623338](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37341623338)
- New hypothesis: composed invoice/subscription activation grants access without clearing cached credentials; endSubscriptionPurchase does clear them. Acceptance proof pending. No finding asserted solely from a failing fixture.
- No verdict posted yet; no local heavy work, candidate edits, merge, deployment or production calls.

## Follow-ups (C)

- C-661-13 carried from prior own-model verdict: finished-key copy should be entitlement-neutral rather than promise ready access on an unentitled paid/active/past_due row; keep credential safety and error code. [Prior disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5982350850)
- C-661-2 historic credential cleanup remains operator-approved deploy-window work, not lens authority; C-661-3/C-656-1 combined recurring behavior is in this review. [Round-7 obligations](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5977850515)

## HANDOFF

- Both heads claimed, review in progress, no published verdict. Evidence directory `ops/aud-120/AUD-SOL-661D-120/`; composed candidate worktree `wt/AUD-SOL-661D-120-1`.
- Next action: finish conflict/integration review and run exact composed-tree prior-probe replay plus new conflict test in a unique CI lane before publishing.
- Active own remote lane: `audit/AUD-SOL-661D-120/1-composed-replay`, run `37341623338`. Await final result with `gh run watch --interval 60 --exit-status`; preserve logs before removing own worktree/branch.
