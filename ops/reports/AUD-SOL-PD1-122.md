# AUD-SOL-PD1-122 — programs delta, agent 122

Started 2026-10-05 16:33:49 PDT; deadline 17:18:49 PDT. Sol lens, independent; no other lens's current-round work read.

## Scope
- Mobile #355 @ 36fd39d9eea8f4603358734a3e6c53905310992d: prior Bs and fix delta.
- Mobile #356 @ d38b4a7045da9c8aa0bec262adba2428dc8da287: prior Bs and fix delta.
- Mobile #357 @ 670fea7555e0621d475455d8f8490b0ac6f28c6d: merge-only delta.
- Mobile #358 @ dc47b4934b1feb5e77d6fc146e48aef3498c66cc: Remove scope and telemetry fix delta.
- Backend #733 @ 635cabeeae1c3e74dd3f9311e5a059680e917628: first full T4 review.

Read the common brief in full, only the assigned JOBS entry, SoT A1/A2 owner overrides/A5 rules 11–12, and builder reports. Claims taken at these exact heads. Operator-ruled Cs excluded from analysis.

## Status
DONE 2026-10-05 16:48:24 PDT; all five exact-head Sol verdicts posted within the 45-minute time box.

- Own prior B-355-1 is fixed by complete 20-row cursor paging, with a failed later page rejecting the whole roster rather than returning a partial list; the real `coachApi.getClients` signature is `(status, cursor, take)` and the backend controller/service consume the same fields. [Reviewed roster implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/36fd39d9eea8f4603358734a3e6c53905310992d/src%2Fapi%2FprogramsApi.ts).
- Mobile parses `code`/`error` and strips envelope keys from the three backend 409 codes; Check again keeps the unresolved history gate for any reply other than successful undo or a parsed moved-head response. [Reviewed mobile API boundary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/36fd39d9eea8f4603358734a3e6c53905310992d/src%2Fapi%2FworkoutAutosaveApi.ts), [reviewed history gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/d38b4a7045da9c8aa0bec262adba2428dc8da287/src%2Fscreens%2Fcoach%2FCoachWorkoutBuilderScreen.tsx).
- #357's own P3 files have zero delta from the previous Sol-reviewed head; its parents are the previous P3 head and the fixed #356 head. [P3 restack record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-6005427938).
- Own prior Sol B-358-3 and B-358-4 are fixed: failure action metadata contains no client/package name; Remove is grouped per client and describes all runs/package copies, omits counts before all pages load, and displays authoritative removed/kept totals afterward. [Reviewed removal implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/dc47b4934b1feb5e77d6fc146e48aef3498c66cc/src%2Fscreens%2Fcoach%2Fprograms%2FProgramHistoryScreen.tsx), [reviewed package failure action](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/dc47b4934b1feb5e77d6fc146e48aef3498c66cc/src%2Fscreens%2Fcoach%2Fprograms%2FProgramPackagesScreen.tsx).
- First full #733 review found no blocker: exactly three named codes allow safe nonnegative integer head indexes and 16-lowercase-hex tokens; service authorization precedes conflict generation and 409 checks precede writes; other fields/codes and 5xx details remain excluded. [Reviewed detail allowlist](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/635cabeeae1c3e74dd3f9311e5a059680e917628/src%2Ffilters%2Ferror-details.ts), [reviewed authorized autosave/undo service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/635cabeeae1c3e74dd3f9311e5a059680e917628/src%2Fworkout-builder%2Fworkout-builder-autosave.service.ts).

## Evidence

Backend lane #37389490185 starts at #733 plus probe-only commit `adfd1569`; its three added cross-repo tests use the copied mobile API boundary over actual Axios HTTP against the real Nest controller/service/filter (in-memory Prisma, test auth). The only mobile platform adaptations are Zod v3 subpath import, a Node Axios transport, and Node UUID generation; this is not real-device/production certification. The lane passed **6 suites / 52 tests**, including all three real 409 mobile parsing paths and bootstrap retry; **2 suites / 16 tests skipped** require live DB, covered by the PR's own green MWB live job; probe lane typecheck was skipped. [Independent backend lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389490185), [exact-head MWB live tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388353649/job/112027205516).

