# AUD-SOL-BC1-122 — independent broadcasts train audit

Job: AUD-SOL-BC1-122, agent 122, GPT-6.1 Sol.

Started 2026-10-05 16:05:41 PDT; time box ends 16:50:41 PDT.

Completed and cleaned up 2026-10-05 16:18:20 PDT.

## Scope and exact heads

| PR / verdict comment | Exact head | Size | Verdict | A/B/C |
|---|---|---:|---|---|
| [#726 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005185979) | b5501a89611844fc43717084d887e604af33037a | 642 | APPROVE | 0/0/0 |
| [#727 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441) | 15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5 | 1,221 | REQUEST CHANGES | 0/1/0 |
| [#728 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900) | 1dd798ab36e90dbb6b3719b7a4ae13883797167f | 1,162 | REQUEST CHANGES | 0/1/1 |
| [#729 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005186386) | 82a28bf2dbbe52b516e30fda1d22959ea0f87b42 | 1,114 | APPROVE | 0/0/0 |
| [#730 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005186836) | e97c472f00cdecbce2e5f1a680e05b1744c14715 | 865 | APPROVE | 0/0/0 |

All are within the 1,500-line cap. Scope is ordinary-user tenant isolation, roster departures, messaging preferences, private card payloads, ordinary schedule execution, and additive migration safety; no edge-case investigation. [Candidate train](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726)

Train total: A/B/C = **0/2/1**; approvals are slice-only and do not make the combined train merge-ready while the two Bs remain open. [#727 blocker](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441), [#728 blocker](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900)

## Prior Sol findings

Read only the prior Sol #659 verdict, not the Opus lens's notes, report, or comments for this round. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/659#issuecomment-5964574829)

The author-bound idempotency lookup/replay and send-time active-author/recipient authority now address A-659-6 and A-659-7; started one-offs refuse edits/rearming and run payloads are frozen for B-659-1. [Replay and lifecycle](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dd798ab36e90dbb6b3719b7a4ae13883797167f/src/broadcasts/broadcasts.service.ts#L185-L380), [send authority](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5/src/broadcasts/broadcast-scope.service.ts#L53-L72), [frozen delivery payload](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/82a28bf2dbbe52b516e30fda1d22959ea0f87b42/src/broadcasts/broadcast-dispatcher.service.ts#L414-L447)

Prior B-659-8 / B-659-9 fixes are present at the final status/flag boundary; no timing-window investigation or new edge probe was performed. [Final write boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/82a28bf2dbbe52b516e30fda1d22959ea0f87b42/src/broadcasts/broadcast-dispatcher.service.ts#L495-L511)

## CI

Initial exact-head checks were cancelled for the draft train; deploy-readiness commenting failed, and no current green required-check attestation is available. [#726 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726/checks), [#730 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730/checks)

The baseline CI lane passed full TypeScript checking and 195 selected tests across 10 suites, with 15 excluded tests; no local test/build was run. [Baseline CI lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386716686)

Both independent ordinary-use finding probes were bundled in one subsequent push after the baseline lane finished; their full TypeScript check passed and **2/2 probes failed at the expected assertions**, with preview 0 rather than 1 and four returned program IDs rather than two readable IDs. The probes call the actual candidate services over mocked ordinary database rows, not a live database. [Program-boundary probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387147283)

Both lanes are complete; no run remains in flight, and no local npm/jest/tsc/build, production database operation, or provider send was used. [Baseline CI lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386716686), [Program-boundary probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387147283)

## Confirmed Bs

### B-727-1 — master-program audiences miss normally assigned client copies

Normal-user story: A coach assigns a program to a client using the normal Programs flow, selects that program in the broadcast audience picker, and gets zero recipients instead of that client, so the announcement cannot be scheduled. [Program-picker masters](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dd798ab36e90dbb6b3719b7a4ae13883797167f/src/broadcasts/broadcasts.service.ts#L91-L96), [literal assignment program-ID match](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5/src/broadcasts/segment-resolver.service.ts#L103-L109)

`ProgramDeliveryService` writes the assigned day's `program_id` as the new client-copy ID and writes `cloned_from_id: master.id` on that copy, but the broadcast resolver compares only the day's literal program ID with the selected master ID. [Ordinary assigned-copy construction](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/src/workout-builder/program-delivery.service.ts#L186-L255)

Minimal fix: resolve the selected readable masters through live, tenant-bounded client copies / their assignment lineage, keeping the final client set bounded to the author's authorized roster; verify one normal master → client copy → assignment → preview/create/send flow. [Canonical program-assignee lookup](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/src/workout-builder/program-library.service.ts#L1159-L1165)

### B-728-1 — ordinary audience picker exposes owner-only program names

Normal-user story: A sub-coach opening the broadcast audience picker receives the head coach's and sibling coaches' owner-only program names even though those programs are private to their authors. [Unrestricted tenant program picker](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dd798ab36e90dbb6b3719b7a4ae13883797167f/src/broadcasts/broadcasts.service.ts#L91-L96)

The candidate filters only tenant, master status, and archive status; the existing library enforces `owner_user_id === actor` or `visibility === tenant_shared`, and the schema expressly says owner-only rows are readable only by their owner. [Canonical library read rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/src/workout-builder/program-library.service.ts#L225-L240), [Owner-only definition](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/prisma/schema.prisma#L2291-L2297)

Minimal fix: apply the same readable-master predicate to program options and to program-reference validation, then verify a sub-coach sees their own private and tenant-shared masters but neither a head-coach nor sibling owner-only master. [Picker and validator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dd798ab36e90dbb6b3719b7a4ae13883797167f/src/broadcasts/broadcasts.service.ts#L91-L96), [Reference validation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/15cf8e5c0f2e3e6de19a0a8f58c0c1ff6a4f76a5/src/broadcasts/segment-resolver.service.ts#L74-L79)

## C

C-728-2 — C (edge, deferred to 10k clients): finite-series exhaustion combined with pause/resume; no investigation, probe or fix requested now. [Resume path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dd798ab36e90dbb6b3719b7a4ae13883797167f/src/broadcasts/broadcasts.service.ts#L350-L365)

## Operator decisions and recommended defaults

1. **Fix round:** recommended default is one builder applying only B-727-1 and B-728-1, replaying the retained ordinary probes, and restacking #727 → #728 → #729 → #730 for fresh exact-head lens attestations; do not fix C-728-2 now. [#727 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441), [#728 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900)
2. **Landing/enablement:** recommended default is the complete split-stack rule-11 landing only after required checks are green, with the feature still off until the mobile composer/device gate passes; the baseline lane is not a substitute for full required CI or live migration/RLS gates. [#730 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005186836), [Release gate](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e97c472f00cdecbce2e5f1a680e05b1744c14715/.github/fly-env-desired-state.json)

## HANDOFF

Complete. All five verdicts posted and read back, and all five heads rechecked unchanged at 16:17:59 PDT. [#726](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/726#issuecomment-6005185979), [#727](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441), [#728](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/728#issuecomment-6005225900), [#729](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/729#issuecomment-6005186386), [#730](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/730#issuecomment-6005186836)

Evidence retained under `/home/user/workspace/ops/aud-122/AUD-SOL-BC1-122/`: all five comment payloads; `normal-program-boundary.probe.spec.ts`; baseline/full/failed CI logs; lane-launch logs; final PR heads and own-verdict receipts. Both owned audit branches and the owned worktree were removed, five claims released, and the main clone remained clean. No other lens's current-round notes/report/comments were read, no PR source or branch was changed, and no merge/deploy/production operation occurred.
