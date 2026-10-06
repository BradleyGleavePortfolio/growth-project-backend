# AUD-SOL-BC5-122 — broadcasts main-refresh audit

Job: AUD-SOL-BC5-122, agent 122, GPT-6.1 Sol.

Window: 2026-10-05 17:43:23–17:46:55 PDT, within the 20-minute time box.

## Result

**APPROVE — A/B/C = 0/0/0; no open Bs in this delta.**

PR: [growth-project-backend#726](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726).

Exact head: `ff2594db6f506b47dc50510a5c7512119e4609bc`. [Refresh commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff2594db6f506b47dc50510a5c7512119e4609bc)

Verdict comment: [posted and read back exactly](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6006817321).

## Scope and independence

Read the common brief including its 17:38 authenticated-checks note, only the assigned JOBS122 entry, current source-of-truth A1/A2 overrides and A5 rules 11–12, the builder's refresh report, and this lens's own prior BC3 evidence.

Reviewed only the eight assigned conflict hunks, their immediate thread-serialization/cascade context, and the merge structure; no Opus lens work was read.

The merge parents are `cb5ef90a43974e17abca3715cdf8d1432d004f48` and main `eb2e9e038a4cc6e2b8b20fb0d37d251a91162350`, and `git rev-list cb5ef90a..ff2594db --no-merges --not eb2e9e03` is empty. [Refresh commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff2594db6f506b47dc50510a5c7512119e4609bc)

The first parent and own BC3-approved top `afbb4c1a846422df6b09a028d71d2a763a6ccf76` have identical tree `22166591835f77eaecc528d330d39c21213e2755`; 26 of the 34 PR files remain byte-identical to that approved tree, with eight changed files comprising the six conflict files and two clean module/env unions. [Prior Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005987162), [Refresh commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/ff2594db6f506b47dc50510a5c7512119e4609bc)

The +5,274/−5 displayed PR total is the rule-11 assembled landing of the five already-audited split pieces, not the size of a newly authored slice; conflict resolution requires fresh lens verdicts rather than rule-12 carryover. [PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726), [Split-stack/refresh rules](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md)

## Eight conflict hunks

| Hunk | Review result and code location |
|---|---|
| 1. Flag values | Both `FEATURE_COACH_CODE_TOOLS` and `FEATURE_COACH_BROADCASTS` remain `unset`, without dropping main's manifest entries. [Flag manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/.github%2Ffly-env-desired-state.json) |
| 2. Flag notes | Both release/rollback notes survive. [Flag manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/.github%2Ffly-env-desired-state.json) |
| 3. CI spec list | `coach-code-tools.live.spec.ts` and `broadcasts-dispatch.live.spec.ts` are both retained and actually pass in the final live job. [CI list](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/.github%2Fworkflows%2Fci.yml), [Live-job log](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394583207/job/112047402184) |
| 4. Runbook | Both default-off/rollback rows survive. [Launch flags](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/docs%2Frunbooks%2Flaunch-flags.md) |
| 5. CoachMessage schema | Lines 1344–1374 retain broadcast card/delivery relations plus main's reply, edit, delete, pin, idempotency fields and indexes. [Schema](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/prisma%2Fschema.prisma) |
| 6. Schema tail | All six broadcast models survive, the `CoachClientTag` closing brace is correct, and main's `FeaturedCoachConfig`, `CoachCodeRedemption`, `CoachlessPromptState` and `SchedulingJobLease` follow intact. [Schema](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/prisma%2Fschema.prisma) |
| 7. Erasure manifest | Lines 92–112 preserve main's detached actor IDs/thread-state deletions and all six broadcast/saved-reply/tag entries; run/delivery/card child cascades remain composed with those entries. [Manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/src%2Faccount-deletion%2Faccount-deletion.manifest.ts), [Schema](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/prisma%2Fschema.prisma) |
| 8. Thread read | Lines 631–695 implement independent flag gating for cards and reply previews, without changing main's tenant predicates, order or limit; the serializer spreads remaining row properties, so a fetched card survives v2 shaping. [Messaging service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/src%2Fmessaging%2Fmessaging.service.ts) |

### Normal thread-read behavior

| Broadcast flag | Messaging v2 flag | Relations read |
|---|---|---|
| Off | Off | None — main's legacy query/response |
| On | Off | Card only |
| Off | On | Reply preview only |
| On | On | Card and reply preview |

These branches match the actual implementation and the passing four-combination public-client-thread probe, including card preservation in returned rows. [Messaging service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/src%2Fmessaging%2Fmessaging.service.ts), [Targeted lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394720313/job/112047844424)

## CI evidence

The existing builder lane `37394720313` succeeded at commit `1d25c70c80e03780597debf0bc0e8f0bf1aa9677`; independent `git diff` confirms its runtime source/schema are byte-identical to this PR head, with only lane configuration and the temporary four-combination probe added. [Builder lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394720313)

Its actual log shows full `npx tsc --noEmit` success and 27 passed suites / 358 passed tests, including the flag/card probe, messaging, deletion coverage/order, manifest, module graph and OpenAPI tests; one live suite / eight tests were skipped there because that lane had no database. [Targeted-job log](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394720313/job/112047844424)

The exact-head PR live job separately passes 13 suites / 128 tests, explicitly including both retained invite-code/broadcast specs and thread-state RLS. [Exact-head live-job log](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37394583207/job/112047402184)

The final pre-post rollup contains 20 successful checks and one skipped ancillary `deploy-readiness-gate`; all required checks, including schema parity and forward/reverse migration checks, are green at `ff2594db`. [PR check rollup](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726), [Exact-head verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6006817321)

No new CI lane, local test/build, worktree, branch, source edit, push, merge or production action was performed.

## Findings

- A: none.
- B: none.
- C: none in this delta; unchanged edge-case code was not reopened.

## Retained evidence

Directory: `/home/user/workspace/ops/aud-122/AUD-SOL-BC5-122/`.

Saved combined/remerge resolution diffs, main-vs-head scoped/schema diffs, changed-PR-file list, merge metadata, own prior approval readback, builder-lane state/jobs/log, exact-head CI jobs/live log, reused probe, verdict payload/readback, pre-post checks and final head confirmation.

`git show --remerge-diff` emitted a missing temporary virtual-blob warning after producing the resolution diff; the complete `git show --cc` diff and direct parent/final comparisons were retained as the independent fallback.

## HANDOFF

Complete: APPROVE at `ff2594db6f506b47dc50510a5c7512119e4609bc`, A/B/C = 0/0/0, no open Sol Bs; comment posted and read back exactly, with the same head confirmed after posting at 17:46:55 PDT. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6006817321)

Owned claim released by moving it into `ops/aud-122/AUD-SOL-BC5-122/released-claims/`; nothing deleted, and no owned worktree, branch, lock or CI run remains.

Default next operator action: obtain the independent other-lens verdict and land the rule-11 assembled train only at the attested SHA with required checks green; preserve the existing broadcasts mobile/device release gate. [Split-stack rules](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md), [Release gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/ff2594db6f506b47dc50510a5c7512119e4609bc/.github%2Ffly-env-desired-state.json)
