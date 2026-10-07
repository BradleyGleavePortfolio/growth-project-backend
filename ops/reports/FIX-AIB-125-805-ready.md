FIX ROUND 1 (OPENING) (FIX-AIB-125, agent 125) — growth-project-backend#805 @ 0096987c0d7f34345f56cfa61c45837ec28c9cc2 — READY FOR AUDIT

Fix round 1 for Sol L4 B-805-1 plus the origin/main merge (delta comment above). CI at this head: GREEN, 15 SUCCESS, deploy-readiness-gate SKIPPED ([build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37550059993/job/112563143654)).
Tier: T4 (money: coach AI pool metering). B fixed: B-805-1, a coach near the end of the AI pool could keep generating for free; now the call that outruns the pool consumes the remainder and the next one gets 402 before any provider call.
Size 342 lines vs main. No merge, deploy or flag change. Lens scope: B-805-1, changed lines and the merge resolution in coach-ai.service.ts imports.
