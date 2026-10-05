# AUD-OPUS-F34-117 complete

#683 `35a18539c8a911524c3eab5b074b33e247f80ac2`: APPROVE 0/0/1 (C-683-4 reconciliation unbounded in Stripe reads). Red by design verified (3 suites / 9 tests, exact list). https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5976735455

#684 `e9ee033d425a61bb48efe2ac2387a23e5347acb0`: REQUEST CHANGES 0/1/2. Opus B-684-3: async-rail (pending) refunds: the round-11 amount_refunded convergence moves money on a pending refund that is never undone if it fails; a pending->succeeded refund never converges otherwise. Probe runs 37177972171 (head) and 37177980871 (pre-round-11). https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/684#issuecomment-5976735562

Default: one combined refund fix with Sol B-684-1 (canonical paged Stripe refund list, succeeded sum, refund updates re-enter the money path); move tests out of F4 to make room (5 lines of headroom).

Full report: `/home/user/workspace/ops/reports/AUD-OPUS-F34-117.md`. Audit branches deleted; worktrees removed; lane ended.
