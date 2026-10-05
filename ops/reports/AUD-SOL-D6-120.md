# AUD-SOL-D6-120 — GPT-6.1 Sol independent T4 audit, agent 120

Scope: backend dunning D1 #687, D2a #688, D2b #704, D2c #705 only.
Started 2026-10-05 10:29 PDT (date observation).

## Current heads / status
| PR | Exact head | Size | Status |
|---|---|---:|---|
| #687 | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | 2,640 | Reading foundation and prior Sol findings |
| #688 | 21714f7bba299336cf71df0c87288c798fd5da13 | 2,784 | Reading service and C-680-18 guard |
| #704 | 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 | 694 | Reading legacy caller/fixture boundary |
| #705 | 5138947cd082328b81cbeb787833914431b22fc1 | 1,409 | Reading pause semantics, races and C-680-19 |

#687/#688 are grandfathered and satisfy the 3,000-line ceiling; #704/#705 opened after the deadline and satisfy the new 1,500-line ceiling.
Evidence: [PR #687](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687), [PR #688](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688), [PR #704](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704), [PR #705](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705).

## Method and binding decisions
- Read _COMMON_120/119/118/116, AGENT_RULES, MODEL_ROUTING, standing orders, merge guide and audit rules.
- Read B-DUNMR-120 report and owner 10-05 rulings 5–7: failed refund after ended access alerts coach only; inquiries pause; full recurring refund pauses and ends access (later D2d ownership).
- No local npm/Jest/tsc/lint/build. Any new proof runs only in unique GitHub CI lanes.
- Candidate source remains read-only. Exact heads must be re-read immediately before verdict publication.
- GitHub evidence downloaded into ops/aud-120/AUD-SOL-D6-120.

## Follow-ups (C)
Pending independent disposition.

## Active CI lanes / preliminary issues
- Foundation replay: [37349204151](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349204151), audit/AUD-SOL-D6-120/687-1.
- D2a replay: [37349210308](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210308), audit/AUD-SOL-D6-120/688-1.
- D2b replay: [37349207076](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349207076), audit/AUD-SOL-D6-120/704-1.
- D2c adversarial boundaries and regressions: [37349210966](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37349210966), audit/AUD-SOL-D6-120/705-1.
- Prior Sol #687 B-687-3/4 and #688 B-688-6/7 fixes are present; replay pending. Original B-628-11 belongs to D3, not this scope.
- #705 preliminary concerns being proved: flag rollback makes pause reader false; compensating pause reuses a cached idempotency key after resume; in-flight original pause can overtake completed restart; read model claims billing paused before provider confirmation.
- Exact candidate check results are captured in checks687/688/704/705.json; applicable checks green, readiness gate skipped. Main-only checks must run on the final composed main-based stack.

## HANDOFF
Audit in progress. Four CI lanes running; no verdict posted. Worktrees wt/AUD-SOL-D6-120-{687,688,704,705} hold candidate head plus probe-only commits. New proof spec is preserved at ops/aud-120/AUD-SOL-D6-120/aud-sol-d6-120-boundaries.spec.ts. Finish code/evidence review, inspect all four lane results, re-read heads, post one verdict each, then remove only these lane branches/worktrees.
