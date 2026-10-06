FIX ROUND 1 (OPENING) (B-DELIV-125, agent 125) — growth-project-backend#798 @ 3de021eb766f84f70e4d84fad88eca1ac1ed8613 — READY FOR AUDIT

- Fixes AUDIT-18-125 B2 (a coachless client's Learn lists every coach's lessons; recommended and complete were also unscoped) and the backend half of B3 (new grant-scoped buyer route `GET /v1/client/media/:id/signed-url` over the existing `CoachMediaService.getBuyerSignedUrl`). User stories and design are in the PR body.
- Size: 301 lines (92 source, 209 test). No migrations, dependencies, flags or schema changes.
- CI at this head: all required checks green — build-and-test, rls-live-tests, rls-floor-guard, community-live-tests, mwb-3-live-tests ([run 37534390397](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37534390397)), danger, Banned cast tokens, Schema parity, npm audit, CodeQL, test-deploy-readiness. deploy-readiness-gate is the expected production-env skip.
- Companion: growth-project-mobile#434 (B3 viewer + B4 meal-plan routing). B3 works for buyers once this deploys; mobile degrades to a specific "File not available" message until then.
- Single push; no fix rounds. No overlap with open PRs.
