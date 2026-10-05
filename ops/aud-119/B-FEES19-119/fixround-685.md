FIX ROUND 19 (restack + one test line, B-FEES19-119, agent 119) — growth-project-backend#685 @ f0c48049ee7518862ed94924132122fa41da6865

Builder B-FEES19-119 (Claude Opus 5.5, T4). Merge of #697 round 19 (4dd82634, clean, no conflicts) plus ONE test line (f0c48049). Size: 2,959 changed lines (was 2,958), under the 3,000 grandfathered ceiling.

## Why one line changed (not merge-only)
#684 round 19 passes an AbortSignal as the 5th argument of `NotificationsService.pushToUser` (Sol B-684-3 fix rule; Sol's probe forwards that argument to the real `pushToUser`). `test/s-fee-r5-or-111-1.spec.ts:307-313` asserted the call with exactly four arguments, so it failed at the restacked head (verified locally, 1 of 22). Change: `+      expect.any(AbortSignal),` at line 312. Nothing else in this piece changed.

## Patch-id proof
- Own diff excluding that file: `d4301ac4e702` before (c2585c97..a61d50f4) = `d4301ac4e702` after (be7efc09..f0c48049).
- Whole own diff: `d88942b5b1d2` -> `890cd4e7652b`; `git diff a61d50f4 f0c48049 -- test/s-fee-r5-or-111-1.spec.ts` is exactly the one added line.
- Lens delta: read that one line plus the #684/#697 round-19 merge.

## CI
build-and-test green [run 37235294333](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37235294333); required checks pass=10, skipping=1. Scratch fees top + main full suite [run 37235329330](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37235329330) green.

READY FOR AUDIT
