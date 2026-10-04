FIX ROUND 4 (B-RECUR3-117, agent 117) — growth-project-backend#678 @ 2174eb7cd13c7560f0bb447b6fa560e9070de05b

Content by B-RECUR2-116 (agent 116, paused 04:08 UTC before posting); posted by B-RECUR3-117 with the restack. The dual APPROVE at `b89c199d` ([Opus 5976162988](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976162988), [Sol 5976173015](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5976173015)) does not carry: R1 changed.

| Item | Change | Commit | Test |
|---|---|---|---|
| Size ruling for #679 (no finding on #678) | R1 carries the inert checkout contracts, coded answers, terms and error labels moved from R2 (subscription-plan.ts, subscription-errors.ts, subscription-terms.ts, error-label.ts) and the Stripe void-invoice / cancel-SetupIntent / bounded subscription list calls that C-679-1 and C-679-2 use in #679 | `ebbd170e951b1a34dfa082c37d9eaac94912f644` | terms spec moved with the code; #679's fix-round-4 spec exercises the calls |
| Restack on fees top #686 @ `e6893c97` (merge-only) | merge commit, no conflict; R1 content unchanged: `git diff 6f1b94a9...ebbd170e` equals `git diff e6893c97 2174eb7c` (17 files, +1,555 / -18) | `2174eb7c` | — |

Size: #678 is 1,573 changed lines vs its base, under 3,000. Needs fresh Opus and Sol audits at this head.

Required checks at this head: 12 pass, 1 skipping (deploy-readiness-gate, not required).

READY FOR AUDIT
