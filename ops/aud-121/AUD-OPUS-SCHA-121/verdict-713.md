AUDIT Claude Opus 5.5 — growth-project-backend#713 @ a7c8b33afbac44f3086036eb59ca617809320411 — VERDICT: APPROVE

A/B/C = 0/0/0

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 2/9 of the S-SCHED-2 split of #634; access control, concurrency, schema). This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone. The pieces land as one train.

### Evidence reuse (G09)
- My model's lens approved #634 at `e18e8055` ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900), merge-only after [5971916062](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971916062) at `3d989702`).
- `scripts/seed-coach-session-types.ts` and `test/seed-coach-session-types.spec.ts` are byte-identical to `e18e8055` (blob compare), so they rest on that APPROVE.
- I audited in full what changed after that verdict:
  - `test/utils/scheduling-fake-db.ts`: the main-merge follow-through. `start_at` is required and is part of the 4-column duplicate key, matching the NOT NULL column and unique index of migration 20270301000000. `$queryRaw` counts `FOR SHARE` reads. The zone delegates follow `recipient-timezone.ts`: a supplied zone only when `timezone_updated_at` is stamped, then the coach profile.
  - The intermediate `test/scheduling.service.spec.ts`.
- Tree check: tree(#720 `c2b27193`) == tree(reference merge M `6fc88c45`) == `0595cfd7`. This piece's three final files equal M.

### Piece boundary
- 4 files, +971/-303 = 1,274 (under 1,500).
- The only runtime file is the seed script, an operator-run script that main's code does not import. Everything else is a test or a test utility, so production behaviour does not change from #712.
- The intermediate service-spec lines say only what holds both before and after the lifecycle swap: `HttpException` with the status still `completed`, a `BadRequestException` window, and a title without ", with a code". 4/9 (#715) and 6/9 (#717) restore the final assertions. I diffed both steps.
- The fake models the two database floors this stack relies on:
  - The P2002 duplicate claim on (session, user, kind, start_at).
  - The delivery status CHECK (`checkDeliveryStatus`).
- Nothing imports a later piece. tsc and the suites are green in this PR's CI.

### CI at this head
All checks that run on a stacked PR are green: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, Schema parity and npm audit. CodeQL, danger, Banned cast tokens and build-sbom run on base main only (they are green on #712).

### Method
- I read the code at the exact head and diffed it against `e18e8055`, M and main `ee55f814`.
- `git merge-tree` of this head with current main `5da537d6` is clean.
- No local suites. The migration-order probe for the stack is reported on #712.
- Nothing was pushed to the PR branch.
