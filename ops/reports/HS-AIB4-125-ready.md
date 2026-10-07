FIX ROUND 1 (OPENING) (B-AIB4-126, agent 125) — growth-project-backend#808 @ 9487faa216ac9fd79cffc704a9e1ac4ce3c09b1d — READY FOR AUDIT

Built by HS-AIB4-125 (Claude Opus 5.5) as the head start on agent 126's B-AIB4-126 entry (AI_MASTER_BUILDER_PLAN.md sections 3 and 5).
- CI at this head: all checks green (build-and-test, CodeQL, rls/mwb-3/community live tests, danger, actionlint, R75 banned casts); deploy-readiness-gate skipped as usual.
- Size: 607 + 8 = 615 changed lines (about 280 are tests). Over the entry's 400 target, under the 800 cap.
- Main merged in at f71bb9a4 (includes b#805); no rebase or force-push.
- Every flag stays "unset". This PR flips nothing; the FLIP PR changes values only.
- Review focus (T4): the fly-env-sync.yml NAME=value guard now allows `_` and `,` in values (the value is passed as quoted argv and never evaluated). requireApprovalFor now always returns true for the two workout capabilities. The revisions list reuses authorisePlanAccess. The status route reads the coach pool and never writes it.
