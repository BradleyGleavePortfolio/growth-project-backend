# AUD-SOL-F56-119 — fees F5 #685 / F6 #686

Started Sun Oct 4 12:30:32 PDT 2026 (date, America/Los_Angeles). Independent Sol lens, operator agent 119.

## Current state
- Claimed #685 c5e282fbfa3e7fe6a5593949182e17c91a011738 and #686 8cb7b2d4bee3bccb65596581f84bccf9227ffc4b.
- Isolated detached worktree: `/home/user/workspace/wt/AUD-SOL-F56-119-686`.
- Prior same-model approvals: #685 858d37165662ad83af7c380f5f57700fd3d47afa ([verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975835233)); #686 7be7d396dcaab5f62c941a78e6e071ce3518ad28 ([verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975835306)).
- Current sizes 2,958 / 1,355. #685 KEEP assessment at current head ([operator](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5983307148)).
- History includes F5 round-12 copy-expectation edits since the last Sol approval, not just merge-only restacks. Those edits require direct review.
- Latest applicable stacked-base checks successful; main-only CodeQL, danger, banned casts and SBOM remain landing prerequisites. Duplicate cancelled readiness comment failures have superseding successful checks.
- Raw PR threads saved under `/home/user/workspace/ops/aud-119/AUD-SOL-F56-119/comments{685,686}.json`.

## Audit plan
1. Prove own-file identity and every restack merge's content provenance; read all resolution hunks.
2. Read composed top's money boundaries and additive migration order; check R75 from b644198b.
3. Inspect exact-head CI/probe logs and execute any independent new probes in the CI lane only.
4. Re-read each head immediately before posting one verdict per PR.

## Follow-ups (C)
- C-685-1, `test/s-fee-r4-money-protocol.spec.ts:788-807`: later-page reversal test returns its matching reversal on page one. Seed a newer nonmatching reversal, assert page-two cursor and no additional movement ([prior verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975835233)).
- C-686-1, `test/s-fee-renewal-backfill.spec.ts:213-219`: listing-failure case lacks a saved non-null cursor and preservation assertion. Seed progress, reject listing, assert cursor preserved, then recover without another payout ([prior verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975835306)).

## HANDOFF
In progress. No verdict posted yet. Worktree and claims above owned by this lens. No candidate source changed, no local heavy execution, no probe branch created.
