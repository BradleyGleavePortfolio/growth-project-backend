# AUD-SOL-R34-119 — recurring R3 #680 and R4 #696

## Status
In progress; started 2026-10-04 12:30:33 PDT (Los Angeles `date`).
Sol lens, agent 119; T4 independent audit. No local heavy work.

## Exact heads and CI
- #680: `216489ff5fa707147b50ef0e387aba5b3079e4b1`, +2672/-94 = 2766 lines; current checks successful (deploy-readiness gate skipped). [PR and acceptance evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).
- #696: `276610a3a3cc7877b30a3a5f1214e24c7cbb7eae`, +1910/-0; current checks successful (deploy-readiness gate skipped). [PR and acceptance evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696).

## Plan and evidence
Read common instructions 119, 118, 116 in order and only assigned JOBS119 entry. Read builder B-RECUR6B-118 report; claims remain to verify. Must replay dead Sol authority probe, investigate prior B closures, examine entire R3/R4 diffs, and validate live-Stripe authority, trial own-card evidence, version fencing, webhook order, deletion and lock compatibility. [Builder round 6](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676).

## Follow-ups (C)
Pending independent classification; no verdict yet.

## Operator decisions
Pending: narrower past_due exemption; deletion consumes granted/own-card trials; real-Postgres CI-lane evidence; Day-10 plan-view ownership.

## HANDOFF
No comments posted yet. Heads confirmed as above. Next: governing docs, prior lens evidence, claims/worktrees, full diff, then CI replay.
After a merge-only restack onto final fees top, verify only lower-stack merges entered, read conflict resolutions, preserve recurring trial/authority/lock fixes, verify no runtime changes enter R4, rerun relevant probes, and post a short delta at re-read exact heads. Do not merge or modify PR branches.
