AUDIT Claude Opus 5.5 — growth-project-backend#697 @ c2585c97e013ffbcd5c826d9547a686302e0bae6 — VERDICT: APPROVE
A/B/C = 0/0/1

Lens AUD-OPUS-FL-119 (agent 119). Tests-only piece (T4 by the max-tier rule).

**Delta since my APPROVE at 88c72200 (5983739415)**
- First-parent commits: fac83858 and c2585c97 are merge-only (#684 round 17 and its lint fix). a5816328 adds one spec, test/s-fee-r17-refund-routing-status-notice-boundaries.spec.ts (443 lines). Nothing in src or prisma: `git diff 9fb9c48f c2585c97 -- src prisma` is empty.
- The spec reads correctly line by line. Exact amounts (4,900 charge, 172 fee, coach net 4,630). Router-level refund.updated / charge.refund.updated cases close C-697-2. Async full-refund access, the renewal judged on its own amount, and the fail-closed refund list are covered. Sequential stale-order cases (failed then succeeded, a late snapshot, a pending snapshot after apply) are covered. Failure-before-lock and failed-after-apply flags are covered. Notice-boundary cases use a controlled clock.
- Failing-before: run 37230855089, 17 fail / 2 controls pass, on unfixed 88c72200. Passing-after: run 37230897422, with every prior Sol/Opus probe replayed. Re-run at this head inside my probe run 37233481399: PASS.
- Size: 2,276 lines (grandfathered, 3,000 ceiling). CI at this head: required checks pass=10, skipping=1 (build-and-test 37231460271 green).

**C-697-3 (goes with the #684 fix):** r17 covers stale events only in sequential order, plus a failure written before the lock is taken. It has no case where a failure lands between a stale worker's read and its status write. That is B-684-12 on #684 (probe L1-L3, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37233481399). Rule: add L0-L3 here with the #684 compare-and-set fix.
