# AUD-SOL-CM10-121 — main-refresh exception check

#674's simulated clean merge with current main `5da537d60b5775078c20530829c94d33be2bc527` remains 2,995 lines, but **fails A5 rule 12's PR-file byte-identity condition**: main changes the PR-owned `test/cancel-pending-on-refund.spec.ts` blob from `29624b4aa1f8ac4165bb0d8f0a5f15a9ed833b27` to `39fa273257c4c37d23fe5a13ae937b4081cf7390`. [Candidate test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/3a07a0de45f431ca9f1f5b9a2ff1710d554e52cb/test/cancel-pending-on-refund.spec.ts) [Main test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5da537d60b5775078c20530829c94d33be2bc527/test/cancel-pending-on-refund.spec.ts)

Recommended default: refresh mechanically, then short exact-head dual delta verdicts plus new required CI; do not carry verdicts without lenses.

Evidence: `ops/aud-121/AUD-SOL-CM10-121/main-merge-owned-blobs.txt`, `main-merge-cancel-test.patch`, `tree-checks.txt`.

#676/#677 Sol APPROVE published at the assigned exact heads. [M3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-6001799433) [M4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/677#issuecomment-6001801825)

All four Sol verdicts are now complete, APPROVE with A/B/C 0/0/2, 0/0/1, 0/0/1 and 0/0/0; #674's three prior Bs close using independently attributed before/after/live evidence under G10, not another lens's judgment. [M1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-6001872671) [M5 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/703#issuecomment-6001873618)

The independent duplicate replay never started during the runner incident and was cancelled; no local or independent CI pass is claimed, and all candidate required checks remain green. [Replay lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365272571)

Final report: `ops/reports/AUD-SOL-CM10-121.md`; both owned worktrees and the owned remote audit branch are removed.
