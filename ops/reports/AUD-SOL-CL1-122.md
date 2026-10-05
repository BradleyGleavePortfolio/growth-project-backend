# AUD-SOL-CL1-122 — coachless backend independent Sol audit

Job: AUD-SOL-CL1-122, agent 122, GPT-6.1 Sol. Started Monday 2026-10-05 15:57:12 PDT; 45-minute box ends 16:42:12 PDT.

## Exact heads and scope

| PR | Head | Changed lines | Status |
|---|---|---:|---|
| [#721](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6004991224) | d90b484278f432e6e73e41326dc31cadc8892999 | 808 | APPROVE; A/B/C 0/0/0 |
| [#722](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6004991568) | c219d2f391c37edd700d5204f31b50286f280d82 | 1290 | APPROVE; A/B/C 0/0/0 |
| [#723](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6004991999) | e3368cc3cbb0961326ddf147728f7fc32d884188 | 1117 | APPROVE; A/B/C 0/0/0 |

T4; auth, tenant attachment, RLS, account erasure, featured paid-offer handoff. No evidence reused from a prior Sol approval; original #657 has no Sol audit verdict. No Opus lens notes, report, or comments read. Claims created for all three exact heads.

## Work and evidence

- Read common brief fully, only assigned JOBS122 entry, current SoT A1 and A2 overrides, A5 rules 11–12, and lens contract.
- Detached read/probe worktree: `/home/user/workspace/wt/AUD-SOL-CL1-122-723` at #723 exact head.
- PR CI build/test and RLS jobs were cancelled, not green: [#721 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37370260535), [#722 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37370260280), [#723 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37370260017).
- #721 is DIRTY versus main; content judged independently of operator-owned refresh, as assigned.
- Single independent targeted lane: [run 37385864416](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37385864416), audit branch `audit/AUD-SOL-CL1-122/723-normal-paths`; **8 suites / 94 tests passed**, exercising coachless Home/redemption, manifest coverage/FK ordering, role enforcement, flags and application OpenAPI/DI boot. The lane does not provision Postgres and is not live RLS evidence; full tsc was skipped. The two additionally requested paths `test/no-pii-in-logs.spec.ts` and `test/fly-env-manifest.spec.ts` were not discovered because their actual paths are under `test/privacy/` and `test/ci/`; no claim of execution is made for those gates. [Executed suites and result](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37385864416/job/112018864858).
- Lane commit `954833a31a2300d9b7f46a8ca69b67588a0ac3fe` changes only `.ci-lane-specs` and `.github/workflows/ci-lane.yml` relative to #723; no production source was edited. [Lane commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/954833a31a2300d9b7f46a8ca69b67588a0ac3fe).

## Source review

- #721: all new tables are additive; FORCE/ENABLE RLS, self/owner read policies, service-only writes, anon deny, rollback, manifest erasure decisions and required live-suite wiring were read. The erasure manifest deletes completed response rows naming an erased coach and detaches singleton editor/coach references. [Migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/d90b484278f432e6e73e41326dc31cadc8892999/prisma/migrations/20270301000000_coachless_featured_coach/migration.sql), [manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/d90b484278f432e6e73e41326dc31cadc8892999/src/account-deletion/account-deletion.manifest.ts#L304-L316).
- #722: reviewed code lookup, authoritative CoachSubscription acceptance, same-coach active package ownership, config validation/write audit, client projection, coachless eligibility, persistent dismissal and flag evaluation. This piece mounts no route and its test fixture has no later-piece import. [Featured service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c219d2f391c37edd700d5204f31b50286f280d82/src/coachless/featured-coach.service.ts), [Home](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c219d2f391c37edd700d5204f31b50286f280d82/src/coachless/coachless-home.service.ts), [fixture](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c219d2f391c37edd700d5204f31b50286f280d82/test/coachless/coachless-fixture.ts).
- #723: reviewed current-user-only controller inputs, JWT/roles/owner guards, kill switch, canonical attach delegation, normal refusal/error mapping, same-coach package selection and module DI. The unchanged canonical writer enforces student role, no reparenting, code lifecycle and recipient restrictions; the grant writer separately qualifies package access. [Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e3368cc3cbb0961326ddf147728f7fc32d884188/src/coachless/coachless.controller.ts), [redemption](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e3368cc3cbb0961326ddf147728f7fc32d884188/src/coachless/coach-code-redemption.service.ts#L207-L282), [canonical writer](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e3368cc3cbb0961326ddf147728f7fc32d884188/src/invite-codes/invite-codes.service.ts#L689-L818), [grant authorization](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e3368cc3cbb0961326ddf147728f7fc32d884188/src/invite-grant/invite-grant.service.ts#L566-L684).

## Operator defaults

1. Keep `FEATURE_COACHLESS_HOME` unset until the mobile consumer, owner-saved featured offer and device pass exist; the manifest expressly requires these before promotion. [Flag manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c219d2f391c37edd700d5204f31b50286f280d82/.github/fly-env-desired-state.json#L93).
2. Configure the public paid offer with the dedicated public code, `grant_mode=none`, and the intended recurring package; do not reuse a comp/prepaid code. This is the existing owner launch setup decision, not a new code defect. [Owner setup decision](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md#L4201-L4203).
3. Keep the reserved migration name and ledger deletion-on-coach-erasure decisions; refresh #721 conflicts under operator ownership and land the reviewed stack together with green required checks. [PR #721 provenance and migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721), [erasure decisions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/d90b484278f432e6e73e41326dc31cadc8892999/src/account-deletion/account-deletion.manifest.ts#L304-L316).
4. Preserve the declared integration responsibility: whichever this stack or #658 lands second maps #658's new code lifecycle errors into ATTACH_TO_COACHLESS; this is not a present-head B or C. [Declared overlap](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723).

## Findings

No normal-use A/B defect found; no C findings raised. APPROVE verdicts posted once per exact head after immediate GitHub head verification: [#721 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6004991224), [#722 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6004991568), [#723 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6004991999).

RUTHLESS SCOPE applies; races, retries, timing windows, and other frozen edge cases were not investigated or raised as blockers.

## Saved evidence

- `ops/aud-122/AUD-SOL-CL1-122/comment-{721,722,723}.md`: exact posted payloads.
- `ops/aud-122/AUD-SOL-CL1-122/comment-{721,722,723}-receipt.json`: GitHub comment receipts.
- `ops/aud-122/AUD-SOL-CL1-122/ci-37385864416-job-112018864858.log`: complete independent CI job log.
- `ops/aud-122/AUD-SOL-CL1-122/reviewed-source-diff.patch`: source review corpus.

## HANDOFF

Completed source audit and posted all three Sol approvals at 16:02:48–16:02:51 PDT. A/B/C = 0/0/0 for every PR; no B IDs and no lens C follow-ups. [#721](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6004991224), [#722](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6004991568), [#723](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6004991999).

Operator next: refresh #721 conflict under normal exact-head review rules; obtain green full required checks, especially live RLS; land the train together; leave the feature flag off pending mobile/config/device readiness. These are merge/promotion gates, not newly invented normal-user code defects. [#721 PR/CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721), [live-suite wiring](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/d90b484278f432e6e73e41326dc31cadc8892999/.github/workflows/ci.yml#L359-L370), [promotion prerequisites](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c219d2f391c37edd700d5204f31b50286f280d82/.github/fly-env-desired-state.json#L93).

No merge, deployment, production access or PR-branch push performed. The independent lane is completed. Workspace evidence and the clean detached worktree are retained per workspace preservation instructions; claim markers are archived out of the active claims directory and the remote audit branch is removed after completion.
