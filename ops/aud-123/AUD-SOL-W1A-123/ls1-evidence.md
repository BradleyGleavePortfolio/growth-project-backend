# AUD-SOL-W1A-123 — LS1 dependency bump evidence

Start 2026-10-05 18:50:22 PDT; deadline 19:05:22 PDT. No Opus round comments or notes read.

## Source verification

PR #738 is at `9c2343126889f2fbcb2210ca6b6511bde40e3d1f`, with parent/base `76a592168cab7f440913cdab8285293607f93ec1`; the only changed file is `package-lock.json`, +7/-3. ([PR #738](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/738))

The only changed package record is `node_modules/proxy-addr`: version 2.0.7 → 2.0.8, new registry tarball/integrity, plus registry funding metadata. Parsed/sorted JSON after deleting that record is identical between parent and head, proving no other package or root metadata moved. ([Lockfile](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/9c2343126889f2fbcb2210ca6b6511bde40e3d1f/package-lock.json))

Express remains 5.2.1 with dependency range `^2.0.7`, which accepts patch 2.0.8; proxy-addr's own dependencies remain `forwarded: 0.2.0` and `ipaddr.js: 1.9.1`, and engines remain `node >= 0.10`. ([Lockfile](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/9c2343126889f2fbcb2210ca6b6511bde40e3d1f/package-lock.json))

Read the public registry version metadata with curl rather than running local npm; registry tarball, dependencies, engines, and funding exactly match the changed record. ([npm registry metadata](https://registry.npmjs.org/proxy-addr/2.0.8))

Expected and actual integrity:

`sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ==`

Both agree between the checked-in lockfile and registry. ([Lockfile](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/9c2343126889f2fbcb2210ca6b6511bde40e3d1f/package-lock.json), [registry](https://registry.npmjs.org/proxy-addr/2.0.8))

## CI progression

Initial exact-head PR checks were queued/in progress, including build-and-test and whole-graph dependency audit. ([Build/test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37401169012/job/112068452394), [dependency-audit job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37401169129/job/112068452553))

Polled at intervals longer than one minute. At 18:59:37 PDT all 11 required checks were green, with no pending/failed checks; exact-head build-and-test completed lint, type-check, build, and test successfully. ([Build/test proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37401169012/job/112068452394), [dependency audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37401169129/job/112068452553))

## Posted and verified

Completed 19:00:01 PDT. Head verified immediately before posting; fetched only the own new comment ID to verify the exact required first line.

Backend #738 @ `9c2343126889f2fbcb2210ca6b6511bde40e3d1f` — APPROVE, A/B/C 0/0/0, no C follow-ups. ([Posted Sol LS1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/738#issuecomment-6007776797))

No local npm/test/build commands, new lanes, worktrees, commits, branch pushes, merges, deployments, or production operations. No operator decision or further fix round needed.
