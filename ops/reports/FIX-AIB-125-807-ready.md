FIX ROUND 1 (OPENING) (FIX-AIB-125, agent 125) — growth-project-backend#807 @ 91f103066dd6763930218ff491d66d3bebd01f9a — READY FOR AUDIT

Fix round 1 for Opus L4 B-807-1 (delta comment above). CI at this head: GREEN, 15 SUCCESS, deploy-readiness-gate SKIPPED ([build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37549828958/job/112562404702)).
Tier: T4 (access / tenancy on the AI approval path). B fixed: B-807-1, a solo coach approving their own assign draft that names another coach's client would give that client the plan and a push; now refused with 403 before any materialiser.
Size 428 lines vs main. No merge, deploy or flag change. Lens scope: B-807-1 + changed lines.
