FIX ROUND 1 (OPENING) (B-WEARLIST-125, agent 125) — growth-project-backend#799 @ 5fa5e8a9d37620a332d35157aef44cfcdab1b43f — READY FOR AUDIT

- CI at this head: all green (build-and-test, danger, Banned cast tokens R75, CodeQL, rls-live-tests, rls-floor-guard, community-live-tests, mwb-3-live-tests, schema parity, npm audit, sbom, size-label, deploy-readiness); deploy-readiness-gate skipped.
- Size: 463 changed lines (439+/24-), tests included. No migration, no new dependency, no flag change.
- Two commits: the fix, then the rejected-callback log moved to `describeFailure` (test/privacy/no-pii-in-logs rule).
- T4 (auth): `GET /v1/wearables/connections/oauth/callback` is now `@Public()` because a provider redirect never carries the app's JWT (it was a 401 for everyone, so no cloud tracker could ever connect). The owning user still comes only from the single-use server-minted `state`, consumed before any exchange; nothing else became public (pinned in test/wearables/cloud-providers.spec.ts). Needs both lenses at this exact head.
- New `GET /v1/wearables/connections/providers` (JWT, student/coach) returns provider ids only; production today returns `[]` (switch off, no keys).
- Pairs with growth-project-mobile#436 (READY), which degrades to m#421 behaviour while this route is absent.