Mobile lane #37390231640 uses #358 plus probe-only `3bd7e667e41ca99ed415b1f650d51f814f743dc0`; the #355 API/service and #356 screen/helper blobs are byte-identical at this top head. It passed **typecheck and 8 suites / 88 tests**, including independent 25-client roster/partial-load refusal replays, both remaining saved Sol P4 counterexamples, the five builder removal/package-telemetry controls, and the history-gate/API/Programs screen suites. [Independent mobile lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37390231640).

The exact-head mobile #358 PR CI passed **498 suites / 6,955 tests**, including the fixed roster, API envelope, history recovery, and removal/telemetry suites; this is source-head CI, distinct from the independent lane. [Exact-head top-piece CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388181057/job/112026655601).

## Verdicts posted

| Repo / PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #355 | 36fd39d9eea8f4603358734a3e6c53905310992d | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-6005739395) |
| mobile #356 | d38b4a7045da9c8aa0bec262adba2428dc8da287 | APPROVE | 0/0/2 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-6005739732) |
| mobile #357 | 670fea7555e0621d475455d8f8490b0ac6f28c6d | APPROVE | 0/0/1 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-6005740086) |
| mobile #358 | dc47b4934b1feb5e77d6fc146e48aef3498c66cc | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-6005740478) |
| backend #733 | 635cabeeae1c3e74dd3f9311e5a059680e917628 | APPROVE | 0/0/0 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/733#issuecomment-6005694990) |

## A/B/C dispositions

- **A = 0, B = 0** across the five current heads; own Sol roster B-355-1 and privacy/removal B-358-3/B-358-4 are repaired and independently replayed. [Roster closure](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-6005739395), [privacy/removal closures](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-6005740478).
- The real backend/mobile 409 contract and changed Check again recovery are verified end to end; the previous Sol history Bs are operator-reclassified, not falsely claimed repaired. [Backend contract verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/733#issuecomment-6005694990), [history delta verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-6005739732).
- **C (edge, deferred to 10k clients): existing C-356-1, C-356-2 and C-357-1 carried unchanged; zero new Cs; operator-ruled cases not re-raised.** [History follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-6005739732), [editor follow-up](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-6005740086).

## CI and decisions

Exact-head PR checks were green on every reviewed head; stacked mobile #356–#358 retain the integrated main-targeted gate, rather than treating one stacked-base combined check as release eligibility. [P1 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387540853/job/112024480210), [P2 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387743215/job/112025218859), [P3 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387969143/job/112025968914), [P4 exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388181057/job/112026655601), [backend exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388353649/job/112027205285).

No new product decisions required. Recommended defaults: land the approved mobile stack under A5 rule 11 and its main-targeted checks; merge/deploy #733 before the separate feature-enablement change, with existing backend flag/secret prerequisites; preserve deferred Cs without another edge-fix round. [Mobile landing recommendation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-6005740478), [backend enablement recommendation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/733#issuecomment-6005694990).

## Evidence preservation

All comment payloads/receipts, complete owned deltas, PR file snapshots, candidate/lane logs, portable probe sources/patches and empty successful tree-diff checks are in `ops/aud-122/AUD-SOL-PD1-122/`. The two completed audit branches were deleted remotely; no run remains active. Disposable local worktrees/branches/claims are preserved under the workspace no-deletion instruction, not active locks:
- `wt/AUD-SOL-PD1-122-mobile` — audit probe commit `3bd7e667e41ca99ed415b1f650d51f814f743dc0`.
- `wt/AUD-SOL-PD1-122-backend` — audit probe commit `adfd1569` plus an untracked empty `.ci-lane-tsc` marker (not in the completed backend lane; typecheck skipped there).

No local npm/Jest/tsc/build execution, dependency installation, PR-branch write, merge, deploy, native build, production action, or spend occurred. Only owned audit branches were pushed; the backend run completed before the mobile run was submitted.

## HANDOFF
DONE. All five Sol verdicts are APPROVE at the exact heads in the table, each immediately reverified before its comment; no current-round Opus work was read before posting. Both independent lanes completed green; no A/B or new decision remains. Next owner is operator 122 for the other lens, integrated stack landing/required checks, backend-first deployment and separate flag enablement. Local evidence/worktrees are preserved; no active lane or lock is held.
