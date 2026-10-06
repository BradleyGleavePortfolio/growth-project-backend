# AUD-SOL-DUN2-122 evidence

## Exact delta and merge checks

Entire D3 delta is 78 patch lines / four files, containing only two copy replacements, optional SetupIntent `on_behalf_of`, and their assertions. [D3 head](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/68796f675df9c67c0618145efff58caf32a26b04).

Entire D4 delta is 287 patch lines / seven files, with D3 inherited and a 94-line controller, module registration, and 82-line HTTP control spec. [D4 head](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5d41f7678438c11865762a7925ad53520948fe75).

Independent direct `cmp` of `git diff 0fbd18ca..68796f67` and `git diff c15f157c..79601701` succeeds; clean lower-piece inheritance adds precisely the reviewed D3 patch. [D4 lower-piece merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/79601701dae74c6b16c5e80e070c48f627b3e1ec).

Independent direct `cmp` of `git diff c15f157c..5d41f767` and `git diff 17cfa566..3dc0e947` succeeds; both stable patch-ids are `bc66ea0896be97015aa20655f1f64f8c224b34ec`, and D5-owned test blobs are unchanged. [D5 merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3dc0e9472954bdd8381d3394aeb79ab0d5712514).

Diff arithmetic gives total changed lines D3 2,956 / D4 2,969 / D5 2,914, with each PR opened 2026-10-03 and below its grandfathered 3,000 cap. [D3 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689), [D4 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690), [D5 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691).

## Ordinary ownership and service path

The new controller passes verified user id, not request-supplied coach id; the real coach guard rejects students, and the existing service refuses foreign-coach purchases before Stripe work. [Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/src/checkout/dunning-v2/dunning-restart.controller.ts#L71-L93), [role guard](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/src/common/guards/coach-or-owner.guard.ts), [service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/src/checkout/dunning-v2/dunning-v2.service.ts#L1553-L1578).

HTTP spec uses module controller metadata plus the actual role guard but mocks JWT authentication and the service; existing service spec separately asserts actual Stripe resume, entitlement restoration and foreign-coach no-change. [HTTP spec](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/test/dunning-v2-coach-restart-route.spec.ts), [service spec](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/test/dunning-v2-dispute-pause.spec.ts#L387-L449).

Production route receives the normal global `/api` prefix, consistent with existing controller patterns. [Global prefix](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5d41f7678438c11865762a7925ad53520948fe75/src/main.ts#L146).

## CI attribution

Verified run 37388562724 is success at `3b59190063ab12e070df05fb2960a8751cb0e0a0`, whose sole parent is reviewed D5 `3dc0e9472954bdd8381d3394aeb79ab0d5712514`; its diff adds only `.ci-lane-specs`, `.ci-lane-tsc` and `.github/workflows/ci-lane.yml`. [Builder lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388562724).

Verified successful type-check step is `npx tsc --noEmit`; lane log states 26 passed suites and 571 passed tests, explicitly including dispute-pause service, D3 copy, recurring subscription wire and coach restart route specs. [Successful targeted job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388562724/job/112027886887).

All seven required contexts that execute on these stacked PRs are successful, while CodeQL JS/TS, banned casts, SBOM and danger are absent until the composed tree targets main. [D3 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689/checks), [D4 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690/checks), [D5 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691/checks).

The initial lane-log read succeeded and supplied the aggregate counts above; a later attempt to save the full log failed with GitHub API rate limiting, leaving `builder-lane.log` empty, so use this cited successful job and saved run/jobs JSON rather than that empty file. [Lane job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388562724/job/112027886887).
