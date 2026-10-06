# AUD-SOL-BC3-122 — broadcasts delta audit

Job: AUD-SOL-BC3-122, agent 122, GPT-6.1 Sol.

Started 2026-10-05 16:57:11 PDT; completed 17:01:48 PDT within the 25-minute time box.

## Scope

Independent delta review of #726–#730; prior Sol B-727-1 and B-728-1 plus changed lines only, under the owner’s RUTHLESS SCOPE rule. No other lens’s current-round report, notes, or verdict comments have been read.

The source-of-truth pull returned an empty proxy reply; current A1, A2 owner overrides, and A5 rules 11–12 were read through the [GitHub contents API](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md).

## Final exact-head verdicts

| PR / verdict comment | Full head | Changed lines | Verdict | A/B/C |
|---|---|---:|---|---|
| [#726 unchanged confirmation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005985517) | b5501a89611844fc43717084d887e604af33037a | 642 | APPROVE | 0/0/0 |
| [#727 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005985987) | 63348b0771e39996cf75f8451802430f9f497229 | 1,404 | APPROVE | 0/0/0 |
| [#728 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005986422) | 06b322e8471929933cbe0e635b1cc2f9dcdbc4cb | 1,210 | APPROVE | 0/0/1 |
| [#729 merge-only verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005986805) | ec53c87f7bd800b9f2c469c7d4b36b16b8e67e65 | 1,114 | APPROVE | 0/0/0 |
| [#730 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005987162) | afbb4c1a846422df6b09a028d71d2a763a6ccf76 | 880 | APPROVE | 0/0/0 |

Train A/B/C = **0/0/1**; both prior Sol Bs closed and no new blocking finding in the reviewed changed lines. [#727 closure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005985987), [#728 closure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005986422)

## Prior Bs closed

### B-727-1 — assigned-copy audience lineage

Prior normal-user story: A coach assigns a program to a client, selects that program as the broadcast audience, and loses the assigned recipient because assignment days point to a client copy rather than the master. [Prior Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441)

`src/broadcasts/segment-resolver.service.ts:113–131` now matches either the direct program ID or a live, non-template, same-tenant copy whose `cloned_from_id` is selected, with every assignment still bounded to the author-authorized roster. [Fixed resolver](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/src/broadcasts/segment-resolver.service.ts)

The new regression verifies an assigned live copy is included and an archived copy excluded, while the original independent Sol probe now passes preview and scheduled create through the real candidate services. [Resolver regression](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/test/broadcasts/segment-resolver.spec.ts), [Passing probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389145763)

### B-728-1 — private program names

Prior normal-user story: A sub-coach opening the broadcast audience picker receives the head coach's and sibling coaches' owner-only program names even though those programs are private to their authors. [Prior Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900)

`src/broadcasts/broadcasts.service.ts:92–98` now includes only own or tenant-shared unarchived master programs; the matching readable-master reference validator at `segment-resolver.service.ts:77–86` also rejects sibling/head-coach private masters and client copies. [Fixed picker](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06b322e8471929933cbe0e635b1cc2f9dcdbc4cb/src/broadcasts/broadcasts.service.ts), [Fixed validator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/src/broadcasts/segment-resolver.service.ts)

The predicates match the existing program library read rule, and the service/validator regressions plus the original independent picker probe passed. [Canonical library read rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/src/workout-builder/program-library.service.ts#L225-L240), [Service regressions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06b322e8471929933cbe0e635b1cc2f9dcdbc4cb/test/broadcasts/broadcasts.service.spec.ts), [Passing probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389145763)

## Other changed lines and evidence reuse

- #726 retains the exact own-lens approved SHA; no source delta was reopened. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005185979)
- #727's scope service excludes archived clients during preview/audience resolution and send authority, preserves authorized roster order, and has its PrismaService constructor dependency supplied by the existing global provider. [Scope delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/src/broadcasts/broadcast-scope.service.ts), [Module-boot lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389145763)
- #728's draft edit keeps draft status and `next_run_at: null` when status is omitted; its test-only harness cleanup removes four banned double casts without weakening assertions. [Service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06b322e8471929933cbe0e635b1cc2f9dcdbc4cb/src/broadcasts/broadcasts.service.ts), [Typed harness/regressions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06b322e8471929933cbe0e635b1cc2f9dcdbc4cb/test/broadcasts/broadcasts.service.spec.ts)
- #729 is merge-only: own dispatcher and delivery-test files match the prior approved blobs exactly (`c9a7d373277780808a044dab10a211e42b30951c`, `18736a52f7f0168fd280d46ca0509f8fb46ba3c2`); the entire delta consists of the reviewed lower-piece fixes, with no own-slice conflict change. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005186386), [Dispatcher](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ec53c87f7bd800b9f2c469c7d4b36b16b8e67e65/src/broadcasts/broadcast-dispatcher.service.ts), [Delivery tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ec53c87f7bd800b9f2c469c7d4b36b16b8e67e65/test/broadcasts/dispatcher-delivery.spec.ts)
- #730's own delta is limited to live-test constructor wiring, one distinct client per sub-coach under the existing uniqueness rule, and cleanup of the new client; routes, application/module registration and CI wiring remain byte-identical to the prior Sol-approved slice. [Live-spec delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/afbb4c1a846422df6b09a028d71d2a763a6ccf76/test/broadcasts/broadcasts-dispatch.live.spec.ts), [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005186836)

## CI verification

All required code/test/security checks succeeded at the five exact heads: #726 has 17 success + 1 skipped deploy-readiness-gate; #727–#730 each have 10 success + the same skipped gate, not an assertion that every reported check ran. [#726 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726/checks), [#727 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727/checks), [#728 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728/checks), [#729 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729/checks), [#730 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730/checks)

Verified the successful builder lane at `e9176b4522307db345167acc8f8588a284cbad48`: its original Sol two-case probe is byte-identical to the retained independent probe, its `src/` and `prisma/` are byte-identical to final top `afbb4c1a`, and its full tsc plus 97 tests / 10 suites passed (8 live tests skipped because the lane has no PostgreSQL database). [Builder lane and logs](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389145763)

The final top's separate disposable-database CI job explicitly passed `test/broadcasts/broadcasts-dispatch.live.spec.ts`, with 110/110 tests in 11/11 suites across that job. [Final live job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37390496684/job/112034145278)

No redundant probe lane or local test/build was launched. Evidence reuse is an explicit code/blob-and-log verification, not acceptance of the builder's summary alone.

## C

C-728-2 — C (edge, deferred to 10k clients): prior finite-series exhaustion combined with pause/resume; no investigation, probe or fix requested. [Prior deferred item](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900)

## Operator next action

The code audit is complete, but #726 is still draft and `mergeable_state: dirty` against advanced main (`6aff479cd09f1afdeafedf47684cb34f4ef0584e` at verification); upper pieces are draft/clean, so this report does not claim immediate merge readiness. [#726 confirmation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005985517)

Recommended default: owner/operator-controlled main refresh and restack, required CI and exact-head/merge-only evidence as applicable, then rule-11 whole-stack landing; keep the feature off until the mobile composer/device gate passes, and do not fix the deferred C now. [Split-stack and refresh rules](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md), [Default-off release gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b5501a89611844fc43717084d887e604af33037a/.github/fly-env-desired-state.json)

## Retained evidence

`/home/user/workspace/ops/aud-122/AUD-SOL-BC3-122/` contains all four delta patches, all five comment payloads/receipts/readbacks, own prior verdict JSON, exact-head check JSON, pre-post/final PR metadata, full builder-lane log, final live-job log, and preserved released claim files. The main checkout remained clean; no worktree or branch was created, and no PR branch or production system was changed.

## HANDOFF

Complete: all five verdict comments posted and read back exactly; every head rechecked unchanged at 17:01:48 PDT. [#726](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005985517), [#727](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005985987), [#728](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005986422), [#729](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005986805), [#730](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005987162)

Five owned claims released by moving them into retained evidence (nothing deleted). No owned worktree, branch or running CI remains. No other lens's current-round work was read. Next owner action is main refresh/restack and whole-stack landing gates; there are no open Sol Bs.
